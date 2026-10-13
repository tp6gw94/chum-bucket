import assert from "node:assert/strict";
import { test } from "node:test";
import { rootOutcome, type TestingPolicyState } from "../../../server/harness/testing-policy";
import { ROLE_IDS } from "../../../shared/testing";

const base: TestingPolicyState = {
  intent: { task: { input: { role: "planner" } } },
  cancelRequested: false,
  deadline: "2030-01-01T00:00:00Z",
  decisions: [],
};

test("completion depends only on the explicitly delegated role", () => {
  for (const role of ROLE_IDS) {
    const state = {
      ...base,
      intent: { task: { input: { role } } },
      decisions: [{ kind: "task_result", role, execution: "completed" }],
    };
    assert.equal(rootOutcome(state, 0), "completed");
    assert.equal(rootOutcome({ ...state, decisions: [] }, 0), "failed");
  }
});

test("a completed dependency never impersonates a completed delegated task", () => {
  assert.equal(
    rootOutcome(
      { ...base, decisions: [{ kind: "task_result", role: "atlassian", execution: "completed" }] },
      0,
    ),
    "failed",
  );
  assert.equal(
    rootOutcome(
      { ...base, decisions: [{ kind: "task_result", role: "planner", execution: "completed" }] },
      0,
    ),
    "completed",
  );
});

test("cancellation and fixed deadlines override a late result", () => {
  const state = {
    ...base,
    decisions: [{ kind: "task_result", role: "planner" as const, execution: "completed" }],
  };
  assert.equal(rootOutcome({ ...state, cancelRequested: true }, 0), "cancelled");
  assert.equal(rootOutcome(state, Date.parse("2030-01-01T00:00:00Z")), "timed_out");
  assert.equal(
    rootOutcome(
      { ...state, decisions: [{ kind: "task_result", role: "planner", execution: "timed_out" }] },
      0,
    ),
    "timed_out",
  );
});

test("legacy operations cannot enter the new task lifecycle", () => {
  assert.throws(() => rootOutcome({ ...base, intent: {} }, 0), /maintenance/);
  assert.equal(rootOutcome({ ...base, cancelRequested: true }, 0), "cancelled");
});
