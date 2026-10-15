import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestView } from "../../../shared/testing";
import {
  artifactLines,
  mergeTestingView,
  mergeTestingViews,
  testingActivity,
  testingStatus,
} from "../../../src/lib/testing-views";

const base: TestView = {
  operationId: "testing-0123456789abcdef0123456789abcdef",
  threadId: "thread",
  requestKey: "call-1",
  version: 1,
  role: "ac",
  summary: "Verify checkout",
  state: "running",
  cancelRequested: false,
  outcome: null,
  task: {
    status: "running",
    reasonCode: null,
    issues: [],
    activity: { kind: "tool", name: "verify_ac" },
    modelSteps: 1,
    toolCalls: 2,
  },
  artifact: null,
};

test("views merge by request key and keep the newest version", () => {
  const first = mergeTestingView({}, base);
  const newer = { ...base, version: 3 };

  assert.equal(mergeTestingView(first, { ...base, version: 1 }), first);
  assert.equal(mergeTestingView(first, newer)["call-1"], newer);
  assert.equal(mergeTestingViews(first, [newer, { ...base, version: 2 }])["call-1"], newer);
  assert.deepEqual(Object.keys(mergeTestingView(first, { ...base, requestKey: "call-2" })), [
    "call-1",
    "call-2",
  ]);
});

test("status prefers outcome, then cancellation, then task status", () => {
  assert.equal(testingStatus(base), "執行中");
  assert.equal(testingStatus({ ...base, cancelRequested: true }), "取消中");
  assert.equal(testingStatus({ ...base, state: "finished", outcome: "deadline" }), "逾時");
  assert.equal(testingStatus({ ...base, task: null }), "排隊中");
});

test("activity is shown only while running", () => {
  assert.equal(testingActivity(base), "執行工具 verify_ac");
  assert.equal(
    testingActivity({ ...base, task: { ...base.task!, activity: { kind: "model", name: null } } }),
    "模型思考中",
  );
  assert.equal(testingActivity({ ...base, state: "finished" }), null);
});

test("artifact lines summarize each artifact kind", () => {
  assert.deepEqual(
    artifactLines({
      ...base,
      artifact: {
        ref: "art-1",
        kind: "ac-result",
        payload: { checks: [{ outcome: "pass" }, { outcome: "fail" }, { outcome: "pass" }] },
      },
    }),
    ["3 項檢查：pass 2、fail 1"],
  );
  assert.deepEqual(
    artifactLines({
      ...base,
      artifact: {
        ref: "art-2",
        kind: "plan",
        payload: { criteria: [1], cases: [1, 2], unresolved: [] },
      },
    }),
    ["1 條驗收條件、2 個測試案例", "未執行案例 0 個、待釐清 0 項"],
  );
  assert.deepEqual(artifactLines(base), []);
});
