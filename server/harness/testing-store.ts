import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { StreamChunk } from "@tanstack/ai";
import { testingProjectionEvent } from "../../shared/testing-event";
import { z } from "zod";
import {
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
  sourceSchema,
  testRunIdSchema,
  testingRequestInputSchema,
  browserOutputSchema,
  designCaptureSchema,
  type ArtifactKind,
  type ArtifactRef,
  type ProgressRow,
  type PublicTestReport,
  type ReuseDecision,
  type ReuseRejection,
  type RoleId,
  type RootRunOutcome,
  type Source,
  type TaskOutcome,
  type TestView,
  type TestingRequest,
  type TestingRequestInput,
} from "../../shared/testing";
import {
  canonicalizePlan,
  checksForRole,
  deriveReport,
  digestOf,
  planScopeDigest,
  projectProgress,
  requirementsScopeDigest,
  roleRegistry,
  sourceCaptureSchema,
  validateRequirements,
  validateResults,
  validateReuse,
  type CanonicalPlan,
  type Requirements,
  type Results,
  type RoleOutcome,
  type SourceCapture,
  type TrustedToolReceipt,
} from "./testing-domain";

export const TESTING_WORKFLOW_VERSION = "testing-child-v1";
export const TESTING_SCHEMA_VERSION = "supervised-testing-schema-v1";
export const SOURCE_CAPTURE_NATIVE = "source_capture";
export const DESIGN_CAPTURE_NATIVE = "design_capture";
export const TESTING_BOUNDS = { maxCases: 20, maxChecks: 80, maxChecksPerCase: 12 } as const;
export const TESTING_LIMITS = {
  turns: 8,
  tools: 24,
  nestedCalls: 8,
  observationEntries: 64,
  observationBytes: 32_768,
  modelAttempts: 3,
  operationMs: 15 * 60 * 1000,
} as const;
export const TESTING_FIXTURE = { id: "host-browser-mock", version: "v1" } as const;

const VERSIONS = {
  runtime: "host-testing-runtime-v1",
  schema: TESTING_SCHEMA_VERSION,
  validator: "testing-domain-v1",
  policy: "role-registry-v1",
  catalog: "catalog-v1",
  adapter: "mock-adapter-v1",
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
  const capabilities =
    definition.capabilities.length > 0 ? definition.capabilities.join("+") : "none";
  return `${definition.artifact}:${definition.profile}:${definition.codeMode}:${capabilities}`;
}

export type HostTestingRuntime = Readonly<{
  absoluteDeadline: string;
  bounds: typeof TESTING_BOUNDS;
  limits: typeof TESTING_LIMITS;
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
  bindings: unknown;
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
  bounds: z.strictObject({
    maxCases: z.number(),
    maxChecks: z.number(),
    maxChecksPerCase: z.number(),
  }),
  fixture: z.strictObject({ id: z.string(), version: z.string() }),
  parentRunId: z.string().min(1),
  producerTaskId: z.string().min(1),
  attempt: z.number().int().positive(),
  inputDigest: z.string().min(1),
  outputDigest: z.string().min(1),
  complete: z.boolean().optional(),
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
});

type DecisionBody =
  | Readonly<{ kind: "reuse"; decision: ReuseDecision }>
  | Readonly<{
      kind: "satisfied";
      role: RoleId;
      ref: string;
      origin: "produced" | "reused" | "recovered";
    }>
  | Readonly<{ kind: "not_required"; role: "ui"; reason: "no_style_checks" }>
  | Readonly<{ kind: "dispatch"; role: RoleId; taskId: string; childWorkflowId: string }>
  | Readonly<{
      kind: "task_result";
      role: RoleId;
      taskId: string;
      execution: "completed";
      ref: string;
    }>
  | Readonly<{
      kind: "task_result";
      role: RoleId;
      taskId: string;
      execution: Exclude<TaskOutcome, "completed">;
      reasonCode: string;
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
    bounds: TESTING_BOUNDS,
    limits: TESTING_LIMITS,
    versions: { ...VERSIONS, model: snapshot.model, build: snapshot.build },
    profiles: profileVersions(),
    registration: registrationVersions(),
    fixture: TESTING_FIXTURE,
    model: snapshot.model,
    build: snapshot.build,
  };
}

export function testingChildWorkflowId(operationId: string, role: RoleId): string {
  const digest = createHash("sha256")
    .update(`${TESTING_WORKFLOW_VERSION}\0${operationId}\0${role}`)
    .digest("hex")
    .slice(0, 24);
  return `testing-${role}-${digest}`;
}

