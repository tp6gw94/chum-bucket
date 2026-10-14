import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ROLE_IDS,
  artifactRefSchema,
  browserOutputSchema,
  deferredCaseSchema,
  designReferenceSchema,
  planCaseSchema,
  planCriteriaSchema,
  requirementSourceSchema,
  testRunIdSchema,
  type Acceptance,
  type ArtifactOrigin,
  type ArtifactRef,
  type CheckProgress,
  type Coverage,
  type DeferredCase,
  type DesignReference,
  type FixtureIdentity,
  type FunctionalCheck,
  type Judgment,
  type NonEmpty,
  type PlanCase,
  type PlanCheck,
  type PlanCriterion,
  type ProgressCard,
  type ProgressRow,
  type PublicCheckResult,
  type RootRunOutcome,
  type PublicEvidence,
  type PublicPlan,
  type PublicTestReport,
  type PublicTaskArtifact,
  type RequirementLink,
  type RequirementSource,
  type ArtifactKind,
  type RoleId,
  type Source,
  type StyleCheck,
  type TaskOutcome,
  type TestRunId,
  type Tolerance,
  type ToolActivityView,
} from "../../shared/testing";
import { figmaLinks, readSource, sourceText } from "./source-links";

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

function accepted<T>(value: T): Validation<T> {
  return { kind: "accepted", value };
}

function rejected(issue: string, ...rest: readonly string[]): Validation<never> {
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

function sourceKey(source: Source): string {
  return source.kind === "jira" ? `jira:${source.issueKey}` : `confluence:${source.pageId}`;
}

export function requirementsScopeDigest(
  input: Readonly<{ goal: string; sources: readonly Source[] }>,
): string {
  return digestOf({ goal: input.goal, sources: input.sources.map(sourceKey) });
}

export function planScopeDigest(
  input: Readonly<{
    goal: string;
    targetUrl: string | null;
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

export type Requirements = Readonly<{
  goal: string;
  sources: readonly RequirementSource[];
}>;

export type SourceReadReceipt = Readonly<{
  nativeName: string;
  input: unknown;
  output: unknown;
  outputDigest: string;
  bindings: Readonly<{ capturedAt?: string }>;
}>;

export function schemaIssueMessages(error: z.ZodError, root = "proposal"): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.reduce<string>((text, part) => {
      if (typeof part === "number") {
        return `${text}[${part}]`;
      }

      return `${text}${text ? "." : ""}${String(part)}`;
    }, "");

    return `${path || root}: ${issue.message}`;
  });
}

function schemaIssues(error: z.ZodError, fallback: string): Validation<never> {
  const issues = schemaIssueMessages(error);

  return rejected(issues[0] ?? fallback, ...issues.slice(1));
}

export function sameSource(left: Source, right: Source): boolean {
  if (left.kind === "jira" && right.kind === "jira") {
    return left.issueKey === right.issueKey;
  }

  if (left.kind === "confluence" && right.kind === "confluence") {
    return left.pageId === right.pageId;
  }

  return false;
}

function sourceRead(reference: Source, receipt: SourceReadReceipt): RequirementSource | null {
  const read = readSource(receipt.nativeName, receipt.input);
  const text = read && sameSource(read, reference) ? sourceText(reference, receipt.output) : null;
  const { capturedAt } = receipt.bindings;

  if (text === null || capturedAt === undefined) {
    return null;
  }

  return {
    reference,
    text,
    links: reference.kind === "jira" ? [...figmaLinks(receipt.output)] : [],
    digest: receipt.outputDigest,
    capturedAt,
  };
}

