import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { StreamChunk } from "@tanstack/ai";
import { parseTestView, testingProjectionEvent } from "../../shared/testing-event";
import { z } from "zod";
import {
  chatEventsTable,
  chatRunsTable,
  testingArtifactsTable,
  testingDecisionsTable,
  testingDeliveriesTable,
  testingObservationsTable,
  testingOperationsTable,
  testingPinsTable,
  testingPublicationsTable,
  testingReceiptsTable,
  testingTasksTable,
} from "../db/schema";
import {
  ROLE_IDS,
  TestingRequestError,
  artifactRefSchema,
  testRunIdSchema,
  testingIntentSchema,
  delegationInputSchema,
  type DelegationInput,
  browserOutputSchema,
  type BrowserOutput,
  designCaptureSchema,
  type ArtifactKind,
  type ArtifactRef,
  type PublicTestReport,
  type ReuseDecision,
  type ReuseRejection,
  type RoleId,
  type RootRunOutcome,
  type Source,
  type TaskOutcome,
  type TaskMessageOrigin,
  type TestView,
  type TestingRequestInput,
} from "../../shared/testing";
import {
  assembleRequirements,
  assembleToolResults,
  canonicalizePlan,
  deriveReport,
  publicIssues,
  schemaIssueMessages,
  digestOf,
  planScopeDigest,
  planPayloadSchema,
  requirementsPayloadSchema,
  projectProgress,
  publicTaskArtifact,
  requirementsScopeDigest,
  validateReuse,
  type CanonicalPlan,
  type Requirements,
  type Results,
  type RoleOutcome,
  type TrustedToolReceipt,
  type Validation,
} from "./testing-domain";
import { roleRegistry } from "./agents";
import { readProjection } from "./conversation";
import { readSource } from "./source-links";

export const TESTING_WORKFLOW_VERSION = "testing-child-v3";
const PROSE_WORKFLOW_VERSIONS: ReadonlySet<string> = new Set([
  "testing-child-v2",
  TESTING_WORKFLOW_VERSION,
]);
const TESTING_SCHEMA_VERSION = "supervised-testing-schema-v2";
export const DESIGN_CAPTURE_NATIVE = "design_capture";
const TESTING_LIMITS = {
  turns: 8,
  tools: 24,
  nestedCalls: 8,
  observationEntries: 64,
  observationBytes: 32_768,
  modelAttempts: 3,
  operationMs: 15 * 60 * 1000,
} as const;
const BROWSER_ROLE_LIMITS = {
  turns: 20,
  tools: 60,
  observationEntries: 240,
  observationBytes: 65_536,
} as const;
const ROLE_LIMITS = { ac: BROWSER_ROLE_LIMITS, ui: BROWSER_ROLE_LIMITS } as const;
const TESTING_FIXTURE = { id: "playwright-chromium", version: "v1" } as const;

const VERSIONS = {
  runtime: "host-testing-runtime-v1",
  schema: TESTING_SCHEMA_VERSION,
  validator: "testing-domain-v2",
  policy: "role-registry-v1",
  catalog: "catalog-v1",
  adapter: "playwright-jev-v1",
  loop: "agent-loop-v1",
  fixture: TESTING_FIXTURE.version,
  workflow: TESTING_WORKFLOW_VERSION,
} as const;

export type TestingSnapshot = Readonly<{ model: string; build: string }>;

type ProfileVersions = Readonly<Record<RoleId, string>>;

function profileVersions(): ProfileVersions {
  return {
    atlassian: roleRegistry.atlassian.profile,
    planner: roleRegistry.planner.profile,
    ac: roleRegistry.ac.profile,
    ui: roleRegistry.ui.profile,
  };
}

function registrationVersions(): ProfileVersions {
  return {
    atlassian: registrationVersion("atlassian"),
    planner: registrationVersion("planner"),
    ac: registrationVersion("ac"),
    ui: registrationVersion("ui"),
  };
}

function registrationVersion(role: RoleId): string {
  const definition = roleRegistry[role];

  return `${definition.artifact}:${definition.profile}:${definition.codeMode}:${definition.registration}`;
}

export type HostTestingRuntime = Readonly<{
  absoluteDeadline: string;
  limits: typeof TESTING_LIMITS;
  roleLimits: typeof ROLE_LIMITS;
  versions: typeof VERSIONS & TestingSnapshot;
  profiles: ProfileVersions;
  registration: ProfileVersions;
  fixture: typeof TESTING_FIXTURE;
  model: string;
  build: string;
}>;

export type TestingAdmission = Readonly<{
  operationId: string;
  parentRunId: string;
  threadId: string;
  requestKey: string;
  deadline: string;
  mode: "attached" | "standalone";
  decisions: readonly ReuseDecision[];
  pinnedRefs: readonly ArtifactRef[];
}>;

export type RoleFrame = Readonly<{
  taskId: string;
  operationId: string;
  role: RoleId;
  childWorkflowId: string;
  attemptNonce: number;
  inputDigest: string;
  input: unknown;
}>;

export type TestingExecutionReceipt = Readonly<{
  id: string;
  taskId: string;
  attemptNonce: number;
  slot: string;
  nativeName: string;
  route: "direct" | "codemode";
  inputDigest: string;
  outputDigest: string;
  input: unknown;
  output: unknown;
  bindings: ReceiptBindings;
}>;

export type TestingExecution = Readonly<{
  operationId: string;
  parentRunId: string;
  threadId: string;
  mode: "attached" | "standalone";
  intent: TestingRequestInput;
  runtime: HostTestingRuntime;
  deadline: string;
  cancelRequested: boolean;
  finished: boolean;
  decisions: readonly DecisionBody[];
  artifacts: readonly Readonly<{
    ref: ArtifactRef;
    role: RoleId;
    kind: ArtifactKind;
    payload: unknown;
    payloadDigest: string;
    scopeDigest: string;
    provenance: Readonly<{
      originalOperationId: string;
      parentRunId: string;
      producerTaskId: string;
      attempt: number;
      issuedAt: string;
    }>;
  }>[];
  tasks: readonly Readonly<{
    frame: RoleFrame;
    observations: readonly ObservationBody[];
    receipts: readonly TestingExecutionReceipt[];
    artifactRef: ArtifactRef | null;
  }>[];
}>;

export type DeliveryRecord = Readonly<{
  key: string;
  operationId: string;
  taskId: string;
  kind: "start" | "cancel";
  acknowledgement: "quiet" | "cancel_requested" | "stopped" | null;
}>;

export type ActualIoGuard =
  | Readonly<{ state: "allowed"; slot: string }>
  | Readonly<{
      state: "denied";
      reason: "cancel_requested" | "terminal" | "deadline" | "budget" | "nonce" | "scope";
    }>;

export type ActualIoInput = Readonly<{
  taskId: string;
  parentRunId: string;
  attemptNonce: number;
  childWorkflowId: string;
}> &
  (
    | Readonly<{ kind: "model"; step: string }>
    | Readonly<{ kind: "tool" }>
    | Readonly<{ kind: "nested" }>
  );

export type AppendTestingEvent = (key: string, event: StreamChunk) => Promise<number>;

export class TestingPersistenceError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "TestingPersistenceError";
  }
}

type Transaction = Parameters<Parameters<typeof import("../db").db.transaction>[0]>[0];
type OperationRow = typeof testingOperationsTable.$inferSelect;
type TaskRow = typeof testingTasksTable.$inferSelect;

const callKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .min(1)
  .max(200);
const roleIdSchema = z.enum(ROLE_IDS);
const artifactKindSchema = z.enum(["requirements", "plan", "ac-result", "ui-result"]);
const modelStepsSchema = z.record(
  callKeySchema,
  z.number().int().positive().max(TESTING_LIMITS.modelAttempts),
);
const metadataSchema = z.strictObject({
  dependencies: z.array(z.string().min(1).max(256)),
  versions: z.strictObject({
    runtime: z.string(),
    schema: z.string(),
    validator: z.string(),
    policy: z.string(),
    catalog: z.string(),
    adapter: z.string(),
    loop: z.string(),
    fixture: z.string(),
    workflow: z.string(),
    model: z.string().min(1),
    build: z.string().min(1),
  }),
  profiles: z.strictObject({
    atlassian: z.string().min(1),
    planner: z.string().min(1),
    ac: z.string().min(1),
    ui: z.string().min(1),
  }),
  registration: z.strictObject({
    atlassian: z.string().min(1),
    planner: z.string().min(1),
    ac: z.string().min(1),
    ui: z.string().min(1),
  }),
  fixture: z.strictObject({ id: z.string(), version: z.string() }),
  parentRunId: z.string().min(1),
  producerTaskId: z.string().min(1),
  attempt: z.number().int().positive(),
  inputDigest: z.string().min(1),
  outputDigest: z.string().min(1),
});
type ArtifactMetadata = z.infer<typeof metadataSchema>;

export type StoredArtifactRow = Readonly<{
  ref: string;
  threadId: string;
  kind: string;
  scopeDigest: string;
  payloadDigest: string;
  payload: unknown;
  metadata: unknown;
  dependencies: readonly string[];
  origin: Readonly<{ runId: string; threadId: string; role: string; issuedAt: string }>;
}>;

const observationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("attempt_started"),
    activity: z.enum(["model", "tool"]),
    at: z.string().min(1).max(64),
  }),
  z.strictObject({
    kind: z.literal("attempt_settled"),
    outcome: z.enum(["completed", "failed", "cancelled", "interrupted"]),
    at: z.string().min(1).max(64),
  }),
  z.strictObject({
    kind: z.literal("tool_started"),
    toolName: z.string().min(1).max(64),
    route: z.enum(["direct", "codemode"]),
    at: z.string().min(1).max(64),
  }),
  z.strictObject({
    kind: z.literal("tool_settled"),
    outcome: z.enum(["completed", "failed", "cancelled"]),
    at: z.string().min(1).max(64),
  }),
]);
type ObservationBody = z.infer<typeof observationSchema>;

const receiptBindingsSchema = z.strictObject({
  fixture: z.strictObject({ id: z.string().min(1), version: z.string().min(1) }).optional(),
  adapterVersion: z.string().min(1).max(64).optional(),
  checkId: z.string().min(1).max(64).optional(),
  nativeName: z.string().min(1).max(64).optional(),
  nativeOutputDigest: z.string().min(1).max(128).optional(),
  capturedAt: z.string().min(1).max(64).optional(),
});

type DecisionBody =
  | Readonly<{ kind: "reuse"; decision: ReuseDecision }>
  | Readonly<{
      kind: "satisfied";
      role: RoleId;
      ref: string;
      origin: "produced" | "reused" | "recovered";
    }>
  | Readonly<{
      kind: "not_required";
      role: "ac" | "ui";
      reason: "no_style_checks" | "no_functional_checks";
    }>
  | Readonly<{ kind: "dispatch"; role: RoleId; taskId: string; childWorkflowId: string }>
  | Readonly<{
      kind: "task_result";
      role: RoleId;
      taskId: string;
      execution: "completed";
      ref: string;
      findings?: string | null;
    }>
  | Readonly<{
      kind: "task_result";
      role: RoleId;
      taskId: string;
      execution: Exclude<TaskOutcome, "completed">;
      reasonCode: string;
      issues?: readonly string[];
    }>
  | Readonly<{ kind: "cancel"; acceptedAt: string }>
  | Readonly<{ kind: "terminal"; outcome: RootRunOutcome; reasonCode: string }>;

type PreparedClosure = Readonly<{
  decisions: readonly ReuseDecision[];
  pinRefs: readonly string[];
  reused: readonly StoredArtifactRow[];
}>;

const database = async () => (await import("../db")).db;

export function hostTestingRuntime(
  snapshot: TestingSnapshot,
  now = new Date(),
): HostTestingRuntime {
  if (snapshot.model.trim() === "" || snapshot.build.trim() === "") {
    throw new TestingPersistenceError(409, "Testing runtime does not match the host snapshot");
  }

  return {
    absoluteDeadline: new Date(now.getTime() + TESTING_LIMITS.operationMs).toISOString(),
    limits: TESTING_LIMITS,
    roleLimits: ROLE_LIMITS,
    versions: { ...VERSIONS, model: snapshot.model, build: snapshot.build },
    profiles: profileVersions(),
    registration: registrationVersions(),
    fixture: TESTING_FIXTURE,
    model: snapshot.model,
    build: snapshot.build,
  };
}

type TestingLimits = Readonly<Record<keyof typeof TESTING_LIMITS, number>>;

export function effectiveLimits(
  runtime: Pick<HostTestingRuntime, "limits" | "roleLimits">,
  role: string,
): TestingLimits {
  return role === "ac" || role === "ui"
    ? { ...runtime.limits, ...runtime.roleLimits[role] }
    : runtime.limits;
}

function testingChildWorkflowId(operationId: string, role: RoleId): string {
  const digest = createHash("sha256")
    .update(`${TESTING_WORKFLOW_VERSION}\0${operationId}\0${role}`)
    .digest("hex")
    .slice(0, 24);

  return `testing-${role}-${digest}`;
}

