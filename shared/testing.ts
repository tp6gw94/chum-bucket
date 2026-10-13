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

export type Judgment =
  | "pass"
  | "fail"
  | "blocked"
  | "simulated_pass"
  | "simulated_fail"
  | "simulated_blocked";

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
      .describe("Jira source issue identity, for example PROJ-123."),
  }),
  z.strictObject({ kind: z.literal("confluence"), pageId: z.string().trim().min(1).max(128) }),
]);
export type Source = Readonly<z.infer<typeof sourceSchema>>;

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
    value: z.string().max(2_048).optional(),
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

const functionalCheckSchema = z
  .strictObject({
    id: z.string().trim().min(1).max(64),
    criterionId: z.string().trim().min(1).max(128),
    kind: z.literal("functional"),
    expectedObservation: z.string().trim().min(1).max(2_000),
    observation: z
      .discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("url"), comparison: z.enum(["equals", "contains"]) }),
        z.strictObject({
          kind: z.enum(["text", "value", "visible"]),
          target: z.string().trim().min(1).max(512),
          comparison: z.enum(["equals", "contains"]),
        }),
        z.strictObject({
          kind: z.literal("operable"),
          target: z.string().trim().min(1).max(512),
          comparison: z.literal("equals"),
        }),
      ])
      .optional(),
  })
  .refine(
    (check) =>
      check.observation?.kind !== "operable" ||
      check.expectedObservation === "true" ||
      check.expectedObservation === "false",
    { path: ["expectedObservation"], message: 'operable expects "true" or "false"' },
  );
export type FunctionalCheck = Readonly<z.infer<typeof functionalCheckSchema>>;