export function missingSourceCaptures(
  requested: readonly Source[],
  captures: readonly SourceCapture[],
): readonly Source[] {
  return requested.filter(
    (source) => !captures.some((capture) => sameSource(source, capture.reference)),
  );
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

function classifyRef(
  ref: string,
  input: {
    threadId: string;
    intent: TestingRequestInput;
    rows: ReadonlyMap<string, StoredArtifactRow>;
    host: HostTestingRuntime;
  },
): ReuseDecision {
  const parsedRef = artifactRefSchema.safeParse(ref);
  if (!parsedRef.success) {
    return rejectedDecision(artifactRefSchema.parse("invalid-ref"), "not_accessible");
  }
  const row = input.rows.get(ref);
  if (!row || row.threadId !== input.threadId || row.origin.threadId !== input.threadId) {
    return rejectedDecision(parsedRef.data, "not_accessible");
  }
  if (row.kind === "ac-result" || row.kind === "ui-result") {
    return rejectedDecision(parsedRef.data, "cross_run_result_forbidden");
  }
  if (row.kind !== "requirements" && row.kind !== "plan") {
    return rejectedDecision(parsedRef.data, "wrong_kind");
  }
  if (row.payload === null || typeof row.payload !== "object" || Array.isArray(row.payload)) {
    return rejectedDecision(parsedRef.data, "raw_blob");
  }
  if (dependencyCycle(ref, input.rows)) {
    return rejectedDecision(parsedRef.data, "conflicting_reference");
  }
  const metadata = metadataSchema.safeParse(row.metadata);
  if (
    !metadata.success ||
    !isDeepStrictEqual(metadata.data.versions, input.host.versions) ||
    !isDeepStrictEqual(metadata.data.profiles, input.host.profiles) ||
    !isDeepStrictEqual(metadata.data.registration, input.host.registration) ||
    !isDeepStrictEqual(metadata.data.bounds, input.host.bounds) ||
    !isDeepStrictEqual(metadata.data.fixture, input.host.fixture)
  ) {
    return rejectedDecision(parsedRef.data, "incompatible_snapshot");
  }
  if (row.dependencies.some((dependency) => !input.rows.has(dependency))) {
    return rejectedDecision(parsedRef.data, "dependency_rejected");
  }
  if (row.kind === "plan") {
    const requirements = input.rows.get(row.dependencies[0] ?? "");
    if (!requirements || !reusableSnapshot(requirements)) {
      return rejectedDecision(parsedRef.data, "dependency_rejected");
    }
  }
  if (!reusableSnapshot(row)) {
    return rejectedDecision(parsedRef.data, "incomplete");
  }
  if (row.kind === "requirements") {
    return reuseRequirements(parsedRef.data, row, input.threadId, input.intent);
  }
  return reusePlan(parsedRef.data, row, input.threadId, input.intent, input.rows, input.host);
}

function reusableSnapshot(row: StoredArtifactRow): boolean {
  const metadata = metadataSchema.safeParse(row.metadata);
  if (!metadata.success || metadata.data.complete !== true) {
    return false;
  }
  if (row.kind !== "requirements") {
    return row.kind === "plan";
  }
  const payload = row.payload as { unresolved?: unknown };
  return Array.isArray(payload.unresolved) && payload.unresolved.length === 0;
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
    expectedScopeDigest: requirementsScopeDigest({
      goal: intent.goal,
      sources: intent.sources,
      selection: intent.criteria,
    }),
  });
  return decisionFromValidation(ref, validation);
}

function reusePlan(
  ref: ArtifactRef,
  row: StoredArtifactRow,
  threadId: string,
  intent: TestingRequestInput,
  rows: ReadonlyMap<string, StoredArtifactRow>,
  host: HostTestingRuntime,
): ReuseDecision {
  const requirementsRef = row.dependencies[0];
  const requirements = requirementsRef ? rows.get(requirementsRef) : undefined;
  if (!requirements || requirements.kind !== "requirements") {
    return rejectedDecision(ref, "dependency_rejected");
  }
  const requirementsValidation = validateReuse(storedPayload(requirements), {
    requested: "requirements",
    threadId,
    expectedScopeDigest: requirementsScopeDigest({
      goal: intent.goal,
      sources: intent.sources,
      selection: intent.criteria,
    }),
  });
  if (
    requirementsValidation.kind === "rejected" ||
    requirementsValidation.value.kind !== "requirements"
  ) {
    return rejectedDecision(ref, "dependency_rejected");
  }
  const validation = validateReuse(storedPayload(row), {
    requested: "plan",
    threadId,
    expectedScopeDigest: planScopeDigest({
      goal: intent.goal,
      targetUrl: intent.targetUrl,
      design: intent.design ?? null,
      requirementsDigest: requirements.payloadDigest,
    }),
    planContext: {
      requirements: requirementsValidation.value.payload,
      requirementsDigest: digestOf(requirementsValidation.value.payload),
      goal: intent.goal,
      targetUrl: intent.targetUrl,
      design: intent.design ?? null,
      bounds: host.bounds,
    },
  });
  return decisionFromValidation(ref, validation);
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
  if (issue.startsWith("selected criterion") || issue === "incomplete") {
    return "incomplete";
  }
  if (issue.includes("bound")) {
    return "incompatible_snapshot";
  }
  return "invalid_evidence";
}