export function assembleRequirements(
  context: Readonly<{ goal: string; sources: readonly Source[] }>,
  receipts: readonly SourceReadReceipt[],
): Validation<Requirements> {
  const sources: RequirementSource[] = [];
  const issues: string[] = [];

  for (const [index, reference] of context.sources.entries()) {
    const read = receipts
      .map((receipt) => sourceRead(reference, receipt))
      .find((item) => item !== null);

    if (read) {
      sources.push(read);
    } else {
      issues.push(`task.sources[${index}]: ${sourceKey(reference)} has no successful read`);
    }
  }

  const failure = nonEmpty(issues);

  return failure ? rejected(...failure) : accepted({ goal: context.goal, sources });
}

export type PlanContext = Readonly<{
  requirementsDigest: string;
  goal: string;
  targetUrl: string | null;
  design: DesignReference | null;
}>;

export type CanonicalPlan = Readonly<{
  requirementsDigest: string;
  goal: string;
  targetUrl: string | null;
  design: DesignReference | null;
  criteria: readonly PlanCriterion[];
  unresolved: readonly string[];
  cases: readonly PlanCase[];
  deferredCases?: readonly DeferredCase[];
  assignments: Readonly<{ ac: readonly string[]; ui: readonly string[] }>;
}>;

const planProposalSchema = z
  .strictObject({
    criteria: planCriteriaSchema,
    unresolved: z.array(z.string().trim().min(1).max(512)),
    cases: z.array(planCaseSchema),
    deferredCases: z.array(deferredCaseSchema).optional(),
  })
  .refine((plan) => plan.cases.length + (plan.deferredCases?.length ?? 0) > 0, {
    path: ["cases"],
    message: "a plan needs at least one executable or deferred case",
  });

type PlanScope = Readonly<{
  criterionIds: ReadonlySet<string>;
  design: DesignReference | null;
}>;

type PlanScan = {
  issues: string[];
  caseIds: Set<string>;
  checkIds: Set<string>;
};

export function sameDesign(left: DesignReference, right: DesignReference | null): boolean {
  return right !== null && left.fileKey === right.fileKey && left.nodeId === right.nodeId;
}

function criterionIds(criteria: readonly PlanCriterion[], scan: PlanScan): ReadonlySet<string> {
  const ids = new Set<string>();

  for (const [index, criterion] of criteria.entries()) {
    if (ids.has(criterion.id)) {
      scan.issues.push(`criteria[${index}].id: duplicate criterion id ${criterion.id}`);
    }

    ids.add(criterion.id);
  }

  return ids;
}

function criterionIssue(subject: string, criterionId: string, scope: PlanScope): string | null {
  return scope.criterionIds.has(criterionId) ? null : `${subject} references an unknown criterion`;
}

function planCheckIssue(check: PlanCheck, scope: PlanScope): string | null {
  const unknown = criterionIssue(`check ${check.id}`, check.criterionId, scope);

  if (unknown) {
    return unknown;
  }

  if (check.kind === "style" && !sameDesign(check.design, scope.design)) {
    return `style check ${check.id} does not reference the requested design`;
  }

  return null;
}

function acceptedPlanChecks(
  proposed: readonly PlanCheck[],
  scope: PlanScope,
  scan: PlanScan,
): PlanCheck[] {
  const checks: PlanCheck[] = [];

  for (const check of proposed) {
    if (scan.checkIds.has(check.id)) {
      scan.issues.push(`duplicate check id ${check.id}`);
      continue;
    }

    scan.checkIds.add(check.id);
    const issue = planCheckIssue(check, scope);

    if (issue) {
      scan.issues.push(issue);
      continue;
    }

    checks.push(check);
  }

  return checks;
}

function canonicalCases(
  proposals: readonly PlanCase[],
  scope: PlanScope,
  scan: PlanScan,
): PlanCase[] {
  const cases: PlanCase[] = [];

  for (const proposed of proposals) {
    if (scan.caseIds.has(proposed.id)) {
      scan.issues.push(`duplicate case id ${proposed.id}`);
      continue;
    }

    scan.caseIds.add(proposed.id);
    cases.push({ ...proposed, checks: acceptedPlanChecks(proposed.checks, scope, scan) });
  }

  return cases;
}