export function closureDecisions(input: {
  threadId: string;
  intent: TestingRequestInput;
  refs: readonly string[];
  rows: ReadonlyMap<string, StoredArtifactRow>;
  host: HostTestingRuntime;
}): readonly ReuseDecision[] {
  const refs = deduped(input.refs);
  const preliminary = refs.map((ref) => classifyRef(ref, input));
  const kinds = new Map<string, string[]>();

  for (const decision of preliminary) {
    if (decision.kind !== "accepted") {
      continue;
    }

    const group = kinds.get(decision.artifactKind) ?? [];
    group.push(decision.ref);
    kinds.set(decision.artifactKind, group);
  }

  return preliminary.map((decision) => {
    if (decision.kind !== "accepted") {
      return decision;
    }

    const group = kinds.get(decision.artifactKind) ?? [];

    if (group.length > 1) {
      return rejectedDecision(decision.ref, "conflicting_reference");
    }

    return decision;
  });
}

type ClassifyInput = Readonly<{
  threadId: string;
  intent: TestingRequestInput;
  rows: ReadonlyMap<string, StoredArtifactRow>;
  host: HostTestingRuntime;
}>;

const SNAPSHOT_KEYS = ["versions", "profiles", "registration", "fixture"] as const;
const PRODUCER_KEYS = ["versions", "profiles", "registration"] as const;

function snapshotMatches(
  metadata: z.infer<typeof metadataSchema>,
  runtime: HostTestingRuntime,
  keys: readonly (typeof SNAPSHOT_KEYS)[number][] = SNAPSHOT_KEYS,
): boolean {
  return keys.every((key) => isDeepStrictEqual(metadata[key], runtime[key]));
}

function isRecord(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rowKindRejection(row: StoredArtifactRow): ReuseRejection | null {
  if (row.kind === "ac-result" || row.kind === "ui-result") {
    return "cross_run_result_forbidden";
  }

  if (row.kind !== "requirements" && row.kind !== "plan") {
    return "wrong_kind";
  }

  return isRecord(row.payload) ? null : "raw_blob";
}

function dependenciesRejected(
  row: StoredArtifactRow,
  rows: ReadonlyMap<string, StoredArtifactRow>,
): boolean {
  return row.dependencies.some((dependency) => {
    const stored = rows.get(dependency);

    return !stored || !metadataSchema.safeParse(stored.metadata).success;
  });
}

function snapshotRejection(
  ref: string,
  row: StoredArtifactRow,
  input: ClassifyInput,
): ReuseRejection | null {
  if (dependencyCycle(ref, input.rows)) {
    return "conflicting_reference";
  }

  const metadata = metadataSchema.safeParse(row.metadata);

  if (!metadata.success || !snapshotMatches(metadata.data, input.host)) {
    return "incompatible_snapshot";
  }

  if (dependenciesRejected(row, input.rows)) {
    return "dependency_rejected";
  }

  return null;
}

function storedRowRejection(
  ref: string,
  row: StoredArtifactRow | undefined,
  input: ClassifyInput,
): ReuseRejection | null {
  if (!row || row.threadId !== input.threadId || row.origin.threadId !== input.threadId) {
    return "not_accessible";
  }

  return rowKindRejection(row) ?? snapshotRejection(ref, row, input);
}

function classifyRef(ref: string, input: ClassifyInput): ReuseDecision {
  const parsedRef = artifactRefSchema.safeParse(ref);

  if (!parsedRef.success) {
    return rejectedDecision(artifactRefSchema.parse("invalid-ref"), "not_accessible");
  }

  const row = input.rows.get(ref);
  const rejection = storedRowRejection(ref, row, input);

  if (rejection || !row) {
    return rejectedDecision(parsedRef.data, rejection ?? "not_accessible");
  }

  if (row.kind === "requirements") {
    return reuseRequirements(parsedRef.data, row, input.threadId, input.intent);
  }

  return reusePlan(parsedRef.data, row, input.threadId, input.intent, input.rows);
}

function reuseRequirements(
  ref: ArtifactRef,
  row: StoredArtifactRow,
  threadId: string,
  intent: TestingRequestInput,
): ReuseDecision {
  const validation = validateReuse(storedPayload(row), {
    requested: "requirements",
    threadId,
    expectedScopeDigest: requirementsScopeDigest({ goal: intent.goal, sources: intent.sources }),
  });

  return decisionFromValidation(ref, validation);
}

function reusePlan(
  ref: ArtifactRef,
  row: StoredArtifactRow,
  threadId: string,
  intent: TestingRequestInput,
  rows: ReadonlyMap<string, StoredArtifactRow>,
): ReuseDecision {
  const requirementsRef = row.dependencies[0];
  const requirements = requirementsRef ? rows.get(requirementsRef) : undefined;

  if (!requirements || requirements.kind !== "requirements") {
    return rejectedDecision(ref, "dependency_rejected");
  }

  const requirementsValidation = validateReuse(storedPayload(requirements), {
    requested: "requirements",
    threadId,
    expectedScopeDigest: requirementsScopeDigest({ goal: intent.goal, sources: intent.sources }),
  });

  if (requirementsValidation.kind === "rejected") {
    return rejectedDecision(ref, mapIssue(requirementsValidation.issues[0]));
  }

  if (requirementsValidation.value.kind !== "requirements") {
    return rejectedDecision(ref, "dependency_rejected");
  }

  const targetUrl = intent.task ? storedPlanTarget(row.payload) : intent.targetUrl;
  const validation = validateReuse(storedPayload(row), {
    requested: "plan",
    threadId,
    expectedScopeDigest: planScopeDigest({
      goal: intent.goal,
      targetUrl,
      design: intent.design ?? null,
      requirementsDigest: requirements.payloadDigest,
    }),
    planContext: {
      requirementsDigest: digestOf(requirementsValidation.value.payload),
      goal: intent.goal,
      targetUrl,
      design: intent.design ?? null,
    },
  });

  return decisionFromValidation(ref, validation);
}

function storedPlanTarget(payload: unknown): string | null {
  return planPayloadSchema.safeParse(payload).data?.targetUrl ?? null;
}

function storedPayload(row: StoredArtifactRow): unknown {
  const metadata = metadataSchema.safeParse(row.metadata);

  return {
    kind: row.kind,
    ref: row.ref,
    digest: row.payloadDigest,
    threadId: row.threadId,
    payload: row.payload,
    scopeDigest: row.scopeDigest,
    dependencies: metadata.success ? metadata.data.dependencies : row.dependencies,
    origin: {
      runId: row.origin.runId,
      threadId: row.origin.threadId,
      role: row.origin.role,
      issuedAt: row.origin.issuedAt,
    },
  };
}

function decisionFromValidation(
  ref: ArtifactRef,
  validation: ReturnType<typeof validateReuse>,
): ReuseDecision {
  if (validation.kind === "rejected") {
    return rejectedDecision(ref, mapIssue(validation.issues[0] ?? "invalid_evidence"));
  }

  return {
    ref,
    kind: "accepted",
    artifactKind: validation.value.kind,
    provenance: {
      originalRunId: validation.value.provenance.originalRunId,
      role: validation.value.provenance.role,
      issuedAt: validation.value.provenance.issuedAt,
    },
  };
}

function mapIssue(issue: string): ReuseRejection {
  if (isReuseRejection(issue)) {
    return issue;
  }

  if (issue.includes("bound")) {
    return "incompatible_snapshot";
  }

  return "invalid_evidence";
}

const REUSE_REJECTIONS: ReadonlySet<string> = new Set<ReuseRejection>([
  "not_accessible",
  "raw_blob",
  "wrong_kind",
  "incomplete",
  "untrusted_producer",
  "scope_mismatch",
  "incompatible_snapshot",
  "dependency_rejected",
  "cross_run_result_forbidden",
  "invalid_evidence",
  "conflicting_reference",
]);

function isReuseRejection(value: string): value is ReuseRejection {
  return REUSE_REJECTIONS.has(value);
}

function rejectedDecision(ref: ArtifactRef, reason: ReuseRejection): ReuseDecision {
  return { ref, kind: "rejected", reason };
}

function dependencyCycle(ref: string, rows: ReadonlyMap<string, StoredArtifactRow>): boolean {
  const visit = (current: string, seen: ReadonlySet<string>): boolean => {
    if (seen.has(current)) {
      return true;
    }

    const row = rows.get(current);

    if (!row) {
      return false;
    }

    const next = new Set(seen);
    next.add(current);

    return row.dependencies.some((dependency) => visit(dependency, next));
  };

  return visit(ref, new Set());
}

function deduped(refs: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const ref of refs) {
    if (seen.has(ref)) {
      continue;
    }

    seen.add(ref);
    result.push(ref);
  }

  return result;
}

function assertHostRuntime(runtime: HostTestingRuntime) {
  const expected = hostTestingRuntime({ model: runtime.model, build: runtime.build });
  const { absoluteDeadline, ...rest } = runtime;
  const { absoluteDeadline: _ignored, ...expectedRest } = expected;

  if (!isDeepStrictEqual(rest, expectedRest) || Number.isNaN(Date.parse(absoluteDeadline))) {
    throw new TestingPersistenceError(409, "Testing runtime does not match the host snapshot");
  }
}

function attachedOperationId(parentRunId: string, callId: string): string {
  return `testing-${createHash("sha256").update(`${parentRunId}\0${callId}`).digest("hex").slice(0, 32)}`;
}

function intentDigest(intent: unknown): string {
  return digestOf(intent);
}

export async function admitAttachedInTransaction(
  tx: Transaction,
  parentRunId: string,
  threadId: string,
  mainModelCallId: string,
  intent: unknown,
  runtime: HostTestingRuntime,
): Promise<TestingAdmission> {
  assertHostRuntime(runtime);
  const callId = callKeySchema.safeParse(mainModelCallId);
  const parsed = delegationInputSchema.safeParse(intent);

  if (!callId.success || !parsed.success) {
    const issues = parsed.success ? [] : publicIssues(schemaIssueMessages(parsed.error, "intent"));

    throw new TestingPersistenceError(
      400,
      issues.length > 0 ? `Invalid testing intent: ${issues.join("; ")}` : "Invalid testing intent",
    );
  }

  const operationId = attachedOperationId(parentRunId, callId.data);
  const existing = await lockOperation(tx, operationId);

  if (existing) {
    const stored = testingIntentSchema.parse(existing.intent);

    if (!isDeepStrictEqual(stored.task?.input, parsed.data)) {
      throw new TestingPersistenceError(409, "Delegation call identity collision");
    }

    return reloadAdmission(tx, existing, stored);
  }

  const normalized = await delegationIntent(tx, threadId, parsed.data);
  const prepared = await prepareClosure(tx, threadId, normalized, runtime);

  return insertOperation(tx, {
    id: operationId,
    parentRunId,
    threadId,
    requestKey: callId.data,
    intent: normalized,
    runtime,
    mode: "attached",
    prepared,
  });
}

async function delegationIntent(
  tx: Transaction,
  threadId: string,
  input: DelegationInput,
): Promise<TestingRequestInput> {
  const task = { version: 2 as const, input };

  if (input.role === "atlassian") {
    return {
      goal: input.goal,
      sources: input.sources,
      targetUrl: null,
      task,
    };
  }

  const ref = input.role === "planner" ? input.requirementsRef : input.planRef;
  const rows = await loadClosure(tx, threadId, [ref]);
  const expected = input.role === "planner" ? "requirements" : "plan";
  const artifact = requireDependency(rows, ref, expected);
  const requirements =
    expected === "requirements"
      ? artifact
      : requireDependency(rows, artifact.dependencies[0] ?? "", "requirements");

  const source = requirementsPayloadSchema.safeParse(requirements.payload);

  if (!source.success) {
    throw new TestingRequestError([
      rejectedDecision(artifactRefSchema.parse(requirements.ref), "incomplete"),
    ]);
  }

  let context;

  if (input.role === "planner") {
    context = { targetUrl: null, design: input.design };
  } else {
    const plan = planPayloadSchema.safeParse(artifact.payload);

    if (!plan.success) {
      throw new TestingRequestError([
        rejectedDecision(artifactRefSchema.parse(artifact.ref), "incomplete"),
      ]);
    }

    context = resultTaskContext(plan.data, input);
  }

  return testingIntentSchema.parse({
    goal: source.data.goal,
    sources: source.data.sources.map((item) => item.reference),
    ...context,
    existingArtifacts: [...rows.keys()],
    task,
  });
}

function requireDependency(
  rows: ReadonlyMap<string, StoredArtifactRow>,
  ref: string,
  kind: "requirements" | "plan",
) {
  const artifact = rows.get(ref);

  if (!artifact || artifact.kind !== kind) {
    throw new TestingRequestError([
      rejectedDecision(
        artifactRefSchema.parse(ref || "invalid-ref"),
        artifact ? "wrong_kind" : "not_accessible",
      ),
    ]);
  }

  return artifact;
}

export function resultTaskContext(
  plan: CanonicalPlan,
  input: Extract<DelegationInput, { role: "ac" | "ui" }>,
) {
  if (plan.targetUrl !== null && plan.targetUrl !== input.targetUrl) {
    throw new TestingPersistenceError(400, "Plan target URL is incompatible");
  }

  if (plan.assignments[input.role].length === 0) {
    throw new TestingPersistenceError(
      400,
      "Plan has no automated checks for the delegated role; deferred cases are not executable",
    );
  }

  return { targetUrl: input.targetUrl, design: plan.design ?? undefined };
}

