import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  artifactRefSchema,
  delegationInputSchema,
  type TestingRequestInput,
} from "../../../shared/testing";
import {
  canonicalizePlan,
  deriveReport,
  digestOf,
  planPayloadSchema,
  requirementsPayloadSchema,
  validateReuse,
} from "../../../server/harness/testing-domain";
import {
  closureDecisions,
  hostTestingRuntime,
  resultTaskContext,
  type StoredArtifactRow,
} from "../../../server/harness/testing-store";
import { testRunIdSchema } from "../../../shared/testing";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/fetm78-reuse.json", import.meta.url), "utf8"),
);
const rows = fixture.rows as StoredArtifactRow[];
const requirementsRow = rows[0]!;
const planRow = rows[1]!;
const requirements = requirementsPayloadSchema.parse(requirementsRow.payload);
const plan = planPayloadSchema.parse(planRow.payload);
const host = hostTestingRuntime(fixture.snapshot);

function intentFor(raw: unknown): TestingRequestInput {
  const input = delegationInputSchema.parse(raw);
  assert.ok(input.role === "ac" || input.role === "ui");
  return {
    goal: requirements.goal,
    sources: requirements.sources.map((source) => source.reference),
    ...resultTaskContext(plan, input),
    existingArtifacts: rows.map((row) => artifactRefSchema.parse(row.ref)),
    task: { version: 2, input },
  };
}

function decide(intent: TestingRequestInput, candidates = rows) {
  return closureDecisions({
    threadId: planRow.threadId,
    intent,
    refs: rows.map((row) => row.ref),
    rows: new Map(candidates.map((row) => [row.ref, row])),
    host,
  });
}

function envelope(row: StoredArtifactRow) {
  return {
    kind: row.kind,
    ref: row.ref,
    digest: row.payloadDigest,
    threadId: row.threadId,
    payload: row.payload,
    scopeDigest: row.scopeDigest,
    dependencies: row.dependencies,
    origin: row.origin,
  };
}

const planContext = {
  requirementsDigest: digestOf(requirements),
  goal: requirements.goal,
  targetUrl: plan.targetUrl,
  design: plan.design,
};

test("stored live-shaped artifacts pass digest, scope and canonical reuse before URL execution", () => {
  assert.equal(
    validateReuse(envelope(requirementsRow), {
      requested: "requirements",
      threadId: requirementsRow.threadId,
      expectedScopeDigest: requirementsRow.scopeDigest,
    }).kind,
    "accepted",
  );
  assert.equal(
    validateReuse(envelope(planRow), {
      requested: "plan",
      threadId: planRow.threadId,
      expectedScopeDigest: planRow.scopeDigest,
      planContext,
    }).kind,
    "accepted",
  );
  assert.match(
    requirements.sources[0]!.text,
    /^FETM-78 司康小舖：商品與購物車\n\n## 驗收條件\n\n1\. AC-1：/,
  );
  assert.equal(requirements.sources[0]!.links.length, 5);
  assert.deepEqual(
    plan.criteria.map((criterion) => criterion.id),
    ["AC-1", "AC-2", "AC-3", "AC-4", "AC-5", "AC-6", "AC-7", "UI-1", "UI-2", "UI-3"],
  );
  assert.equal(plan.targetUrl, null);
  assert.equal(plan.assignments.ac.length, 20);
  assert.equal(plan.assignments.ui.length, 7);
});

test("URL follow-up accepts explicit assigned checks despite planner unresolved notes and deferred outcomes", () => {
  for (const input of fixture.inputs) {
    const decisions = decide(intentFor(input));
    assert.deepEqual(
      decisions.map((decision) => ({ ref: decision.ref, kind: decision.kind })),
      rows.map((row) => ({ ref: row.ref, kind: "accepted" })),
    );
  }
  const report = deriveReport({
    runId: testRunIdSchema.parse("run-report"),
    rootOutcome: "completed",
    requirements,
    plan,
    acResults: null,
    uiResults: null,
    unresolvedSources: [],
    artifacts: [],
    progressVersion: 1,
    outcomes: {},
  });
  assert.deepEqual(report.plan?.unresolved, plan.unresolved);
  assert.equal(plan.unresolved.length, 5);
  assert.deepEqual(report.acceptance, {
    verdict: "blocked",
    reasons: [
      "ac_results_missing",
      "ui_results_missing",
      "requirements_unresolved",
      "coverage_incomplete",
    ],
  });
  assert.ok(report.coverage.some((row) => row.state === "deferred"));
});

