import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ROLE_IDS,
  actionSchema,
  artifactRefSchema,
  browserOutputSchema,
  criteriaSelectionSchema,
  designReferenceSchema,
  planCaseSchema,
  planCheckSchema,
  requirementCriterionSchema,
  sourceSchema,
  testRunIdSchema,
  type Acceptance,
  type ArtifactKind,
  type ArtifactOrigin,
  type ArtifactRef,
  type CheckProgress,
  type Coverage,
  type CriteriaSelection,
  type DesignReference,
  type FixtureIdentity,
  type FunctionalCheck,
  type Judgment,
  type NonEmpty,
  type PlanCase,
  type PlanCheck,
  type ProgressCard,
  type ProgressRow,
  type PublicCheckResult,
  type RootRunOutcome,
  type PublicEvidence,
  type PublicPlan,
  type PublicTestReport,
  type RequirementCriterion,
  type RoleId,
  type Source,
  type StyleCheck,
  type TaskOutcome,
  type TestRunId,
  type Tolerance,
  type ToolActivityView,
} from "../../shared/testing";

export type Capability = "atlassian_read" | "browser_mock" | "figma_read";

export type RoleDefinition = Readonly<{
  artifact: ArtifactKind;
  capabilities: readonly Capability[];
  codeMode: "enabled";
  profile: string;
}>;

export const roleRegistry = {
  atlassian: {
    artifact: "requirements",
    capabilities: ["atlassian_read"],
    codeMode: "enabled",
    profile: "requirements-v1",
  },
  planner: {
    artifact: "plan",
    capabilities: [],
    codeMode: "enabled",
    profile: "planning-v1",
  },
  ac: {
    artifact: "ac-result",
    capabilities: ["browser_mock"],
    codeMode: "enabled",
    profile: "functional-v1",
  },
  ui: {
    artifact: "ui-result",
    capabilities: ["browser_mock", "figma_read"],
    codeMode: "enabled",
    profile: "style-v1",
  },
} as const satisfies Record<RoleId, RoleDefinition>;

export const capabilityToolNames = {
  atlassian_read: null,
  browser_mock: "use_browser",
  figma_read: "get_figma",
} as const satisfies Record<Capability, string | null>;

export function browserRole(role: RoleId): "ac" | "ui" | null {
  return role === "ac" || role === "ui" ? role : null;
}

const isFunctionalCheck = (check: PlanCheck): check is FunctionalCheck =>
  check.kind === "functional";
const isStyleCheck = (check: PlanCheck): check is StyleCheck => check.kind === "style";

export function checksForRole(cases: readonly PlanCase[], role: "ac"): readonly FunctionalCheck[];
export function checksForRole(cases: readonly PlanCase[], role: "ui"): readonly StyleCheck[];
export function checksForRole(cases: readonly PlanCase[], role: "ac" | "ui"): readonly PlanCheck[];

export function checksForRole(cases: readonly PlanCase[], role: "ac" | "ui"): readonly PlanCheck[] {
  return cases.flatMap<PlanCheck>((planCase) =>
    role === "ac"
      ? planCase.checks.filter(isFunctionalCheck)
      : planCase.checks.filter(isStyleCheck),
  );
}

export type Validation<T> =
  | Readonly<{ kind: "accepted"; value: T }>
  | Readonly<{ kind: "rejected"; issues: NonEmpty<string> }>;

export function accepted<T>(value: T): Validation<T> {
  return { kind: "accepted", value };
}

export function rejected(issue: string, ...rest: readonly string[]): Validation<never> {
  return { kind: "rejected", issues: [issue, ...rest] };
}

