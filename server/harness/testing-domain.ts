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
  type PublicTaskArtifact,
  type ArtifactKind,
  type RequirementCriterion,
  type RoleId,
  type Source,
  type StyleCheck,
  type TaskOutcome,
  type TestRunId,
  type Tolerance,
  type ToolActivityView,
} from "../../shared/testing";

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

export const sourceCaptureSchema = z.strictObject({
  reference: sourceSchema,
  digest: z.string().trim().min(1).max(128),
  anchors: z.array(z.string().trim().min(1).max(512)).min(1),
  capturedAt: z.string().trim().min(1).max(64),
});
export type SourceCapture = Readonly<z.infer<typeof sourceCaptureSchema>>;

export function sourceCaptureView(capture: SourceCapture) {
  return {
    ...capture,
    anchorRefs: capture.anchors.map((anchor) => ({
      id: digestOf({
        namespace: "requirements-anchor-v1",
        reference: capture.reference,
        digest: capture.digest,
        anchor,
      }),
      text: anchor,
    })),
  };
}

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
      z
        .strictObject({
          key: z.string().trim().min(1).max(128),
          statement: z.string().trim().min(1).max(2_000),
          source: sourceSchema,
          anchor: z.string().trim().min(1).max(512).optional(),
          anchorId: z.string().trim().min(1).max(128).optional(),
        })
        .refine(
          (criterion) => (criterion.anchor === undefined) !== (criterion.anchorId === undefined),
          {
            path: ["anchorId"],
            message: "exactly one of anchorId or legacy anchor is required",
          },
        ),
    )
    .min(1),
  unresolved: z.array(z.string().trim().min(1).max(512)).max(50),
});

const notExtractableSchema = z.strictObject({
  kind: z.literal("not_extractable"),
  unresolved: z.array(z.string().trim().min(1).max(512)).min(1).max(50),
});

export type RequirementsDecision =
  | Validation<Requirements>
  | Readonly<{
      kind: "not_extractable";
      unresolved: readonly string[];
    }>;

function requirementsSchemaIssues(error: z.ZodError): Validation<never> {
  const issues = error.issues.map((issue) => {
    const path = issue.path.reduce<string>(
      (text, part) =>
        typeof part === "number" ? `${text}[${part}]` : `${text}${text ? "." : ""}${String(part)}`,
      "",
    );

    return `${path || "proposal"}: ${issue.message}`;
  });

  return rejected(issues[0] ?? "requirements rejected", ...issues.slice(1));
}

export type RequirementsContext = Readonly<{
  goal: string;
  selection: CriteriaSelection;
  captures: readonly SourceCapture[];
}>;

export function sameSource(left: Source, right: Source): boolean {
  if (left.kind === "jira" && right.kind === "jira") {
    return left.issueKey === right.issueKey;
  }

  if (left.kind === "confluence" && right.kind === "confluence") {
    return left.pageId === right.pageId;
  }

  return false;
}

type RequirementProposal = z.infer<typeof requirementsProposalSchema>["criteria"][number];

function resolveRequirementCriterion(
  proposal: RequirementProposal,
  captures: readonly SourceCapture[],
  index: number,
): Validation<RequirementCriterion> {
  const capture = captures.find((item) => sameSource(item.reference, proposal.source));

  if (!capture) {
    return rejected(
      `criteria[${index}].source: criterion ${proposal.key} references an uncaptured source`,
    );
  }

  const anchor =
    proposal.anchorId === undefined
      ? proposal.anchor
      : sourceCaptureView(capture).anchorRefs.find((ref) => ref.id === proposal.anchorId)?.text;

  if (anchor === undefined || !capture.anchors.includes(anchor)) {
    return rejected(
      proposal.anchorId === undefined
        ? `criteria[${index}].anchor: criterion ${proposal.key} references an unknown anchor for this source capture`
        : `criteria[${index}].anchorId: unknown anchor for host-selected capture ${capture.digest}; use anchorRefs ids ${sourceCaptureView(
            capture,
          )
            .anchorRefs.slice(0, 3)
            .map((ref) => ref.id)
            .join(", ")}. Later reads do not replace this capture.`,
    );
  }

  return accepted({
    id: `crit:${proposal.key}`,
    key: proposal.key,
    statement: proposal.statement,
    sourceDigest: capture.digest,
    anchor,
  });
}

