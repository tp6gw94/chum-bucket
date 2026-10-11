import assert from "node:assert/strict";
import { test } from "node:test";

import {
  testRunIdSchema,
  type ProgressRow,
  type PublicTestReport,
  type RoleId,
  type TestView,
} from "../../../shared/testing";
import { mergeHydratedTestingView, mergeTestingView } from "../../../src/lib/testing-projections";

const runId = testRunIdSchema.parse("run-1");
const otherRunId = testRunIdSchema.parse("run-2");

function rows(): Record<RoleId, ProgressRow> {
  return {
    atlassian: { status: "terminal", outcome: "completed", reasonCode: "ok" },
    planner: { status: "running", activity: "model" },
    ac: { status: "waiting", reason: "dependency" },
    ui: { status: "not_required", reason: "no_style_checks" },
  };
}

function report(): PublicTestReport {
  return {
    runId,
    requirements: null,
    plan: null,
    results: { ac: [], ui: [] },
    coverage: [],
    unresolvedSources: [],
    artifacts: [],
    roleOutcomes: rows(),
    acceptance: { verdict: "not_verified", reason: "mock_only" },
  };
}

function activeView(version: number, viewRunId = runId): TestView {
  return {
    runId: viewRunId,
    state: "active",
    report: null,
    progress: { version, rows: rows() },
    reuse: [],
    availableArtifacts: [],
  };
}

function finishedView(version: number, viewRunId = runId): TestView {
  return {
    runId: viewRunId,
    state: "finished",
    report: report(),
    progress: { version, rows: rows() },
    reuse: [],
    availableArtifacts: [],
  };
}

test("hydration alone stores the published operation", () => {
  const hydrated = mergeHydratedTestingView([], activeView(1));
  assert.deepEqual(hydrated, [activeView(1)]);
  assert.equal(mergeHydratedTestingView(hydrated, null), hydrated);
});

test("a later SSE projection replaces the hydrated snapshot for the same operation", () => {
  const hydrated = mergeHydratedTestingView([], activeView(1));
  const streamed = mergeTestingView(hydrated, activeView(2));
  assert.equal(streamed.length, 1);
  assert.equal(streamed[0]!.progress.version, 2);
});

test("stale and equal projections keep the current snapshot identity", () => {
  const current = [activeView(3)];
  assert.equal(mergeTestingView(current, activeView(2)), current);
  assert.equal(mergeTestingView(current, activeView(3)), current);
  assert.equal(mergeHydratedTestingView(current, activeView(3)), current);
});

test("a finished operation cannot be revived by a newer active projection", () => {
  const current = [finishedView(5)];
  assert.equal(mergeTestingView(current, activeView(6)), current);
  assert.equal(mergeTestingView(current, finishedView(7)), current);
});

test("multiple operations in one mounted session are preserved independently", () => {
  const first = mergeTestingView([], activeView(1));
  const both = mergeTestingView(first, activeView(1, otherRunId));
  assert.deepEqual(
    both.map((view) => view.runId),
    [runId, otherRunId],
  );

  const updated = mergeTestingView(both, finishedView(2));
  assert.deepEqual(
    updated.map((view) => view.runId),
    [runId, otherRunId],
  );
  assert.equal(updated[0]!.state, "finished");
  assert.equal(updated[1], both[1]);

  const older = mergeHydratedTestingView(updated, activeView(1, otherRunId));
  assert.equal(older, updated);
});

test("hydration enriches a frozen task origin without reviving its state or progress", () => {
  const task = {
    version: 2 as const,
    role: "planner" as const,
    summary: "Plan checkout",
    result: null,
  };
  const terminal: TestView = { ...activeView(5), state: "finished", report: null, task };
  const origin = {
    parentRunId: "parent-one",
    requestKey: "call-one",
    parentMessageId: "assistant-one",
  };
  const enriched: TestView = { ...activeView(5), report: null, task: { ...task, origin } };
  const result = mergeHydratedTestingView([terminal, activeView(2, otherRunId)], enriched);
  assert.deepEqual(result[0], { ...terminal, task: { ...task, origin } });
  assert.deepEqual(result[1], activeView(2, otherRunId));
  assert.equal(
    mergeTestingView(result, { ...enriched, progress: { ...enriched.progress, version: 9 } }),
    result,
  );
});

test("a merge leaves untouched operations and inputs unchanged", () => {
  const both = [activeView(1), activeView(1, otherRunId)];
  const snapshot = structuredClone(both);
  const result = mergeTestingView(both, activeView(2));
  assert.notEqual(result, both);
  assert.deepEqual(both, snapshot);
  assert.notEqual(result[1], undefined);
});
