import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveFrontier,
  isDecided,
  isNotRequired,
  isSatisfied,
  isStyleRequired,
  phaseEligible,
  rootOutcome,
  type TestingPolicyState,
} from "../../../server/harness/testing-policy";

test("deriveFrontier returns empty when finished or cancel requested", () => {
  const finishedState: TestingPolicyState = {
    finished: true,
    cancelRequested: false,
    decisions: [],
    artifacts: [],
  };
  assert.deepEqual(deriveFrontier(finishedState), []);

  const cancelledState: TestingPolicyState = {
    finished: false,
    cancelRequested: true,
    decisions: [],
    artifacts: [],
  };
  assert.deepEqual(deriveFrontier(cancelledState), []);
});

test("deriveFrontier sequences atlassian before planner and AC before UI", () => {
  const initialState: TestingPolicyState = {
    finished: false,
    cancelRequested: false,
    decisions: [],
    artifacts: [],
  };
  assert.deepEqual(deriveFrontier(initialState), ["atlassian"]);

  const atlassianDone: TestingPolicyState = {
    ...initialState,
    decisions: [{ kind: "satisfied", role: "atlassian" }],
  };
  assert.deepEqual(deriveFrontier(atlassianDone), ["planner"]);

  const plannerDoneWithoutUi: TestingPolicyState = {
    ...initialState,
    decisions: [
      { kind: "satisfied", role: "atlassian" },
      { kind: "satisfied", role: "planner" },
    ],
    artifacts: [{ kind: "plan", payload: { assignments: {} } }],
  };
  assert.deepEqual(deriveFrontier(plannerDoneWithoutUi), ["ac"]);

  const plannerDoneWithUi: TestingPolicyState = {
    ...initialState,
    decisions: [
      { kind: "satisfied", role: "atlassian" },
      { kind: "satisfied", role: "planner" },
    ],
    artifacts: [{ kind: "plan", payload: { assignments: { ui: ["check-1"] } } }],
  };
  assert.deepEqual(deriveFrontier(plannerDoneWithUi), ["ac", "ui"]);

  const acDoneWithUi: TestingPolicyState = {
    ...plannerDoneWithUi,
    decisions: [
      { kind: "satisfied", role: "atlassian" },
      { kind: "satisfied", role: "planner" },
      { kind: "satisfied", role: "ac" },
    ],
  };
  assert.deepEqual(deriveFrontier(acDoneWithUi), ["ui"]);
});

test("phaseEligible checks task_result decision and dependencies", () => {
  const state: TestingPolicyState = {
    finished: false,
    cancelRequested: false,
    decisions: [
      { kind: "satisfied", role: "atlassian" },
      { kind: "task_result", role: "planner" },
    ],
    artifacts: [{ kind: "plan", payload: { assignments: { ui: ["check-1"] } } }],
  };

  assert.strictEqual(phaseEligible(state, "atlassian"), false);
  assert.strictEqual(phaseEligible(state, "planner"), false);
  assert.strictEqual(phaseEligible(state, "ac"), false);
  assert.strictEqual(phaseEligible(state, "ui"), false);

  const plannerSatisfied: TestingPolicyState = {
    ...state,
    decisions: [
      { kind: "satisfied", role: "atlassian" },
      { kind: "satisfied", role: "planner" },
    ],
  };
  assert.strictEqual(phaseEligible(plannerSatisfied, "ac"), true);
  assert.strictEqual(phaseEligible(plannerSatisfied, "ui"), true);

  const uiNotRequired: TestingPolicyState = {
    ...plannerSatisfied,
    decisions: [...plannerSatisfied.decisions, { kind: "not_required", role: "ui" }],
  };
  assert.strictEqual(phaseEligible(uiNotRequired, "ui"), false);
});

test("rootOutcome determines completion, cancellation, timeout, and failure", () => {
  const base: TestingPolicyState & { deadline: string } = {
    finished: false,
    cancelRequested: false,
    decisions: [
      { kind: "satisfied", role: "atlassian" },
      { kind: "satisfied", role: "planner" },
      { kind: "satisfied", role: "ac" },
    ],
    artifacts: [{ kind: "plan", payload: { assignments: {} } }],
    deadline: new Date(Date.now() + 60000).toISOString(),
  };

  assert.strictEqual(rootOutcome(base, Date.now()), "completed");

  const cancelled = { ...base, cancelRequested: true };
  assert.strictEqual(rootOutcome(cancelled, Date.now()), "cancelled");

  const timedOut = { ...base, deadline: new Date(Date.now() - 1000).toISOString() };
  assert.strictEqual(rootOutcome(timedOut, Date.now()), "timed_out");

  const missingRole = {
    ...base,
    decisions: [{ kind: "satisfied" as const, role: "atlassian" as const }],
  };
  assert.strictEqual(rootOutcome(missingRole, Date.now()), "failed");
});

test("predicates isSatisfied isNotRequired isStyleRequired isDecided behave consistently", () => {
  const state: TestingPolicyState = {
    finished: false,
    cancelRequested: false,
    decisions: [
      { kind: "satisfied", role: "atlassian" },
      { kind: "not_required", role: "ui" },
      { kind: "task_result", role: "ac" },
    ],
    artifacts: [{ kind: "plan", payload: { assignments: { ui: ["style-1"] } } }],
  };

  assert.strictEqual(isSatisfied(state, "atlassian"), true);
  assert.strictEqual(isSatisfied(state, "planner"), false);
  assert.strictEqual(isNotRequired(state), true);
  assert.strictEqual(isDecided(state, "ac"), true);
  assert.strictEqual(isDecided(state, "ui"), false);
  assert.strictEqual(isStyleRequired(state), true);
});