async function prepareClosure(
  tx: Transaction,
  threadId: string,
  intent: TestingRequestInput,
  runtime: HostTestingRuntime,
): Promise<PreparedClosure> {
  const refs = deduped(intent.existingArtifacts ?? []);
  const rows = await loadClosure(tx, threadId, refs);
  const decisions = closureDecisions({ threadId, intent, refs, rows, host: runtime });
  const rejected = decisions.filter((decision) => decision.kind === "rejected");

  if (rejected.length > 0) {
    const [first, ...rest] = decisions;

    if (!first) {
      throw new TestingPersistenceError(409, "Testing request has invalid artifact references");
    }

    throw new TestingRequestError([first, ...rest]);
  }

  const pinRefs = [
    ...decisions.flatMap((decision) => (decision.kind === "accepted" ? [decision.ref] : [])),
    ...[...rows.values()].flatMap((row) =>
      decisions.some((decision) => decision.kind === "accepted" && decision.ref === row.ref)
        ? row.dependencies
        : [],
    ),
  ];

  return {
    decisions,
    pinRefs: deduped(pinRefs),
    reused: [...rows.values()].filter((row) => pinRefs.includes(row.ref)),
  };
}

async function loadClosure(
  tx: Transaction,
  threadId: string,
  refs: readonly string[],
): Promise<Map<string, StoredArtifactRow>> {
  const pending = [...refs];
  const seen = new Set<string>();
  const rows = new Map<string, StoredArtifactRow>();

  while (pending.length > 0) {
    const ref = pending.pop();

    if (!ref || seen.has(ref)) {
      continue;
    }

    seen.add(ref);
    const [row] = await tx
      .select()
      .from(testingArtifactsTable)
      .where(eq(testingArtifactsTable.ref, ref));

    if (!row || row.thread_id !== threadId) {
      continue;
    }

    const stored = toStoredArtifact(row);
    rows.set(ref, stored);

    for (const dependency of stored.dependencies) {
      pending.push(dependency);
    }
  }

  return rows;
}

function toStoredArtifact(row: typeof testingArtifactsTable.$inferSelect): StoredArtifactRow {
  const metadata = metadataSchema.safeParse(row.metadata);

  return {
    ref: row.ref,
    threadId: row.thread_id,
    kind: row.kind,
    scopeDigest: row.scope_digest,
    payloadDigest: row.payload_digest,
    payload: row.payload,
    metadata: row.metadata,
    dependencies: metadata.success ? metadata.data.dependencies : [],
    origin: {
      runId: metadata.success ? metadata.data.parentRunId : row.original_operation_id,
      threadId: row.thread_id,
      role: row.role,
      issuedAt: row.created_at.toISOString(),
    },
  };
}

async function insertOperation(
  tx: Transaction,
  input: {
    id: string;
    parentRunId: string;
    threadId: string;
    requestKey: string;
    intent: unknown;
    runtime: HostTestingRuntime;
    mode: "attached" | "standalone";
    prepared: PreparedClosure;
  },
): Promise<TestingAdmission> {
  const [inserted] = await tx
    .insert(testingOperationsTable)
    .values({
      id: input.id,
      parent_run_id: input.parentRunId,
      thread_id: input.threadId,
      request_key: input.requestKey,
      intent: input.intent,
      runtime: { ...input.runtime, mode: input.mode },
      deadline: new Date(input.runtime.absoluteDeadline),
    })
    .onConflictDoNothing()
    .returning();

  if (!inserted) {
    const existing = await lockOperation(tx, input.id);

    if (!existing) {
      throw new TestingPersistenceError(409, "Testing operation identity collision");
    }

    return reloadAdmission(tx, existing, input.intent);
  }

  let index = 0;

  for (const decision of input.prepared.decisions) {
    await appendDecision(tx, inserted, `reuse:${decision.ref}`, { kind: "reuse", decision }, index);
    index += 1;

    if (decision.kind === "accepted") {
      const role = decision.artifactKind === "requirements" ? "atlassian" : "planner";
      await appendDecision(
        tx,
        inserted,
        `satisfied:${role}`,
        { kind: "satisfied", role, ref: decision.ref, origin: "reused" },
        index,
      );
      index += 1;
    }
  }

  const plan = input.prepared.reused.find((row) => row.kind === "plan");

  for (const role of plan ? unassignedRoles(plan.payload) : []) {
    await appendDecision(
      tx,
      inserted,
      `not_required:${role}`,
      { kind: "not_required", role, reason: NOT_REQUIRED_REASON[role] },
      index,
    );
    index += 1;
  }

  if (input.prepared.pinRefs.length > 0) {
    await tx.insert(testingPinsTable).values(
      input.prepared.pinRefs.map((ref) => ({
        operation_id: inserted.id,
        ref,
      })),
    );
  }

  return admissionFrom(inserted, input.prepared.decisions, input.prepared.pinRefs);
}

const NOT_REQUIRED_REASON = { ac: "no_functional_checks", ui: "no_style_checks" } as const;

function assignedChecks(payload: unknown, role: "ac" | "ui"): readonly string[] {
  if (!payload || typeof payload !== "object" || !("assignments" in payload)) {
    return [];
  }

  const assignments = payload.assignments;

  if (!assignments || typeof assignments !== "object" || !(role in assignments)) {
    return [];
  }

  const assigned = (assignments as Record<string, unknown>)[role];

  return Array.isArray(assigned) ? assigned.filter((item) => typeof item === "string") : [];
}

function unassignedRoles(payload: unknown): readonly ("ac" | "ui")[] {
  return (["ac", "ui"] as const).filter((role) => assignedChecks(payload, role).length === 0);
}

async function appendDecision(
  tx: Transaction,
  operation: OperationRow,
  key: string,
  body: DecisionBody,
  index = operation.writer_nonce,
) {
  const [last] = await tx
    .select({ decision_index: testingDecisionsTable.decision_index })
    .from(testingDecisionsTable)
    .where(eq(testingDecisionsTable.operation_id, operation.id))
    .orderBy(desc(testingDecisionsTable.decision_index))
    .limit(1);
  const decisionIndex = last ? last.decision_index + 1 : index;
  await tx.insert(testingDecisionsTable).values({
    operation_id: operation.id,
    decision_index: decisionIndex,
    decision_key: key,
    body,
  });
}

async function reloadAdmission(
  tx: Transaction,
  existing: OperationRow,
  intent: unknown,
): Promise<TestingAdmission> {
  if (intentDigest(existing.intent) !== intentDigest(intent)) {
    throw new TestingPersistenceError(409, "Testing request collision");
  }

  const decisions = await readDecisions(tx, existing.id);
  const reuse = decisions.flatMap((decision) =>
    decision.kind === "reuse" ? [decision.decision] : [],
  );
  const pins = await tx
    .select({ ref: testingPinsTable.ref })
    .from(testingPinsTable)
    .where(eq(testingPinsTable.operation_id, existing.id));

  return admissionFrom(
    existing,
    reuse,
    pins.map((pin) => pin.ref),
  );
}

function admissionFrom(
  operation: OperationRow,
  decisions: readonly ReuseDecision[],
  pinRefs: readonly string[],
): TestingAdmission {
  const runtime = operation.runtime as { mode?: "attached" | "standalone" };

  return {
    operationId: operation.id,
    parentRunId: operation.parent_run_id,
    threadId: operation.thread_id,
    requestKey: operation.request_key,
    deadline: operation.deadline.toISOString(),
    mode: runtime.mode === "standalone" ? "standalone" : "attached",
    decisions,
    pinnedRefs: pinRefs.map((ref) => artifactRefSchema.parse(ref)),
  };
}

async function lockOperation(tx: Transaction, id: string): Promise<OperationRow | undefined> {
  const [operation] = await tx
    .select()
    .from(testingOperationsTable)
    .where(eq(testingOperationsTable.id, id))
    .for("update");

  return operation;
}

async function requireOperation(tx: Transaction, id: string): Promise<OperationRow> {
  const operation = await lockOperation(tx, id);

  if (!operation) {
    throw new TestingPersistenceError(404, "Unknown testing operation");
  }

  return operation;
}

function assertOwner(operation: OperationRow, ownerRunId: string) {
  if (operation.parent_run_id !== ownerRunId) {
    throw new TestingPersistenceError(409, "Testing operation owner mismatch");
  }
}

function frozenRuntime(
  operation: OperationRow,
): HostTestingRuntime & { mode: "attached" | "standalone" } {
  const runtime = operation.runtime as HostTestingRuntime & { mode?: "attached" | "standalone" };

  return { ...runtime, mode: runtime.mode === "standalone" ? "standalone" : "attached" };
}

function isProseOperation(operation: OperationRow): boolean {
  return PROSE_WORKFLOW_VERSIONS.has(frozenRuntime(operation).versions.workflow);
}

export async function reserveRoleTaskInTransaction(
  tx: Transaction,
  operationId: string,
  ownerRunId: string,
  role: RoleId,
  input: unknown,
): Promise<RoleFrame | null> {
  const operation = await requireOperation(tx, operationId);
  assertOwner(operation, ownerRunId);

  if (operation.finished_at) {
    throw new TestingPersistenceError(409, "Testing operation is terminal");
  }

  const intent = testingIntentSchema.parse(operation.intent);

  if (!intent.task || role !== intent.task.input.role) {
    throw new TestingPersistenceError(409, "Only the explicitly delegated role can be reserved");
  }

  const decisions = await readDecisions(tx, operation.id);
  const existing = await tx
    .select()
    .from(testingTasksTable)
    .where(eq(testingTasksTable.operation_id, operation.id))
    .orderBy(asc(testingTasksTable.created_at));
  const prior = existing.find((task) => task.role === role);
  const digest = digestOf(input);

  if (operation.cancel_accepted_at) {
    await ensureCancelDeliveries(tx, operation.id, existing);

    return prior ? frameFrom(prior) : null;
  }

  if (prior) {
    if (prior.input_digest !== digest) {
      throw new TestingPersistenceError(409, "Reserved task input collision");
    }

    return frameFrom(prior);
  }

  assertReservable(role, decisions);
  const taskId = `task-${role}-${createHash("sha256")
    .update(`${operation.id}\0${role}`)
    .digest("hex")
    .slice(0, 24)}`;
  const childWorkflowId = testingChildWorkflowId(operation.id, role);
  const [inserted] = await tx
    .insert(testingTasksTable)
    .values({
      id: taskId,
      operation_id: operation.id,
      role,
      child_workflow_id: childWorkflowId,
      attempt_nonce: 1,
      input_digest: digest,
      input,
      runtime: operation.runtime,
    })
    .returning();

  if (!inserted) {
    throw new TestingPersistenceError(409, "Reserved task identity collision");
  }

  await tx.insert(testingDeliveriesTable).values({
    delivery_key: `start:${taskId}`,
    operation_id: operation.id,
    task_id: taskId,
    kind: "start",
  });
  await appendDecision(tx, operation, `dispatch:${role}`, {
    kind: "dispatch",
    role,
    taskId,
    childWorkflowId,
  });

  return frameFrom(inserted);
}

function assertReservable(role: RoleId, decisions: readonly DecisionBody[]) {
  if (decisions.some((decision) => decision.kind === "satisfied" && decision.role === role)) {
    throw new TestingPersistenceError(409, "Satisfied role cannot be reserved");
  }

  if (decisions.some((decision) => decision.kind === "not_required" && decision.role === role)) {
    throw new TestingPersistenceError(409, "Role is not required");
  }

  if (
    role === "planner" &&
    !decisions.some((decision) => decision.kind === "satisfied" && decision.role === "atlassian")
  ) {
    throw new TestingPersistenceError(409, "Planner reservation needs requirements");
  }

  if (
    (role === "ac" || role === "ui") &&
    !decisions.some((decision) => decision.kind === "satisfied" && decision.role === "planner")
  ) {
    throw new TestingPersistenceError(409, "Result reservation needs a plan");
  }
}

function frameFrom(task: TaskRow): RoleFrame {
  return {
    taskId: task.id,
    operationId: task.operation_id,
    role: task.role as RoleId,
    childWorkflowId: task.child_workflow_id,
    attemptNonce: task.attempt_nonce,
    inputDigest: task.input_digest,
    input: task.input,
  };
}

type IoDenial = Extract<ActualIoGuard, { state: "denied" }>;
type TaskUpdate = Partial<typeof testingTasksTable.$inferInsert>;

function denied(reason: IoDenial["reason"]): IoDenial {
  return { state: "denied", reason };
}

function operationDenial(operation: OperationRow): IoDenial | null {
  if (operation.finished_at) {
    return denied("terminal");
  }

  if (operation.cancel_accepted_at) {
    return denied("cancel_requested");
  }

  return operation.deadline.getTime() <= Date.now() ? denied("deadline") : null;
}

function attemptDenial(
  task: TaskRow,
  attemptNonce: number,
  operation: OperationRow,
): IoDenial | null {
  return task.attempt_nonce === attemptNonce ? operationDenial(operation) : denied("nonce");
}

