import { z } from "zod";

export const ROLE_IDS = ["atlassian", "planner", "ac", "ui"] as const;
export type RoleId = (typeof ROLE_IDS)[number];

export const ARTIFACT_KINDS = ["requirements", "plan", "ac-result", "ui-result"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export type NonEmpty<T> = readonly [T, ...T[]];

export type TaskOutcome =
  | "completed"
  | "failed"
  | "cancelled"
  | "missing"
  | "incompatible"
  | "timed_out";

export type RootRunOutcome = TaskOutcome;

export type Judgment = "simulated_pass" | "simulated_fail" | "simulated_blocked";

export const artifactRefSchema = z.string().trim().min(1).max(256).brand<"ArtifactRef">();
export type ArtifactRef = z.infer<typeof artifactRefSchema>;

export const testRunIdSchema = z.string().trim().min(1).max(256).brand<"TestRunId">();
export type TestRunId = z.infer<typeof testRunIdSchema>;

export const sourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("jira"),
    issueKey: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .describe("Jira source issue identity, for example PROJ-123. Not a criterion selection key."),
  }),
  z.strictObject({ kind: z.literal("confluence"), pageId: z.string().trim().min(1).max(128) }),
]);
export type Source = Readonly<z.infer<typeof sourceSchema>>;

export const criteriaSelectionSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("all") }),
    z.strictObject({
      kind: z.literal("selected"),
      keys: z
        .array(z.string().trim().min(1).max(128))
        .min(1)
        .describe(
          "Explicit criterion keys such as AC-2 and AC-5. Preserve exactly; do not substitute source issue keys or widen the subset.",
        ),
    }),
  ])
  .describe(
    "Use all for a whole issue or page. Use selected only for explicitly requested criterion keys, not source identities.",
  );
export type CriteriaSelection = Readonly<z.infer<typeof criteriaSelectionSchema>>;

export const designReferenceSchema = z.strictObject({
  fileKey: z.string().trim().min(1).max(256),
  nodeId: z.string().trim().min(1).max(256),
});
export type DesignReference = Readonly<z.infer<typeof designReferenceSchema>>;

export const designCaptureSchema = z.strictObject({
  reference: designReferenceSchema,
  propertiesDigest: z.string().trim().min(1).max(128),
  complete: z.literal(true),
  capturedAt: z.string().trim().min(1).max(64),
});
export type DesignCapture = Readonly<z.infer<typeof designCaptureSchema>>;

export const testingRequestInputSchema = z.strictObject({
  goal: z.string().trim().min(1).max(2_000),
  sources: z.array(sourceSchema).min(1).max(20),
  criteria: criteriaSelectionSchema,
  targetUrl: z.url().max(2_048),
  design: designReferenceSchema.optional(),
  existingArtifacts: z.array(artifactRefSchema).max(20).optional(),
});
export type TestingRequestInput = Readonly<z.infer<typeof testingIntentSchema>>;

const delegationSummary = z.string().trim().min(1).max(2_000);

export const delegationInputSchema = z.discriminatedUnion("role", [
  z.strictObject({
    role: z.literal("atlassian"),
    summary: delegationSummary,
    goal: delegationSummary,
    sources: z.array(sourceSchema).min(1).max(20),
    criteria: criteriaSelectionSchema,
  }),
  z.strictObject({
    role: z.literal("planner"),
    summary: delegationSummary,
    requirementsRef: artifactRefSchema,
    design: designReferenceSchema.optional(),
  }),
  z.strictObject({
    role: z.literal("ac"),
    summary: delegationSummary,
    planRef: artifactRefSchema,
    targetUrl: z.url().max(2_048),
  }),
  z.strictObject({
    role: z.literal("ui"),
    summary: delegationSummary,
    planRef: artifactRefSchema,
    targetUrl: z.url().max(2_048),
  }),
]);
export type DelegationInput = Readonly<z.infer<typeof delegationInputSchema>>;

export const testingIntentSchema = testingRequestInputSchema.extend({
  targetUrl: z.url().max(2_048).nullable(),
  task: z
    .strictObject({
      version: z.literal(2),
      input: delegationInputSchema,
    })
    .optional(),
});

export const testingRequestSchema = testingRequestInputSchema.extend({
  threadId: z.string().trim().min(1).max(128),
  expectedRevision: z.number().int().nonnegative(),
  requestId: z.string().trim().min(1).max(128),
});

export const actionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("navigate"), path: z.string().trim().min(1).max(2_048) }),
  z.strictObject({ kind: z.literal("click"), target: z.string().trim().min(1).max(512) }),
  z.strictObject({
    kind: z.literal("fill"),
    target: z.string().trim().min(1).max(512),
    value: z.string().max(2_048),
  }),
]);
export type Action = Readonly<z.infer<typeof actionSchema>>;

const toleranceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("exact") }),
  z.strictObject({
    kind: z.literal("numeric"),
    unit: z.enum(["px", "ratio"]),
    maxDelta: z.number().positive().finite(),
  }),
]);
export type Tolerance = Readonly<z.infer<typeof toleranceSchema>>;

const fixtureIdentitySchema = z.strictObject({
  id: z.string().trim().min(1).max(128),
  version: z.string().trim().min(1).max(64),
});
export type FixtureIdentity = Readonly<z.infer<typeof fixtureIdentitySchema>>;

const functionalCheckSchema = z.strictObject({
  id: z.string().trim().min(1).max(64),
  criterionId: z.string().trim().min(1).max(128),
  kind: z.literal("functional"),
  expectedObservation: z.string().trim().min(1).max(2_000),
});
export type FunctionalCheck = Readonly<z.infer<typeof functionalCheckSchema>>;

const styleCheckSchema = z.strictObject({
  id: z.string().trim().min(1).max(64),
  criterionId: z.string().trim().min(1).max(128),
  kind: z.literal("style"),
  design: designReferenceSchema,
  property: z.string().trim().min(1).max(128),
  tolerance: toleranceSchema,
});
export type StyleCheck = Readonly<z.infer<typeof styleCheckSchema>>;

export const planCheckSchema = z.discriminatedUnion("kind", [
  functionalCheckSchema,
  styleCheckSchema,
]);
export type PlanCheck = FunctionalCheck | StyleCheck;

export const planCaseSchema = z.strictObject({
  id: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(200),
  preconditions: z.array(z.string().trim().max(500)),
  actions: z.array(actionSchema).min(1),
  checks: z.array(planCheckSchema).min(1),
});
export type PlanCase = Readonly<z.infer<typeof planCaseSchema>>;

export const requirementCriterionSchema = z.strictObject({
  id: z.string().trim().min(1).max(128),
  key: z.string().trim().min(1).max(128),
  statement: z.string().trim().min(1).max(2_000),
  sourceDigest: z.string().trim().min(1).max(128),
  anchor: z.string().trim().min(1).max(512),
});
export type RequirementCriterion = Readonly<z.infer<typeof requirementCriterionSchema>>;

const mockEvidenceBase = {
  caseId: z.string().trim().min(1).max(64),
  checkId: z.string().trim().min(1).max(64),
  origin: z.literal("mock"),
  fixture: fixtureIdentitySchema,
  adapterVersion: z.string().min(1).max(64),
};

export const evidenceSchema = z.union([
  z.strictObject({
    kind: z.literal("functional"),
    outcome: z.literal("pass"),
    expected: z.string().min(1),
    observed: z.string().min(1),
    actionIndex: z.number().int().nonnegative(),
    ...mockEvidenceBase,
  }),
  z.strictObject({
    kind: z.literal("functional"),
    outcome: z.literal("fail"),
    expected: z.string().min(1),
    observed: z.string().min(1),
    actionIndex: z.number().int().nonnegative(),
    ...mockEvidenceBase,
  }),
  z.strictObject({
    kind: z.literal("functional"),
    outcome: z.literal("blocked"),
    reason: z.string().min(1),
    actionIndex: z.number().int().nonnegative(),
    ...mockEvidenceBase,
  }),
  z.strictObject({
    kind: z.literal("style"),
    outcome: z.literal("inside_tolerance"),
    property: z.string().min(1),
    expected: z.string().min(1),
    observed: z.string().min(1),
    tolerance: toleranceSchema,
    capturedDesign: designCaptureSchema,
    ...mockEvidenceBase,
  }),
  z.strictObject({
    kind: z.literal("style"),
    outcome: z.literal("outside_tolerance"),
    property: z.string().min(1),
    expected: z.string().min(1),
    observed: z.string().min(1),
    tolerance: toleranceSchema,
    capturedDesign: designCaptureSchema,
    ...mockEvidenceBase,
  }),
  z.strictObject({
    kind: z.literal("style"),
    outcome: z.literal("blocked"),
    reason: z.string().min(1),
    property: z.string().min(1),
    tolerance: toleranceSchema,
    capturedDesign: designCaptureSchema,
    ...mockEvidenceBase,
  }),
]);
export type PublicEvidence = Readonly<z.infer<typeof evidenceSchema>>;

export const browserOutputSchema = z.strictObject({
  checkId: z.string().trim().min(1).max(64),
  evidence: evidenceSchema,
});
export type BrowserOutput = Readonly<z.infer<typeof browserOutputSchema>>;

export const useBrowserInputSchema = z.strictObject({
  checkId: z.string().trim().min(1).max(64),
});

export type ArtifactOrigin = Readonly<{
  originalRunId: TestRunId;
  role: RoleId;
  issuedAt: string;
}>;

