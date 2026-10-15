import { z } from "zod";

export const roleSchema = z.enum(["atlassian", "planner", "ac", "ui"]);
export type Role = z.infer<typeof roleSchema>;

export const artifactKinds = {
  atlassian: "requirements",
  planner: "plan",
  ac: "ac-result",
  ui: "ui-result",
} as const satisfies Record<Role, string>;
export type ArtifactKind = (typeof artifactKinds)[Role];

const identifier = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.:-]{1,64}$/);
const sourceKey = z.string().trim().min(1).max(128);
const summarySchema = z.string().trim().min(1).max(4_000);
const refSchema = z.string().trim().min(1).max(128);
const targetText = z.string().trim().min(1).max(500);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const sourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("jira"), issueKey: sourceKey }),
  z.strictObject({ kind: z.literal("confluence"), pageId: sourceKey }),
]);
export type Source = z.infer<typeof sourceSchema>;

export const designSchema = z.strictObject({
  fileKey: z
    .string()
    .regex(/^[A-Za-z0-9]+$/)
    .max(128),
  nodeId: z
    .string()
    .regex(/^\d+:\d+$/)
    .max(64),
});
export type Design = z.infer<typeof designSchema>;

const targetUrlSchema = z.url({ protocol: /^https?$/ }).max(2_048);

export const delegationInputSchema = z.discriminatedUnion("role", [
  z.strictObject({
    role: z.literal("atlassian"),
    summary: summarySchema,
    goal: summarySchema,
    sources: z.array(sourceSchema).min(1).max(10),
  }),
  z.strictObject({
    role: z.literal("planner"),
    summary: summarySchema,
    requirementsRef: refSchema,
    design: designSchema.optional(),
  }),
  z.strictObject({
    role: z.literal("ac"),
    summary: summarySchema,
    planRef: refSchema,
    targetUrl: targetUrlSchema,
  }),
  z.strictObject({
    role: z.literal("ui"),
    summary: summarySchema,
    planRef: refSchema,
    targetUrl: targetUrlSchema,
  }),
]);
export type DelegationInput = z.infer<typeof delegationInputSchema>;

const actionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("navigate"),
    path: z.string().trim().startsWith("/").max(2_048),
  }),
  z.strictObject({ kind: z.literal("click"), target: targetText }),
  z.strictObject({
    kind: z.literal("fill"),
    target: targetText,
    value: z.string().max(2_000).optional(),
  }),
]);
export type Action = z.infer<typeof actionSchema>;

const comparison = z.enum(["equals", "contains"]);

const observationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("url"), comparison }),
  z.strictObject({ kind: z.literal("text"), target: targetText, comparison }),
  z.strictObject({ kind: z.literal("value"), target: targetText, comparison }),
  z.strictObject({ kind: z.literal("visible"), target: targetText, comparison }),
  z.strictObject({
    kind: z.literal("operable"),
    target: targetText,
    comparison: z.literal("equals"),
  }),
]);

const toleranceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("exact") }),
  z.strictObject({
    kind: z.literal("numeric"),
    unit: z.enum(["px", "ratio"]),
    maxDelta: z.number().nonnegative().max(10_000),
  }),
]);
export type Tolerance = z.infer<typeof toleranceSchema>;

const functionalCheckSchema = z.strictObject({
  id: identifier,
  criterionId: identifier,
  kind: z.literal("functional"),
  expectedObservation: z.string().max(2_000),
  observation: observationSchema.optional(),
});
export type FunctionalCheck = z.infer<typeof functionalCheckSchema>;

const styleCheckSchema = z.strictObject({
  id: identifier,
  criterionId: identifier,
  kind: z.literal("style"),
  design: designSchema,
  property: z.string().trim().min(1).max(64),
  target: targetText.optional(),
  tolerance: toleranceSchema,
});
export type StyleCheck = z.infer<typeof styleCheckSchema>;

const checkSchema = z.discriminatedUnion("kind", [functionalCheckSchema, styleCheckSchema]);
export type Check = z.infer<typeof checkSchema>;

const planCaseSchema = z.strictObject({
  id: identifier,
  title: z.string().trim().min(1).max(500),
  preconditions: z.array(z.string().max(1_000)).max(20),
  actions: z.array(actionSchema).max(30),
  checks: z.array(checkSchema).min(1).max(30),
});
export type PlanCase = z.infer<typeof planCaseSchema>;