export async function claimActualTask(input: {
  taskId: string;
  attemptNonce: number;
  childWorkflowId: string;
  parentRunId: string;
}): Promise<RoleFrame | ActualIoGuard> {
  const db = await database();

  return db.transaction(async (tx) => {
    const task = await lockTask(tx, input.taskId);
    const operation = await requireOperation(tx, task.operation_id);

    if (
      operation.parent_run_id !== input.parentRunId ||
      task.child_workflow_id !== input.childWorkflowId
    ) {
      return denied("scope");
    }

    return attemptDenial(task, input.attemptNonce, operation) ?? frameFrom(task);
  });
}

function ioScopeDenial(
  task: TaskRow,
  operation: OperationRow,
  input: ActualIoInput,
  parentThreadId: string,
): IoDenial | null {
  if (
    operation.parent_run_id !== input.parentRunId ||
    operation.thread_id !== parentThreadId ||
    task.child_workflow_id !== input.childWorkflowId
  ) {
    return denied("scope");
  }

  return attemptDenial(task, input.attemptNonce, operation);
}

function modelStepUpdate(
  task: TaskRow,
  stepKey: string,
  limits: TestingLimits,
): TaskUpdate | IoDenial {
  const step = callKeySchema.safeParse(stepKey);
  const parsed = modelStepsSchema.safeParse(task.model_steps);

  if (!step.success) {
    throw new TestingPersistenceError(400, "Invalid host model step");
  }

  if (!parsed.success) {
    throw new TestingPersistenceError(409, "Stored model budget is invalid");
  }

  const attempts = parsed.data[step.data] ?? 0;
  const turnsExhausted = attempts === 0 && Object.keys(parsed.data).length >= limits.turns;

  if (turnsExhausted || attempts >= limits.modelAttempts) {
    return denied("budget");
  }

  return { model_steps: { ...parsed.data, [step.data]: attempts + 1 } };
}

function toolCallUpdate(
  task: TaskRow,
  nested: boolean,
  limits: TestingLimits,
): TaskUpdate | IoDenial {
  if (task.native_calls >= limits.tools || (nested && task.nested_calls >= limits.nestedCalls)) {
    return denied("budget");
  }

  return nested
    ? { native_calls: task.native_calls + 1, nested_calls: task.nested_calls + 1 }
    : { native_calls: task.native_calls + 1 };
}

export async function guardActualIOInTransaction(
  tx: Transaction,
  input: ActualIoInput,
  parentThreadId: string,
): Promise<ActualIoGuard> {
  const task = await lockTask(tx, input.taskId);
  const operation = await requireOperation(tx, task.operation_id);
  const denial = ioScopeDenial(task, operation, input, parentThreadId);

  if (denial) {
    return denial;
  }

  const limits = effectiveLimits(frozenRuntime(operation), task.role);
  const budget =
    input.kind === "model"
      ? modelStepUpdate(task, input.step, limits)
      : toolCallUpdate(task, input.kind === "nested", limits);

  if ("state" in budget) {
    return budget;
  }

  const nextSequence = task.io_sequence + 1;
  await tx
    .update(testingTasksTable)
    .set({ io_sequence: nextSequence, ...budget })
    .where(eq(testingTasksTable.id, task.id));

  return { state: "allowed", slot: `${task.id}-io-${nextSequence}` };
}

type ArtifactRow = typeof testingArtifactsTable.$inferSelect;
type ReceiptRow = typeof testingReceiptsTable.$inferSelect;
type ExecutionArtifact = TestingExecution["artifacts"][number];
type ExecutionTask = TestingExecution["tasks"][number];

function pinIntact(
  artifact: ArtifactRow,
  threadId: string,
  metadata: z.infer<typeof metadataSchema>,
  runtime: HostTestingRuntime,
): boolean {
  return (
    artifact.thread_id === threadId &&
    artifact.payload_digest === digestOf(artifact.payload) &&
    metadata.outputDigest === artifact.payload_digest &&
    snapshotMatches(metadata, runtime)
  );
}

function verifiedPin(
  artifact: ArtifactRow,
  threadId: string,
  runtime: HostTestingRuntime,
): ExecutionArtifact {
  const metadata = metadataSchema.safeParse(artifact.metadata);
  const role = roleIdSchema.safeParse(artifact.role);
  const kind = artifactKindSchema.safeParse(artifact.kind);

  if (
    !metadata.success ||
    !role.success ||
    !kind.success ||
    roleRegistry[role.data].artifact !== kind.data ||
    !pinIntact(artifact, threadId, metadata.data, runtime)
  ) {
    throw new TestingPersistenceError(409, "Pinned artifact version or digest mismatch");
  }

  return {
    ref: artifactRefSchema.parse(artifact.ref),
    role: role.data,
    kind: kind.data,
    payload: artifact.payload,
    payloadDigest: artifact.payload_digest,
    scopeDigest: artifact.scope_digest,
    provenance: {
      originalOperationId: artifact.original_operation_id,
      parentRunId: metadata.data.parentRunId,
      producerTaskId: metadata.data.producerTaskId,
      attempt: metadata.data.attempt,
      issuedAt: artifact.created_at.toISOString(),
    },
  };
}

async function pinnedArtifacts(
  tx: Transaction,
  operation: OperationRow,
  runtime: HostTestingRuntime,
): Promise<ExecutionArtifact[]> {
  const pins = await tx
    .select({ ref: testingPinsTable.ref })
    .from(testingPinsTable)
    .where(eq(testingPinsTable.operation_id, operation.id))
    .orderBy(asc(testingPinsTable.ref));
  const artifacts: ExecutionArtifact[] = [];

  for (const pin of pins) {
    artifacts.push(verifiedPin(await artifactByRef(tx, pin.ref), operation.thread_id, runtime));
  }

  return artifacts;
}

function verifiedReceipt(
  row: ReceiptRow,
  task: TaskRow,
  runtime: HostTestingRuntime,
): TestingExecutionReceipt {
  const bindings = receiptBindingsSchema.safeParse(row.bindings);
  const route = z.enum(["direct", "codemode"]).safeParse(row.route);

  if (
    !bindings.success ||
    !route.success ||
    row.input_digest !== digestOf(row.input) ||
    row.output_digest !== digestOf(row.output)
  ) {
    throw new TestingPersistenceError(409, "Stored tool receipt failed verification");
  }

  assertReceiptScope(task, runtime, row.native_name, route.data, row.output, bindings.data);

  return {
    id: row.id,
    taskId: row.task_id,
    attemptNonce: row.attempt,
    slot: row.slot,
    nativeName: row.native_name,
    route: route.data,
    inputDigest: row.input_digest,
    outputDigest: row.output_digest,
    input: row.input,
    output: row.output,
    bindings: bindings.data,
  };
}

async function taskReceipts(
  tx: Transaction,
  task: TaskRow,
  runtime: HostTestingRuntime,
): Promise<TestingExecutionReceipt[]> {
  const rows = await tx
    .select()
    .from(testingReceiptsTable)
    .where(
      and(
        eq(testingReceiptsTable.task_id, task.id),
        eq(testingReceiptsTable.attempt, task.attempt_nonce),
      ),
    )
    .orderBy(asc(testingReceiptsTable.slot), asc(testingReceiptsTable.native_name));

  return rows.map((row) => verifiedReceipt(row, task, runtime));
}

function completedArtifactRef(
  decisions: readonly DecisionBody[],
  taskId: string,
): ArtifactRef | null {
  const result = decisions.find(
    (decision) => decision.kind === "task_result" && decision.taskId === taskId,
  );

  return result?.kind === "task_result" && result.execution === "completed"
    ? artifactRefSchema.parse(result.ref)
    : null;
}

async function taskSnapshot(
  tx: Transaction,
  task: TaskRow,
  operation: OperationRow,
  runtime: HostTestingRuntime,
  decisions: readonly DecisionBody[],
): Promise<ExecutionTask> {
  if (!roleIdSchema.safeParse(task.role).success) {
    throw new TestingPersistenceError(409, "Stored testing task has an invalid role");
  }

  if (!isDeepStrictEqual(task.runtime, operation.runtime)) {
    throw new TestingPersistenceError(409, "Task runtime does not match its operation");
  }

  const receipts = await taskReceipts(tx, task, runtime);

  return {
    frame: frameFrom(task),
    observations: await readObservations(tx, task.id),
    receipts,
    artifactRef: completedArtifactRef(decisions, task.id),
  };
}

async function taskSnapshots(
  tx: Transaction,
  operation: OperationRow,
  runtime: HostTestingRuntime,
  decisions: readonly DecisionBody[],
): Promise<ExecutionTask[]> {
  const tasks = await tx
    .select()
    .from(testingTasksTable)
    .where(eq(testingTasksTable.operation_id, operation.id))
    .orderBy(asc(testingTasksTable.created_at));
  const snapshots: ExecutionTask[] = [];

  for (const task of tasks) {
    snapshots.push(await taskSnapshot(tx, task, operation, runtime, decisions));
  }

  return snapshots;
}

export async function readTestingExecutionInTransaction(
  tx: Transaction,
  ownerRunId: string,
  ownerThreadId: string,
  operationId: string,
): Promise<TestingExecution> {
  const operation = await requireOperation(tx, operationId);
  assertOwner(operation, ownerRunId);

  if (operation.thread_id !== ownerThreadId) {
    throw new TestingPersistenceError(409, "Testing operation thread mismatch");
  }

  const { mode, ...runtime } = frozenRuntime(operation);
  assertHostRuntime(runtime);
  const intent = testingIntentSchema.parse(operation.intent);
  const decisions = await readDecisions(tx, operation.id);
  const artifacts = await pinnedArtifacts(tx, operation, runtime);
  const tasks = await taskSnapshots(tx, operation, runtime, decisions);

  return {
    operationId: operation.id,
    parentRunId: operation.parent_run_id,
    threadId: operation.thread_id,
    mode,
    intent,
    runtime,
    deadline: operation.deadline.toISOString(),
    cancelRequested: operation.cancel_accepted_at !== null,
    finished: operation.finished_at !== null,
    decisions,
    artifacts,
    tasks,
  };
}

export async function appendTrustedObservation(input: {
  taskId: string;
  attemptNonce: number;
  key: string;
  body: unknown;
}): Promise<{ seq: number; duplicate: boolean }> {
  const parsed = observationSchema.safeParse(input.body);

  if (!parsed.success || !callKeySchema.safeParse(input.key).success) {
    throw new TestingPersistenceError(400, "Invalid testing observation");
  }

  const bytes = Buffer.byteLength(JSON.stringify(parsed.data));
  const db = await database();

  return db.transaction(async (tx) => {
    const task = await lockTask(tx, input.taskId);
    const operation = await requireOperation(tx, task.operation_id);

    if (operation.finished_at) {
      throw new TestingPersistenceError(409, "Testing operation is terminal");
    }

    if (task.attempt_nonce !== input.attemptNonce) {
      throw new TestingPersistenceError(409, "Observation nonce mismatch");
    }

    const [prior] = await tx
      .select()
      .from(testingObservationsTable)
      .where(
        and(
          eq(testingObservationsTable.task_id, task.id),
          eq(testingObservationsTable.observation_key, input.key),
        ),
      );

    if (prior) {
      if (!isDeepStrictEqual(prior.safe_body, parsed.data)) {
        throw new TestingPersistenceError(409, "Observation key collision");
      }

      return { seq: prior.seq, duplicate: true };
    }

    const existing = await tx
      .select()
      .from(testingObservationsTable)
      .where(eq(testingObservationsTable.task_id, task.id));
    const limits = effectiveLimits(frozenRuntime(operation), task.role);
    const used = existing.reduce((sum, row) => sum + row.bytes, 0);

    if (existing.length + 1 > limits.observationEntries || used + bytes > limits.observationBytes) {
      throw new TestingPersistenceError(409, "Observation bound exceeded");
    }

    const seq = existing.reduce((max, row) => Math.max(max, row.seq), -1) + 1;
    await tx.insert(testingObservationsTable).values({
      task_id: task.id,
      attempt: input.attemptNonce,
      seq,
      observation_key: input.key,
      safe_body: parsed.data,
      bytes,
    });

    return { seq, duplicate: false };
  });
}

function storedJson(value: unknown): unknown {
  if (value === undefined) {
    throw new TestingPersistenceError(400, "Testing receipt must be JSON");
  }

  const json = JSON.stringify(value);

  if (json === undefined) {
    throw new TestingPersistenceError(400, "Testing receipt must be JSON");
  }

  return JSON.parse(json) as unknown;
}

function rawFigmaOutput(output: unknown): boolean {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return false;
  }

  const record = output as Record<string, unknown>;

  return Array.isArray(record.nodes) || typeof record.truncated === "boolean";
}

