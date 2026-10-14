import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationState } from "../../../server/harness/conversation";
import type { RoleTaskInput } from "../../../server/harness/prompts";
import { reviewPlanner } from "../../../server/harness/role-run";
import type { Requirements } from "../../../server/harness/testing-domain";
import { testingIntentSchema } from "../../../shared/testing";

const requirements: Requirements = {
  goal: "Checkout",
  sources: [
    {
      reference: { kind: "jira", issueKey: "PROJ-1" },
      text: "The checkout heading is Checkout",
      links: [],
      digest: "digest-1",
      capturedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

function intentWith(
  design?: Readonly<{ fileKey: string; nodeId: string }>,
): RoleTaskInput["intent"] {
  return testingIntentSchema.parse({
    goal: "Checkout",
    sources: [{ kind: "jira", issueKey: "PROJ-1" }],
    targetUrl: null,
    ...(design ? { design } : {}),
    task: {
      version: 2,
      input: {
        role: "planner",
        summary: "Plan the checkout subset",
        requirementsRef: "requirements-1",
      },
    },
  });
}

function reply(text: string): ConversationState {
  const message = {
    id: "assistant-1",
    role: "assistant" as const,
    parts: [{ type: "text" as const, content: text }],
  };

  return { display: [message], context: [message] };
}

test("canonical proposals still fail when a functional check lacks observation or a style check lacks target", () => {
  const withoutObservation = {
    criteria: [{ id: "AC-1", statement: "The checkout heading is Checkout" }],
    unresolved: [],
    cases: [
      {
        id: "case-1",
        title: "Checkout heading",
        preconditions: [],
        actions: [{ kind: "navigate", path: "/" }],
        checks: [
          {
            id: "check-1",
            criterionId: "AC-1",
            kind: "functional",
            expectedObservation: "Checkout",
          },
        ],
      },
    ],
  };
  const missingObservation = reviewPlanner(
    { intent: intentWith(), requirements },
    reply(JSON.stringify(withoutObservation)),
  );

  assert.deepEqual(missingObservation.issues, [
    "Check check-1 requires a typed executable observation or style target",
  ]);
  assert.deepEqual(missingObservation.completion, {
    role: "planner",
    proposal: withoutObservation,
  });

  const design = { fileKey: "CheckoutDemo", nodeId: "12:34" };
  const withoutTarget = {
    criteria: [{ id: "AC-1", statement: "The checkout button is 320px wide" }],
    unresolved: [],
    cases: [
      {
        id: "case-1",
        title: "Checkout button width",
        preconditions: [],
        actions: [{ kind: "navigate", path: "/" }],
        checks: [
          {
            id: "check-2",
            criterionId: "AC-1",
            kind: "style",
            design,
            property: "width",
            tolerance: { kind: "exact" },
          },
        ],
      },
    ],
  };
  const missingTarget = reviewPlanner(
    { intent: intentWith(design), requirements },
    reply(JSON.stringify(withoutTarget)),
  );

  assert.deepEqual(missingTarget.issues, [
    "Check check-2 requires a typed executable observation or style target",
  ]);
});

test("requirements absence is reported before the proposal is inspected", () => {
  const result = reviewPlanner(
    { intent: intentWith(), requirements: null },
    reply(JSON.stringify({ criteria: [], unresolved: [], cases: [] })),
  );

  assert.deepEqual(result.issues, ["requirements_missing"]);
});

test("text without JSON is reported with a null proposal", () => {
  const result = reviewPlanner(
    { intent: intentWith(), requirements },
    reply("I could not finish the plan"),
  );

  assert.deepEqual(result, {
    completion: { role: "planner", proposal: null },
    issues: ["Role output is not valid JSON"],
  });
});