const styleCheckSchema = z.strictObject({
  id: z.string().trim().min(1).max(64),
  criterionId: z.string().trim().min(1).max(128),
  kind: z.literal("style"),
  design: designReferenceSchema,
  property: z.string().trim().min(1).max(128),
  target: z.string().trim().min(1).max(512).optional(),
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

export const deferredCaseSchema = z.strictObject({
  id: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(200),
  steps: z.array(z.string().trim().min(1).max(500)).min(1),
  reason: z.string().trim().min(1).max(500),
  expectations: z
    .array(
      z.strictObject({
        criterionId: z.string().trim().min(1).max(128),
        expectedObservation: z.string().trim().min(1).max(2_000),
      }),
    )
    .min(1),
});
export type DeferredCase = Readonly<z.infer<typeof deferredCaseSchema>>;

export const figmaLinkSchema = z.strictObject({
  url: z.string().trim().min(1).max(2_048),
  label: z.string().trim().min(1).max(256).optional(),
  fileKey: z.string().trim().min(1).max(256),
  nodeId: z.string().trim().min(1).max(256).optional(),
});
export type FigmaLink = Readonly<z.infer<typeof figmaLinkSchema>>;

export const requirementLinkSchema = figmaLinkSchema.extend({ source: sourceSchema });
export type RequirementLink = Readonly<z.infer<typeof requirementLinkSchema>>;

export const requirementSourceSchema = z.strictObject({
  reference: sourceSchema,
  text: z.string(),
  links: z.array(figmaLinkSchema).max(20),
  digest: z.string().trim().min(1).max(128),
  capturedAt: z.string().trim().min(1).max(64),
});
export type RequirementSource = Readonly<z.infer<typeof requirementSourceSchema>>;

const planCriterionSchema = z.strictObject({
  id: z.string().trim().min(1).max(128),
  statement: z.string().trim().min(1).max(2_000),
});
export type PlanCriterion = Readonly<z.infer<typeof planCriterionSchema>>;

export const planCriteriaSchema = z.array(planCriterionSchema).min(1);

export const MAX_CASE_HANDOFFS = 3;
export const MAX_JEV_CANDIDATES = 254;

const actionLocationSchema = z.strictObject({
  kind: z.literal("action"),
  index: z.number().int().nonnegative(),
});

const handoffTargetSchema = z.strictObject({
  intent: z.string().min(1).max(512),
  operation: z.enum(["click", "fill", "observe", "visible", "operable"]),
  at: z.discriminatedUnion("kind", [
    actionLocationSchema,
    z.strictObject({ kind: z.literal("check"), checkId: z.string().trim().min(1).max(64) }),
  ]),
});
export type HandoffTarget = Readonly<z.infer<typeof handoffTargetSchema>>;

const fillTargetSchema = handoffTargetSchema.extend({
  operation: z.literal("fill"),
  at: actionLocationSchema,
});
export type FillTarget = Readonly<z.infer<typeof fillTargetSchema>>;

const artifactPngSchema = z.strictObject({
  path: z.string().regex(/^[0-9a-f-]{36}\.png$/),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ArtifactPng = Readonly<z.infer<typeof artifactPngSchema>>;

const browserSelectionSchema = z.union([
  z.strictObject({
    model: z.string(),
    choice: z.string(),
    confidence: z.number().min(0).max(1),
    candidateDigest: z.string(),
  }),
  z.strictObject({
    source: z.literal("agent_choose"),
    handoffId: z.string(),
    candidateId: z.string(),
    fingerprintDigest: z.string(),
    target: handoffTargetSchema,
  }),
  z.strictObject({
    source: z.literal("agent_navigate"),
    handoffId: z.string(),
    linkId: z.string(),
    from: z.string(),
    to: z.string(),
  }),
  z.strictObject({
    source: z.literal("agent_fill"),
    handoffId: z.string(),
    candidateId: z.string(),
    fingerprintDigest: z.string(),
    target: fillTargetSchema,
    value: z.string().max(2_048),
  }),
]);
export type BrowserSelection = Readonly<z.infer<typeof browserSelectionSchema>>;

const skippedActionSchema = z.strictObject({
  actionIndex: z.number().int().nonnegative(),
  reasons: z.union([
    z.tuple([z.literal("hidden")]),
    z.tuple([z.literal("disabled")]),
    z.tuple([z.literal("hidden"), z.literal("disabled")]),
  ]),
});
export type SkippedAction = Readonly<z.infer<typeof skippedActionSchema>>;

const mockEvidenceBase = {
  caseId: z.string().trim().min(1).max(64),
  checkId: z.string().trim().min(1).max(64),
  origin: z.enum(["mock", "browser"]),
  browser: z
    .strictObject({
      selections: z.array(browserSelectionSchema).max(100),
      skippedActions: z.array(skippedActionSchema).max(50).optional(),
      screenshot: artifactPngSchema.optional(),
    })
    .optional(),
  fixture: fixtureIdentitySchema,
  adapterVersion: z.string().min(1).max(64),
};

export const evidenceSchema = z
  .union([
    z.strictObject({
      kind: z.literal("functional"),
      outcome: z.literal("pass"),
      expected: z.string().min(1),
      observed: z.string(),
      actionIndex: z.number().int().nonnegative(),
      ...mockEvidenceBase,
    }),
    z.strictObject({
      kind: z.literal("functional"),
      outcome: z.literal("fail"),
      expected: z.string().min(1),
      observed: z.string(),
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
  ])
  .superRefine((evidence, context) => {
    if (
      evidence.origin === "browser" &&
      (!evidence.browser ||
        evidence.fixture.id !== "playwright-chromium" ||
        evidence.adapterVersion !== "playwright-jev-v1")
    ) {
      context.addIssue({
        code: "custom",
        message: "Browser evidence requires its live adapter identity and observations",
      });
    }

    if (evidence.origin === "mock" && evidence.browser) {
      context.addIssue({
        code: "custom",
        message: "Mock evidence cannot contain browser provenance",
      });
    }
  });
export type PublicEvidence = Readonly<z.infer<typeof evidenceSchema>>;

export const browserOutputSchema = z.strictObject({
  checkId: z.string().trim().min(1).max(64),
  evidence: evidenceSchema,
});
export type BrowserOutput = Readonly<z.infer<typeof browserOutputSchema>>;

const handoffResolutionSchema = z.strictObject({
  handoffId: z.string().trim().min(1).max(64),
  decision: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("navigate"), linkId: z.string().trim().min(1).max(16) }),
    z.strictObject({ kind: z.literal("choose"), candidateId: z.string().trim().min(1).max(16) }),
    z.strictObject({ kind: z.literal("abandon"), reason: z.string().trim().min(1).max(500) }),
    z.strictObject({ kind: z.literal("fill_value"), value: z.string().max(2_048) }),
  ]),
});
export type HandoffResolution = Readonly<z.infer<typeof handoffResolutionSchema>>;
export type HandoffDecision = HandoffResolution["decision"];

export const useBrowserInputSchema = z.strictObject({
  checkId: z.string().trim().min(1).max(64),
  resolution: handoffResolutionSchema.optional(),
});

const jevDiagnosticsSchema = z.strictObject({
  code: z.literal("uncertain_or_invalid_selection"),
  choice: z.string(),
  confidence: z.number(),
  probability: z.number(),
  gap: z.number(),
  probabilityTotal: z.number(),
  candidateCount: z.number().int().nonnegative(),
  probabilityCount: z.number().int().nonnegative(),
});
export type JevDiagnostics = Readonly<z.infer<typeof jevDiagnosticsSchema>>;

const selectionDiagnosticsSchema = z.discriminatedUnion("code", [
  jevDiagnosticsSchema,
  z.strictObject({
    code: z.literal("candidate_overflow"),
    candidateCount: z
      .number()
      .int()
      .min(MAX_JEV_CANDIDATES + 1),
  }),
]);
export type SelectionDiagnostics = Readonly<z.infer<typeof selectionDiagnosticsSchema>>;

const snapshotEntrySchema = z.strictObject({
  id: z.string().min(1).max(16),
  description: z.string(),
});

const snapshotBase = {
  id: z.string().min(1).max(64),
  caseId: z.string().min(1).max(64),
  expiresAt: z.string().min(1).max(64),
  url: z.string().min(1),
  links: z.array(snapshotEntrySchema.extend({ url: z.string().min(1) })),
  image: artifactPngSchema,
};

const selectionSnapshotSchema = z.strictObject({
  kind: z.literal("selection"),
  ...snapshotBase,
  ordinal: z.number().int().min(1).max(MAX_CASE_HANDOFFS),
  laterHandoffsAllowed: z
    .number()
    .int()
    .min(0)
    .max(MAX_CASE_HANDOFFS - 1),
  target: handoffTargetSchema,
  candidates: z.array(snapshotEntrySchema),
  diagnostics: selectionDiagnosticsSchema,
});
export type SelectionSnapshot = Readonly<z.infer<typeof selectionSnapshotSchema>>;

const fillValueSnapshotSchema = z.strictObject({
  kind: z.literal("fill_value"),
  ...snapshotBase,
  laterSelectionHandoffs: z.number().int().min(0).max(MAX_CASE_HANDOFFS),
  target: fillTargetSchema,
  field: snapshotEntrySchema,
});
export type FillValueSnapshot = Readonly<z.infer<typeof fillValueSnapshotSchema>>;

const handoffCheckIdSchema = z.string().trim().min(1).max(64);

export const browserHandoffSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("selection_required"),
    checkId: handoffCheckIdSchema,
    handoff: selectionSnapshotSchema,
  }),
  z.strictObject({
    state: z.literal("fill_value_required"),
    checkId: handoffCheckIdSchema,
    handoff: fillValueSnapshotSchema,
  }),
]);
export type BrowserHandoff = Readonly<z.infer<typeof browserHandoffSchema>>;

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
  sources: readonly RequirementSource[];
  links?: readonly RequirementLink[];
}>;

export type PublicPlan = Readonly<{
  criteria: readonly PlanCriterion[];
  unresolved: readonly string[];
  cases: readonly PlanCase[];
  deferredCases?: readonly DeferredCase[];
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
  state: Judgment | "uncovered" | "deferred";
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
  | Readonly<{ status: "not_required"; reason: "no_style_checks" | "no_functional_checks" }>
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
  | Readonly<{
      status: "terminal";
      outcome: TaskOutcome;
      reasonCode: string;
      issues?: readonly string[];
    }>;

export type ProgressCard = Readonly<{
  version: number;
  rows: Readonly<Record<RoleId, ProgressRow>>;
}>;

export type Acceptance =
  | Readonly<{ verdict: "not_verified"; reason: "mock_only" | "release_not_assessed" }>
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