async function assertDerivedLink(
  tx: Transaction,
  task: TaskRow,
  slot: string,
  bindings: z.infer<typeof receiptBindingsSchema>,
) {
  const [native] = await tx
    .select()
    .from(testingReceiptsTable)
    .where(
      and(
        eq(testingReceiptsTable.task_id, task.id),
        eq(testingReceiptsTable.attempt, task.attempt_nonce),
        eq(testingReceiptsTable.slot, slot),
        eq(testingReceiptsTable.native_name, bindings.nativeName ?? ""),
      ),
    );

  if (
    !native ||
    native.output_digest !== bindings.nativeOutputDigest ||
    native.output_digest !== digestOf(native.output) ||
    native.input_digest !== digestOf(native.input)
  ) {
    throw new TestingPersistenceError(409, "Derived receipt is not linked to its native response");
  }
}

type ReceiptBindings = z.infer<typeof receiptBindingsSchema>;

function designCaptureValid(
  task: TaskRow,
  route: "direct" | "codemode",
  output: unknown,
  bindings: ReceiptBindings,
): boolean {
  return (
    route === "direct" &&
    Boolean(bindings.nativeName && bindings.nativeOutputDigest) &&
    designCaptureSchema.safeParse(output).success &&
    task.role === "ui"
  );
}

function sameFixture(
  fixture: Readonly<{ id: string; version: string }> | undefined,
  runtime: HostTestingRuntime,
): boolean {
  return fixture?.id === runtime.fixture.id && fixture.version === runtime.fixture.version;
}

const browserNativeByRole = { ac: "verify_ac", ui: "verify_ui" } as const;
const browserEvidenceKindByRole = { ac: "functional", ui: "style" } as const;

function isBrowserReceiptNative(nativeName: string): boolean {
  return nativeName === "use_browser" || nativeName === "verify_ac" || nativeName === "verify_ui";
}

function browserEvidenceMatches(
  role: "ac" | "ui",
  checkId: string,
  evidence: BrowserOutput["evidence"],
  bindings: ReceiptBindings,
): boolean {
  return (
    evidence.kind === browserEvidenceKindByRole[role] &&
    checkId === bindings.checkId &&
    evidence.checkId === bindings.checkId &&
    evidence.origin === "browser" &&
    evidence.browser !== undefined
  );
}

function browserReceiptValid(
  task: TaskRow,
  runtime: HostTestingRuntime,
  output: unknown,
  bindings: ReceiptBindings,
): boolean {
  if (task.role !== "ac" && task.role !== "ui") {
    return false;
  }

  const parsed = browserOutputSchema.safeParse(output);

  if (!parsed.success) {
    return false;
  }

  return (
    browserEvidenceMatches(task.role, parsed.data.checkId, parsed.data.evidence, bindings) &&
    sameFixture(bindings.fixture, runtime) &&
    sameFixture(parsed.data.evidence.fixture, runtime) &&
    parsed.data.evidence.adapterVersion === runtime.versions.adapter
  );
}

function figmaReceiptValid(task: TaskRow, output: unknown): boolean {
  return (
    task.role === "ui" && rawFigmaOutput(output) && !designCaptureSchema.safeParse(output).success
  );
}

function browserScopeError(
  task: TaskRow,
  runtime: HostTestingRuntime,
  nativeName: string,
  output: unknown,
  bindings: ReceiptBindings,
): string | null {
  const role = task.role === "ac" || task.role === "ui" ? task.role : "ui";

  if (nativeName !== "use_browser" && nativeName !== browserNativeByRole[role]) {
    return "Browser tool does not match role";
  }

  return browserReceiptValid(task, runtime, output, bindings)
    ? null
    : "Browser receipt is outside the host scope";
}

function receiptScopeError(
  task: TaskRow,
  runtime: HostTestingRuntime,
  nativeName: string,
  route: "direct" | "codemode",
  output: unknown,
  bindings: ReceiptBindings,
): string | null {
  if (nativeName === DESIGN_CAPTURE_NATIVE) {
    return designCaptureValid(task, route, output, bindings)
      ? null
      : "Design capture is a private host receipt";
  }

  if (task.role === "planner") {
    return "Planner has no external receipt scope";
  }

  if (isBrowserReceiptNative(nativeName)) {
    return browserScopeError(task, runtime, nativeName, output, bindings);
  }

  if (nativeName === "get_figma") {
    return figmaReceiptValid(task, output) ? null : "Figma receipt is outside the host scope";
  }

  return task.role === "atlassian" ? null : "Receipt is outside the role scope";
}

function assertReceiptScope(
  task: TaskRow,
  runtime: HostTestingRuntime,
  nativeName: string,
  route: "direct" | "codemode",
  output: unknown,
  bindings: ReceiptBindings,
) {
  const error = receiptScopeError(task, runtime, nativeName, route, output, bindings);

  if (error) {
    throw new TestingPersistenceError(409, error);
  }
}

function assertReceiptFence(operation: OperationRow, task: TaskRow, attemptNonce: number) {
  if (operation.finished_at || operation.cancel_accepted_at) {
    throw new TestingPersistenceError(409, "Testing receipt fence is closed");
  }

  if (task.attempt_nonce !== attemptNonce) {
    throw new TestingPersistenceError(409, "Receipt nonce mismatch");
  }
}

function sameReceipt(
  prior: ReceiptRow,
  taskId: string,
  outputDigest: string,
  inputDigest: string,
): boolean {
  return (
    prior.task_id === taskId &&
    prior.output_digest === outputDigest &&
    prior.input_digest === inputDigest
  );
}

export async function appendTrustedReceipt(input: {
  id: string;
  taskId: string;
  attemptNonce: number;
  slot: string;
  nativeName: string;
  route: "direct" | "codemode";
  input: unknown;
  output: unknown;
  bindings: unknown;
}): Promise<{ outputDigest: string; duplicate: boolean }> {
  const bindings = receiptBindingsSchema.safeParse(input.bindings);

  if (!bindings.success || !callKeySchema.safeParse(input.id).success) {
    throw new TestingPersistenceError(400, "Invalid testing receipt");
  }

  const storedInput = storedJson(input.input);
  const storedOutput = storedJson(input.output);
  const outputDigest = digestOf(storedOutput);
  const inputDigest = digestOf(storedInput);
  const db = await database();

  return db.transaction(async (tx) => {
    const task = await lockTask(tx, input.taskId);
    const operation = await requireOperation(tx, task.operation_id);
    assertReceiptFence(operation, task, input.attemptNonce);
    const [prior] = await tx
      .select()
      .from(testingReceiptsTable)
      .where(eq(testingReceiptsTable.id, input.id));

    if (prior) {
      if (!sameReceipt(prior, task.id, outputDigest, inputDigest)) {
        throw new TestingPersistenceError(409, "Receipt identity collision");
      }

      return { outputDigest, duplicate: true };
    }

    const decisions = await readDecisions(tx, operation.id);

    if (
      (task.role === "ac" || task.role === "ui") &&
      decisions.some((decision) => decision.kind === "task_result" && decision.taskId === task.id)
    ) {
      throw new TestingPersistenceError(409, "Testing receipt fence is closed");
    }

    assertReceiptScope(
      task,
      frozenRuntime(operation),
      input.nativeName,
      input.route,
      storedOutput,
      bindings.data,
    );

    if (input.nativeName === DESIGN_CAPTURE_NATIVE) {
      await assertDerivedLink(tx, task, input.slot, bindings.data);
    }

    await tx.insert(testingReceiptsTable).values({
      id: input.id,
      task_id: task.id,
      attempt: input.attemptNonce,
      slot: input.slot,
      native_name: input.nativeName,
      route: input.route,
      input_digest: inputDigest,
      output_digest: outputDigest,
      input: storedInput,
      output: storedOutput,
      bindings: readSource(input.nativeName, storedInput)
        ? { ...bindings.data, capturedAt: new Date().toISOString() }
        : bindings.data,
    });

    return { outputDigest, duplicate: false };
  });
}

export type RoleCompletion =
  | Readonly<{ role: "atlassian" }>
  | Readonly<{ role: "planner"; proposal: unknown }>
  | Readonly<{ role: "ac" | "ui"; findings: string | null }>;

type Candidate = Readonly<{
  kind: ArtifactKind;
  payload: Requirements | CanonicalPlan | Results;
  digest: string;
  scopeDigest: string;
  dependencies: string[];
}>;

type ReplayedCandidate = Pick<Candidate, "kind" | "digest">;

function committedRequirements(artifact: ArtifactRow): ReplayedCandidate | null {
  return requirementsPayloadSchema.safeParse(artifact.payload).success
    ? { kind: "requirements", digest: digestOf(artifact.payload) }
    : null;
}

async function replayCompletion(
  tx: Transaction,
  operation: OperationRow,
  task: TaskRow,
  completion: RoleCompletion,
  priorRef: string,
): Promise<{ ref: ArtifactRef; kind: ArtifactKind }> {
  const runtime = frozenRuntime(operation);
  const artifact = await artifactByRef(tx, priorRef);
  const metadata = metadataSchema.safeParse(artifact.metadata);
  const replayed =
    completion.role === "atlassian"
      ? committedRequirements(artifact)
      : await validateCandidate(tx, operation, task, completion, runtime);

  if (
    !replayed ||
    artifact.payload_digest !== digestOf(artifact.payload) ||
    !replayedCandidateMatches(replayed, artifact, metadata, runtime)
  ) {
    throw new TestingPersistenceError(409, "Task result version mismatch");
  }

  return { ref: artifactRefSchema.parse(priorRef), kind: replayed.kind };
}

function replayedCandidateMatches(
  candidate: ReplayedCandidate,
  artifact: ArtifactRow,
  metadata: ReturnType<typeof metadataSchema.safeParse>,
  runtime: HostTestingRuntime,
): boolean {
  return (
    candidate.kind === artifact.kind &&
    candidate.digest === artifact.payload_digest &&
    metadata.success &&
    metadata.data.outputDigest === artifact.payload_digest &&
    snapshotMatches(metadata.data, runtime, PRODUCER_KEYS)
  );
}

async function storeCandidate(
  tx: Transaction,
  operation: OperationRow,
  task: TaskRow,
  accepted: Candidate,
  runtime: HostTestingRuntime,
): Promise<ArtifactRef> {
  const ref = artifactRefSchema.parse(
    `art-${createHash("sha256").update(`${operation.id}\0${task.role}\0${accepted.digest}`).digest("hex").slice(0, 40)}`,
  );
  const metadata: ArtifactMetadata = {
    dependencies: accepted.dependencies,
    versions: runtime.versions,
    profiles: runtime.profiles,
    registration: runtime.registration,
    fixture: runtime.fixture,
    parentRunId: operation.parent_run_id,
    producerTaskId: task.id,
    attempt: task.attempt_nonce,
    inputDigest: task.input_digest,
    outputDigest: accepted.digest,
  };
  await tx.insert(testingArtifactsTable).values({
    ref,
    thread_id: operation.thread_id,
    original_operation_id: operation.id,
    role: task.role,
    kind: accepted.kind,
    scope_digest: accepted.scopeDigest,
    payload_digest: accepted.digest,
    metadata,
    payload: accepted.payload,
    validation_receipt: { issues: [], acceptedAt: new Date().toISOString() },
  });
  await tx.insert(testingPinsTable).values({ operation_id: operation.id, ref });

  return ref;
}

async function recordCandidateDecisions(
  tx: Transaction,
  operation: OperationRow,
  task: TaskRow,
  accepted: Candidate,
  ref: ArtifactRef,
  completion: RoleCompletion,
) {
  await appendDecision(tx, operation, `task_result:${task.role}`, {
    kind: "task_result",
    role: task.role as RoleId,
    taskId: task.id,
    execution: "completed",
    ref,
    ...("findings" in completion ? { findings: completion.findings } : {}),
  });
  await appendDecision(tx, operation, `satisfied:${task.role}`, {
    kind: "satisfied",
    role: task.role as RoleId,
    ref,
    origin: "produced",
  });

  for (const role of accepted.kind === "plan" ? unassignedRoles(accepted.payload) : []) {
    await appendDecision(tx, operation, `not_required:${role}`, {
      kind: "not_required",
      role,
      reason: NOT_REQUIRED_REASON[role],
    });
  }
}

export async function acceptRoleCompletionInTransaction(
  tx: Transaction,
  ownerRunId: string,
  taskId: string,
  completion: RoleCompletion,
): Promise<{ ref: ArtifactRef; kind: ArtifactKind }> {
  const task = await lockTask(tx, taskId);
  const operation = await requireOperation(tx, task.operation_id);
  assertOwner(operation, ownerRunId);

  if (operation.finished_at || operation.cancel_accepted_at) {
    throw new TestingPersistenceError(409, "Testing accept fence is closed");
  }

  if (completion.role !== task.role) {
    throw new TestingPersistenceError(409, "Completion role does not match its task");
  }

  const decisions = await readDecisions(tx, operation.id);
  const prior = decisions.find(
    (decision) => decision.kind === "task_result" && decision.taskId === task.id,
  );

  if (prior?.kind === "task_result") {
    if (prior.execution !== "completed") {
      throw new TestingPersistenceError(409, "Task result is already decided");
    }

    if ("findings" in completion && completion.findings !== prior.findings) {
      throw new TestingPersistenceError(409, "Task result version mismatch");
    }

    return replayCompletion(tx, operation, task, completion, prior.ref);
  }

  const runtime = frozenRuntime(operation);
  const accepted = await validateCandidate(tx, operation, task, completion, runtime);
  const ref = await storeCandidate(tx, operation, task, accepted, runtime);
  await recordCandidateDecisions(tx, operation, task, accepted, ref, completion);

  return { ref, kind: accepted.kind };
}

