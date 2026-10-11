import assert from "node:assert/strict";
import { test } from "node:test";
import { delegationInputSchema } from "../../shared/testing";

test("planner accepts an explicit requirements reference without a target URL", () => {
  assert.deepEqual(
    delegationInputSchema.parse({
      role: "planner",
      summary: "Plan checkout acceptance checks",
      requirementsRef: "requirements-checkout",
    }),
    {
      role: "planner",
      summary: "Plan checkout acceptance checks",
      requirementsRef: "requirements-checkout",
    },
  );
});

test("each delegation names exactly one role and its immutable dependency", () => {
  const input = {
    role: "ac",
    summary: "Check checkout",
    planRef: "plan-checkout",
    targetUrl: "https://example.test",
  };
  assert.deepEqual(delegationInputSchema.parse(input), input);
  for (const invalid of [
    { ...input, planRef: undefined },
    { ...input, targetUrl: undefined },
    { ...input, requirements: { criteria: [] } },
    { ...input, roles: ["ac", "ui"] },
    { role: "planner", summary: "Plan", existingArtifacts: ["requirements-checkout"] },
  ]) {
    assert.equal(delegationInputSchema.safeParse(invalid).success, false);
  }
});

test("atlassian takes source intent, not a browser URL or untrusted requirements", () => {
  const input = {
    role: "atlassian",
    summary: "Read checkout requirements",
    goal: "Checkout",
    sources: [{ kind: "jira", issueKey: "TEST-1" }],
    criteria: { kind: "all" },
  };
  assert.deepEqual(delegationInputSchema.parse(input), input);
  assert.equal(
    delegationInputSchema.safeParse({ ...input, targetUrl: "https://example.test" }).success,
    false,
  );
});
