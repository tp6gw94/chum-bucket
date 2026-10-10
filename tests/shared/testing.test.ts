import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evidenceSchema,
  testingRequestInputSchema,
  testingRequestSchema,
} from "../../shared/testing";

const base = {
  goal: "Verify checkout behavior and styles",
  sources: [{ kind: "jira", issueKey: "CHUM-42" }],
  criteria: { kind: "all" },
  targetUrl: "https://preview.example.test/checkout",
};

test("a public request parses to exactly the intent fields", () => {
  assert.deepEqual(testingRequestInputSchema.parse(base), {
    goal: "Verify checkout behavior and styles",
    sources: [{ kind: "jira", issueKey: "CHUM-42" }],
    criteria: { kind: "all" },
    targetUrl: "https://preview.example.test/checkout",
  });
});

test("host binds thread, revision and request identity outside the intent", () => {
  assert.deepEqual(
    testingRequestSchema.parse({
      ...base,
      criteria: { kind: "selected", keys: ["AC-1"] },
      design: { fileKey: "CheckoutDemo", nodeId: "12:34" },
      existingArtifacts: ["artifact-1"],
      threadId: "thread-1",
      expectedRevision: 4,
      requestId: "request-1",
    }),
    {
      ...base,
      criteria: { kind: "selected", keys: ["AC-1"] },
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
    { ...base, criteria: { kind: "selected", keys: [] } },
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