function canonicalDeferredCases(
  proposals: readonly DeferredCase[],
  scope: PlanScope,
  scan: PlanScan,
): DeferredCase[] {
  const deferred: DeferredCase[] = [];

  for (const proposed of proposals) {
    if (scan.caseIds.has(proposed.id)) {
      scan.issues.push(`duplicate case id ${proposed.id}`);
      continue;
    }

    scan.caseIds.add(proposed.id);

    for (const expectation of proposed.expectations) {
      const issue = criterionIssue(`deferred case ${proposed.id}`, expectation.criterionId, scope);

      if (issue) {
        scan.issues.push(issue);
      }
    }

    deferred.push(proposed);
  }

  return deferred;
}

export function canonicalizePlan(raw: unknown, context: PlanContext): Validation<CanonicalPlan> {
  const parsed = planProposalSchema.safeParse(raw);

  if (!parsed.success) {
    return schemaIssues(parsed.error, "plan rejected");
  }

  const { criteria, unresolved } = parsed.data;
  const proposedDeferred = parsed.data.deferredCases ?? [];
  const scan: PlanScan = { issues: [], caseIds: new Set(), checkIds: new Set() };
  const scope: PlanScope = { criterionIds: criterionIds(criteria, scan), design: context.design };

  const cases = canonicalCases(parsed.data.cases, scope, scan);
  const deferredCases = canonicalDeferredCases(proposedDeferred, scope, scan);

  const failure = nonEmpty(scan.issues);

  if (failure) {
    return rejected(...failure);
  }

  const functional = checksForRole(cases, "ac");
  const styles = checksForRole(cases, "ui");

  return accepted({
    requirementsDigest: context.requirementsDigest,
    goal: context.goal,
    targetUrl: context.targetUrl,
    design: context.design,
    criteria,
    unresolved,
    cases,
    ...(deferredCases.length > 0 ? { deferredCases } : {}),
    assignments: { ac: functional.map((check) => check.id), ui: styles.map((check) => check.id) },
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
  judgment: z.enum([
    "pass",
    "fail",
    "blocked",
    "simulated_pass",
    "simulated_fail",
    "simulated_blocked",
  ]),
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
  checks: z.array(resultClaimSchema).min(1),
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
      return evidence.origin === "browser" ? "pass" : "simulated_pass";
    case "fail":
    case "outside_tolerance":
      return evidence.origin === "browser" ? "fail" : "simulated_fail";
    case "blocked":
      return evidence.origin === "browser" ? "blocked" : "simulated_blocked";
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

function normalizedColor(value: string): string {
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*1)?\)$/.exec(value);

  if (rgb && rgb.slice(1).every((channel) => Number(channel) <= 255)) {
    return `#${rgb
      .slice(1)
      .map((channel) => Number(channel).toString(16).padStart(2, "0"))
      .join("")}`;
  }

  if (/^#[0-9a-f]{6}$/i.test(value)) {
    return value.toLowerCase();
  }

  if (/^#[0-9a-f]{3}$/i.test(value)) {
    return `#${value
      .slice(1)
      .split("")
      .map((channel) => channel + channel)
      .join("")
      .toLowerCase()}`;
  }

  return value;
}

export function withinTolerance(tolerance: Tolerance, expected: string, observed: string): boolean {
  switch (tolerance.kind) {
    case "exact":
      return normalizedColor(expected) === normalizedColor(observed);

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

type Checked<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; issue: string }>;

function pass<T>(value: T): Checked<T> {
  return { ok: true, value };
}

function fail(issue: string): Checked<never> {
  return { ok: false, issue };
}

type ResultClaim = z.infer<typeof resultClaimSchema>;
type EvidenceClaim = ResultClaim["evidence"][number];
type BrowserEvidence = z.infer<typeof browserOutputSchema>["evidence"];

type ClaimScope = Readonly<{
  claim: ResultClaim;
  planCheck: PlanCheck;
  role: "ac" | "ui";
  cases: readonly PlanCase[];
  receiptById: ReadonlyMap<string, TrustedToolReceipt>;
}>;

function trustedReceipt(item: EvidenceClaim, scope: ClaimScope): Checked<TrustedToolReceipt> {
  const receipt = scope.receiptById.get(item.receiptId);

  if (!receipt) {
    return fail(`unknown receipt ${item.receiptId}`);
  }

  if (receipt.role !== scope.role || receipt.checkId !== scope.claim.checkId) {
    return fail(`receipt ${receipt.id} is not bound to ${scope.claim.checkId}`);
  }

  const outputDigest = digestOf(receipt.output);

  if (receipt.outputDigest !== outputDigest || item.digest !== outputDigest) {
    return fail(`evidence digest mismatch for ${receipt.id}`);
  }

  return pass(receipt);
}

function framedEvidence(
  evidence: BrowserEvidence,
  planCase: PlanCase,
  planCheck: PlanCheck,
  receiptId: string,
): Checked<PublicEvidence> {
  if (evidence.kind === "functional" && evidence.actionIndex !== planCase.actions.length - 1) {
    return fail(`receipt ${receiptId} evidence action index does not match the case frame`);
  }

  if (
    evidence.kind === "style" &&
    planCheck.kind === "style" &&
    !sameDesign(evidence.capturedDesign.reference, planCheck.design)
  ) {
    return fail(`receipt ${receiptId} evidence design does not match the check`);
  }

  return pass(evidence);
}

function receiptEvidence(receipt: TrustedToolReceipt, scope: ClaimScope): Checked<PublicEvidence> {
  const { claim } = scope;
  const output = browserOutputSchema.safeParse(receipt.output);

  if (!output.success || output.data.checkId !== claim.checkId) {
    return fail(`receipt ${receipt.id} does not carry a matching check result`);
  }

  const evidence = output.data.evidence;

  if (evidence.kind !== scope.planCheck.kind) {
    return fail(`receipt ${receipt.id} evidence kind does not match the check`);
  }

  const planCase = scope.cases.find((item) => item.id === claim.caseId);

  if (!planCase) {
    return fail(`unknown case ${claim.caseId}`);
  }

  if (evidence.caseId !== claim.caseId || evidence.checkId !== claim.checkId) {
    return fail(`receipt ${receipt.id} evidence is not bound to ${claim.caseId}/${claim.checkId}`);
  }

  return framedEvidence(evidence, planCase, scope.planCheck, receipt.id);
}

export function assembleToolResults(context: Omit<ResultsContext, "checks">): Results {
  const receiptById = new Map(context.receipts.map((receipt) => [receipt.id, receipt]));
  const assigned = context.cases.flatMap((planCase) =>
    checksForRole([planCase], context.role).map((planCheck) => ({ planCase, planCheck })),
  );
  const checks = assigned.flatMap(({ planCase, planCheck }) =>
    context.receipts.flatMap((receipt): CheckResult[] => {
      const claim = {
        caseId: planCase.id,
        checkId: planCheck.id,
        judgment: "pass" as const,
        evidence: [{ receiptId: receipt.id, digest: receipt.outputDigest }],
      };
      const scope = { claim, planCheck, role: context.role, cases: context.cases, receiptById };
      const trusted = trustedReceipt(claim.evidence[0]!, scope);

      if (!trusted.ok) {
        return [];
      }

      const observed = receiptEvidence(trusted.value, scope);

      return observed.ok
        ? [
            {
              caseId: planCase.id,
              checkId: planCheck.id,
              judgment: judgmentOf(observed.value),
              evidence: [observed.value],
            },
          ]
        : [];
    }),
  );

  return { role: context.role, checks };
}

function claimEvidence(scope: ClaimScope, issues: string[]): PublicEvidence[] {
  const evidence: PublicEvidence[] = [];
  const digests = new Set<string>();

  for (const item of scope.claim.evidence) {
    const receipt = trustedReceipt(item, scope);

    if (!receipt.ok) {
      issues.push(receipt.issue);
      continue;
    }

    if (digests.has(receipt.value.outputDigest)) {
      issues.push(`duplicate evidence for ${receipt.value.id}`);
      continue;
    }

    digests.add(receipt.value.outputDigest);
    const checked = receiptEvidence(receipt.value, scope);

    if (!checked.ok) {
      issues.push(checked.issue);
      continue;
    }

    evidence.push(checked.value);
  }

  return evidence;
}

function claimResult(scope: ClaimScope, issues: string[]): CheckResult | null {
  const { claim } = scope;
  const trustedEvidence = evidenceList(claimEvidence(scope, issues));

  if (!trustedEvidence) {
    issues.push(`check ${claim.checkId} has no trusted evidence`);

    return null;
  }

  const judgment = judgmentOf(trustedEvidence[0]);

  if (claim.judgment !== judgment) {
    issues.push(`judgment for ${claim.checkId} is not supported by trusted evidence`);

    return null;
  }

  return {
    caseId: claim.caseId,
    checkId: claim.checkId,
    judgment,
    evidence: trustedEvidence,
  };
}

type ClaimLedger = Readonly<{
  assigned: ReadonlyMap<string, PlanCheck>;
  caseByCheck: ReadonlyMap<string, string>;
  seen: Set<string>;
}>;

function claimedCheck(claim: ResultClaim, ledger: ClaimLedger): Checked<PlanCheck> {
  const planCheck = ledger.assigned.get(claim.checkId);

  if (!planCheck) {
    return fail(`unknown check ${claim.checkId}`);
  }

  if (ledger.seen.has(claim.checkId)) {
    return fail(`duplicate check ${claim.checkId}`);
  }

  ledger.seen.add(claim.checkId);

  if (ledger.caseByCheck.get(claim.checkId) !== claim.caseId) {
    return fail(`case mismatch for ${claim.checkId}`);
  }

  return pass(planCheck);
}

export function validateResults(raw: unknown, context: ResultsContext): Validation<Results> {
  const parsed = resultsProposalSchema.safeParse(raw);

  if (!parsed.success) {
    return rejected(parsed.error.issues.map((issue) => issue.message).join("; "));
  }

  const issues: string[] = [];
  const ledger: ClaimLedger = {
    assigned: new Map(context.checks.map((check) => [check.id, check])),
    caseByCheck: new Map(
      context.cases.flatMap((planCase) =>
        planCase.checks.map((check) => [check.id, planCase.id] as const),
      ),
    ),
    seen: new Set(),
  };
  const receiptById = new Map(context.receipts.map((receipt) => [receipt.id, receipt]));
  const checks: CheckResult[] = [];

  for (const claim of parsed.data.checks) {
    const planCheck = claimedCheck(claim, ledger);

    if (!planCheck.ok) {
      issues.push(planCheck.issue);
      continue;
    }

    const result = claimResult(
      { claim, planCheck: planCheck.value, role: context.role, cases: context.cases, receiptById },
      issues,
    );

    if (result) {
      checks.push(result);
    }
  }

  for (const check of context.checks) {
    if (!ledger.seen.has(check.id)) {
      issues.push(`missing check ${check.id}`);
    }
  }

  const failure = nonEmpty(issues);

  if (failure) {
    return rejected(...failure);
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

export const requirementsPayloadSchema = z.strictObject({
  goal: z.string().min(1).max(2_000),
  sources: z.array(requirementSourceSchema).min(1),
});

export const planPayloadSchema = z.strictObject({
  requirementsDigest: z.string().min(1).max(128),
  goal: z.string().min(1).max(2_000),
  targetUrl: z.string().min(1).max(2_048).nullable(),
  design: designReferenceSchema.nullable(),
  criteria: planCriteriaSchema,
  unresolved: z.array(z.string().min(1)),
  cases: z.array(planCaseSchema),
  deferredCases: z.array(deferredCaseSchema).optional(),
  assignments: z.strictObject({
    ac: z.array(z.string().min(1)),
    ui: z.array(z.string().min(1)),
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

type StoredArtifact = z.infer<typeof storedArtifactSchema>;

function reuseAccessIssue(artifact: StoredArtifact, context: ReuseContext): string | null {
  if (artifact.kind === "ac-result" || artifact.kind === "ui-result") {
    return "cross_run_result_forbidden";
  }

  if (artifact.kind !== context.requested) {
    return "wrong_kind";
  }

  if (artifact.threadId !== context.threadId || artifact.origin.threadId !== context.threadId) {
    return "not_accessible";
  }

  const producer = artifact.kind === "requirements" ? "atlassian" : "planner";

  if (artifact.origin.role !== producer) {
    return "untrusted_producer";
  }

  return artifact.scopeDigest === context.expectedScopeDigest ? null : "scope_mismatch";
}

function reuseRequirements(artifact: StoredArtifact): Validation<BoundArtifact> {
  const payload = requirementsPayloadSchema.safeParse(artifact.payload);

  if (!payload.success) {
    return rejected("incomplete");
  }

  if (digestOf(payload.data) !== artifact.digest) {
    return rejected("invalid_evidence");
  }

  const scope = requirementsScopeDigest({
    goal: payload.data.goal,
    sources: payload.data.sources.map((source) => source.reference),
  });

  if (scope !== artifact.scopeDigest) {
    return rejected("scope_mismatch");
  }

  return accepted(boundRequirements(artifact, payload.data));
}

type PlanPayload = z.infer<typeof planPayloadSchema>;

function planDependenciesMatch(payload: PlanPayload, planContext: PlanContext): boolean {
  return (
    payload.requirementsDigest === planContext.requirementsDigest &&
    payload.goal === planContext.goal &&
    payload.targetUrl === planContext.targetUrl &&
    digestOf(payload.design) === digestOf(planContext.design)
  );
}

function reusePlan(artifact: StoredArtifact, context: ReuseContext): Validation<BoundArtifact> {
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

  if (!planDependenciesMatch(payload.data, context.planContext)) {
    return rejected("dependency_rejected");
  }

  const canonical = canonicalizePlan(
    {
      criteria: payload.data.criteria,
      unresolved: payload.data.unresolved,
      cases: payload.data.cases,
      ...(payload.data.deferredCases ? { deferredCases: payload.data.deferredCases } : {}),
    },
    context.planContext,
  );

  if (canonical.kind === "rejected") {
    return rejected(...canonical.issues);
  }

  if (digestOf(canonical.value) !== digestOf(payload.data)) {
    return rejected("invalid_evidence");
  }

  return accepted(boundPlan(artifact, canonical.value));
}

export function validateReuse(raw: unknown, context: ReuseContext): Validation<BoundArtifact> {
  const parsed = storedArtifactSchema.safeParse(raw);

  if (!parsed.success) {
    return rejected(parsed.error.issues.map((issue) => issue.message).join("; "));
  }

  const issue = reuseAccessIssue(parsed.data, context);

  if (issue) {
    return rejected(issue);
  }

  return parsed.data.kind === "requirements"
    ? reuseRequirements(parsed.data)
    : reusePlan(parsed.data, context);
}

export type RoleOutcome =
  | Readonly<{ kind: "reused"; artifact: ArtifactRef; provenance: ArtifactOrigin }>
  | Readonly<{ kind: "not_required"; reason: "no_style_checks" | "no_functional_checks" }>
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
  | Readonly<{
      kind: "terminal";
      outcome: TaskOutcome;
      reasonCode: string;
      issues?: readonly string[];
    }>;

function withChecks(checks: CheckProgress | undefined): Readonly<{ checks?: CheckProgress }> {
  return checks ? { checks } : {};
}

function withIssues(
  issues: readonly string[] | undefined,
): Readonly<{ issues?: readonly string[] }> {
  return issues ? { issues } : {};
}

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
      return { status: "running", activity: outcome.activity, ...withChecks(outcome.checks) };
    case "tool_activity":
      return { status: "tool_activity", active: outcome.active, ...withChecks(outcome.checks) };
    case "cancelling":
      return { status: "cancelling", active: outcome.active };
    case "terminal":
      return {
        status: "terminal",
        outcome: outcome.outcome,
        reasonCode: outcome.reasonCode,
        ...withIssues(outcome.issues),
      };
  }
}

const MAX_PUBLIC_ISSUES = 8;
const MAX_PUBLIC_ISSUE_LENGTH = 240;

export function publicIssues(issues: readonly string[]): string[] {
  const bounded = issues
    .map((issue) => issue.trim().slice(0, MAX_PUBLIC_ISSUE_LENGTH).trim())
    .filter((issue) => issue.length > 0);

  return [...new Set(bounded)].slice(0, MAX_PUBLIC_ISSUES);
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

    if (role === "ac" && plan && plan.assignments.ac.length === 0) {
      return { status: "not_required", reason: "no_functional_checks" };
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

function publicPlan(plan: CanonicalPlan | null): PublicPlan | null {
  return plan
    ? {
        criteria: plan.criteria,
        unresolved: plan.unresolved,
        cases: plan.cases,
        ...(plan.deferredCases ? { deferredCases: plan.deferredCases } : {}),
        assignments: { ac: plan.assignments.ac, ui: plan.assignments.ui },
      }
    : null;
}

function publicResults(results: Results | null): readonly PublicCheckResult[] {
  return (results?.checks ?? []).map((check) => ({
    caseId: check.caseId,
    checkId: check.checkId,
    judgment: check.judgment,
    evidence: check.evidence,
  }));
}

function judgmentsByCheck(input: ReportInput): ReadonlyMap<string, Judgment> {
  return new Map(
    [...(input.acResults?.checks ?? []), ...(input.uiResults?.checks ?? [])].map((check) => [
      check.checkId,
      check.judgment,
    ]),
  );
}

function uncoveredCriteria(plan: PublicPlan | null, covered: ReadonlySet<string>): Coverage[] {
  return (plan?.criteria ?? [])
    .filter((criterion) => !covered.has(criterion.id))
    .map((criterion): Coverage => ({
      criterionId: criterion.id,
      caseId: null,
      checkId: null,
      state: "uncovered",
    }));
}

function reportCoverage(input: ReportInput, plan: PublicPlan | null): Coverage[] {
  const byCheck = judgmentsByCheck(input);
  const planned = (plan?.cases ?? []).flatMap((planCase) =>
    planCase.checks.map((check): Coverage => ({
      criterionId: check.criterionId,
      caseId: planCase.id,
      checkId: check.id,
      state: byCheck.get(check.id) ?? "uncovered",
    })),
  );
  const deferred = (plan?.deferredCases ?? []).flatMap((deferredCase) =>
    deferredCase.expectations.map((expectation): Coverage => ({
      criterionId: expectation.criterionId,
      caseId: deferredCase.id,
      checkId: null,
      state: "deferred",
    })),
  );
  const covered = new Set([...planned, ...deferred].map((row) => row.criterionId));

  return [...planned, ...deferred, ...uncoveredCriteria(plan, covered)];
}

function resultsMissing(assigned: readonly string[] | undefined, results: Results | null): boolean {
  return (assigned?.length ?? 0) > 0 && !results;
}

function reportIssues(
  input: ReportInput,
  plan: PublicPlan | null,
  coverage: readonly Coverage[],
): string[] {
  const conditions: ReadonlyArray<readonly [boolean, string]> = [
    [!input.requirements, "requirements_missing"],
    [!plan, "plan_missing"],
    [resultsMissing(plan?.assignments.ac, input.acResults), "ac_results_missing"],
    [resultsMissing(plan?.assignments.ui, input.uiResults), "ui_results_missing"],
    [(plan?.unresolved.length ?? 0) > 0, "requirements_unresolved"],
    [input.unresolvedSources.length > 0, "sources_unresolved"],
    [coverage.some((row) => row.state === "uncovered"), "coverage_incomplete"],
    [
      coverage.some((row) => row.state === "simulated_blocked" || row.state === "blocked"),
      "blocked_evidence",
    ],
    [input.rootOutcome !== "completed", `root_${input.rootOutcome}`],
  ];

  return conditions.filter(([failed]) => failed).map(([, issue]) => issue);
}

function notRequiredIssue(role: RoleId, plan: PublicPlan | null): string | null {
  return (role === "ui" || role === "ac") && plan?.assignments[role].length === 0
    ? null
    : `role_${role}_unexpected_not_required`;
}

function roleIssue(role: RoleId, outcome: RoleOutcome, plan: PublicPlan | null): string | null {
  switch (outcome.kind) {
    case "reused":
      return null;
    case "not_required":
      return notRequiredIssue(role, plan);
    case "terminal":
      return outcome.outcome === "completed" ? null : `role_${role}_${outcome.outcome}`;
    case "undispatched":
      return `role_${role}_undispatched_${outcome.reason}`;
    case "waiting":
      return `role_${role}_waiting`;
    default:
      return `role_${role}_${outcome.kind}`;
  }
}

function roleIssues(input: ReportInput, plan: PublicPlan | null): string[] {
  return ROLE_IDS.flatMap((role) => {
    const outcome = input.outcomes[role];
    const issue = outcome ? roleIssue(role, outcome, plan) : null;

    return issue ? [issue] : [];
  });
}

function requirementLinks(requirements: Requirements): RequirementLink[] {
  return requirements.sources.flatMap((source) =>
    source.links.map((link) => ({ source: source.reference, ...link })),
  );
}

function publicRequirements(requirements: Requirements | null): PublicTestReport["requirements"] {
  if (!requirements) {
    return null;
  }

  const links = requirementLinks(requirements);

  return {
    goal: requirements.goal,
    sources: requirements.sources,
    ...(links.length > 0 ? { links } : {}),
  };
}

export function publicTaskArtifact(
  artifact: Readonly<{ ref: string; kind: ArtifactKind; payload: unknown }>,
): PublicTaskArtifact {
  const ref = artifactRefSchema.parse(artifact.ref);

  switch (artifact.kind) {
    case "requirements":
      return {
        ref,
        kind: artifact.kind,
        payload: publicRequirements(artifact.payload as Requirements)!,
      };
    case "plan":
      return { ref, kind: artifact.kind, payload: publicPlan(artifact.payload as CanonicalPlan)! };
    case "ac-result":
    case "ui-result":
      return { ref, kind: artifact.kind, payload: publicResults(artifact.payload as Results) };
  }
}

export function deriveReport(input: ReportInput): PublicTestReport {
  const plan = publicPlan(input.plan);
  const coverage = reportCoverage(input, plan);
  const blocked = nonEmpty([...reportIssues(input, plan, coverage), ...roleIssues(input, plan)]);
  const acceptance: Acceptance = blocked
    ? { verdict: "blocked", reasons: blocked }
    : {
        verdict: "not_verified",
        reason: coverage.some((row) => ["pass", "fail", "blocked", "deferred"].includes(row.state))
          ? "release_not_assessed"
          : "mock_only",
      };

  return {
    runId: input.runId,
    requirements: publicRequirements(input.requirements),
    plan,
    results: { ac: publicResults(input.acResults), ui: publicResults(input.uiResults) },
    coverage,
    unresolvedSources: input.unresolvedSources,
    artifacts: input.artifacts,
    roleOutcomes: projectProgress(input.progressVersion, input.outcomes, plan).rows,
    acceptance,
  };
}