function extractRequirementCriteria(
  proposals: readonly RequirementProposal[],
  captures: readonly SourceCapture[],
) {
  const issues: string[] = [];
  const keys = new Set<string>();
  const criteria: RequirementCriterion[] = [];

  for (const [index, proposal] of proposals.entries()) {
    const duplicate = keys.has(proposal.key);

    if (duplicate) {
      issues.push(`criteria[${index}].key: duplicate criterion key ${proposal.key}`);
    }

    keys.add(proposal.key);
    const resolved = resolveRequirementCriterion(proposal, captures, index);

    if (resolved.kind === "rejected") {
      issues.push(...resolved.issues);
    } else if (!duplicate) {
      criteria.push(resolved.value);
    }
  }

  return { criteria, issues };
}

export function validateRequirements(
  raw: unknown,
  context: RequirementsContext,
): RequirementsDecision {
  if (context.captures.length === 0) {
    return rejected("requirements need at least one source capture");
  }

  if (typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === "not_extractable") {
    const failure = notExtractableSchema.safeParse(raw);

    return failure.success
      ? { kind: "not_extractable", unresolved: failure.data.unresolved }
      : requirementsSchemaIssues(failure.error);
  }

  const parsed = requirementsProposalSchema.safeParse(raw);

  if (!parsed.success) {
    return requirementsSchemaIssues(parsed.error);
  }

  const { criteria, issues } = extractRequirementCriteria(parsed.data.criteria, context.captures);

  const selected = selectedCriteria(criteria, context.selection);

  for (const key of selected.missingKeys) {
    const index = context.selection.kind === "selected" ? context.selection.keys.indexOf(key) : 0;
    issues.push(
      `task.criteria.keys[${index}]: selected criterion ${key} is missing from the extraction`,
    );
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
  targetUrl: string | null;
  design: DesignReference | null;
  bounds: Readonly<{ maxCases: number; maxChecks: number; maxChecksPerCase: number }>;
}>;

export type CanonicalPlan = Readonly<{
  requirementsDigest: string;
  goal: string;
  targetUrl: string | null;
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

type PlanProposal = z.infer<typeof planProposalSchema>;

type PlanScope = Readonly<{
  universeIds: ReadonlySet<string>;
  selectedIds: ReadonlySet<string>;
  design: DesignReference | null;
}>;

type PlanScan = {
  issues: string[];
  checkIds: Set<string>;
  functionalByCriterion: Map<string, number>;
  totalChecks: number;
};

export function sameDesign(left: DesignReference, right: DesignReference | null): boolean {
  return right !== null && left.fileKey === right.fileKey && left.nodeId === right.nodeId;
}

function planCheckIssue(check: PlanCheck, scope: PlanScope): string | null {
  if (!scope.selectedIds.has(check.criterionId)) {
    return scope.universeIds.has(check.criterionId)
      ? `check ${check.id} references an unselected criterion`
      : `check ${check.id} references an unknown criterion`;
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

    if (check.kind === "functional") {
      scan.functionalByCriterion.set(
        check.criterionId,
        (scan.functionalByCriterion.get(check.criterionId) ?? 0) + 1,
      );
    }

    checks.push(check);
  }

  return checks;
}

function canonicalCases(
  proposals: PlanProposal["cases"],
  scope: PlanScope,
  maxChecksPerCase: number,
  scan: PlanScan,
): PlanCase[] {
  const caseIds = new Set<string>();
  const cases: PlanCase[] = [];

  for (const proposed of proposals) {
    if (caseIds.has(proposed.id)) {
      scan.issues.push(`duplicate case id ${proposed.id}`);
      continue;
    }

    caseIds.add(proposed.id);

    if (proposed.checks.length > maxChecksPerCase) {
      scan.issues.push(`case ${proposed.id} exceeds the check bound`);
    }

    scan.totalChecks += proposed.checks.length;
    cases.push({
      id: proposed.id,
      title: proposed.title,
      preconditions: proposed.preconditions,
      actions: proposed.actions,
      checks: acceptedPlanChecks(proposed.checks, scope, scan),
    });
  }

  return cases;
}

export function canonicalizePlan(raw: unknown, context: PlanContext): Validation<CanonicalPlan> {
  const parsed = planProposalSchema.safeParse(raw);

  if (!parsed.success) {
    return rejected(parsed.error.issues.map((issue) => issue.message).join("; "));
  }

  const { maxCases, maxChecks, maxChecksPerCase } = context.bounds;
  const selection = selectedCriteria(context.requirements.criteria, context.requirements.selection);
  const scope: PlanScope = {
    universeIds: new Set(context.requirements.criteria.map((criterion) => criterion.id)),
    selectedIds: new Set(selection.criteria.map((criterion) => criterion.id)),
    design: context.design,
  };
  const scan: PlanScan = {
    issues: selection.missingKeys.map(
      (key) => `selected criterion ${key} is missing from the extraction`,
    ),
    checkIds: new Set(),
    functionalByCriterion: new Map(),
    totalChecks: 0,
  };

  if (parsed.data.cases.length > maxCases) {
    scan.issues.push("plan exceeds the case bound");
  }

  const cases = canonicalCases(parsed.data.cases, scope, maxChecksPerCase, scan);

  if (scan.totalChecks > maxChecks) {
    scan.issues.push("plan exceeds the check bound");
  }

  for (const criterion of selection.criteria) {
    if (!scan.functionalByCriterion.has(criterion.id)) {
      scan.issues.push(`criterion ${criterion.id} has no functional check`);
    }
  }

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
  selection: criteriaSelectionSchema,
  criteria: z.array(requirementCriterionSchema).min(1),
  unresolved: z.array(z.string().min(1)),
  captures: z.array(sourceCaptureSchema).min(1),
});

export const planPayloadSchema = z.strictObject({
  requirementsDigest: z.string().min(1).max(128),
  goal: z.string().min(1).max(2_000),
  targetUrl: z.string().min(1).max(2_048).nullable(),
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

  const [missingKey] = selectedCriteria(payload.data.criteria, payload.data.selection).missingKeys;

  if (missingKey !== undefined) {
    return rejected(`selected criterion ${missingKey} is missing from the extraction`);
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

type PlanPayload = z.infer<typeof planPayloadSchema>;

function planDependenciesMatch(payload: PlanPayload, planContext: PlanContext): boolean {
  return (
    digestOf(planContext.requirements) === planContext.requirementsDigest &&
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

  const canonical = canonicalizePlan({ cases: payload.data.cases }, context.planContext);

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

function withChecks(checks: CheckProgress | undefined): Readonly<{ checks?: CheckProgress }> {
  return checks ? { checks } : {};
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

function publicPlan(plan: CanonicalPlan | null): PublicPlan | null {
  return plan
    ? { cases: plan.cases, assignments: { ac: plan.assignments.ac, ui: plan.assignments.ui } }
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

function uncoveredCriteria(
  requirements: Requirements | null,
  covered: ReadonlySet<string>,
): Coverage[] {
  if (!requirements) {
    return [];
  }

  return selectedCriteria(requirements.criteria, requirements.selection)
    .criteria.filter((criterion) => !covered.has(criterion.id))
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
  const covered = new Set(planned.map((row) => row.criterionId));

  return [...planned, ...uncoveredCriteria(input.requirements, covered)];
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
    [(input.requirements?.unresolved.length ?? 0) > 0, "requirements_unresolved"],
    [input.unresolvedSources.length > 0, "sources_unresolved"],
    [coverage.some((row) => row.state === "uncovered"), "coverage_incomplete"],
    [coverage.some((row) => row.state === "simulated_blocked"), "blocked_evidence"],
    [input.rootOutcome !== "completed", `root_${input.rootOutcome}`],
  ];

  return conditions.filter(([failed]) => failed).map(([, issue]) => issue);
}

function notRequiredIssue(role: RoleId, plan: PublicPlan | null): string | null {
  return role === "ui" && plan?.assignments.ui.length === 0
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

function publicRequirements(requirements: Requirements | null): PublicTestReport["requirements"] {
  return requirements
    ? {
        goal: requirements.goal,
        criteria: requirements.criteria,
        selection: requirements.selection,
        unresolved: requirements.unresolved,
      }
    : null;
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
    : { verdict: "not_verified", reason: "mock_only" };

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
