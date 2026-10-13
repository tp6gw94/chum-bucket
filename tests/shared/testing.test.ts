import assert from "node:assert/strict";
import { test } from "node:test";
import {
  actionSchema,
  browserHandoffSchema,
  evidenceSchema,
  planCheckSchema,
  testingRequestInputSchema,
  testingRequestSchema,
} from "../../shared/testing";

const base = {
  goal: "Verify checkout behavior and styles",
  sources: [{ kind: "jira", issueKey: "CHUM-42" }],
  targetUrl: "https://preview.example.test/checkout",
};

test("a public request parses to exactly the intent fields", () => {
  assert.deepEqual(testingRequestInputSchema.parse(base), {
    goal: "Verify checkout behavior and styles",
    sources: [{ kind: "jira", issueKey: "CHUM-42" }],
    targetUrl: "https://preview.example.test/checkout",
  });
});

test("host binds thread, revision and request identity outside the intent", () => {
  assert.deepEqual(
    testingRequestSchema.parse({
      ...base,
      design: { fileKey: "CheckoutDemo", nodeId: "12:34" },
      existingArtifacts: ["artifact-1"],
      threadId: "thread-1",
      expectedRevision: 4,
      requestId: "request-1",
    }),
    {
      ...base,
      design: { fileKey: "CheckoutDemo", nodeId: "12:34" },
      existingArtifacts: ["artifact-1"],
      threadId: "thread-1",
      expectedRevision: 4,
      requestId: "request-1",
    },
  );
});

test("empty existing artifact lists are a valid no-reuse request", () => {
  assert.deepEqual(
    testingRequestInputSchema.parse({ ...base, existingArtifacts: [] }).existingArtifacts,
    [],
  );
});

test("public mock evidence requires case, check and kind-specific metadata", () => {
  const capture = {
    reference: { fileKey: "CheckoutDemo", nodeId: "12:34" },
    propertiesDigest: "digest-1",
    complete: true,
    capturedAt: "2026-10-09T00:00:00Z",
  };
  const functional = {
    kind: "functional",
    outcome: "pass",
    caseId: "case-1",
    checkId: "check-1",
    actionIndex: 0,
    expected: "Order confirmation is visible",
    observed: "Order confirmation is visible",
    origin: "mock",
    fixture: { id: "fixture-1", version: "1" },
    adapterVersion: "browser-mock-1",
  };
  assert.equal(evidenceSchema.safeParse(functional).success, true);
  assert.equal(evidenceSchema.safeParse({ ...functional, actionIndex: undefined }).success, false);
  assert.equal(evidenceSchema.safeParse({ ...functional, checkId: undefined }).success, false);

  const style = {
    kind: "style",
    outcome: "inside_tolerance",
    caseId: "case-1",
    checkId: "check-2",
    property: "padding-left",
    expected: "16px",
    observed: "15px",
    tolerance: { kind: "numeric", unit: "px", maxDelta: 2 },
    capturedDesign: capture,
    origin: "mock",
    fixture: { id: "fixture-1", version: "1" },
    adapterVersion: "browser-mock-1",
  };
  assert.equal(evidenceSchema.safeParse(style).success, true);
  assert.equal(
    evidenceSchema.safeParse({ ...style, capturedDesign: { ...capture, complete: false } }).success,
    false,
  );
});

test("unknown, empty and malformed request fields are rejected", () => {
  const cases = [
    { ...base, model: "deepseek-ai/DeepSeek-V4.1-Flash" },
    { ...base, sources: [] },
    { ...base, criteria: { kind: "all" } },
    { ...base, criteria: { kind: "selected", keys: ["AC-1"] } },
    { ...base, scope: "AC-1" },
    { ...base, targetUrl: "not-a-url" },
    { ...base, goal: "   " },
  ];

  for (const input of cases) {
    assert.equal(testingRequestInputSchema.safeParse(input).success, false);
  }

  assert.equal(testingRequestSchema.safeParse(base).success, false);
  assert.equal(
    testingRequestSchema.safeParse({
      ...base,
      sources: [{ kind: "confluence", pageId: "1" }, { kind: "jira" }],
    }).success,
    false,
  );
});

test("an operable check compares only by equality against true or false", () => {
  const check = {
    id: "decrease",
    criterionId: "AC-3",
    kind: "functional",
    expectedObservation: "false",
    observation: { kind: "operable", target: "decrease quantity control", comparison: "equals" },
  };

  assert.deepEqual(
    [
      check,
      { ...check, expectedObservation: "true" },
      { ...check, expectedObservation: "disabled" },
      { ...check, observation: { ...check.observation, comparison: "contains" } },
      { ...check, observation: { kind: "operable", comparison: "equals" } },
    ].map((item) => planCheckSchema.safeParse(item).success),
    [true, true, false, false, false],
  );
});

test("a fill action may omit its value, and an empty value stays a planned value", () => {
  assert.deepEqual(actionSchema.parse({ kind: "fill", target: "order note" }), {
    kind: "fill",
    target: "order note",
  });
  assert.deepEqual(actionSchema.parse({ kind: "fill", target: "order note", value: "" }), {
    kind: "fill",
    target: "order note",
    value: "",
  });
  assert.equal(
    actionSchema.safeParse({ kind: "fill", target: "order note", value: "x".repeat(2_049) })
      .success,
    false,
  );
});

test("a handoff output pairs each state with its snapshot kind", () => {
  const image = { path: "00000000-0000-4000-8000-000000000000.png", digest: "d".repeat(64) };
  const fill = {
    kind: "fill_value",
    id: "h2",
    caseId: "case-1",
    laterSelectionHandoffs: 3,
    expiresAt: "2026-10-13T00:03:00.000Z",
    url: "http://127.0.0.1:4173/checkout",
    target: { intent: "order note", operation: "fill", at: { kind: "action", index: 1 } },
    field: { id: "c0", description: "Order note" },
    links: [],
    image,
  };

  assert.deepEqual(
    [
      { state: "fill_value_required", checkId: "check-1", handoff: fill },
      { state: "selection_required", checkId: "check-1", handoff: fill },
      {
        state: "fill_value_required",
        checkId: "check-1",
        handoff: { ...fill, target: { ...fill.target, operation: "click" } },
      },
      {
        state: "fill_value_required",
        checkId: "check-1",
        handoff: { ...fill, laterSelectionHandoffs: 4 },
      },
    ].map((output) => browserHandoffSchema.safeParse(output).success),
    [true, false, false, false],
  );
});

test("browser evidence records skipped actions with one or both non-operable reasons", () => {
  const evidence = (skippedActions: unknown) => ({
    kind: "functional",
    outcome: "pass",
    expected: "Count: 1",
    observed: "Count: 1",
    actionIndex: 2,
    caseId: "case-1",
    checkId: "check-1",
    origin: "browser",
    fixture: { id: "playwright-chromium", version: "v1" },
    adapterVersion: "playwright-jev-v1",
    browser: { selections: [], skippedActions },
  });

  assert.deepEqual(
    [
      [{ actionIndex: 1, reasons: ["disabled"] }],
      [{ actionIndex: 1, reasons: ["hidden", "disabled"] }],
      [{ actionIndex: 1, reasons: [] }],
      [{ actionIndex: 1, reasons: ["disabled", "hidden"] }],
      [{ actionIndex: 1, reasons: ["hidden", "hidden"] }],
    ].map((skipped) => evidenceSchema.safeParse(evidence(skipped)).success),
    [true, true, false, false, false],
  );
});