function acceptedOrThrow<T>(validation: Validation<T>): T {
  if (validation.kind === "rejected") {
    throw new TestingPersistenceError(400, validation.issues.join("; "));
  }

  return validation.value;
}

async function requirementsCandidate(
  tx: Transaction,
  task: TaskRow,
  intent: TestingRequestInput,
  runtime: HostTestingRuntime,
): Promise<Candidate> {
  const payload = acceptedOrThrow(
    assembleRequirements(intent, await taskReceipts(tx, task, runtime)),
  );

  return {
    kind: "requirements",
    payload,
    digest: digestOf(payload),
    scopeDigest: requirementsScopeDigest({ goal: intent.goal, sources: intent.sources }),
    dependencies: [],
  };
}

function planCandidate(
  requirements: ArtifactRow | undefined,
  intent: TestingRequestInput,
  proposal: unknown,
): Candidate {
  if (!requirements) {
    throw new TestingPersistenceError(409, "Plan candidate needs requirements");
  }

  const design = intent.design ?? null;
  const payload = acceptedOrThrow(
    canonicalizePlan(proposal, {
      requirementsDigest: requirements.payload_digest,
      goal: intent.goal,
      targetUrl: intent.targetUrl,
      design,
    }),
  );

  return {
    kind: "plan",
    payload,
    digest: digestOf(payload),
    scopeDigest: planScopeDigest({
      goal: intent.goal,
      targetUrl: intent.targetUrl,
      design,
      requirementsDigest: requirements.payload_digest,
    }),
    dependencies: [requirements.ref],
  };
}

async function resultsCandidate(
  tx: Transaction,
  operation: OperationRow,
  task: TaskRow,
): Promise<Candidate> {
  const plan = await satisfiedPayload(tx, operation.id, "planner");

  if (!plan) {
    throw new TestingPersistenceError(409, "Result candidate needs a plan");
  }

  const canonical = plan.payload as CanonicalPlan;
  const role = task.role === "ac" ? "ac" : "ui";
  const receipts = (await readTrustedReceipts(tx, task)).filter((receipt) => receipt.role === role);
  const payload = assembleToolResults({
    role,
    cases: canonical.cases,
    receipts,
  });

  return {
    kind: role === "ac" ? "ac-result" : "ui-result",
    payload,
    digest: digestOf(payload),
    scopeDigest: digestOf({
      operationId: operation.id,
      taskId: task.id,
      planDigest: plan.payload_digest,
      role,
    }),
    dependencies: [plan.ref],
  };
}

async function validateCandidate(
  tx: Transaction,
  operation: OperationRow,
  task: TaskRow,
  completion: RoleCompletion,
  runtime: HostTestingRuntime,
): Promise<Candidate> {
  const intent = testingIntentSchema.parse(operation.intent);

  if (completion.role === "atlassian") {
    return requirementsCandidate(tx, task, intent, runtime);
  }

  if (completion.role === "planner") {
    const requirements = await satisfiedPayload(tx, operation.id, "atlassian");

    return planCandidate(requirements, intent, completion.proposal);
  }

  return resultsCandidate(tx, operation, task);
}

async function satisfiedPayload(tx: Transaction, operationId: string, role: RoleId) {
  const decisions = await readDecisions(tx, operationId);
  const satisfied = decisions.find(
    (decision) => decision.kind === "satisfied" && decision.role === role,
  );

  if (!satisfied || satisfied.kind !== "satisfied") {
    return undefined;
  }

  return artifactByRef(tx, satisfied.ref);
}

async function artifactByRef(tx: Transaction, ref: string) {
  const [artifact] = await tx
    .select()
    .from(testingArtifactsTable)
    .where(eq(testingArtifactsTable.ref, ref));

  if (!artifact) {
    throw new TestingPersistenceError(404, "Pinned artifact is missing");
  }

  return artifact;
}

function browserProjectionMatches(
  output: BrowserOutput,
  bindings: ReceiptBindings,
  role: "ac" | "ui",
): boolean {
  const { evidence } = output;

  return (
    evidence.kind === browserEvidenceKindByRole[role] &&
    output.checkId === bindings.checkId &&
    evidence.checkId === bindings.checkId
  );
}

function trustedBrowserReceipt(row: ReceiptRow, role: "ac" | "ui"): TrustedToolReceipt | undefined {
  const output = browserOutputSchema.safeParse(row.output);
  const bindings = receiptBindingsSchema.safeParse(row.bindings);

  if (!output.success || !bindings.success || !bindings.data.fixture) {
    return undefined;
  }

  if (row.native_name !== "use_browser" && row.native_name !== browserNativeByRole[role]) {
    return undefined;
  }

  if (!browserProjectionMatches(output.data, bindings.data, role)) {
    return undefined;
  }

  if (row.output_digest !== digestOf(row.output)) {
    return undefined;
  }

  return {
    id: row.id,
    role,
    checkId: output.data.checkId,
    inputDigest: row.input_digest,
    outputDigest: row.output_digest,
    output: row.output,
    fixture: bindings.data.fixture,
  };
}

async function readTrustedReceipts(tx: Transaction, task: TaskRow): Promise<TrustedToolReceipt[]> {
  const rows = await tx
    .select()
    .from(testingReceiptsTable)
    .where(
      and(
        eq(testingReceiptsTable.task_id, task.id),
        eq(testingReceiptsTable.attempt, task.attempt_nonce),
      ),
    )
    .orderBy(asc(testingReceiptsTable.id));
  const role = task.role === "ac" || task.role === "ui" ? task.role : null;

  if (!role) {
    return [];
  }

  return rows.flatMap((row) => {
    const receipt = trustedBrowserReceipt(row, role);

    return receipt ? [receipt] : [];
  });
}

export async function publishProjectionInTransaction(
  tx: Transaction,
  ownerRunId: string,
  operationId: string,
  append: AppendTestingEvent,
): Promise<TestView> {
  const operation = await requireOperation(tx, operationId);
  assertOwner(operation, ownerRunId);

  return publishOperation(tx, operation, append, operation.terminal_outcome);
}

export async function closeTestingInTransaction(
  tx: Transaction,
  ownerRunId: string,
  operationId: string,
  rootOutcome: RootRunOutcome,
  append: AppendTestingEvent,
): Promise<TestView> {
  const operation = await requireOperation(tx, operationId);
  assertOwner(operation, ownerRunId);
  const outcome = operation.cancel_accepted_at ? "cancelled" : rootOutcome;

  if (!operation.finished_at) {
    if (isProseOperation(operation)) {
      const tasks = await tx
        .select()
        .from(testingTasksTable)
        .where(eq(testingTasksTable.operation_id, operation.id));
      const decisions = await readDecisions(tx, operation.id);
      const unsettled = tasks.filter(
        (task) =>
          (task.role === "ac" || task.role === "ui") &&
          !decisions.some(
            (decision) => decision.kind === "task_result" && decision.taskId === task.id,
          ),
      );

      for (const task of unsettled) {
        await recordRoleFailureInTransaction(
          tx,
          ownerRunId,
          task.id,
          outcome === "cancelled" ? "cancelled" : "child_failed",
        );
      }
    }

    await tx
      .update(testingOperationsTable)
      .set({ finished_at: sql`now()`, terminal_outcome: outcome })
      .where(eq(testingOperationsTable.id, operation.id));
    operation.finished_at = new Date();
    operation.terminal_outcome = outcome;
    await appendDecision(tx, operation, `terminal:${outcome}`, {
      kind: "terminal",
      outcome,
      reasonCode: outcome,
    });
  }

  return publishOperation(tx, operation, append, operation.terminal_outcome);
}

async function operationMarkersQuiet(tx: Transaction, operationId: string): Promise<boolean> {
  const tasks = await tx
    .select()
    .from(testingTasksTable)
    .where(eq(testingTasksTable.operation_id, operationId));
  const deliveries = await tx
    .select()
    .from(testingDeliveriesTable)
    .where(eq(testingDeliveriesTable.operation_id, operationId));

  return tasks.every((task) => {
    const start = deliveries.find(
      (delivery) => delivery.task_id === task.id && delivery.kind === "start",
    );
    const cancel = deliveries.find(
      (delivery) => delivery.task_id === task.id && delivery.kind === "cancel",
    );

    return start?.acknowledgement === "quiet" && (!cancel || cancel.acknowledgement === "stopped");
  });
}

export async function ensureTestingCancelDeliveries(operationId: string): Promise<void> {
  const db = await database();
  await db.transaction(async (tx) => {
    const operation = await requireOperation(tx, operationId);

    if (!operation.cancel_accepted_at || operation.finished_at) {
      return;
    }

    const tasks = await tx
      .select()
      .from(testingTasksTable)
      .where(eq(testingTasksTable.operation_id, operation.id));
    await ensureCancelDeliveries(tx, operation.id, tasks);
  });
}

export async function closeUnfinishedTesting(
  tx: Transaction,
  parentRunId: string,
  rootOutcome: RootRunOutcome,
  append: AppendTestingEvent,
): Promise<void> {
  const operations = await tx
    .select()
    .from(testingOperationsTable)
    .where(
      and(
        eq(testingOperationsTable.parent_run_id, parentRunId),
        sql`${testingOperationsTable.finished_at} is null`,
      ),
    )
    .for("update");

  for (const operation of operations) {
    if (!(await operationMarkersQuiet(tx, operation.id))) {
      throw new TestingPersistenceError(409, "Testing producers are not quiet");
    }

    await closeTestingInTransaction(tx, parentRunId, operation.id, rootOutcome, append);
  }
}

async function publishOperation(
  tx: Transaction,
  operation: OperationRow,
  append: AppendTestingEvent,
  forcedOutcome: string | null,
): Promise<TestView> {
  const [latest] = await tx
    .select()
    .from(testingPublicationsTable)
    .where(eq(testingPublicationsTable.operation_id, operation.id))
    .orderBy(desc(testingPublicationsTable.version))
    .limit(1);
  const version = latest ? latest.version + 1 : 0;
  const snapshot = await projectionSnapshot(tx, operation, forcedOutcome, version);

  const retained = retainedPublication(latest, operation, snapshot);

  if (retained) {
    return retained;
  }

  const key = `testing:${operation.id}:v${version}`;
  const event = testingProjectionEvent(snapshot.view);
  const sequence = await append(key, event);
  await tx.insert(testingPublicationsTable).values({
    operation_id: operation.id,
    version,
    root_event_key: key,
    public_sequence: sequence,
    view: snapshot.view,
    cursors: snapshot.cursors,
  });
  await tx
    .update(testingOperationsTable)
    .set({ writer_nonce: version })
    .where(eq(testingOperationsTable.id, operation.id));

  return snapshot.view;
}

function retainedPublication(
  latest: typeof testingPublicationsTable.$inferSelect | undefined,
  operation: OperationRow,
  snapshot: { view: TestView; cursors: Record<string, unknown> },
): TestView | null {
  const view = latest ? parseTestView(latest.view) : null;

  if (!latest || !view) {
    return null;
  }

  const finished = operation.finished_at && (latest.cursors as { finished?: boolean }).finished;

  if (finished || isDeepStrictEqual(latest.cursors, snapshot.cursors)) {
    return enrichTaskOrigin(view, snapshot.view.task?.origin ?? null);
  }

  return null;
}

async function taskObservations(
  tx: Transaction,
  tasks: readonly TaskRow[],
): Promise<{ observations: Map<string, ObservationBody[]>; cursors: Record<string, number> }> {
  const observations = new Map<string, ObservationBody[]>();
  const cursors: Record<string, number> = {};

  for (const task of tasks) {
    const bodies = await readObservations(tx, task.id);
    observations.set(task.id, bodies);
    cursors[task.id] = bodies.length - 1;
  }

  return { observations, cursors };
}

function lifecycle(
  report: PublicTestReport | null,
  cancelling: boolean,
):
  | Readonly<{ state: "finished"; report: PublicTestReport }>
  | Readonly<{ state: "cancelling" | "active"; report: null }> {
  if (report) {
    return { state: "finished", report };
  }

  return { state: cancelling ? "cancelling" : "active", report: null };
}

