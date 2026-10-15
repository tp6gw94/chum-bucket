import assert from "node:assert/strict";
import { test } from "node:test";
import {
  delegationInputSchema,
  handoffDecisionSchema,
  parsePublishedTasks,
  parseTestingProjectionEvent,
  testingProjectionEventName,
  type TestView,
} from "../../shared/testing";

const view: TestView = {
  operationId: "testing-0123456789abcdef0123456789abcdef",
  threadId: "thread",
  requestKey: "call-1",
  version: 2,
  role: "planner",
  summary: "Plan checkout",
  state: "running",
  cancelRequested: false,
  outcome: null,
  task: null,
  artifact: null,
};

test("delegation input accepts each role shape", () => {
  const inputs = [
    {
      role: "atlassian",
      summary: "Read PROJ-1",
      goal: "Collect checkout requirements",
      sources: [{ kind: "jira", issueKey: "PROJ-1" }],
    },
    {
      role: "planner",
      summary: "Plan",
      requirementsRef: "art-1",
      design: { fileKey: "abc", nodeId: "1:2" },
    },
    { role: "ac", summary: "Verify", planRef: "art-2", targetUrl: "http://localhost:4173/" },
    { role: "ui", summary: "Verify", planRef: "art-2", targetUrl: "https://example.com" },
  ];

  for (const input of inputs) {
    assert.equal(delegationInputSchema.safeParse(input).success, true, input.role);
  }
});

test("delegation input rejects unknown fields, empty sources, and unsafe urls", () => {
  const rejected = [
    { role: "atlassian", summary: "s", goal: "g", sources: [] },
    { role: "planner", summary: "s", requirementsRef: "art-1", extra: true },
    {
      role: "planner",
      summary: "s",
      requirementsRef: "art-1",
      design: { fileKey: "abc", nodeId: "1-2" },
    },
    { role: "ac", summary: "s", planRef: "art-2", targetUrl: "file:///etc/passwd" },
    { role: "ac", summary: "s", planRef: "art-2", targetUrl: "javascript:alert(1)" },
    { role: "qa", summary: "s" },
  ];

  for (const input of rejected) {
    assert.equal(delegationInputSchema.safeParse(input).success, false, JSON.stringify(input));
  }
});

test("handoff decisions only reference handoff ids", () => {
  assert.equal(
    handoffDecisionSchema.safeParse({ kind: "choose", candidateId: "c3" }).success,
    true,
  );
  assert.equal(handoffDecisionSchema.safeParse({ kind: "navigate", linkId: "l0" }).success, true);
  assert.equal(
    handoffDecisionSchema.safeParse({ kind: "choose", candidateId: "#submit" }).success,
    false,
  );
  assert.equal(handoffDecisionSchema.safeParse({ kind: "abandon", reason: " " }).success, false);
});

test("projection events and published tasks parse defensively", () => {
  assert.deepEqual(
    parseTestingProjectionEvent({ type: "CUSTOM", name: testingProjectionEventName, value: view }),
    view,
  );
  assert.equal(parseTestingProjectionEvent({ type: "CUSTOM", name: "other", value: view }), null);
  assert.deepEqual(parsePublishedTasks([view]), [view]);
  assert.deepEqual(parsePublishedTasks([{ ...view, role: "main" }]), []);
  assert.deepEqual(parsePublishedTasks(undefined), []);
});
