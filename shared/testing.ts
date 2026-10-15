import { z } from "zod";

const text = z.string().trim().min(1).max(4000);
const id = z.string().trim().min(1).max(128);
export const sourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("jira"), issueKey: id }),
  z.strictObject({ kind: z.literal("confluence"), pageId: id }),
]);
export const designSchema = z.strictObject({ fileKey: id, nodeId: id });
const summary = text;
const targetUrl = z.url().refine((value) => {
  const url = new URL(value);

  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
}, "Expected an HTTP(S) URL without credentials");
export const delegationInputSchema = z.discriminatedUnion("role", [
  z.strictObject({
    role: z.literal("atlassian"),
    summary,
    goal: text,
    sources: z.array(sourceSchema).min(1).max(20),
  }),
  z.strictObject({
    role: z.literal("planner"),
    summary,
    requirementsRef: id,
    design: designSchema.optional(),
  }),
  z.strictObject({ role: z.literal("ac"), summary, planRef: id, targetUrl }),
  z.strictObject({ role: z.literal("ui"), summary, planRef: id, targetUrl }),
]);
const comparison = z.enum(["equals", "contains"]);
const observationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("url"), comparison }),
  z.strictObject({ kind: z.enum(["text", "value", "visible"]), target: text, comparison }),
  z.strictObject({ kind: z.literal("operable"), target: text, comparison: z.literal("equals") }),
]);
const checkSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    id,
    criterionId: id,
    kind: z.literal("functional"),
    expectedObservation: text,
    observation: observationSchema,
  }),
  z.strictObject({
    id,
    criterionId: id,
    kind: z.literal("style"),
    design: designSchema,
    property: text,
    target: text,
    tolerance: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("exact") }),
      z.strictObject({
        kind: z.literal("numeric"),
        unit: z.enum(["px", "ratio"]),
        maxDelta: z.number().finite().nonnegative(),
      }),
    ]),
  }),
]);
export const planProposalSchema = z.strictObject({
  criteria: z
    .array(z.strictObject({ id, statement: text }))
    .min(1)
    .max(100),
  unresolved: z.array(text).max(100),
  cases: z
    .array(
      z.strictObject({
        id,
        title: text,
        preconditions: z.array(text).max(20),
        actions: z
          .array(
            z.discriminatedUnion("kind", [
              z.strictObject({ kind: z.literal("navigate"), path: text }),
              z.strictObject({ kind: z.literal("click"), target: text }),
              z.strictObject({ kind: z.literal("fill"), target: text, value: text.optional() }),
            ]),
          )
          .max(30),
        checks: z.array(checkSchema).min(1).max(60),
      }),
    )
    .max(60),
  deferredCases: z
    .array(
      z.strictObject({
        id,
        title: text,
        steps: z.array(text),
        reason: text,
        expectations: z.array(z.strictObject({ criterionId: id, expectedObservation: text })),
      }),
    )
    .optional(),
});
export type DelegationInput = z.infer<typeof delegationInputSchema>;
export type Role = DelegationInput["role"];
export type Source = z.infer<typeof sourceSchema>;
export type Design = z.infer<typeof designSchema>;
export type PlanProposal = z.infer<typeof planProposalSchema>;
export type PlanCase = PlanProposal["cases"][number];
export type Check = PlanCase["checks"][number];
export type Requirements = {
  goal: string;
  sources: { reference: Source; text: string; digest: string; capturedAt: string }[];
};
export type Plan = PlanProposal & {
  requirementsDigest: string;
  goal: string;
  targetUrl: null;
  design: Design | null;
  assignments: { ac: string[]; ui: string[] };
};
export type Evidence = {
  origin: "browser";
  fixture: { id: "playwright-chromium"; version: "v1" };
  caseId: string;
  checkId: string;
  outcome: "pass" | "fail" | "blocked";
  expected?: string;
  observed?: string;
  reason?: string;
  screenshot?: string;
};
export type Receipt = {
  id: string;
  taskId: string;
  name: string;
  route: "direct" | "codemode";
  input: unknown;
  output: unknown;
  outputDigest: string;
  capturedAt: string;
  checkId?: string;
};
export type ArtifactPayload = Requirements | Plan | { checks: Evidence[] };
export type Artifact = {
  ref: string;
  threadId: string;
  role: Role;
  kind: "requirements" | "plan" | "ac-result" | "ui-result";
  digest: string;
  payload: ArtifactPayload;
  metadata: { profile: string; registration: string; dependencies: string[] };
};
export type RoleTask = {
  summary: string;
  goal: string;
  sources: Source[];
  requirements: Requirements | null;
  plan: Plan | null;
  design: Design | null;
  targetUrl: string | null;
  checks: string[];
};
export type RoleCompletion = {
  state: "ready" | "failed";
  candidate: unknown;
  findings: string | null;
  reason?: string;
  issues?: string[];
};