test("a plan artifact stored under the planning-v3 profile must be produced again", () => {
  const metadata = planRow.metadata as {
    profiles: Record<string, string>;
    registration: Record<string, string>;
  };
  const previousPlan: StoredArtifactRow = {
    ...planRow,
    metadata: {
      ...metadata,
      profiles: { ...metadata.profiles, planner: "planning-v3" },
      registration: { ...metadata.registration, planner: "plan:planning-v3:enabled:none" },
    },
  };

  assert.deepEqual(
    decide(intentFor(fixture.inputs[0]), [requirementsRow, previousPlan]).map((decision) => [
      decision.ref,
      decision.kind === "rejected" ? decision.reason : decision.kind,
    ]),
    [
      ["artifact-live-requirements", "accepted"],
      ["artifact-live-plan", "incompatible_snapshot"],
    ],
  );
});

test("assigned-check reuse still rejects altered snapshots, source scope, digests and provenance", () => {
  const intent = intentFor(fixture.inputs[0]);
  const variants: StoredArtifactRow[] = [
    { ...requirementsRow, metadata: {} },
    { ...requirementsRow, scopeDigest: "altered-scope" },
    { ...requirementsRow, payloadDigest: "altered-digest" },
    { ...requirementsRow, origin: { ...requirementsRow.origin, role: "planner" } },
    { ...requirementsRow, payload: { ...requirements, sources: [] } },
    {
      ...requirementsRow,
      payload: {
        ...requirements,
        sources: requirements.sources.map((source) => ({ ...source, text: "Altered" })),
      },
    },
    { ...requirementsRow, threadId: "foreign-thread" },
  ];
  const reasons = (candidate: StoredArtifactRow) =>
    decide(intent, [candidate, planRow]).map((decision) =>
      decision.kind === "rejected" ? decision.reason : decision.kind,
    );
  assert.deepEqual(variants.map(reasons), [
    ["incompatible_snapshot", "dependency_rejected"],
    ["scope_mismatch", "scope_mismatch"],
    ["invalid_evidence", "invalid_evidence"],
    ["untrusted_producer", "untrusted_producer"],
    ["incomplete", "incomplete"],
    ["invalid_evidence", "invalid_evidence"],
    ["not_accessible", "not_accessible"],
  ]);
  assert.deepEqual(
    decide({ ...intent, task: undefined }).map((decision) => [
      decision.ref,
      decision.kind === "rejected" ? decision.reason : decision.kind,
    ]),
    [
      ["artifact-live-requirements", "accepted"],
      ["artifact-live-plan", "scope_mismatch"],
    ],
  );
  const input = delegationInputSchema.parse(fixture.inputs[0]);
  assert.ok(input.role === "ac" || input.role === "ui");
  assert.throws(
    () => resultTaskContext({ ...plan, targetUrl: "https://bound.example.test" }, input),
    /Plan target URL is incompatible/,
  );
});

test("27 real-shaped requirements plan as grouped deferred scenarios", () => {
  const expanded = requirementsPayloadSchema.parse(fixture.expandedRequirements);
  const { criteria, unresolved } = fixture.expandedPlanning as {
    criteria: { id: string; statement: string }[];
    unresolved: string[];
  };
  const groups = Array.from({ length: 3 }, (_, index) => ({
    id: `deferred-scenario-${index}`,
    title: [
      "Functional cart behavior",
      "Shared page appearance",
      "Interactive and responsive appearance",
    ][index]!,
    steps: [
      "Use the visible page navigation to open the relevant product or cart page",
      "Inspect each criterion-linked expected outcome",
    ],
    reason:
      "These source expectations require manual verification with setup or properties unavailable to the runner",
    expectations: criteria.slice(index * 9, index * 9 + 9).map((criterion) => ({
      criterionId: criterion.id,
      expectedObservation: criterion.statement,
    })),
  }));
  const context = {
    ...planContext,
    requirementsDigest: digestOf(expanded),
    goal: expanded.goal,
    design: null,
  };
  const result = canonicalizePlan(
    { criteria, unresolved, cases: [], deferredCases: groups },
    context,
  );
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") return;
  assert.equal(result.value.deferredCases?.length, 3);
  assert.equal(result.value.deferredCases?.flatMap((item) => item.expectations).length, 27);
  assert.deepEqual(result.value.assignments, { ac: [], ui: [] });
  const report = deriveReport({
    runId: testRunIdSchema.parse("run-grouped"),
    rootOutcome: "completed",
    requirements: expanded,
    plan: result.value,
    acResults: null,
    uiResults: null,
    unresolvedSources: [],
    artifacts: [],
    progressVersion: 1,
    outcomes: {},
  });
  assert.deepEqual(
    report.coverage.map((row) => row.criterionId),
    criteria.map((criterion) => criterion.id),
  );
  assert.ok(report.coverage.every((row) => row.state === "deferred"));
  assert.deepEqual(report.acceptance, { verdict: "blocked", reasons: ["requirements_unresolved"] });
  assert.deepEqual(report.results, { ac: [], ui: [] });
});