const deferredCaseSchema = z.strictObject({
  id: identifier,
  title: z.string().trim().min(1).max(500),
  steps: z.array(z.string().max(1_000)).max(30),
  reason: z.string().trim().min(1).max(1_000),
  expectations: z
    .array(
      z.strictObject({
        criterionId: identifier,
        expectedObservation: z.string().max(2_000),
      }),
    )
    .max(30),
});

const criterionSchema = z.strictObject({
  id: identifier,
  statement: z.string().trim().min(1).max(2_000),
});

export const planProposalSchema = z.strictObject({
  criteria: z.array(criterionSchema).min(1).max(100),
  unresolved: z.array(z.string().max(1_000)).max(50),
  cases: z.array(planCaseSchema).max(50),
  deferredCases: z.array(deferredCaseSchema).max(50).optional(),
});
export type PlanProposal = z.infer<typeof planProposalSchema>;

const figmaLinkSchema = z.strictObject({
  url: z.string().max(2_048),
  label: z.string().max(500).optional(),
  fileKey: z.string().max(128),
  nodeId: z.string().max(64).optional(),
});
export type FigmaLink = z.infer<typeof figmaLinkSchema>;

export const requirementsSchema = z.strictObject({
  goal: z.string(),
  sources: z.array(
    z.strictObject({
      reference: sourceSchema,
      text: z.string(),
      links: z.array(figmaLinkSchema).max(20),
      digest: digestSchema,
      capturedAt: z.string(),
    }),
  ),
});
export type Requirements = z.infer<typeof requirementsSchema>;

export const planArtifactSchema = planProposalSchema.extend({
  assignments: z.strictObject({ ac: z.array(identifier), ui: z.array(identifier) }),
  requirementsRef: refSchema,
  requirementsDigest: digestSchema,
  goal: z.string(),
  targetUrl: z.null(),
  design: designSchema.nullable(),
});
export type PlanArtifact = z.infer<typeof planArtifactSchema>;

const functionalOutcomeSchema = z.strictObject({
  kind: z.literal("functional"),
  caseId: identifier,
  checkId: identifier,
  actionIndex: z.number().int().nonnegative().nullable(),
  outcome: z.enum(["pass", "fail", "blocked"]),
  expected: z.string().nullable(),
  observed: z.string().nullable(),
  reason: z.string().nullable(),
});

const styleOutcomeSchema = z.strictObject({
  kind: z.literal("style"),
  caseId: identifier,
  checkId: identifier,
  outcome: z.enum(["inside_tolerance", "outside_tolerance", "blocked"]),
  property: z.string(),
  expected: z.string().nullable(),
  observed: z.string().nullable(),
  tolerance: toleranceSchema,
  capturedDesign: designSchema.nullable(),
  reason: z.string().nullable(),
});

const checkOutcomeSchema = z.discriminatedUnion("kind", [
  functionalOutcomeSchema,
  styleOutcomeSchema,
]);
export type CheckOutcome = z.infer<typeof checkOutcomeSchema>;

const selectionRecordSchema = z.strictObject({
  actionIndex: z.number().int().nonnegative(),
  target: z.string(),
  by: z.enum(["jev", "agent_choose"]),
  candidateId: z.string(),
  probability: z.number().optional(),
  confidence: z.number().optional(),
});
export type SelectionRecord = z.infer<typeof selectionRecordSchema>;

const imageSchema = z.strictObject({ path: z.string(), digest: digestSchema });

export const browserFixture = { id: "playwright-chromium", version: "v1" } as const;
export const browserAdapterVersion = "playwright-jev-v1";

export const evidenceSchema = z.discriminatedUnion("origin", [
  z.strictObject({
    origin: z.literal("browser"),
    fixture: z.strictObject({
      id: z.literal(browserFixture.id),
      version: z.literal(browserFixture.version),
    }),
    adapterVersion: z.literal(browserAdapterVersion),
    browser: z.strictObject({
      selections: z.array(selectionRecordSchema),
      skippedActions: z.array(
        z.strictObject({ actionIndex: z.number().int().nonnegative(), reason: z.string() }),
      ),
    }),
    screenshot: imageSchema.nullable(),
    check: checkOutcomeSchema,
  }),
  z.strictObject({ origin: z.literal("mock"), check: checkOutcomeSchema }),
]);
export type Evidence = z.infer<typeof evidenceSchema>;