async function projectionSnapshot(
  tx: Transaction,
  operation: OperationRow,
  forcedOutcome: string | null,
  version: number,
): Promise<{ view: TestView; cursors: Record<string, unknown> }> {
  const decisions = await readDecisions(tx, operation.id);
  const tasks = await tx
    .select()
    .from(testingTasksTable)
    .where(eq(testingTasksTable.operation_id, operation.id));
  const pins = await tx
    .select()
    .from(testingPinsTable)
    .where(eq(testingPinsTable.operation_id, operation.id));
  const artifacts = await Promise.all(pins.map((pin) => artifactByRef(tx, pin.ref)));
  const { observations, cursors } = await taskObservations(tx, tasks);
  const requirements = artifactPayload(artifacts, "requirements") as Requirements | null;
  const plan = artifactPayload(artifacts, "plan") as CanonicalPlan | null;
  const reuse = decisions.flatMap((decision) =>
    decision.kind === "reuse" ? [decision.decision] : [],
  );
  const available = artifacts
    .filter((artifact) => artifact.kind === "requirements" || artifact.kind === "plan")
    .map((artifact) => artifactRefSchema.parse(artifact.ref));
  const finished = Boolean(operation.finished_at);
  const cancelling = Boolean(operation.cancel_accepted_at) && !finished;
  const outcomes = roleOutcomes(decisions, tasks, observations, cancelling || finished);
  const intent = testingIntentSchema.parse(operation.intent);
  const runId = testRunIdSchema.parse(intent.task ? operation.id : operation.parent_run_id);
  const report = completedProjectionReport(operation, intent, forcedOutcome, {
    runId,
    requirements,
    plan,
    artifacts,
    version,
    outcomes,
  });
  const origins = intent.task
    ? await taskOrigins(tx, [operation])
    : new Map<string, TaskMessageOrigin | null>();
  const view: TestView = {
    runId,
    progress: projectProgress(version, outcomes, plan),
    reuse,
    availableArtifacts: available,
    ...(intent.task
      ? taskProjection(
          intent.task,
          artifacts,
          operation,
          origins.get(operation.id) ?? null,
          decisions,
          plan,
        )
      : lifecycle(report, cancelling)),
  };

  return {
    view,
    cursors: {
      tasks: cursors,
      decisions: decisions.length,
      cancel: Boolean(operation.cancel_accepted_at),
      finished,
      outcome: forcedOutcome,
    },
  };
}

function completedProjectionReport(
  operation: OperationRow,
  intent: TestingRequestInput,
  forcedOutcome: string | null,
  snapshot: {
    runId: TestView["runId"];
    requirements: Requirements | null;
    plan: CanonicalPlan | null;
    artifacts: ArtifactRow[];
    version: number;
    outcomes: ReturnType<typeof roleOutcomes>;
  },
): PublicTestReport | null {
  if (!operation.finished_at || intent.task) {
    return null;
  }

  return deriveReport({
    runId: snapshot.runId,
    rootOutcome: (forcedOutcome ?? operation.terminal_outcome ?? "failed") as RootRunOutcome,
    requirements: snapshot.requirements,
    plan: snapshot.plan,
    acResults: artifactPayload(snapshot.artifacts, "ac-result") as Results | null,
    uiResults: artifactPayload(snapshot.artifacts, "ui-result") as Results | null,
    unresolvedSources: unresolvedFrom(snapshot.requirements, operation.intent),
    artifacts: snapshot.artifacts.map((artifact) => artifactRefSchema.parse(artifact.ref)),
    progressVersion: snapshot.version,
    outcomes: snapshot.outcomes,
  });
}

function qaTaskFacts(
  result: NonNullable<TestView["task"]>["result"],
  assigned: readonly string[],
  decision: DecisionBody | undefined,
) {
  const qaResult = result?.kind === "ac-result" || result?.kind === "ui-result" ? result : null;
  const observations = qaResult?.payload ?? [];
  const observed = new Set(observations.map((check) => check.checkId));
  const conflictingChecks = [...observed].filter(
    (id) =>
      new Set(
        observations
          .filter((check) => check.checkId === id)
          .flatMap((check) => check.evidence.map((evidence) => evidence.outcome)),
      ).size > 1,
  );

  return {
    findings:
      decision?.kind === "task_result" && decision.execution === "completed"
        ? (decision.findings ?? null)
        : null,
    missingChecks: assigned.filter((id) => !observed.has(id)),
    conflictingChecks,
    result: qaResult,
  };
}

function taskProjection(
  task: NonNullable<TestingRequestInput["task"]>,
  artifacts: readonly ArtifactRow[],
  operation: OperationRow,
  origin: TaskMessageOrigin | null,
  decisions: readonly DecisionBody[],
  plan: CanonicalPlan | null,
) {
  const role = task.input.role;
  const result = taskArtifact(artifacts, role, operation.id);
  const decision = decisions.find((item) => item.kind === "task_result" && item.role === role);
  const qa = (role === "ac" || role === "ui") && isProseOperation(operation);
  const projectedTask: NonNullable<TestView["task"]> = qa
    ? {
        version: 3,
        origin,
        role,
        summary: task.input.summary,
        ...qaTaskFacts(result, plan?.assignments[role] ?? [], decision),
      }
    : {
        version: 2,
        origin,
        role,
        summary: task.input.summary,
        result,
      };

  return {
    task: projectedTask,
    state: operation.finished_at
      ? ("finished" as const)
      : operation.cancel_accepted_at
        ? ("cancelling" as const)
        : ("active" as const),
    report: null,
  };
}

function taskArtifact(artifacts: readonly ArtifactRow[], role: RoleId, operationId: string) {
  const artifact = artifacts.find(
    (item) => item.role === role && item.original_operation_id === operationId,
  );

  return artifact ? publicTaskArtifact({ ...artifact, kind: artifact.kind as ArtifactKind }) : null;
}

function artifactPayload(
  artifacts: readonly (typeof testingArtifactsTable.$inferSelect)[],
  kind: ArtifactKind,
): unknown {
  return artifacts.find((artifact) => artifact.kind === kind)?.payload ?? null;
}

function unresolvedFrom(requirements: Requirements | null, intent: unknown): readonly Source[] {
  if (requirements) {
    return [];
  }

  const parsed = testingIntentSchema.safeParse(intent);

  return parsed.success ? parsed.data.sources : [];
}

function reusedOutcome(role: RoleId, decisions: readonly DecisionBody[]): RoleOutcome | null {
  const reused = decisions.find(
    (decision) =>
      decision.kind === "reuse" &&
      decision.decision.kind === "accepted" &&
      decision.decision.artifactKind === artifactKindFor(role),
  );

  return reused?.kind === "reuse" && reused.decision.kind === "accepted"
    ? { kind: "reused", artifact: reused.decision.ref, provenance: reused.decision.provenance }
    : null;
}

function notRequiredOutcome(role: RoleId, decisions: readonly DecisionBody[]): RoleOutcome | null {
  const notRequired = decisions.find(
    (decision) => decision.kind === "not_required" && decision.role === role,
  );

  return notRequired?.kind === "not_required"
    ? { kind: "not_required", reason: notRequired.reason }
    : null;
}

function resultOutcome(role: RoleId, decisions: readonly DecisionBody[]): RoleOutcome | null {
  const result = decisions.find(
    (decision) => decision.kind === "task_result" && decision.role === role,
  );

  if (result?.kind !== "task_result") {
    return null;
  }

  return result.execution === "completed"
    ? { kind: "terminal", outcome: "completed", reasonCode: "completed" }
    : {
        kind: "terminal",
        outcome: result.execution,
        reasonCode: result.reasonCode,
        ...(result.issues ? { issues: result.issues } : {}),
      };
}

function dependencyPending(role: RoleId, decisions: readonly DecisionBody[]): boolean {
  if (role === "atlassian") {
    return false;
  }

  const dependency = role === "planner" ? "atlassian" : "planner";

  return !decisions.some(
    (decision) => decision.kind === "satisfied" && decision.role === dependency,
  );
}

function undispatchedOutcome(
  role: RoleId,
  decisions: readonly DecisionBody[],
  stopping: boolean,
): RoleOutcome {
  if (stopping) {
    return { kind: "undispatched", reason: "cancelled" };
  }

  return {
    kind: "waiting",
    reason: dependencyPending(role, decisions) ? "dependency" : "dispatch",
  };
}

function liveOutcome(bodies: readonly ObservationBody[], stopping: boolean): RoleOutcome {
  const activity = toolActivity(bodies);

  if (stopping) {
    return { kind: "cancelling", active: activity };
  }

  const [first, ...rest] = activity;

  if (first !== undefined) {
    return { kind: "tool_activity", active: [first, ...rest] };
  }

  const running = bodies.some((observation) => observation.kind === "attempt_started");

  return { kind: "running", activity: running ? "model" : null };
}

function roleOutcome(
  role: RoleId,
  decisions: readonly DecisionBody[],
  tasks: readonly TaskRow[],
  observations: ReadonlyMap<string, ObservationBody[]>,
  stopping: boolean,
): RoleOutcome {
  const decided =
    reusedOutcome(role, decisions) ??
    notRequiredOutcome(role, decisions) ??
    resultOutcome(role, decisions);

  if (decided) {
    return decided;
  }

  const task = tasks.find((item) => item.role === role);

  return task
    ? liveOutcome(observations.get(task.id) ?? [], stopping)
    : undispatchedOutcome(role, decisions, stopping);
}

function roleOutcomes(
  decisions: readonly DecisionBody[],
  tasks: readonly TaskRow[],
  observations: ReadonlyMap<string, ObservationBody[]>,
  stopping: boolean,
): Partial<Record<RoleId, RoleOutcome>> {
  const outcomes: Partial<Record<RoleId, RoleOutcome>> = {};

  for (const role of ROLE_IDS) {
    outcomes[role] = roleOutcome(role, decisions, tasks, observations, stopping);
  }

  return outcomes;
}

function artifactKindFor(role: RoleId): ArtifactKind {
  return roleRegistry[role].artifact;
}

function toolActivity(observations: readonly ObservationBody[]) {
  const open = new Map<
    string,
    { toolName: string; route: "direct" | "codemode"; startedAt: string }
  >();

  for (const observation of observations) {
    if (observation.kind === "tool_started") {
      open.set(observation.toolName, {
        toolName: observation.toolName,
        route: observation.route,
        startedAt: observation.at,
      });
    }

    if (observation.kind === "tool_settled") {
      open.clear();
    }
  }

  return [...open.values()];
}

async function readDecisions(tx: Transaction, operationId: string): Promise<DecisionBody[]> {
  const rows = await tx
    .select()
    .from(testingDecisionsTable)
    .where(eq(testingDecisionsTable.operation_id, operationId))
    .orderBy(asc(testingDecisionsTable.decision_index));

  return rows.map((row) => row.body as DecisionBody);
}

async function readObservations(tx: Transaction, taskId: string): Promise<ObservationBody[]> {
  const rows = await tx
    .select()
    .from(testingObservationsTable)
    .where(eq(testingObservationsTable.task_id, taskId))
    .orderBy(asc(testingObservationsTable.seq));

  return rows.map((row) => observationSchema.parse(row.safe_body));
}

async function lockTask(tx: Transaction, taskId: string): Promise<TaskRow> {
  const [task] = await tx
    .select()
    .from(testingTasksTable)
    .where(eq(testingTasksTable.id, taskId))
    .for("update");

  if (!task) {
    throw new TestingPersistenceError(404, "Unknown testing task");
  }

  return task;
}

export async function cancelTestingInTransaction(
  tx: Transaction,
  ownerRunId: string,
  operationId: string,
  append: AppendTestingEvent,
): Promise<TestView> {
  const operation = await requireOperation(tx, operationId);
  assertOwner(operation, ownerRunId);

  if (operation.finished_at) {
    return publishOperation(tx, operation, append, operation.terminal_outcome);
  }

  if (!operation.cancel_accepted_at) {
    const acceptedAt = new Date();
    await tx
      .update(testingOperationsTable)
      .set({ cancel_accepted_at: acceptedAt })
      .where(eq(testingOperationsTable.id, operation.id));
    operation.cancel_accepted_at = acceptedAt;
    await appendDecision(tx, operation, "cancel", {
      kind: "cancel",
      acceptedAt: acceptedAt.toISOString(),
    });
  }

  const tasks = await tx
    .select()
    .from(testingTasksTable)
    .where(eq(testingTasksTable.operation_id, operation.id));
  await ensureCancelDeliveries(tx, operation.id, tasks);

  return publishOperation(tx, operation, append, null);
}

async function ensureCancelDeliveries(
  tx: Transaction,
  operationId: string,
  tasks: readonly TaskRow[],
) {
  for (const task of tasks) {
    const [start] = await tx
      .select()
      .from(testingDeliveriesTable)
      .where(
        and(
          eq(testingDeliveriesTable.operation_id, operationId),
          eq(testingDeliveriesTable.task_id, task.id),
          eq(testingDeliveriesTable.kind, "start"),
        ),
      )
      .for("update");

    if (start?.acknowledgement === "quiet") {
      continue;
    }

    await tx
      .insert(testingDeliveriesTable)
      .values({
        delivery_key: `cancel:${task.id}`,
        operation_id: operationId,
        task_id: task.id,
        kind: "cancel",
      })
      .onConflictDoNothing();
  }
}

function operationScope(threadId: string, runId: string) {
  return and(
    eq(testingOperationsTable.thread_id, threadId),
    sql`(${testingOperationsTable.id} = ${runId} or (${testingOperationsTable.parent_run_id} = ${runId} and ${testingOperationsTable.intent}->'task' is null))`,
  );
}

type CancellationSelection =
  | Readonly<{ kind: "live"; parentRunId: string; operationId: string }>
  | Readonly<{ kind: "terminal" }>
  | Readonly<{ kind: "missing" }>;