export type ReuseRejection =
  | "not_accessible"
  | "raw_blob"
  | "wrong_kind"
  | "incomplete"
  | "untrusted_producer"
  | "scope_mismatch"
  | "incompatible_snapshot"
  | "dependency_rejected"
  | "cross_run_result_forbidden"
  | "invalid_evidence"
  | "conflicting_reference";

export type ReuseDecision = Readonly<{ ref: ArtifactRef }> &
  (
    | Readonly<{ kind: "accepted"; artifactKind: ArtifactKind; provenance: ArtifactOrigin }>
    | Readonly<{ kind: "rejected"; reason: ReuseRejection }>
  );

export class TestingRequestError extends Error {
  readonly decisions: NonEmpty<ReuseDecision>;

  constructor(decisions: NonEmpty<ReuseDecision>) {
    super(
      `Testing request has invalid artifact references: ${decisions
        .filter((decision) => decision.kind === "rejected")
        .map((decision) => `${decision.ref} (${decision.reason})`)
        .join("; ")}`,
    );
    this.name = "TestingRequestError";
    this.decisions = decisions;
  }
}

export type PublicRequirements = Readonly<{
  goal: string;
  criteria: readonly RequirementCriterion[];
  selection: CriteriaSelection;
  unresolved: readonly string[];
}>;

export type PublicPlan = Readonly<{
  cases: readonly PlanCase[];
  assignments: Readonly<{ ac: readonly string[]; ui: readonly string[] }>;
}>;

export type PublicCheckResult = Readonly<{
  caseId: string;
  checkId: string;
  judgment: Judgment;
  evidence: readonly PublicEvidence[];
}>;

export type Coverage = Readonly<{
  criterionId: string;
  caseId: string | null;
  checkId: string | null;
  state: Judgment | "uncovered";
}>;

export type CheckProgress = Readonly<{ completed: number; total: number }>;

export type ToolActivityView = Readonly<{
  toolName: string;
  route: "direct" | "codemode";
  startedAt: string;
}>;

export type ProgressRow =
  | Readonly<{ status: "waiting"; reason: "dependency" | "dispatch" }>
  | Readonly<{ status: "reused"; artifact: ArtifactRef; provenance: ArtifactOrigin }>
  | Readonly<{ status: "not_required"; reason: "no_style_checks" }>
  | Readonly<{
      status: "undispatched";
      reason: "cancelled" | "dependency_blocked" | "incompatible" | "timed_out";
    }>
  | Readonly<{ status: "running"; activity: "model" | "tool" | null; checks?: CheckProgress }>
  | Readonly<{
      status: "tool_activity";
      active: readonly ToolActivityView[];
      checks?: CheckProgress;
    }>
  | Readonly<{ status: "cancelling"; active: readonly ToolActivityView[] }>
  | Readonly<{ status: "terminal"; outcome: TaskOutcome; reasonCode: string }>;

export type ProgressCard = Readonly<{
  version: number;
  rows: Readonly<Record<RoleId, ProgressRow>>;
}>;

export type Acceptance =
  | Readonly<{ verdict: "not_verified"; reason: "mock_only" }>
  | Readonly<{ verdict: "blocked"; reasons: NonEmpty<string> }>;

export type PublicTestReport = Readonly<{
  runId: TestRunId;
  requirements: PublicRequirements | null;
  plan: PublicPlan | null;
  results: Readonly<{ ac: readonly PublicCheckResult[]; ui: readonly PublicCheckResult[] }>;
  coverage: readonly Coverage[];
  unresolvedSources: readonly Source[];
  artifacts: readonly ArtifactRef[];
  roleOutcomes: ProgressCard["rows"];
  acceptance: Acceptance;
}>;

export type PublicTaskArtifact = Readonly<{ ref: ArtifactRef }> &
  (
    | Readonly<{ kind: "requirements"; payload: PublicRequirements }>
    | Readonly<{ kind: "plan"; payload: PublicPlan }>
    | Readonly<{ kind: "ac-result" | "ui-result"; payload: readonly PublicCheckResult[] }>
  );

export type TaskMessageOrigin = Readonly<{
  parentRunId: string;
  requestKey: string;
  parentMessageId: string;
}>;

type TestViewBase = Readonly<{
  runId: TestRunId;
  progress: ProgressCard;
  reuse: readonly ReuseDecision[];
  availableArtifacts: readonly ArtifactRef[];
}>;

export type TestView = TestViewBase &
  (
    | Readonly<{
        task: Readonly<{
          version: 2;
          role: RoleId;
          summary: string;
          origin?: TaskMessageOrigin | null;
          result: PublicTaskArtifact | null;
        }>;
        state: "active" | "cancelling" | "finished";
        report: null;
      }>
    | (Readonly<{ task?: undefined }> &
        (
          | Readonly<{ state: "active" | "cancelling"; report: null }>
          | Readonly<{ state: "finished"; report: PublicTestReport }>
        ))
  );