export const handoffDecisionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("choose"), candidateId: z.string().regex(/^c\d{1,3}$/) }),
  z.strictObject({ kind: z.literal("navigate"), linkId: z.string().regex(/^l\d{1,3}$/) }),
  z.strictObject({ kind: z.literal("abandon"), reason: z.string().trim().min(1).max(500) }),
  z.strictObject({ kind: z.literal("fill_value"), value: z.string().max(2_000) }),
]);
export type HandoffDecision = z.infer<typeof handoffDecisionSchema>;

const handoffTarget = z.strictObject({
  intent: z.string(),
  operation: z.enum(["click", "fill", "observe"]),
  at: z.number().int().nonnegative(),
});

const handoffSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("selection"),
    id: z.string(),
    caseId: identifier,
    ordinal: z.number().int().positive(),
    laterHandoffsAllowed: z.boolean(),
    expiresAt: z.string(),
    url: z.string(),
    target: handoffTarget,
    candidates: z.array(z.strictObject({ id: z.string(), description: z.string() })),
    links: z.array(z.strictObject({ id: z.string(), description: z.string(), url: z.string() })),
    diagnostics: z.array(z.string()),
    image: imageSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("fill_value"),
    id: z.string(),
    caseId: identifier,
    expiresAt: z.string(),
    url: z.string(),
    target: handoffTarget,
  }),
]);
export type Handoff = z.infer<typeof handoffSchema>;

export const verifyInputSchema = z.strictObject({
  checkId: identifier,
  resolution: z
    .strictObject({ handoffId: z.string().min(1).max(64), decision: handoffDecisionSchema })
    .optional(),
});
export type VerifyInput = z.infer<typeof verifyInputSchema>;

const resultArtifactSchema = z.strictObject({
  planRef: refSchema,
  targetUrl: z.string(),
  checks: z.array(
    z.strictObject({
      caseId: identifier,
      checkId: identifier,
      outcome: z.string(),
      evidence: evidenceSchema,
      receiptId: z.string(),
      outputDigest: digestSchema,
    }),
  ),
});
export type ResultArtifact = z.infer<typeof resultArtifactSchema>;

const roleFailureCodeSchema = z.enum([
  "source_reads_incomplete",
  "proposal_rejected",
  "checks_incomplete",
  "child_failed",
  "cancelled",
  "deadline",
  "budget",
  "denied",
]);
export type RoleFailureCode = z.infer<typeof roleFailureCodeSchema>;

const taskStatusSchema = z.enum(["queued", "running", "ready", "failed", "cancelled"]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

const operationOutcomeSchema = z.enum(["satisfied", "failed", "cancelled", "deadline"]);
export type OperationOutcome = z.infer<typeof operationOutcomeSchema>;

const testViewSchema = z.object({
  operationId: z.string(),
  threadId: z.string(),
  requestKey: z.string(),
  version: z.number().int().nonnegative(),
  role: roleSchema,
  summary: z.string(),
  state: z.enum(["running", "finished"]),
  cancelRequested: z.boolean(),
  outcome: operationOutcomeSchema.nullable(),
  task: z
    .object({
      status: taskStatusSchema,
      reasonCode: z.string().nullable(),
      issues: z.array(z.string()),
      activity: z
        .object({ kind: z.enum(["model", "tool"]), name: z.string().nullable() })
        .nullable(),
      modelSteps: z.number().int().nonnegative(),
      toolCalls: z.number().int().nonnegative(),
    })
    .nullable(),
  artifact: z.object({ ref: z.string(), kind: z.string(), payload: z.unknown() }).nullable(),
});
export type TestView = z.infer<typeof testViewSchema>;

export const testingProjectionEventName = "testing.projection";

const projectionEventSchema = z.object({
  type: z.literal("CUSTOM"),
  name: z.literal(testingProjectionEventName),
  value: testViewSchema,
});

export function parseTestingProjectionEvent(chunk: unknown): TestView | null {
  const parsed = projectionEventSchema.safeParse(chunk);

  return parsed.success ? parsed.data.value : null;
}

export function parsePublishedTasks(value: unknown): TestView[] {
  const parsed = z.array(testViewSchema).safeParse(value);

  return parsed.success ? parsed.data : [];
}

export const testingPath = "/api/testing";

export const cancelTestingSchema = z.strictObject({ threadId: z.uuid() });
