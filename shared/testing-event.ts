import { EventType, type StreamChunk } from "@tanstack/ai";
import { z } from "zod";

import {
  ARTIFACT_KINDS,
  ROLE_IDS,
  artifactRefSchema,
  criteriaSelectionSchema,
  evidenceSchema,
  planCaseSchema,
  requirementCriterionSchema,
  sourceSchema,
  testRunIdSchema,
  type TestView,
} from "./testing";

export const TESTING_PROJECTION_EVENT = "testing.projection";

const boundedText = (max: number) => z.string().trim().min(1).max(max);

const judgmentSchema = z.enum(["simulated_pass", "simulated_fail", "simulated_blocked"]);

const taskOutcomeSchema = z.enum([
  "completed",
  "failed",
  "cancelled",
  "missing",
  "incompatible",
  "timed_out",
]);

const toolActivityViewSchema = z.object({
  toolName: boundedText(200),
  route: z.enum(["direct", "codemode"]),
  startedAt: boundedText(64),
});

const checkProgressSchema = z.object({
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

const progressRowSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("waiting"),
    reason: z.enum(["dependency", "dispatch"]),
  }),
  z.object({
    status: z.literal("reused"),
    artifact: artifactRefSchema,
    provenance: z.object({
      originalRunId: testRunIdSchema,
      role: z.enum(ROLE_IDS),
      issuedAt: boundedText(64),
    }),
  }),
  z.object({
    status: z.literal("not_required"),
    reason: z.literal("no_style_checks"),
  }),
  z.object({
    status: z.literal("undispatched"),
    reason: z.enum(["cancelled", "dependency_blocked", "incompatible", "timed_out"]),
  }),
  z.object({
    status: z.literal("running"),
    activity: z.enum(["model", "tool"]).nullable(),
    checks: checkProgressSchema.optional(),
  }),
  z.object({
    status: z.literal("tool_activity"),
    active: z.array(toolActivityViewSchema).max(32),
    checks: checkProgressSchema.optional(),
  }),
  z.object({
    status: z.literal("cancelling"),
    active: z.array(toolActivityViewSchema).max(32),
  }),
  z.object({
    status: z.literal("terminal"),
    outcome: taskOutcomeSchema,
    reasonCode: boundedText(128),
  }),
]);

const roleProgressSchema = z.object({
  atlassian: progressRowSchema,
  planner: progressRowSchema,
  ac: progressRowSchema,
  ui: progressRowSchema,
});

const progressCardSchema = z.object({
  version: z.number().int().nonnegative(),
  rows: roleProgressSchema,
});

const artifactOriginSchema = z.object({
  originalRunId: testRunIdSchema,
  role: z.enum(ROLE_IDS),
  issuedAt: boundedText(64),
});

const reuseDecisionSchema = z.discriminatedUnion("kind", [
  z.object({
    ref: artifactRefSchema,
    kind: z.literal("accepted"),
    artifactKind: z.enum(ARTIFACT_KINDS),
    provenance: artifactOriginSchema,
  }),
  z.object({
    ref: artifactRefSchema,
    kind: z.literal("rejected"),
    reason: z.enum([
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
    ]),
  }),
]);

const publicRequirementsSchema = z.object({
  goal: boundedText(2_000),
  criteria: z.array(requirementCriterionSchema).max(500),
  selection: criteriaSelectionSchema,
  unresolved: z.array(boundedText(512)).max(500),
});

const publicPlanSchema = z.object({
  cases: z.array(planCaseSchema).max(20),
  assignments: z.object({
    ac: z.array(boundedText(64)).max(80),
    ui: z.array(boundedText(64)).max(80),
  }),
});

const publicCheckResultSchema = z.object({
  caseId: boundedText(64),
  checkId: boundedText(64),
  judgment: judgmentSchema,
  evidence: z.array(evidenceSchema).max(80),
});

const coverageSchema = z.object({
  criterionId: boundedText(128),
  caseId: boundedText(64).nullable(),
  checkId: boundedText(64).nullable(),
  state: z.union([judgmentSchema, z.literal("uncovered")]),
});

const blockedReasonsSchema = z.tuple([boundedText(256)]).rest(boundedText(256));

const acceptanceSchema = z.discriminatedUnion("verdict", [
  z.object({
    verdict: z.literal("not_verified"),
    reason: z.literal("mock_only"),
  }),
  z.object({
    verdict: z.literal("blocked"),
    reasons: blockedReasonsSchema,
  }),
]);

const publicTestReportSchema = z.object({
  runId: testRunIdSchema,
  requirements: publicRequirementsSchema.nullable(),
  plan: publicPlanSchema.nullable(),
  results: z.object({
    ac: z.array(publicCheckResultSchema).max(80),
    ui: z.array(publicCheckResultSchema).max(80),
  }),
  coverage: z.array(coverageSchema).max(500),
  unresolvedSources: z.array(sourceSchema).max(20),
  artifacts: z.array(artifactRefSchema).max(500),
  roleOutcomes: roleProgressSchema,
  acceptance: acceptanceSchema,
});

const testViewBase = {
  runId: testRunIdSchema,
  progress: progressCardSchema,
  reuse: z.array(reuseDecisionSchema).max(500),
  availableArtifacts: z.array(artifactRefSchema).max(500),
};

const testViewSchema = z.discriminatedUnion("state", [
  z.object({
    ...testViewBase,
    state: z.literal("active"),
    report: z.null(),
  }),
  z.object({
    ...testViewBase,
    state: z.literal("cancelling"),
    report: z.null(),
  }),
  z.object({
    ...testViewBase,
    state: z.literal("finished"),
    report: publicTestReportSchema,
  }),
]);

const testingProjectionChunkSchema = z.object({
  type: z.literal(EventType.CUSTOM),
  name: z.literal(TESTING_PROJECTION_EVENT),
  value: testViewSchema,
});

const testingHydrationSchema = z.object({
  publishedTesting: testViewSchema.nullish(),
});

export function parseTestView(value: unknown): TestView | null {
  const parsed = testViewSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
}

export function parseTestingProjectionEvent(chunk: unknown): TestView | null {
  const parsed = testingProjectionChunkSchema.safeParse(chunk);

  return parsed.success ? parsed.data.value : null;
}

export function parsePublishedTesting(payload: unknown): TestView | null {
  const parsed = testingHydrationSchema.safeParse(payload);

  return parsed.success ? (parsed.data.publishedTesting ?? null) : null;
}

export function testingProjectionEvent(view: TestView): StreamChunk {
  return {
    type: EventType.CUSTOM,
    name: TESTING_PROJECTION_EVENT,
    value: view,
    timestamp: Date.now(),
  };
}