function isReuseRejection(value: string): value is ReuseRejection {
  return (
    value === "not_accessible" ||
    value === "raw_blob" ||
    value === "wrong_kind" ||
    value === "incomplete" ||
    value === "untrusted_producer" ||
    value === "scope_mismatch" ||
    value === "incompatible_snapshot" ||
    value === "dependency_rejected" ||
    value === "cross_run_result_forbidden" ||
    value === "invalid_evidence" ||
    value === "conflicting_reference"
  );
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

function sameSource(left: Source, right: Source): boolean {
  if (left.kind === "jira" && right.kind === "jira") {
    return left.issueKey === right.issueKey;
  }
  if (left.kind === "confluence" && right.kind === "confluence") {
    return left.pageId === right.pageId;
  }
  return false;
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
  const parsed = testingRequestInputSchema.safeParse(intent);
  if (!callId.success || !parsed.success) {
    throw new TestingPersistenceError(400, "Invalid testing intent");
  }
  const operationId = attachedOperationId(parentRunId, callId.data);
  const existing = await lockOperation(tx, operationId);
  if (existing) {
    return reloadAdmission(tx, existing, parsed.data);
  }
  const prepared = await prepareClosure(tx, threadId, parsed.data, runtime);
  return insertOperation(tx, {
    id: operationId,
    parentRunId,
    threadId,
    requestKey: callId.data,
    intent: parsed.data,
    runtime,
    mode: "attached",
    prepared,
  });
}

function testingIntent(request: TestingRequest): TestingRequestInput {
  return {
    goal: request.goal,
    sources: request.sources,
    criteria: request.criteria,
    targetUrl: request.targetUrl,
    ...(request.design ? { design: request.design } : {}),
    ...(request.existingArtifacts ? { existingArtifacts: request.existingArtifacts } : {}),
  };
}

export async function findStandaloneAdmission(
  tx: Transaction,
  request: TestingRequest,
): Promise<TestingAdmission | null> {
  const [existing] = await tx
    .select()
    .from(testingOperationsTable)
    .where(eq(testingOperationsTable.id, request.requestId))
    .for("update");
  if (!existing) {
    return null;
  }
  return reloadAdmission(tx, existing, testingIntent(request));
}

export async function prepareStandaloneClosure(
  tx: Transaction,
  request: TestingRequest,
  runtime: HostTestingRuntime,
): Promise<PreparedClosure> {
  assertHostRuntime(runtime);
  return prepareClosure(tx, request.threadId, request, runtime);
}

export async function insertStandaloneOperation(
  tx: Transaction,
  request: TestingRequest,
  runtime: HostTestingRuntime,
  prepared: PreparedClosure,
): Promise<TestingAdmission> {
  return insertOperation(tx, {
    id: request.requestId,
    parentRunId: request.requestId,
    threadId: request.threadId,
    requestKey: request.requestId,
    intent: testingIntent(request),
    runtime,
    mode: "standalone",
    prepared,
  });
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
  if (plan && styleAssignments(plan.payload).length === 0) {
    await appendDecision(
      tx,
      inserted,
      "not_required:ui",
      { kind: "not_required", role: "ui", reason: "no_style_checks" },
      index,
    );
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

function styleAssignments(payload: unknown): readonly string[] {
  if (!payload || typeof payload !== "object" || !("assignments" in payload)) {
    return [];
  }
  const assignments = payload.assignments;
  if (!assignments || typeof assignments !== "object" || !("ui" in assignments)) {
    return [];
  }
  return Array.isArray(assignments.ui)
    ? assignments.ui.filter((item) => typeof item === "string")
    : [];
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

export async function reserveRoleTasksInTransaction(
  tx: Transaction,
  operationId: string,
  ownerRunId: string,
  frontier: readonly Readonly<{ role: RoleId; input: unknown }>[],
): Promise<readonly RoleFrame[]> {
  const operation = await requireOperation(tx, operationId);
  assertOwner(operation, ownerRunId);
  if (operation.finished_at) {
    throw new TestingPersistenceError(409, "Testing operation is terminal");
  }
  const decisions = await readDecisions(tx, operation.id);
  const existing = await tx
    .select()
    .from(testingTasksTable)
    .where(eq(testingTasksTable.operation_id, operation.id))
    .orderBy(asc(testingTasksTable.created_at));
  const ordered = [...frontier].sort(
    (left, right) => ROLE_IDS.indexOf(left.role) - ROLE_IDS.indexOf(right.role),
  );
  const frames: RoleFrame[] = [];
  for (const task of existing) {
    frames.push(frameFrom(task));
  }
  if (operation.cancel_accepted_at) {
    await ensureCancelDeliveries(tx, operation.id, existing);
    return frames;
  }
  for (const reservation of ordered) {
    const prior = existing.find((task) => task.role === reservation.role);
    const digest = digestOf(reservation.input);
    if (prior) {
      if (prior.input_digest !== digest) {
        throw new TestingPersistenceError(409, "Reserved task input collision");
      }
      continue;
    }
    assertReservable(reservation.role, decisions);
    const taskId = `task-${reservation.role}-${createHash("sha256")
      .update(`${operation.id}\0${reservation.role}`)
      .digest("hex")
      .slice(0, 24)}`;
    const childWorkflowId = testingChildWorkflowId(operation.id, reservation.role);
    const [inserted] = await tx
      .insert(testingTasksTable)
      .values({
        id: taskId,
        operation_id: operation.id,
        role: reservation.role,
        child_workflow_id: childWorkflowId,
        attempt_nonce: 1,
        input_digest: digest,
        input: reservation.input,
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
    await appendDecision(tx, operation, `dispatch:${reservation.role}`, {
      kind: "dispatch",
      role: reservation.role,
      taskId,
      childWorkflowId,
    });
    frames.push(frameFrom(inserted));
  }
  return frames.sort((left, right) => ROLE_IDS.indexOf(left.role) - ROLE_IDS.indexOf(right.role));
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
      return { state: "denied", reason: "scope" };
    }
    if (task.attempt_nonce !== input.attemptNonce) {
      return { state: "denied", reason: "nonce" };
    }
    if (operation.finished_at) {
      return { state: "denied", reason: "terminal" };
    }
    if (operation.cancel_accepted_at) {
      return { state: "denied", reason: "cancel_requested" };
    }
    if (operation.deadline.getTime() <= Date.now()) {
      return { state: "denied", reason: "deadline" };
    }
    return frameFrom(task);
  });
}

export async function guardActualIOInTransaction(
  tx: Transaction,
  input: ActualIoInput,
  parentThreadId: string,
): Promise<ActualIoGuard> {
  const task = await lockTask(tx, input.taskId);
  const operation = await requireOperation(tx, task.operation_id);
  if (
    operation.parent_run_id !== input.parentRunId ||
    operation.thread_id !== parentThreadId ||
    task.child_workflow_id !== input.childWorkflowId
  ) {
    return { state: "denied", reason: "scope" };
  }
  if (task.attempt_nonce !== input.attemptNonce) {
    return { state: "denied", reason: "nonce" };
  }
  if (operation.finished_at) {
    return { state: "denied", reason: "terminal" };
  }
  if (operation.cancel_accepted_at) {
    return { state: "denied", reason: "cancel_requested" };
  }
  if (operation.deadline.getTime() <= Date.now()) {
    return { state: "denied", reason: "deadline" };
  }
  const runtime = frozenRuntime(operation);
  const nextSequence = task.io_sequence + 1;
  const update: Partial<typeof testingTasksTable.$inferInsert> = { io_sequence: nextSequence };
  if (input.kind === "model") {
    const step = callKeySchema.safeParse(input.step);
    const parsed = modelStepsSchema.safeParse(task.model_steps);
    if (!step.success) {
      throw new TestingPersistenceError(400, "Invalid host model step");
    }
    if (!parsed.success) {
      throw new TestingPersistenceError(409, "Stored model budget is invalid");
    }
    const attempts = parsed.data[step.data] ?? 0;
    if (
      (attempts === 0 && Object.keys(parsed.data).length >= runtime.limits.turns) ||
      attempts >= runtime.limits.modelAttempts
    ) {
      return { state: "denied", reason: "budget" };
    }
    update.model_steps = { ...parsed.data, [step.data]: attempts + 1 };
  } else if (
    task.native_calls >= runtime.limits.tools ||
    (input.kind === "nested" && task.nested_calls >= runtime.limits.nestedCalls)
  ) {
    return { state: "denied", reason: "budget" };
  } else if (input.kind === "nested") {
    update.native_calls = task.native_calls + 1;
    update.nested_calls = task.nested_calls + 1;
  } else {
    update.native_calls = task.native_calls + 1;
  }
  await tx.update(testingTasksTable).set(update).where(eq(testingTasksTable.id, task.id));
  return { state: "allowed", slot: `${task.id}-io-${nextSequence}` };
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
  const storedRuntime = frozenRuntime(operation);
  const { mode, ...runtime } = storedRuntime;
  assertHostRuntime(runtime);
  const intent = testingRequestInputSchema.parse(operation.intent);
  const decisions = await readDecisions(tx, operation.id);
  const pins = await tx
    .select({ ref: testingPinsTable.ref })
    .from(testingPinsTable)
    .where(eq(testingPinsTable.operation_id, operation.id))
    .orderBy(asc(testingPinsTable.ref));
  const artifacts: TestingExecution["artifacts"][number][] = [];
  for (const pin of pins) {
    const artifact = await artifactByRef(tx, pin.ref);
    const metadata = metadataSchema.safeParse(artifact.metadata);
    const role = roleIdSchema.safeParse(artifact.role);
    const kind = artifactKindSchema.safeParse(artifact.kind);
    if (
      artifact.thread_id !== operation.thread_id ||
      artifact.payload_digest !== digestOf(artifact.payload) ||
      !metadata.success ||
      !role.success ||
      !kind.success ||
      (role.success && kind.success && roleRegistry[role.data].artifact !== kind.data) ||
      metadata.data.outputDigest !== artifact.payload_digest ||
      !isDeepStrictEqual(metadata.data.versions, runtime.versions) ||
      !isDeepStrictEqual(metadata.data.profiles, runtime.profiles) ||
      !isDeepStrictEqual(metadata.data.registration, runtime.registration) ||
      !isDeepStrictEqual(metadata.data.bounds, runtime.bounds) ||
      !isDeepStrictEqual(metadata.data.fixture, runtime.fixture)
    ) {
      throw new TestingPersistenceError(409, "Pinned artifact version or digest mismatch");
    }
    artifacts.push({
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
    });
  }
  const tasks = await tx
    .select()
    .from(testingTasksTable)
    .where(eq(testingTasksTable.operation_id, operation.id))
    .orderBy(asc(testingTasksTable.created_at));
  const taskSnapshots: TestingExecution["tasks"][number][] = [];
  for (const task of tasks) {
    if (!roleIdSchema.safeParse(task.role).success) {
      throw new TestingPersistenceError(409, "Stored testing task has an invalid role");
    }
    if (!isDeepStrictEqual(task.runtime, operation.runtime)) {
      throw new TestingPersistenceError(409, "Task runtime does not match its operation");
    }
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
    const receipts: TestingExecutionReceipt[] = [];
    for (const row of rows) {
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
      receipts.push({
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
      });
    }
    const result = decisions.find(
      (decision) => decision.kind === "task_result" && decision.taskId === task.id,
    );
    taskSnapshots.push({
      frame: frameFrom(task),
      observations: await readObservations(tx, task.id),
      receipts,
      artifactRef:
        result?.kind === "task_result" && result.execution === "completed"
          ? artifactRefSchema.parse(result.ref)
          : null,
    });
  }
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
    tasks: taskSnapshots,
  };
}

export async function readPrivateTask(taskId: string): Promise<
  Readonly<{
    frame: RoleFrame;
    observations: readonly ObservationBody[];
    receipts: readonly TrustedToolReceipt[];
    artifactRef: string | null;
  }>
> {
  const db = await database();
  return db.transaction(async (tx) => {
    const task = await lockTask(tx, taskId);
    const decisions = await readDecisions(tx, task.operation_id);
    const completed = decisions.find(
      (decision) =>
        decision.kind === "task_result" &&
        decision.taskId === task.id &&
        decision.execution === "completed",
    );
    return {
      frame: frameFrom(task),
      observations: await readObservations(tx, task.id),
      receipts: await readTrustedReceipts(tx, task),
      artifactRef:
        completed && completed.kind === "task_result" && completed.execution === "completed"
          ? completed.ref
          : null,
    };
  });
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
  if (parsed.data.kind === "tool_started" && parsed.data.toolName === SOURCE_CAPTURE_NATIVE) {
    throw new TestingPersistenceError(409, "Source capture cannot be minted as a model tool");
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
    const runtime = frozenRuntime(operation);
    const used = existing.reduce((sum, row) => sum + row.bytes, 0);
    if (
      existing.length + 1 > runtime.limits.observationEntries ||
      used + bytes > runtime.limits.observationBytes
    ) {
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
  if (!native || native.output_digest !== bindings.nativeOutputDigest) {
    throw new TestingPersistenceError(409, "Derived receipt is not linked to its native response");
  }
}

function assertReceiptScope(
  task: TaskRow,
  runtime: HostTestingRuntime,
  nativeName: string,
  route: "direct" | "codemode",
  output: unknown,
  bindings: z.infer<typeof receiptBindingsSchema>,
) {
  if (nativeName === SOURCE_CAPTURE_NATIVE || nativeName === DESIGN_CAPTURE_NATIVE) {
    const linked = Boolean(bindings.nativeName && bindings.nativeOutputDigest);
    const captureOk =
      nativeName === SOURCE_CAPTURE_NATIVE
        ? sourceCaptureSchema.safeParse(output).success
        : designCaptureSchema.safeParse(output).success;
    if (
      route !== "direct" ||
      !linked ||
      !captureOk ||
      (nativeName === SOURCE_CAPTURE_NATIVE && task.role !== "atlassian") ||
      (nativeName === DESIGN_CAPTURE_NATIVE && task.role !== "ui")
    ) {
      throw new TestingPersistenceError(409, "Source capture is a private host receipt");
    }
    return;
  }
  if (task.role === "planner") {
    throw new TestingPersistenceError(409, "Planner has no external receipt scope");
  }
  if (nativeName === "use_browser") {
    const parsed = browserOutputSchema.safeParse(output);
    if (
      (task.role !== "ac" && task.role !== "ui") ||
      !parsed.success ||
      !bindings.fixture ||
      bindings.fixture.id !== runtime.fixture.id ||
      bindings.fixture.version !== runtime.fixture.version ||
      parsed.data.evidence.fixture.id !== runtime.fixture.id ||
      parsed.data.evidence.fixture.version !== runtime.fixture.version ||
      parsed.data.evidence.adapterVersion !== runtime.versions.adapter
    ) {
      throw new TestingPersistenceError(409, "Browser receipt is outside the host scope");
    }
    return;
  }
  if (nativeName === "get_figma") {
    if (
      task.role !== "ui" ||
      !rawFigmaOutput(output) ||
      designCaptureSchema.safeParse(output).success
    ) {
      throw new TestingPersistenceError(409, "Figma receipt is outside the host scope");
    }
    return;
  }
  if (task.role !== "atlassian") {
    throw new TestingPersistenceError(409, "Receipt is outside the role scope");
  }
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
    if (operation.finished_at || operation.cancel_accepted_at) {
      throw new TestingPersistenceError(409, "Testing receipt fence is closed");
    }
    if (task.attempt_nonce !== input.attemptNonce) {
      throw new TestingPersistenceError(409, "Receipt nonce mismatch");
    }
    const [prior] = await tx
      .select()
      .from(testingReceiptsTable)
      .where(eq(testingReceiptsTable.id, input.id));
    if (prior) {
      if (
        prior.task_id !== task.id ||
        prior.output_digest !== outputDigest ||
        prior.input_digest !== inputDigest
      ) {
        throw new TestingPersistenceError(409, "Receipt identity collision");
      }
      return { outputDigest, duplicate: true };
    }
    assertReceiptScope(
      task,
      frozenRuntime(operation),
      input.nativeName,
      input.route,
      storedOutput,
      bindings.data,
    );
    if (input.nativeName === SOURCE_CAPTURE_NATIVE || input.nativeName === DESIGN_CAPTURE_NATIVE) {
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
      bindings: bindings.data,
    });
    return { outputDigest, duplicate: false };
  });
}

export async function acceptRoleCandidateInTransaction(
  tx: Transaction,
  ownerRunId: string,
  taskId: string,
  proposal: unknown,
): Promise<{ ref: ArtifactRef; kind: ArtifactKind }> {
  const task = await lockTask(tx, taskId);
  const operation = await requireOperation(tx, task.operation_id);
  assertOwner(operation, ownerRunId);
  if (operation.finished_at || operation.cancel_accepted_at) {
    throw new TestingPersistenceError(409, "Testing accept fence is closed");
  }
  const decisions = await readDecisions(tx, operation.id);
  const prior = decisions.find(
    (decision) => decision.kind === "task_result" && decision.taskId === task.id,
  );
  if (prior && prior.kind === "task_result") {
    if (prior.execution !== "completed") {
      throw new TestingPersistenceError(409, "Task result is already decided");
    }
    const runtime = frozenRuntime(operation);
    const again = await validateCandidate(tx, operation, task, proposal, runtime);
    const artifact = await artifactByRef(tx, prior.ref);
    const metadata = metadataSchema.safeParse(artifact.metadata);
    if (
      again.digest !== artifact.payload_digest ||
      !metadata.success ||
      !isDeepStrictEqual(metadata.data.versions, runtime.versions) ||
      !isDeepStrictEqual(metadata.data.profiles, runtime.profiles) ||
      !isDeepStrictEqual(metadata.data.registration, runtime.registration)
    ) {
      throw new TestingPersistenceError(409, "Task result version mismatch");
    }
    return { ref: artifactRefSchema.parse(prior.ref), kind: again.kind };
  }
  const runtime = frozenRuntime(operation);
  const accepted = await validateCandidate(tx, operation, task, proposal, runtime);
  const ref = artifactRefSchema.parse(
    `art-${createHash("sha256").update(`${operation.id}\0${task.role}\0${accepted.digest}`).digest("hex").slice(0, 40)}`,
  );
  const metadata: ArtifactMetadata = {
    dependencies: accepted.dependencies,
    versions: runtime.versions,
    profiles: runtime.profiles,
    registration: runtime.registration,
    bounds: runtime.bounds,
    fixture: runtime.fixture,
    parentRunId: operation.parent_run_id,
    producerTaskId: task.id,
    attempt: task.attempt_nonce,
    inputDigest: task.input_digest,
    outputDigest: accepted.digest,
    complete: await artifactComplete(tx, accepted),
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
  await appendDecision(tx, operation, `task_result:${task.role}`, {
    kind: "task_result",
    role: task.role as RoleId,
    taskId: task.id,
    execution: "completed",
    ref,
  });
  await appendDecision(tx, operation, `satisfied:${task.role}`, {
    kind: "satisfied",
    role: task.role as RoleId,
    ref,
    origin: "produced",
  });
  if (accepted.kind === "plan" && styleAssignments(accepted.payload).length === 0) {
    await appendDecision(tx, operation, "not_required:ui", {
      kind: "not_required",
      role: "ui",
      reason: "no_style_checks",
    });
  }
  return { ref, kind: accepted.kind };
}

async function validateCandidate(
  tx: Transaction,
  operation: OperationRow,
  task: TaskRow,
  proposal: unknown,
  runtime: HostTestingRuntime,
): Promise<{
  kind: ArtifactKind;
  payload: Requirements | CanonicalPlan | Results;
  digest: string;
  scopeDigest: string;
  dependencies: string[];
}> {
  const intent = testingRequestInputSchema.parse(operation.intent);
  if (task.role === "atlassian") {
    const captures = await sourceCaptures(tx, task);
    const missing = missingSourceCaptures(intent.sources, captures);
    if (missing.length > 0) {
      throw new TestingPersistenceError(409, "Source captures do not cover the request");
    }
    const orderedCaptures = intent.sources.flatMap((source) => {
      const capture = captures.find((item) => sameSource(item.reference, source));
      return capture ? [capture] : [];
    });
    const validation = validateRequirements(proposal, {
      goal: intent.goal,
      selection: intent.criteria,
      captures: orderedCaptures,
    });
    if (validation.kind === "rejected") {
      throw new TestingPersistenceError(400, validation.issues.join("; "));
    }
    return {
      kind: "requirements",
      payload: validation.value,
      digest: digestOf(validation.value),
      scopeDigest: requirementsScopeDigest({
        goal: intent.goal,
        sources: intent.sources,
        selection: intent.criteria,
      }),
      dependencies: [],
    };
  }
  const requirements = await satisfiedPayload(tx, operation.id, "atlassian");
  if (task.role === "planner") {
    if (!requirements) {
      throw new TestingPersistenceError(409, "Plan candidate needs requirements");
    }
    const validation = canonicalizePlan(proposal, {
      requirements: requirements.payload as Requirements,
      requirementsDigest: requirements.payload_digest,
      goal: intent.goal,
      targetUrl: intent.targetUrl,
      design: intent.design ?? null,
      bounds: runtime.bounds,
    });
    if (validation.kind === "rejected") {
      throw new TestingPersistenceError(400, validation.issues.join("; "));
    }
    return {
      kind: "plan",
      payload: validation.value,
      digest: digestOf(validation.value),
      scopeDigest: planScopeDigest({
        goal: intent.goal,
        targetUrl: intent.targetUrl,
        design: intent.design ?? null,
        requirementsDigest: requirements.payload_digest,
      }),
      dependencies: [requirements.ref],
    };
  }
  const plan = await satisfiedPayload(tx, operation.id, "planner");
  if (!plan) {
    throw new TestingPersistenceError(409, "Result candidate needs a plan");
  }

  const canonical = plan.payload as CanonicalPlan;
  const role = task.role === "ac" ? "ac" : "ui";
  const checks = checksForRole(canonical.cases, role);
  const receipts = (await readTrustedReceipts(tx, task)).filter((receipt) => receipt.role === role);
  const validation = validateResults(proposal, {
    role,
    cases: canonical.cases,
    checks,
    receipts,
  });
  if (validation.kind === "rejected") {
    throw new TestingPersistenceError(400, validation.issues.join("; "));
  }
  return {
    kind: role === "ac" ? "ac-result" : "ui-result",
    payload: validation.value,
    digest: digestOf(validation.value),
    scopeDigest: digestOf({
      operationId: operation.id,
      taskId: task.id,
      planDigest: plan.payload_digest,
      role,
    }),
    dependencies: [plan.ref],
  };
}

async function sourceCaptures(tx: Transaction, task: TaskRow): Promise<SourceCapture[]> {
  const rows = await tx
    .select()
    .from(testingReceiptsTable)
    .where(
      and(
        eq(testingReceiptsTable.task_id, task.id),
        eq(testingReceiptsTable.native_name, SOURCE_CAPTURE_NATIVE),
      ),
    );
  const captures: SourceCapture[] = [];
  for (const row of rows) {
    const parsed = sourceCaptureSchema.safeParse(row.output);
    const bindings = receiptBindingsSchema.safeParse(row.bindings);
    if (
      !parsed.success ||
      !bindings.success ||
      row.output_digest !== digestOf(row.output) ||
      parsed.data.digest !== bindings.data.nativeOutputDigest
    ) {
      throw new TestingPersistenceError(409, "Source receipt is not a host capture");
    }
    await assertDerivedLink(tx, task, row.slot, bindings.data);
    captures.push(parsed.data);
  }
  return captures;
}

async function artifactComplete(
  tx: Transaction,
  accepted: {
    kind: ArtifactKind;
    payload: Requirements | CanonicalPlan | Results;
    dependencies: string[];
  },
): Promise<boolean> {
  if (accepted.kind === "requirements") {
    return (accepted.payload as Requirements).unresolved.length === 0;
  }
  if (accepted.kind !== "plan") {
    return false;
  }
  const requirements = await artifactByRef(tx, accepted.dependencies[0] ?? "");
  const payload = requirements.payload as Requirements;
  return Array.isArray(payload.unresolved) && payload.unresolved.length === 0;
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

async function readTrustedReceipts(tx: Transaction, task: TaskRow): Promise<TrustedToolReceipt[]> {
  const rows = await tx
    .select()
    .from(testingReceiptsTable)
    .where(
      and(
        eq(testingReceiptsTable.task_id, task.id),
        eq(testingReceiptsTable.attempt, task.attempt_nonce),
      ),
    );
  const role = task.role === "ac" || task.role === "ui" ? task.role : null;
  if (!role) {
    return [];
  }
  return rows.flatMap((row) => {
    const output = browserOutputSchema.safeParse(row.output);
    const bindings = receiptBindingsSchema.safeParse(row.bindings);
    if (!output.success || !bindings.success || !bindings.data.fixture) {
      return [];
    }
    if (row.output_digest !== digestOf(row.output)) {
      return [];
    }
    return [
      {
        id: row.id,
        role,
        checkId: output.data.checkId,
        inputDigest: row.input_digest,
        outputDigest: row.output_digest,
        output: row.output,
        fixture: bindings.data.fixture,
      },
    ];
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
  if (latest && isDeepStrictEqual(latest.cursors, snapshot.cursors)) {
    return latest.view as TestView;
  }
  if (operation.finished_at && latest && (latest.cursors as { finished?: boolean }).finished) {
    return latest.view as TestView;
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
  const observations = new Map<string, ObservationBody[]>();
  const cursors: Record<string, number> = {};
  for (const task of tasks) {
    const bodies = await readObservations(tx, task.id);
    observations.set(task.id, bodies);
    cursors[task.id] = bodies.length === 0 ? -1 : bodies.length - 1;
  }
  const requirements = artifactPayload(artifacts, "requirements") as Requirements | null;
  const plan = artifactPayload(artifacts, "plan") as CanonicalPlan | null;
  const acResults = artifactPayload(artifacts, "ac-result") as Results | null;
  const uiResults = artifactPayload(artifacts, "ui-result") as Results | null;
  const reuse = decisions.flatMap((decision) =>
    decision.kind === "reuse" ? [decision.decision] : [],
  );
  const available = artifacts
    .filter((artifact) => artifact.kind === "requirements" || artifact.kind === "plan")
    .map((artifact) => artifactRefSchema.parse(artifact.ref));
  const allRefs = artifacts.map((artifact) => artifactRefSchema.parse(artifact.ref));
  const finished = Boolean(operation.finished_at);
  const cancelling = Boolean(operation.cancel_accepted_at) && !finished;
  const outcomes = roleOutcomes(decisions, tasks, observations, cancelling || finished);
  const progress = projectProgress(version, outcomes, plan);
  const runId = testRunIdSchema.parse(operation.parent_run_id);
  const unresolvedSources = unresolvedFrom(requirements, operation.intent);
  let report: PublicTestReport | null = null;
  if (finished) {
    const rootOutcome = (forcedOutcome ?? operation.terminal_outcome ?? "failed") as RootRunOutcome;
    report = deriveReport({
      runId,
      rootOutcome,
      requirements,
      plan,
      acResults,
      uiResults,
      unresolvedSources,
      artifacts: allRefs,
      progressVersion: version,
      outcomes,
    });
  }
  const view: TestView = {
    runId,
    progress,
    reuse,
    availableArtifacts: available,
    ...(finished
      ? { state: "finished" as const, report: report! }
      : { state: cancelling ? ("cancelling" as const) : ("active" as const), report: null }),
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
  const parsed = testingRequestInputSchema.safeParse(intent);
  return parsed.success ? parsed.data.sources : [];
}

function roleOutcomes(
  decisions: readonly DecisionBody[],
  tasks: readonly TaskRow[],
  observations: ReadonlyMap<string, ObservationBody[]>,
  stopping: boolean,
): Partial<Record<RoleId, RoleOutcome>> {
  const outcomes: Partial<Record<RoleId, RoleOutcome>> = {};
  for (const role of ROLE_IDS) {
    const reused = decisions.find(
      (decision) =>
        decision.kind === "reuse" &&
        decision.decision.kind === "accepted" &&
        decision.decision.artifactKind === artifactKindFor(role),
    );
    if (reused && reused.kind === "reuse" && reused.decision.kind === "accepted") {
      outcomes[role] = {
        kind: "reused",
        artifact: reused.decision.ref,
        provenance: reused.decision.provenance,
      };
      continue;
    }
    const notRequired = decisions.find(
      (decision) => decision.kind === "not_required" && decision.role === role,
    );
    if (notRequired && notRequired.kind === "not_required") {
      outcomes[role] = { kind: "not_required", reason: notRequired.reason };
      continue;
    }
    const result = decisions.find(
      (decision) => decision.kind === "task_result" && decision.role === role,
    );
    if (result && result.kind === "task_result") {
      outcomes[role] =
        result.execution === "completed"
          ? { kind: "terminal", outcome: "completed", reasonCode: "completed" }
          : { kind: "terminal", outcome: result.execution, reasonCode: result.reasonCode };
      continue;
    }
    const task = tasks.find((item) => item.role === role);
    if (!task) {
      outcomes[role] = stopping
        ? { kind: "undispatched", reason: "cancelled" }
        : {
            kind: "waiting",
            reason:
              role !== "atlassian" &&
              !decisions.some(
                (decision) =>
                  decision.kind === "satisfied" &&
                  decision.role === (role === "planner" ? "atlassian" : "planner"),
              )
                ? "dependency"
                : "dispatch",
          };
      continue;
    }
    const activity = toolActivity(observations.get(task.id) ?? []);
    if (stopping) {
      outcomes[role] = { kind: "cancelling", active: activity };
      continue;
    }
    if (activity.length > 0) {
      const [first, ...rest] = activity;
      outcomes[role] = { kind: "tool_activity", active: [first!, ...rest] };
      continue;
    }
    const running = (observations.get(task.id) ?? []).some(
      (observation) => observation.kind === "attempt_started",
    );
    outcomes[role] = { kind: "running", activity: running ? "model" : null };
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
    sql`(${testingOperationsTable.id} = ${runId} or ${testingOperationsTable.parent_run_id} = ${runId})`,
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

async function selectPublished(
  tx: Transaction,
  threadId: string,
  runId?: string,
): Promise<readonly TestView[]> {
  const rows = await tx
    .select({
      operation_id: testingPublicationsTable.operation_id,
      view: testingPublicationsTable.view,
      thread_id: testingOperationsTable.thread_id,
    })
    .from(testingPublicationsTable)
    .innerJoin(
      testingOperationsTable,
      eq(testingPublicationsTable.operation_id, testingOperationsTable.id),
    )
    .where(runId ? operationScope(threadId, runId) : eq(testingOperationsTable.thread_id, threadId))
    .orderBy(desc(testingPublicationsTable.public_sequence));
  const seen = new Set<string>();
  const views: TestView[] = [];
  for (const row of rows) {
    if (row.thread_id !== threadId || seen.has(row.operation_id)) {
      continue;
    }
    seen.add(row.operation_id);
    views.push(row.view as TestView);
  }
  return views;
}

export async function readPublishedTesting(
  threadId: string,
  runId: string,
): Promise<TestView | null> {
  const db = await database();
  return db.transaction(async (tx) => {
    const views = await selectPublished(tx, threadId, runId);
    return views[0] ?? null;
  });
}

export async function readPublishedThreadViews(threadId: string): Promise<readonly TestView[]> {
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

export async function ackDelivery(
  key: string,
  acknowledgement: "quiet" | "cancel_requested" | "stopped",
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
    const allowed =
      (delivery.kind === "start" &&
        acknowledgement === "quiet" &&
        delivery.acknowledgement === null) ||
      (delivery.kind === "cancel" &&
        acknowledgement === "cancel_requested" &&
        delivery.acknowledgement === null) ||
      (delivery.kind === "cancel" &&
        acknowledgement === "stopped" &&
        delivery.acknowledgement === "cancel_requested");
    if (!allowed) {
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

export function parseStoredIntentSources(intent: unknown): readonly Source[] {
  const parsed = z.strictObject({ sources: z.array(sourceSchema) }).safeParse(intent);
  return parsed.success ? parsed.data.sources : [];
}

const roleFailureSchema = z.enum([
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
  await appendDecision(tx, operation, `task_result:${task.role}`, {
    kind: "task_result",
    role: task.role as RoleId,
    taskId: task.id,
    execution,
    reasonCode: reason.data,
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
    const runtime = row.runtime as { mode?: string };
    return {
      operationId: row.id,
      parentRunId: row.parent_run_id,
      threadId: row.thread_id,
      mode: runtime.mode === "standalone" ? "standalone" : "attached",
      cancelRequested: row.cancel_accepted_at !== null,
      deadline: row.deadline.toISOString(),
    };
  });
}

export async function readTestingAdmissionInTransaction(
  tx: Transaction,
  ownerRunId: string,
  operationId: string,
): Promise<TestingAdmission> {
  const operation = await requireOperation(tx, operationId);
  assertOwner(operation, ownerRunId);
  return reloadAdmission(tx, operation, operation.intent);
}

export type { ProgressRow };