export async function selectTestingCancellation(
  threadId: string,
  runId: string,
): Promise<CancellationSelection> {
  const db = await database();
  const rows = await db
    .select({
      id: testingOperationsTable.id,
      parentRunId: testingOperationsTable.parent_run_id,
      finishedAt: testingOperationsTable.finished_at,
    })
    .from(testingOperationsTable)
    .where(operationScope(threadId, runId));
  const target = rows.find((row) => row.finishedAt === null) ?? rows[0];

  if (!target) {
    return { kind: "missing" };
  }

  return target.finishedAt
    ? { kind: "terminal" }
    : { kind: "live", parentRunId: target.parentRunId, operationId: target.id };
}

type OriginOperation = Readonly<{ id: string; parent_run_id: string; request_key: string }>;

const delegationStartSchema = z.object({
  type: z.literal("TOOL_CALL_START"),
  toolCallName: z.literal("delegate_task"),
  toolCallId: z.string().min(1),
  parentMessageId: z.string().min(1).optional(),
});

async function taskOrigins(
  tx: Transaction,
  operations: readonly OriginOperation[],
): Promise<Map<string, TaskMessageOrigin | null>> {
  const origins = new Map<string, TaskMessageOrigin | null>();
  const runIds = [...new Set(operations.map((operation) => operation.parent_run_id))];

  if (runIds.length === 0) {
    return origins;
  }

  const [runs, events] = await Promise.all([
    tx
      .select({
        id: chatRunsTable.id,
        accepted: chatRunsTable.accepted,
        projection: chatRunsTable.projection,
      })
      .from(chatRunsTable)
      .where(inArray(chatRunsTable.id, runIds)),
    tx
      .select({ run_id: chatEventsTable.run_id, payload: chatEventsTable.payload })
      .from(chatEventsTable)
      .where(
        and(
          inArray(chatEventsTable.run_id, runIds),
          sql`${chatEventsTable.payload}->>'type' = 'TOOL_CALL_START'`,
          sql`${chatEventsTable.payload}->>'toolCallName' = 'delegate_task'`,
        ),
      ),
  ]);
  const evidence = delegationEvidence(events);
  const owners = new Map(runs.map((run) => [run.id, delegationOwners(run)]));

  for (const operation of operations) {
    const parents = evidence.get(operation.parent_run_id)?.get(operation.request_key);
    const surviving = owners.get(operation.parent_run_id)?.get(operation.request_key);
    const parentMessageId = delegationParent(parents, surviving);

    origins.set(
      operation.id,
      parentMessageId
        ? {
            parentRunId: operation.parent_run_id,
            requestKey: operation.request_key,
            parentMessageId,
          }
        : null,
    );
  }

  return origins;
}

function delegationEvidence(events: readonly { run_id: string; payload: unknown }[]) {
  const evidence = new Map<string, Map<string, Set<string>>>();

  for (const event of events) {
    const parsed = delegationStartSchema.safeParse(event.payload);

    if (!parsed.success) {
      continue;
    }

    const starts = evidence.get(event.run_id) ?? new Map<string, Set<string>>();
    const parents = starts.get(parsed.data.toolCallId) ?? new Set<string>();

    if (parsed.data.parentMessageId) {
      parents.add(parsed.data.parentMessageId);
    }

    starts.set(parsed.data.toolCallId, parents);
    evidence.set(event.run_id, starts);
  }

  return evidence;
}

function delegationOwners(run: Pick<typeof chatRunsTable.$inferSelect, "accepted" | "projection">) {
  const baseline = new Set(run.accepted.messages.map((message) => message.id));
  const calls = new Map<string, Set<string>>();

  for (const message of readProjection(run.projection).display) {
    if (message.role !== "assistant" || baseline.has(message.id)) {
      continue;
    }

    for (const callId of message.parts.flatMap((part) =>
      part.type === "tool-call" && part.name === "delegate_task" ? [part.id] : [],
    )) {
      const messages = calls.get(callId) ?? new Set<string>();
      messages.add(message.id);
      calls.set(callId, messages);
    }
  }

  return calls;
}

function delegationParent(
  parents: Set<string> | undefined,
  surviving: Set<string> | undefined,
): string | null {
  if (!parents || parents.size > 1) {
    return null;
  }

  if (parents.size === 1) {
    const parent = [...parents][0]!;

    return surviving?.has(parent) ? parent : null;
  }

  return surviving?.size === 1 ? [...surviving][0]! : null;
}

function enrichTaskOrigin(view: TestView, origin: TaskMessageOrigin | null): TestView {
  return view.task && !view.task.origin && origin
    ? { ...view, task: { ...view.task, origin } }
    : view;
}

async function selectPublished(
  tx: Transaction,
  threadId: string,
  runId?: string,
): Promise<readonly TestView[]> {
  const rows = await tx
    .select({
      operation_id: testingPublicationsTable.operation_id,
      version: testingPublicationsTable.version,
      view: testingPublicationsTable.view,
      thread_id: testingOperationsTable.thread_id,
      parent_run_id: testingOperationsTable.parent_run_id,
      request_key: testingOperationsTable.request_key,
    })
    .from(testingPublicationsTable)
    .innerJoin(
      testingOperationsTable,
      eq(testingPublicationsTable.operation_id, testingOperationsTable.id),
    )
    .where(runId ? operationScope(threadId, runId) : eq(testingOperationsTable.thread_id, threadId))
    .orderBy(
      desc(testingOperationsTable.created_at),
      desc(testingOperationsTable.id),
      desc(testingPublicationsTable.version),
    );
  const seen = new Set<string>();
  const latestRows = rows.filter((row) => {
    if (row.thread_id !== threadId || seen.has(row.operation_id)) {
      return false;
    }

    seen.add(row.operation_id);

    return true;
  });
  const origins = await taskOrigins(
    tx,
    latestRows.map((row) => ({ ...row, id: row.operation_id })),
  );
  const views: TestView[] = [];

  for (const row of latestRows) {
    const parsed = parseTestView(row.view);
    const view = parsed ? enrichTaskOrigin(parsed, origins.get(row.operation_id) ?? null) : null;
    const identity = testRunIdSchema.safeParse(row.operation_id);

    if (!view || !identity.success) {
      console.warn("Invalid testing publication", {
        operationId: row.operation_id,
        threadId: row.thread_id,
        version: row.version,
      });
      continue;
    }

    const runId = identity.data;
    views.push(
      view.report ? { ...view, runId, report: { ...view.report, runId } } : { ...view, runId },
    );
  }

  return views;
}

export async function readPublishedTestingRow(
  threadId: string,
  runId: string,
): Promise<TestView | null> {
  const db = await database();

  return db.transaction(async (tx) => {
    const views = await selectPublished(tx, threadId, runId);

    return views[0] ?? null;
  });
}

export async function readPublishedThreadViewsRow(threadId: string): Promise<readonly TestView[]> {
  const db = await database();

  return db.transaction((tx) => selectPublished(tx, threadId));
}

export async function readPublishedThreadViewsInTransaction(
  tx: Transaction,
  threadId: string,
): Promise<readonly TestView[]> {
  return selectPublished(tx, threadId);
}

export async function readStartCancelDeliveries(
  operationId: string,
  limit = 100,
): Promise<readonly DeliveryRecord[]> {
  const db = await database();
  const rows = await db
    .select()
    .from(testingDeliveriesTable)
    .where(eq(testingDeliveriesTable.operation_id, operationId))
    .orderBy(asc(testingDeliveriesTable.created_at))
    .limit(limit);

  return rows.map(deliveryFrom);
}

type DeliveryAcknowledgement = "quiet" | "cancel_requested" | "stopped";

const DELIVERY_TRANSITIONS: ReadonlyArray<
  readonly [kind: string, next: DeliveryAcknowledgement, prior: string | null]
> = [
  ["start", "quiet", null],
  ["cancel", "cancel_requested", null],
  ["cancel", "stopped", "cancel_requested"],
];

function acknowledgementAllowed(
  delivery: typeof testingDeliveriesTable.$inferSelect,
  acknowledgement: DeliveryAcknowledgement,
): boolean {
  return DELIVERY_TRANSITIONS.some(
    ([kind, next, prior]) =>
      delivery.kind === kind && acknowledgement === next && delivery.acknowledgement === prior,
  );
}

export async function ackDelivery(
  key: string,
  acknowledgement: DeliveryAcknowledgement,
): Promise<DeliveryRecord> {
  const db = await database();

  return db.transaction(async (tx) => {
    const [delivery] = await tx
      .select()
      .from(testingDeliveriesTable)
      .where(eq(testingDeliveriesTable.delivery_key, key))
      .for("update");

    if (!delivery) {
      throw new TestingPersistenceError(404, "Unknown testing delivery");
    }

    if (delivery.acknowledgement === acknowledgement) {
      return deliveryFrom(delivery);
    }

    if (!acknowledgementAllowed(delivery, acknowledgement)) {
      throw new TestingPersistenceError(409, "Delivery acknowledgement is not allowed");
    }

    await tx
      .update(testingDeliveriesTable)
      .set({ acknowledgement, acked_at: sql`now()` })
      .where(eq(testingDeliveriesTable.delivery_key, key));

    return { ...deliveryFrom(delivery), acknowledgement };
  });
}

function deliveryFrom(row: typeof testingDeliveriesTable.$inferSelect): DeliveryRecord {
  return {
    key: row.delivery_key,
    operationId: row.operation_id,
    taskId: row.task_id,
    kind: row.kind === "cancel" ? "cancel" : "start",
    acknowledgement:
      row.acknowledgement === "quiet" ||
      row.acknowledgement === "cancel_requested" ||
      row.acknowledgement === "stopped"
        ? row.acknowledgement
        : null,
  };
}

export function testingFinishOutcome(code: string, succeeded: boolean): RootRunOutcome {
  if (code.includes("cancel")) {
    return "cancelled";
  }

  if (code.includes("timeout") || code.includes("timed_out")) {
    return "timed_out";
  }

  return succeeded ? "missing" : "failed";
}

const roleFailureSchema = z.enum([
  "source_reads_incomplete",
  "proposal_rejected",
  "child_failed",
  "cancelled",
  "timed_out",
  "budget",
  "missing",
  "denied",
]);

export type RoleFailureCode = z.infer<typeof roleFailureSchema>;

export type PendingTestingOperation = Readonly<{
  delegated: boolean;
  workflow: string;
  operationId: string;
  parentRunId: string;
  threadId: string;
  mode: "attached" | "standalone";
  cancelRequested: boolean;
  deadline: string;
}>;

function failureOutcome(reason: RoleFailureCode): Exclude<TaskOutcome, "completed"> {
  if (reason === "cancelled") {
    return "cancelled";
  }

  if (reason === "timed_out") {
    return "timed_out";
  }

  if (reason === "missing") {
    return "missing";
  }

  return "failed";
}

export async function recordRoleFailureInTransaction(
  tx: Transaction,
  ownerRunId: string,
  taskId: string,
  reasonCode: string,
  issues?: readonly string[],
): Promise<{ duplicate: boolean }> {
  const reason = roleFailureSchema.safeParse(reasonCode);

  if (!reason.success) {
    throw new TestingPersistenceError(400, "Invalid role failure");
  }

  const task = await lockTask(tx, taskId);
  const operation = await requireOperation(tx, task.operation_id);
  assertOwner(operation, ownerRunId);

  if (operation.finished_at) {
    throw new TestingPersistenceError(409, "Testing operation is terminal");
  }

  const decisions = await readDecisions(tx, operation.id);
  const prior = decisions.find(
    (decision) => decision.kind === "task_result" && decision.taskId === task.id,
  );
  const execution = failureOutcome(reason.data);

  if (prior && prior.kind === "task_result") {
    if (prior.execution === "completed") {
      throw new TestingPersistenceError(409, "Task result is already decided");
    }

    if (prior.execution === execution && prior.reasonCode === reason.data) {
      return { duplicate: true };
    }

    throw new TestingPersistenceError(409, "Task result is already decided");
  }

  if ((task.role === "ac" || task.role === "ui") && isProseOperation(operation)) {
    const candidate = await resultsCandidate(tx, operation, task);
    await storeCandidate(tx, operation, task, candidate, frozenRuntime(operation));
  }

  await appendDecision(tx, operation, `task_result:${task.role}`, {
    kind: "task_result",
    role: task.role as RoleId,
    taskId: task.id,
    execution,
    reasonCode: reason.data,
    ...(issues && issues.length > 0 ? { issues: publicIssues(issues) } : {}),
  });

  return { duplicate: false };
}

export async function listPendingTestingOperations(): Promise<readonly PendingTestingOperation[]> {
  const db = await database();
  const rows = await db
    .select()
    .from(testingOperationsTable)
    .where(sql`${testingOperationsTable.finished_at} is null`);

  return rows.map((row) => {
    const runtime = row.runtime as { mode?: string; versions?: { workflow?: string } };

    return {
      delegated:
        testingIntentSchema.safeParse(row.intent).success &&
        Boolean((row.intent as TestingRequestInput).task),
      workflow: runtime.versions?.workflow ?? "legacy",
      operationId: row.id,
      parentRunId: row.parent_run_id,
      threadId: row.thread_id,
      mode: runtime.mode === "standalone" ? "standalone" : "attached",
      cancelRequested: row.cancel_accepted_at !== null,
      deadline: row.deadline.toISOString(),
    };
  });
}