function nonEmpty(values: readonly string[]): NonEmpty<string> | null {
  const [first, ...rest] = values;
  return first === undefined ? null : [first, ...rest];
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function digestOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function requirementsScopeDigest(
  input: Readonly<{ goal: string; sources: readonly Source[]; selection: CriteriaSelection }>,
): string {
  return digestOf({
    goal: input.goal,
    sources: input.sources.map((source) =>
      source.kind === "jira" ? `jira:${source.issueKey}` : `confluence:${source.pageId}`,
    ),
    selection: input.selection,
  });
}

export function planScopeDigest(
  input: Readonly<{
    goal: string;
    targetUrl: string;
    design: DesignReference | null;
    requirementsDigest: string;
  }>,
): string {
  return digestOf({
    goal: input.goal,
    targetUrl: input.targetUrl,
    design: input.design,
    requirementsDigest: input.requirementsDigest,
  });
}

export const sourceCaptureSchema = z.strictObject({
  reference: sourceSchema,
  digest: z.string().trim().min(1).max(128),
  anchors: z.array(z.string().trim().min(1).max(512)).min(1),
  capturedAt: z.string().trim().min(1).max(64),
});
export type SourceCapture = Readonly<z.infer<typeof sourceCaptureSchema>>;

export type Requirements = Readonly<{
  goal: string;
  selection: CriteriaSelection;
  criteria: readonly RequirementCriterion[];
  unresolved: readonly string[];
  captures: readonly SourceCapture[];
}>;

type SelectedCriteria = Readonly<{
  criteria: readonly RequirementCriterion[];
  missingKeys: readonly string[];
}>;

function selectedCriteria(
  criteria: readonly RequirementCriterion[],
  selection: CriteriaSelection,
): SelectedCriteria {
  if (selection.kind === "all") {
    return { criteria, missingKeys: [] };
  }
  const criteriaByKey = new Map(criteria.map((criterion) => [criterion.key, criterion]));
  const selected: RequirementCriterion[] = [];
  const missingKeys: string[] = [];
  for (const key of selection.keys) {
    const criterion = criteriaByKey.get(key);
    if (criterion) {
      selected.push(criterion);
    } else {
      missingKeys.push(key);
    }
  }
  return { criteria: selected, missingKeys };
}

const requirementsProposalSchema = z.strictObject({
  criteria: z
    .array(
      z.strictObject({
        key: z.string().trim().min(1).max(128),
        statement: z.string().trim().min(1).max(2_000),
        source: sourceSchema,
        anchor: z.string().trim().min(1).max(512),
      }),
    )
    .min(1),
  unresolved: z.array(z.string().trim().min(1).max(512)).max(50),
});

export type RequirementsContext = Readonly<{
  goal: string;
  selection: CriteriaSelection;
  captures: readonly SourceCapture[];
}>;

function sameSource(left: Source, right: Source): boolean {
  if (left.kind === "jira" && right.kind === "jira") {
    return left.issueKey === right.issueKey;
  }
  if (left.kind === "confluence" && right.kind === "confluence") {
    return left.pageId === right.pageId;
  }
  return false;
}

export function validateRequirements(
  raw: unknown,
  context: RequirementsContext,
): Validation<Requirements> {
  if (context.captures.length === 0) {
    return rejected("requirements need at least one source capture");
  }
  const parsed = requirementsProposalSchema.safeParse(raw);
  if (!parsed.success) {
    return rejected(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  const issues: string[] = [];
  const keys = new Set<string>();
  const criteria: RequirementCriterion[] = [];
  for (const proposal of parsed.data.criteria) {
    if (keys.has(proposal.key)) {
      issues.push(`duplicate criterion key ${proposal.key}`);
      continue;
    }
    keys.add(proposal.key);
    const capture = context.captures.find((item) => sameSource(item.reference, proposal.source));
    if (!capture) {
      issues.push(`criterion ${proposal.key} references an uncaptured source`);
      continue;
    }
    if (!capture.anchors.includes(proposal.anchor)) {
      issues.push(`criterion ${proposal.key} references an unknown anchor`);
      continue;
    }
    criteria.push({
      id: `crit:${proposal.key}`,
      key: proposal.key,
      statement: proposal.statement,
      sourceDigest: capture.digest,
      anchor: proposal.anchor,
    });
  }
  const selected = selectedCriteria(criteria, context.selection);
  for (const key of selected.missingKeys) {
    issues.push(`selected criterion ${key} is missing from the extraction`);
  }
  if (issues.length > 0) {
    const [first, ...rest] = issues;
    return first === undefined ? rejected("requirements rejected") : rejected(first, ...rest);
  }
  return accepted({
    goal: context.goal,
    selection: context.selection,
    criteria,
    unresolved: parsed.data.unresolved,
    captures: context.captures,
  });
}

export type PlanContext = Readonly<{
  requirements: Requirements;
  requirementsDigest: string;
  goal: string;
  targetUrl: string;
  design: DesignReference | null;
  bounds: Readonly<{ maxCases: number; maxChecks: number; maxChecksPerCase: number }>;
}>;

export type CanonicalPlan = Readonly<{
  requirementsDigest: string;
  goal: string;
  targetUrl: string;
  design: DesignReference | null;
  cases: readonly PlanCase[];
  assignments: Readonly<{ ac: readonly string[]; ui: readonly string[] }>;
  bounds: PlanContext["bounds"];
}>;

const planProposalSchema = z.strictObject({
  cases: z
    .array(
      z.strictObject({
        id: z.string().trim().min(1).max(64),
        title: z.string().trim().min(1).max(200),
        preconditions: z.array(z.string().trim().max(500)).max(20),
        actions: z.array(actionSchema).min(1).max(50),
        checks: z.array(planCheckSchema).min(1).max(50),
      }),
    )
    .min(1),
});

export function canonicalizePlan(raw: unknown, context: PlanContext): Validation<CanonicalPlan> {
  const parsed = planProposalSchema.safeParse(raw);
  if (!parsed.success) {
    return rejected(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  const issues: string[] = [];
  const { maxCases, maxChecks, maxChecksPerCase } = context.bounds;
  const selection = selectedCriteria(context.requirements.criteria, context.requirements.selection);
  const universeIds = new Set(context.requirements.criteria.map((criterion) => criterion.id));
  const selectedIds = new Set(selection.criteria.map((criterion) => criterion.id));
  for (const key of selection.missingKeys) {
    issues.push(`selected criterion ${key} is missing from the extraction`);
  }
  if (parsed.data.cases.length > maxCases) {
    issues.push("plan exceeds the case bound");
  }
  const caseIds = new Set<string>();
  const checkIds = new Set<string>();
  const functionalByCriterion = new Map<string, number>();
  let totalChecks = 0;
  const cases: PlanCase[] = [];
  for (const proposed of parsed.data.cases) {
    if (caseIds.has(proposed.id)) {
      issues.push(`duplicate case id ${proposed.id}`);
      continue;
    }
    caseIds.add(proposed.id);
    if (proposed.checks.length > maxChecksPerCase) {
      issues.push(`case ${proposed.id} exceeds the check bound`);
    }
    totalChecks += proposed.checks.length;
    const checks: PlanCheck[] = [];
    for (const check of proposed.checks) {
      if (checkIds.has(check.id)) {
        issues.push(`duplicate check id ${check.id}`);
        continue;
      }
      checkIds.add(check.id);
      if (!selectedIds.has(check.criterionId)) {
        issues.push(
          universeIds.has(check.criterionId)
            ? `check ${check.id} references an unselected criterion`
            : `check ${check.id} references an unknown criterion`,
        );
        continue;
      }
      if (check.kind === "functional") {
        functionalByCriterion.set(
          check.criterionId,
          (functionalByCriterion.get(check.criterionId) ?? 0) + 1,
        );
      } else if (
        context.design === null ||
        check.design.fileKey !== context.design.fileKey ||
        check.design.nodeId !== context.design.nodeId
      ) {
        issues.push(`style check ${check.id} does not reference the requested design`);
        continue;
      }
      checks.push(check);
    }
    cases.push({
      id: proposed.id,
      title: proposed.title,
      preconditions: proposed.preconditions,
      actions: proposed.actions,
      checks,
    });
  }
  if (totalChecks > maxChecks) {
    issues.push("plan exceeds the check bound");
  }
  for (const criterion of selection.criteria) {
    if ((functionalByCriterion.get(criterion.id) ?? 0) === 0) {
      issues.push(`criterion ${criterion.id} has no functional check`);
    }
  }
  if (issues.length > 0) {
    const [first, ...rest] = issues;

    return first === undefined ? rejected("plan rejected") : rejected(first, ...rest);
  }

  const functional = checksForRole(cases, "ac");
  const styles = checksForRole(cases, "ui");

  return accepted({
    requirementsDigest: context.requirementsDigest,
    goal: context.goal,
    targetUrl: context.targetUrl,
    design: context.design,
    cases,
    assignments: { ac: functional.map((check) => check.id), ui: styles.map((check) => check.id) },
    bounds: context.bounds,
  });
}

export type TrustedToolReceipt = Readonly<{
  id: string;
  role: "ac" | "ui";
  checkId: string;
  inputDigest: string;
  outputDigest: string;
  output: unknown;
  fixture: FixtureIdentity;
}>;

export type CheckResult = Readonly<{
  caseId: string;
  checkId: string;
  judgment: Judgment;
  evidence: NonEmpty<PublicEvidence>;
}>;

export type Results = Readonly<{ role: "ac" | "ui"; checks: readonly CheckResult[] }>;

const resultClaimSchema = z.strictObject({
  caseId: z.string().trim().min(1).max(64),
  checkId: z.string().trim().min(1).max(64),
  judgment: z.enum(["simulated_pass", "simulated_fail", "simulated_blocked"]),
  evidence: z
    .array(
      z.strictObject({
        receiptId: z.string().trim().min(1).max(128),
        digest: z.string().trim().min(1).max(128),
      }),
    )
    .min(1)
    .max(10),
});

const resultsProposalSchema = z.strictObject({
  checks: z.array(resultClaimSchema).min(1).max(200),
});

export type ResultsContext = Readonly<{
  role: "ac" | "ui";
  cases: readonly PlanCase[];
  checks: readonly PlanCheck[];
  receipts: readonly TrustedToolReceipt[];
}>;

function judgmentOf(evidence: PublicEvidence): Judgment {
  switch (evidence.outcome) {
    case "pass":
    case "inside_tolerance":
      return "simulated_pass";
    case "fail":
    case "outside_tolerance":
      return "simulated_fail";
    case "blocked":
      return "simulated_blocked";
  }
}

function numericValue(value: string, unit: "px" | "ratio"): number | null {
  const numberPattern = "([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?)";
  const pattern =
    unit === "px" ? new RegExp(`^${numberPattern}px$`) : new RegExp(`^${numberPattern}$`);
  const match = pattern.exec(value);
  const numericText = match?.[1];
  if (numericText === undefined) {
    return null;
  }
  const numeric = Number(numericText);
  return Number.isFinite(numeric) ? numeric : null;
}

export function withinTolerance(tolerance: Tolerance, expected: string, observed: string): boolean {
  switch (tolerance.kind) {
    case "exact":
      return expected === observed;
    case "numeric": {
      const left = numericValue(expected, tolerance.unit);
      const right = numericValue(observed, tolerance.unit);
      return left !== null && right !== null && Math.abs(left - right) <= tolerance.maxDelta;
    }
  }
}

function evidenceList(values: readonly PublicEvidence[]): NonEmpty<PublicEvidence> | null {
  const [first, ...rest] = values;
  return first === undefined ? null : [first, ...rest];
}

export function validateResults(raw: unknown, context: ResultsContext): Validation<Results> {
  const parsed = resultsProposalSchema.safeParse(raw);
  if (!parsed.success) {
    return rejected(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  const issues: string[] = [];
  const caseByCheck = new Map<string, string>();
  for (const planCase of context.cases) {
    for (const check of planCase.checks) {
      caseByCheck.set(check.id, planCase.id);
    }
  }
  const assigned = new Map(context.checks.map((check) => [check.id, check]));
  const receiptById = new Map(context.receipts.map((receipt) => [receipt.id, receipt]));
  const seen = new Set<string>();
  const checks: CheckResult[] = [];
  for (const claim of parsed.data.checks) {
    const planCheck = assigned.get(claim.checkId);
    if (!planCheck) {
      issues.push(`unknown check ${claim.checkId}`);
      continue;
    }
    if (seen.has(claim.checkId)) {
      issues.push(`duplicate check ${claim.checkId}`);
      continue;
    }
    seen.add(claim.checkId);
    if (caseByCheck.get(claim.checkId) !== claim.caseId) {
      issues.push(`case mismatch for ${claim.checkId}`);
      continue;
    }
    const evidence: PublicEvidence[] = [];
    const digests = new Set<string>();
    for (const item of claim.evidence) {
      const receipt = receiptById.get(item.receiptId);
      if (!receipt) {
        issues.push(`unknown receipt ${item.receiptId}`);
        continue;
      }
      if (receipt.role !== context.role || receipt.checkId !== claim.checkId) {
        issues.push(`receipt ${receipt.id} is not bound to ${claim.checkId}`);
        continue;
      }
      const outputDigest = digestOf(receipt.output);
      if (receipt.outputDigest !== outputDigest || item.digest !== outputDigest) {
        issues.push(`evidence digest mismatch for ${receipt.id}`);
        continue;
      }
      if (digests.has(outputDigest)) {
        issues.push(`duplicate evidence for ${receipt.id}`);
        continue;
      }
      digests.add(outputDigest);
      const output = browserOutputSchema.safeParse(receipt.output);
      if (!output.success || output.data.checkId !== claim.checkId) {
        issues.push(`receipt ${receipt.id} does not carry a matching check result`);
        continue;
      }
      if (output.data.evidence.kind !== planCheck.kind) {
        issues.push(`receipt ${receipt.id} evidence kind does not match the check`);
        continue;
      }
      const outputEvidence = output.data.evidence;
      const planCase = context.cases.find((item) => item.id === claim.caseId);
      if (!planCase) {
        issues.push(`unknown case ${claim.caseId}`);
        continue;
      }
      if (outputEvidence.caseId !== claim.caseId || outputEvidence.checkId !== claim.checkId) {
        issues.push(
          `receipt ${receipt.id} evidence is not bound to ${claim.caseId}/${claim.checkId}`,
        );
        continue;
      }
      if (
        outputEvidence.kind === "functional" &&
        outputEvidence.actionIndex !== planCase.actions.length - 1
      ) {
        issues.push(`receipt ${receipt.id} evidence action index does not match the case frame`);
        continue;
      }
      if (
        outputEvidence.kind === "style" &&
        planCheck.kind === "style" &&
        (outputEvidence.capturedDesign.reference.fileKey !== planCheck.design.fileKey ||
          outputEvidence.capturedDesign.reference.nodeId !== planCheck.design.nodeId)
      ) {
        issues.push(`receipt ${receipt.id} evidence design does not match the check`);
        continue;
      }
      evidence.push(outputEvidence);
    }
    const trustedEvidence = evidenceList(evidence);
    if (!trustedEvidence) {
      issues.push(`check ${claim.checkId} has no trusted evidence`);
      continue;
    }
    const judgment = judgmentOf(trustedEvidence[0]);
    if (claim.judgment !== judgment) {
      issues.push(`judgment for ${claim.checkId} is not supported by trusted evidence`);
      continue;
    }
    checks.push({
      caseId: claim.caseId,
      checkId: claim.checkId,
      judgment,
      evidence: trustedEvidence,
    });
  }
  for (const check of context.checks) {
    if (!seen.has(check.id)) {
      issues.push(`missing check ${check.id}`);
    }
  }
  if (issues.length > 0) {
    const [first, ...rest] = issues;
    return first === undefined ? rejected("results rejected") : rejected(first, ...rest);
  }
  return accepted({ role: context.role, checks });
}

export type Provenance = Readonly<{
  originalRunId: TestRunId;
  originalThreadId: string;
  role: RoleId;
  issuedAt: string;
}>;

const binding: unique symbol = Symbol("testing-domain.binding");

export type ArtifactBinding = Readonly<{
  taskId: string;
  role: RoleId;
  scopeDigest: string;
}>;

export type BoundRequirements = Readonly<{
  ref: ArtifactRef;
  kind: "requirements";
  digest: string;
  payload: Requirements;
  provenance: Provenance;
  dependencies: readonly ArtifactRef[];
  [binding]: ArtifactBinding;
}>;

export type BoundPlan = Readonly<{
  ref: ArtifactRef;
  kind: "plan";
  digest: string;
  payload: CanonicalPlan;
  provenance: Provenance;
  dependencies: readonly ArtifactRef[];
  [binding]: ArtifactBinding;
}>;

export type BoundArtifact = BoundRequirements | BoundPlan;

export type ReuseContext =
  | Readonly<{
      requested: "requirements";
      threadId: string;
      expectedScopeDigest: string;
    }>
  | Readonly<{
      requested: "plan";
      threadId: string;
      expectedScopeDigest: string;
      planContext: PlanContext;
    }>;

const requirementsPayloadSchema = z.strictObject({
  goal: z.string().min(1).max(2_000),
  selection: criteriaSelectionSchema,
  criteria: z.array(requirementCriterionSchema).min(1),
  unresolved: z.array(z.string().min(1)),
  captures: z.array(sourceCaptureSchema).min(1),
});

const planPayloadSchema = z.strictObject({
  requirementsDigest: z.string().min(1).max(128),
  goal: z.string().min(1).max(2_000),
  targetUrl: z.string().min(1).max(2_048),
  design: designReferenceSchema.nullable(),
  cases: z.array(planCaseSchema).min(1),
  assignments: z.strictObject({
    ac: z.array(z.string().min(1)).min(1),
    ui: z.array(z.string().min(1)),
  }),
  bounds: z.strictObject({
    maxCases: z.number().int().positive(),
    maxChecks: z.number().int().positive(),
    maxChecksPerCase: z.number().int().positive(),
  }),
});

const storedArtifactSchema = z.strictObject({
  kind: z.enum(["requirements", "plan", "ac-result", "ui-result"]),
  ref: artifactRefSchema,
  digest: z.string().trim().min(1).max(128),
  threadId: z.string().trim().min(1).max(128),
  payload: z.unknown(),
  scopeDigest: z.string().trim().min(1).max(128),
  dependencies: z.array(artifactRefSchema),
  origin: z.strictObject({
    runId: testRunIdSchema,
    threadId: z.string().trim().min(1).max(128),
    role: z.enum(ROLE_IDS),
    issuedAt: z.string().trim().min(1).max(64),
  }),
});

function boundRequirements(
  artifact: z.infer<typeof storedArtifactSchema>,
  payload: Requirements,
): BoundRequirements {
  return {
    ref: artifact.ref,
    kind: "requirements",
    digest: artifact.digest,
    payload,
    provenance: {
      originalRunId: artifact.origin.runId,
      originalThreadId: artifact.threadId,
      role: artifact.origin.role,
      issuedAt: artifact.origin.issuedAt,
    },
    dependencies: artifact.dependencies,
    [binding]: {
      taskId: `reuse:${artifact.ref}`,
      role: artifact.origin.role,
      scopeDigest: artifact.scopeDigest,
    },
  };
}

function boundPlan(
  artifact: z.infer<typeof storedArtifactSchema>,
  payload: CanonicalPlan,
): BoundPlan {
  return {
    ref: artifact.ref,
    kind: "plan",
    digest: artifact.digest,
    payload,
    provenance: {
      originalRunId: artifact.origin.runId,
      originalThreadId: artifact.threadId,
      role: artifact.origin.role,
      issuedAt: artifact.origin.issuedAt,
    },
    dependencies: artifact.dependencies,
    [binding]: {
      taskId: `reuse:${artifact.ref}`,
      role: artifact.origin.role,
      scopeDigest: artifact.scopeDigest,
    },
  };
}

export function validateReuse(raw: unknown, context: ReuseContext): Validation<BoundArtifact> {
  const parsed = storedArtifactSchema.safeParse(raw);
  if (!parsed.success) {
    return rejected(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  const artifact = parsed.data;
  if (artifact.kind === "ac-result" || artifact.kind === "ui-result") {
    return rejected("cross_run_result_forbidden");
  }
  if (artifact.kind !== context.requested) {
    return rejected("wrong_kind");
  }
  if (artifact.threadId !== context.threadId || artifact.origin.threadId !== context.threadId) {
    return rejected("not_accessible");
  }
  const producer = artifact.kind === "requirements" ? "atlassian" : "planner";
  if (artifact.origin.role !== producer) {
    return rejected("untrusted_producer");
  }
  if (artifact.scopeDigest !== context.expectedScopeDigest) {
    return rejected("scope_mismatch");
  }
  if (artifact.kind === "requirements") {
    const payload = requirementsPayloadSchema.safeParse(artifact.payload);
    if (!payload.success) {
      return rejected("incomplete");
    }
    if (digestOf(payload.data) !== artifact.digest) {
      return rejected("invalid_evidence");
    }
    const selected = selectedCriteria(payload.data.criteria, payload.data.selection);
    if (selected.missingKeys.length > 0) {
      const [key] = selected.missingKeys;
      return key === undefined
        ? rejected("incomplete")
        : rejected(`selected criterion ${key} is missing from the extraction`);
    }
    const scope = requirementsScopeDigest({
      goal: payload.data.goal,
      sources: payload.data.captures.map((capture) => capture.reference),
      selection: payload.data.selection,
    });
    if (scope !== artifact.scopeDigest) {
      return rejected("scope_mismatch");
    }
    return accepted(boundRequirements(artifact, payload.data));
  }
  const payload = planPayloadSchema.safeParse(artifact.payload);
  if (!payload.success) {
    return rejected("incomplete");
  }
  if (digestOf(payload.data) !== artifact.digest) {
    return rejected("invalid_evidence");
  }
  const scope = planScopeDigest({
    goal: payload.data.goal,
    targetUrl: payload.data.targetUrl,
    design: payload.data.design,
    requirementsDigest: payload.data.requirementsDigest,
  });
  if (scope !== artifact.scopeDigest) {
    return rejected("scope_mismatch");
  }
  if (context.requested !== "plan") {
    return rejected("wrong_kind");
  }
  const planContext = context.planContext;
  if (
    digestOf(planContext.requirements) !== planContext.requirementsDigest ||
    payload.data.requirementsDigest !== planContext.requirementsDigest ||
    payload.data.goal !== planContext.goal ||
    payload.data.targetUrl !== planContext.targetUrl ||
    digestOf(payload.data.design) !== digestOf(planContext.design)
  ) {
    return rejected("dependency_rejected");
  }
  const canonical = canonicalizePlan({ cases: payload.data.cases }, planContext);
  if (canonical.kind === "rejected") {
    const [first, ...rest] = canonical.issues;
    return first === undefined ? rejected("plan rejected") : rejected(first, ...rest);
  }
  if (digestOf(canonical.value) !== digestOf(payload.data)) {
    return rejected("invalid_evidence");
  }
  return accepted(boundPlan(artifact, canonical.value));
}

export type RoleOutcome =
  | Readonly<{ kind: "reused"; artifact: ArtifactRef; provenance: ArtifactOrigin }>
  | Readonly<{ kind: "not_required"; reason: "no_style_checks" }>
  | Readonly<{ kind: "waiting"; reason: "dependency" | "dispatch" }>
  | Readonly<{
      kind: "undispatched";
      reason: "cancelled" | "dependency_blocked" | "incompatible" | "timed_out";
    }>
  | Readonly<{ kind: "running"; activity: "model" | "tool" | null; checks?: CheckProgress }>
  | Readonly<{
      kind: "tool_activity";
      active: NonEmpty<ToolActivityView>;
      checks?: CheckProgress;
    }>
  | Readonly<{ kind: "cancelling"; active: readonly ToolActivityView[] }>
  | Readonly<{ kind: "terminal"; outcome: TaskOutcome; reasonCode: string }>;

function rowOf(outcome: RoleOutcome): ProgressRow {
  switch (outcome.kind) {
    case "reused":
      return { status: "reused", artifact: outcome.artifact, provenance: outcome.provenance };
    case "not_required":
      return { status: "not_required", reason: outcome.reason };
    case "waiting":
      return { status: "waiting", reason: outcome.reason };
    case "undispatched":
      return { status: "undispatched", reason: outcome.reason };
    case "running":
      return outcome.checks
        ? { status: "running", activity: outcome.activity, checks: outcome.checks }
        : { status: "running", activity: outcome.activity };
    case "tool_activity":
      return outcome.checks
        ? { status: "tool_activity", active: outcome.active, checks: outcome.checks }
        : { status: "tool_activity", active: outcome.active };
    case "cancelling":
      return { status: "cancelling", active: outcome.active };
    case "terminal":
      return { status: "terminal", outcome: outcome.outcome, reasonCode: outcome.reasonCode };
  }
}

export function projectProgress(
  version: number,
  outcomes: Partial<Record<RoleId, RoleOutcome>>,
  plan: Pick<PublicPlan, "assignments"> | null,
): ProgressCard {
  const rowFor = (role: RoleId): ProgressRow => {
    const outcome = outcomes[role];
    if (outcome) {
      return rowOf(outcome);
    }
    if (role === "ui" && plan && plan.assignments.ui.length === 0) {
      return { status: "not_required", reason: "no_style_checks" };
    }
    return { status: "waiting", reason: "dispatch" };
  };
  return {
    version,
    rows: {
      atlassian: rowFor("atlassian"),
      planner: rowFor("planner"),
      ac: rowFor("ac"),
      ui: rowFor("ui"),
    },
  };
}

export type ReportInput = Readonly<{
  runId: TestRunId;
  rootOutcome: RootRunOutcome;
  requirements: Requirements | null;
  plan: CanonicalPlan | null;
  acResults: Results | null;
  uiResults: Results | null;
  unresolvedSources: readonly Source[];
  artifacts: readonly ArtifactRef[];
  progressVersion: number;
  outcomes: Partial<Record<RoleId, RoleOutcome>>;
}>;

export function deriveReport(input: ReportInput): PublicTestReport {
  const plan: PublicPlan | null = input.plan
    ? {
        cases: input.plan.cases,
        assignments: { ac: input.plan.assignments.ac, ui: input.plan.assignments.ui },
      }
    : null;
  const toPublic = (results: Results | null): readonly PublicCheckResult[] =>
    (results?.checks ?? []).map((check) => ({
      caseId: check.caseId,
      checkId: check.checkId,
      judgment: check.judgment,
      evidence: check.evidence,
    }));
  const coverage: Coverage[] = [];
  const byCheck = new Map<string, Judgment>();
  for (const check of input.acResults?.checks ?? []) {
    byCheck.set(check.checkId, check.judgment);
  }
  for (const check of input.uiResults?.checks ?? []) {
    byCheck.set(check.checkId, check.judgment);
  }
  const coveredCriteria = new Set<string>();
  for (const planCase of plan?.cases ?? []) {
    for (const check of planCase.checks) {
      coveredCriteria.add(check.criterionId);
      coverage.push({
        criterionId: check.criterionId,
        caseId: planCase.id,
        checkId: check.id,
        state: byCheck.get(check.id) ?? "uncovered",
      });
    }
  }
  if (input.requirements) {
    const selected = selectedCriteria(input.requirements.criteria, input.requirements.selection);
    for (const criterion of selected.criteria) {
      if (!coveredCriteria.has(criterion.id)) {
        coverage.push({
          criterionId: criterion.id,
          caseId: null,
          checkId: null,
          state: "uncovered",
        });
      }
    }
  }
  const issues: string[] = [];
  if (!input.requirements) {
    issues.push("requirements_missing");
  }
  if (!plan) {
    issues.push("plan_missing");
  }
  if (plan && plan.assignments.ac.length > 0 && !input.acResults) {
    issues.push("ac_results_missing");
  }
  if (plan && plan.assignments.ui.length > 0 && !input.uiResults) {
    issues.push("ui_results_missing");
  }
  if (input.requirements && input.requirements.unresolved.length > 0) {
    issues.push("requirements_unresolved");
  }
  if (input.unresolvedSources.length > 0) {
    issues.push("sources_unresolved");
  }
  if (coverage.some((row) => row.state === "uncovered")) {
    issues.push("coverage_incomplete");
  }
  if (coverage.some((row) => row.state === "simulated_blocked")) {
    issues.push("blocked_evidence");
  }
  if (input.rootOutcome !== "completed") {
    issues.push(`root_${input.rootOutcome}`);
  }
  for (const role of ROLE_IDS) {
    const outcome = input.outcomes[role];
    if (!outcome) {
      continue;
    }
    switch (outcome.kind) {
      case "reused":
        break;
      case "not_required":
        if (role !== "ui" || plan?.assignments.ui.length !== 0) {
          issues.push(`role_${role}_unexpected_not_required`);
        }
        break;
      case "terminal":
        if (outcome.outcome !== "completed") {
          issues.push(`role_${role}_${outcome.outcome}`);
        }
        break;
      case "undispatched":
        issues.push(`role_${role}_undispatched_${outcome.reason}`);
        break;
      case "waiting":
        issues.push(`role_${role}_waiting`);
        break;
      case "running":
      case "tool_activity":
      case "cancelling":
        issues.push(`role_${role}_${outcome.kind}`);
        break;
    }
  }
  const blocked = nonEmpty(issues);
  const acceptance: Acceptance = blocked
    ? { verdict: "blocked", reasons: blocked }
    : { verdict: "not_verified", reason: "mock_only" };
  return {
    runId: input.runId,
    requirements: input.requirements
      ? {
          goal: input.requirements.goal,
          criteria: input.requirements.criteria,
          selection: input.requirements.selection,
          unresolved: input.requirements.unresolved,
        }
      : null,
    plan,
    results: { ac: toPublic(input.acResults), ui: toPublic(input.uiResults) },
    coverage,
    unresolvedSources: input.unresolvedSources,
    artifacts: input.artifacts,
    roleOutcomes: projectProgress(input.progressVersion, input.outcomes, plan).rows,
    acceptance,
  };
}
