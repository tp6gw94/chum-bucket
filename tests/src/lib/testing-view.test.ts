import assert from "node:assert/strict";
import { test } from "node:test";

import {
  artifactRefSchema,
  testRunIdSchema,
  type ProgressRow,
  type PublicTestReport,
  type RoleId,
  type TestView,
} from "../../../shared/testing";
import {
  ROLE_ORDER,
  beginCancelRequest,
  cancelButtonDisabled,
  cancelRequestFor,
  cancelRequestMessage,
  mergeTestView,
  orderedRows,
  settleCancelRequest,
} from "../../../src/lib/testing-view";

const runId = testRunIdSchema.parse("run-1");
const otherRunId = testRunIdSchema.parse("run-2");
const artifact = artifactRefSchema.parse("artifact:requirements:1");

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

function finishedView(version: number): TestView {
  return {
    runId,
    state: "finished",
    report: report(),
    progress: { version, rows: rows() },
    reuse: [],
    availableArtifacts: [artifact],
  };
}

test("role rows project in the fixed atlassian, planner, ac, ui order", () => {
  const card = { version: 1, rows: rows() };
  const projected = orderedRows(card);
  assert.deepEqual(
    projected.map(([role]) => role),
    [...ROLE_ORDER],
  );
  for (const [role, row] of projected) {
    assert.equal(row, card.rows[role]);
  }
});

test("a merge accepts a new run and a strictly newer version", () => {
  const incomingRun = activeView(1, otherRunId);
  assert.equal(mergeTestView(activeView(9), incomingRun), incomingRun);

  const current = activeView(2);
  const newer = activeView(3);
  assert.equal(mergeTestView(current, newer), newer);
});

test("a merge rejects stale and equal versions", () => {
  const current = activeView(4);
  assert.equal(mergeTestView(current, activeView(3)), current);
  assert.equal(mergeTestView(current, activeView(4)), current);
  assert.equal(mergeTestView(null, current), current);
});

test("a finished terminal is never revived by a later active projection", () => {
  const finished = finishedView(5);
  const active = activeView(6);
  assert.equal(mergeTestView(finished, active), finished);
  assert.equal(mergeTestView(finished, finishedView(7)), finished);
});

test("a merge leaves both snapshots untouched", () => {
  const current = activeView(1);
  const incoming = activeView(2);
  const currentSnapshot = structuredClone(current);
  const incomingSnapshot = structuredClone(incoming);
  mergeTestView(current, incoming);
  assert.deepEqual(current, currentSnapshot);
  assert.deepEqual(incoming, incomingSnapshot);
});

test("cancel state is scoped to the active run", () => {
  assert.deepEqual(cancelRequestFor(null, runId), { status: "idle" });
  assert.deepEqual(
    cancelRequestFor({ runId: otherRunId, generation: 2, request: { status: "accepted" } }, runId),
    { status: "idle" },
  );
  assert.deepEqual(
    cancelRequestFor({ runId, generation: 1, request: { status: "requesting" } }, runId),
    {
      status: "requesting",
    },
  );
});

test("the cancel control disables on server state and on local acknowledgement", () => {
  assert.equal(cancelButtonDisabled(activeView(1), { status: "idle" }), false);
  assert.equal(cancelButtonDisabled(activeView(1), { status: "requesting" }), true);
  assert.equal(cancelButtonDisabled(activeView(1), { status: "accepted" }), true);
  assert.equal(cancelButtonDisabled(activeView(1), { status: "failed", message: "boom" }), false);

  const cancelling: TestView = {
    runId,
    state: "cancelling",
    report: null,
    progress: { version: 2, rows: rows() },
    reuse: [],
    availableArtifacts: [],
  };
  assert.equal(cancelButtonDisabled(cancelling, { status: "idle" }), true);
  assert.equal(cancelButtonDisabled(finishedView(3), { status: "idle" }), true);
});

test("a late cancellation result for run A cannot replace the pending request for run B", () => {
  const runA = beginCancelRequest(null, runId, 1);
  const runB = beginCancelRequest(runA, otherRunId, 2);
  const pendingB = cancelRequestFor(runB, otherRunId);

  assert.deepEqual(cancelRequestFor(runB, runId), { status: "idle" });
  assert.deepEqual(pendingB, { status: "requesting" });
  assert.equal(cancelButtonDisabled(activeView(1, otherRunId), pendingB), true);
  assert.equal(cancelRequestMessage(pendingB), "取消要求已送出，等待伺服器回應。");
  assert.equal(settleCancelRequest(runB, runId, 1, { status: "accepted" }), runB);
  assert.equal(
    settleCancelRequest(runB, runId, 1, { status: "failed", message: "late A failure" }),
    runB,
  );

  const acceptedB = settleCancelRequest(runB, otherRunId, 2, { status: "accepted" });
  const acceptedRequest = cancelRequestFor(acceptedB, otherRunId);
  assert.deepEqual(acceptedRequest, { status: "accepted" });
  assert.equal(cancelButtonDisabled(activeView(1, otherRunId), acceptedRequest), true);
  assert.equal(cancelRequestMessage(acceptedRequest), "伺服器已接受取消要求，尚未確認停止。");

  const retryB = beginCancelRequest(acceptedB, otherRunId, 3);
  const failedB = settleCancelRequest(retryB, otherRunId, 3, {
    status: "failed",
    message: "network error",
  });
  const failedRequest = cancelRequestFor(failedB, otherRunId);
  assert.deepEqual(failedRequest, { status: "failed", message: "network error" });
  assert.equal(cancelButtonDisabled(activeView(1, otherRunId), failedRequest), false);
  assert.equal(cancelRequestMessage(failedRequest), "取消失敗：network error");
});

test("an older cancellation generation cannot settle a reused run id", () => {
  const runA1 = beginCancelRequest(null, runId, 1);
  const runB = beginCancelRequest(runA1, otherRunId, 2);
  const runA2 = beginCancelRequest(runB, runId, 3);

  assert.equal(settleCancelRequest(runA2, runId, 1, { status: "accepted" }), runA2);
  assert.equal(
    settleCancelRequest(runA2, runId, 1, { status: "failed", message: "late failure" }),
    runA2,
  );
  assert.equal(settleCancelRequest(runA2, otherRunId, 2, { status: "accepted" }), runA2);
  assert.deepEqual(cancelRequestFor(runA2, runId), { status: "requesting" });

  const acceptedA2 = settleCancelRequest(runA2, runId, 3, { status: "accepted" });
  assert.deepEqual(cancelRequestFor(acceptedA2, runId), { status: "accepted" });
  assert.equal(cancelButtonDisabled(activeView(1), cancelRequestFor(acceptedA2, runId)), true);

  const runA3 = beginCancelRequest(acceptedA2, runId, 4);
  const failedA3 = settleCancelRequest(runA3, runId, 4, {
    status: "failed",
    message: "request timed out",
  });
  assert.deepEqual(cancelRequestFor(failedA3, runId), {
    status: "failed",
    message: "request timed out",
  });
  assert.equal(cancelButtonDisabled(activeView(1), cancelRequestFor(failedA3, runId)), false);
  assert.equal(
    cancelRequestMessage(cancelRequestFor(failedA3, runId)),
    "取消失敗：request timed out",
  );
  assert.equal(settleCancelRequest(failedA3, runId, 3, { status: "accepted" }), failedA3);
});
