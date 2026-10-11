import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  DesignCapture,
  FunctionalCheck,
  PlanCase,
  StyleCheck,
} from "../../../../shared/testing";
import { browserOutputSchema, useBrowserInputSchema } from "../../../../shared/testing";
import { digestOf } from "../../../../server/harness/testing-domain";
import {
  createUseBrowserTool,
  type BrowserAdapter,
  type BrowserOutcome,
} from "../../../../server/harness/tools/use-browser";

const fixtureIdentity = { id: "playwright-chromium", version: "v1" };
const adapterVersion = "playwright-jev-v1";
const browser = { selections: [] };

function runner(outcomes: Readonly<Record<string, BrowserOutcome>>): BrowserAdapter["run"] {
  return async (_planCase, check) => {
    const outcome = outcomes[check.id];
    assert.ok(outcome, `Missing test observation for ${check.id}`);
    return { ...outcome, browser };
  };
}

const functionalChecks: readonly FunctionalCheck[] = [
  {
    id: "check-pass",
    criterionId: "crit:AC-1",
    kind: "functional",
    expectedObservation: "Order confirmation is visible",
  },
  {
    id: "check-fail",
    criterionId: "crit:AC-2",
    kind: "functional",
    expectedObservation: "Cart count is two",
  },
  {
    id: "check-blocked",
    criterionId: "crit:AC-3",
    kind: "functional",
    expectedObservation: "Receipt page loads",
  },
];

const styleChecks: readonly StyleCheck[] = [
  {
    id: "check-inside",
    criterionId: "crit:AC-1",
    kind: "style",
    design: { fileKey: "CheckoutDemo", nodeId: "12:34" },
    property: "padding-left",
    tolerance: { kind: "numeric", unit: "px", maxDelta: 2 },
  },
  {
    id: "check-outside",
    criterionId: "crit:AC-2",
    kind: "style",
    design: { fileKey: "CheckoutDemo", nodeId: "12:34" },
    property: "border-radius",
    tolerance: { kind: "numeric", unit: "px", maxDelta: 2 },
  },
  {
    id: "check-style-blocked",
    criterionId: "crit:AC-3",
    kind: "style",
    design: { fileKey: "CheckoutDemo", nodeId: "12:34" },
    property: "margin-top",
    tolerance: { kind: "exact" },
  },
];

const planCases: readonly PlanCase[] = [
  {
    id: "case-1",
    title: "Checkout",
    preconditions: [],
    actions: [
      { kind: "navigate", path: "/checkout" },
      { kind: "click", target: "Place order" },
    ],
    checks: [...functionalChecks, ...styleChecks],
  },
];

const figmaProperties = {
  "padding-left": "16px",
  "border-radius": "18px",
  "margin-top": "0px",
};

const designCapture: DesignCapture = {
  reference: { fileKey: "CheckoutDemo", nodeId: "12:34" },
  propertiesDigest: digestOf(figmaProperties),
  complete: true,
  capturedAt: "2026-10-09T00:00:00Z",
};

const functionalFixture: BrowserAdapter = {
  identity: fixtureIdentity,
  adapterVersion,
  run: runner({
    "check-pass": { state: "observed", observed: "Order confirmation is visible" },
    "check-fail": { state: "observed", observed: "Cart count is one" },
    "check-blocked": { state: "blocked", reason: "Fixture target page is unavailable" },
  }),
};

const styleFixture: BrowserAdapter = {
  identity: fixtureIdentity,
  adapterVersion,
  run: runner({
    "check-inside": { state: "observed", observed: "15px" },
    "check-outside": { state: "observed", observed: "24px" },
    "check-style-blocked": { state: "blocked", reason: "Fixture computed styles are unavailable" },
  }),
};

test("functional checks return literal pass, fail and blocked fixture outputs", async () => {
  const tool = createUseBrowserTool({
    role: "ac",
    cases: planCases,
    checks: functionalChecks,
    fixture: functionalFixture,
    figmaProperties: null,
    designCapture: null,
  });
  assert.deepEqual(await tool.execute!({ checkId: "check-pass" }), {
    checkId: "check-pass",
    evidence: {
      kind: "functional",
      outcome: "pass",
      caseId: "case-1",
      checkId: "check-pass",
      actionIndex: 1,
      expected: "Order confirmation is visible",
      observed: "Order confirmation is visible",
      origin: "browser",
      browser,
      fixture: fixtureIdentity,
      adapterVersion,
    },
  });
  assert.deepEqual(await tool.execute!({ checkId: "check-fail" }), {
    checkId: "check-fail",
    evidence: {
      kind: "functional",
      outcome: "fail",
      caseId: "case-1",
      checkId: "check-fail",
      actionIndex: 1,
      expected: "Cart count is two",
      observed: "Cart count is one",
      origin: "browser",
      browser,
      fixture: fixtureIdentity,
      adapterVersion,
    },
  });
  assert.deepEqual(await tool.execute!({ checkId: "check-blocked" }), {
    checkId: "check-blocked",
    evidence: {
      kind: "functional",
      outcome: "blocked",
      caseId: "case-1",
      checkId: "check-blocked",
      actionIndex: 1,
      reason: "Fixture target page is unavailable",
      origin: "browser",
      browser,
      fixture: fixtureIdentity,
      adapterVersion,
    },
  });
});

test("style checks bind expected properties, tolerance and the trusted design capture", async () => {
  const tool = createUseBrowserTool({
    role: "ui",
    cases: planCases,
    checks: styleChecks,
    fixture: styleFixture,
    figmaProperties,
    designCapture,
  });
  assert.deepEqual(await tool.execute!({ checkId: "check-inside" }), {
    checkId: "check-inside",
    evidence: {
      kind: "style",
      outcome: "inside_tolerance",
      caseId: "case-1",
      checkId: "check-inside",
      property: "padding-left",
      expected: "16px",
      observed: "15px",
      tolerance: { kind: "numeric", unit: "px", maxDelta: 2 },
      capturedDesign: designCapture,
      origin: "browser",
      browser,
      fixture: fixtureIdentity,
      adapterVersion,
    },
  });
  assert.deepEqual(await tool.execute!({ checkId: "check-outside" }), {
    checkId: "check-outside",
    evidence: {
      kind: "style",
      outcome: "outside_tolerance",
      caseId: "case-1",
      checkId: "check-outside",
      property: "border-radius",
      expected: "18px",
      observed: "24px",
      tolerance: { kind: "numeric", unit: "px", maxDelta: 2 },
      capturedDesign: designCapture,
      origin: "browser",
      browser,
      fixture: fixtureIdentity,
      adapterVersion,
    },
  });
  assert.deepEqual(await tool.execute!({ checkId: "check-style-blocked" }), {
    checkId: "check-style-blocked",
    evidence: {
      kind: "style",
      outcome: "blocked",
      caseId: "case-1",
      checkId: "check-style-blocked",
      property: "margin-top",
      tolerance: { kind: "exact" },
      capturedDesign: designCapture,
      reason: "Fixture computed styles are unavailable",
      origin: "browser",
      browser,
      fixture: fixtureIdentity,
      adapterVersion,
    },
  });
});

test("numeric style observations reject foreign units, trailing junk and non-finite values", async () => {
  const checks: readonly StyleCheck[] = [
    {
      id: "check-foreign-unit",
      criterionId: "crit:AC-1",
      kind: "style",
      design: { fileKey: "CheckoutDemo", nodeId: "12:34" },
      property: "padding-left",
      tolerance: { kind: "numeric", unit: "px", maxDelta: 2 },
    },
    {
      id: "check-missing-px-unit",
      criterionId: "crit:AC-1",
      kind: "style",
      design: { fileKey: "CheckoutDemo", nodeId: "12:34" },
      property: "padding-left",
      tolerance: { kind: "numeric", unit: "px", maxDelta: 2 },
    },
    {
      id: "check-trailing-junk",
      criterionId: "crit:AC-1",
      kind: "style",
      design: { fileKey: "CheckoutDemo", nodeId: "12:34" },
      property: "padding-left",
      tolerance: { kind: "numeric", unit: "px", maxDelta: 2 },
    },
    {
      id: "check-invalid-capture-unit",
      criterionId: "crit:AC-1",
      kind: "style",
      design: { fileKey: "CheckoutDemo", nodeId: "12:34" },
      property: "captured-padding",
      tolerance: { kind: "numeric", unit: "px", maxDelta: 2 },
    },
    {
      id: "check-ratio-percent",
      criterionId: "crit:AC-1",
      kind: "style",
      design: { fileKey: "CheckoutDemo", nodeId: "12:34" },
      property: "opacity",
      tolerance: { kind: "numeric", unit: "ratio", maxDelta: 0.1 },
    },
    {
      id: "check-non-finite",
      criterionId: "crit:AC-1",
      kind: "style",
      design: { fileKey: "CheckoutDemo", nodeId: "12:34" },
      property: "padding-left",
      tolerance: { kind: "numeric", unit: "px", maxDelta: 2 },
    },
  ];
  const numericProperties = {
    "padding-left": "16px",
    "captured-padding": "16em",
    opacity: "0.5",
  };
  const fixture: BrowserAdapter = {
    identity: fixtureIdentity,
    adapterVersion,
    run: runner({
      "check-foreign-unit": { state: "observed", observed: "16em" },
      "check-missing-px-unit": { state: "observed", observed: "16" },
      "check-trailing-junk": { state: "observed", observed: "16garbage" },
      "check-invalid-capture-unit": { state: "observed", observed: "16px" },
      "check-ratio-percent": { state: "observed", observed: "0.5%" },
      "check-non-finite": { state: "observed", observed: "Infinitypx" },
    }),
  };
  const tool = createUseBrowserTool({
    role: "ui",
    cases: [{ ...planCases[0]!, checks: [...checks] }],
    checks,
    fixture,
    figmaProperties: numericProperties,
    designCapture: {
      reference: { fileKey: "CheckoutDemo", nodeId: "12:34" },
      propertiesDigest: digestOf(numericProperties),
      complete: true,
      capturedAt: "2026-10-09T00:00:00Z",
    },
  });
  const outcomes = [];

  for (const check of checks) {
    const output = browserOutputSchema.parse(await tool.execute!({ checkId: check.id }));
    outcomes.push(output.evidence.outcome);
  }

  assert.deepEqual(outcomes, [
    "outside_tolerance",
    "outside_tolerance",
    "outside_tolerance",
    "outside_tolerance",
    "outside_tolerance",
    "outside_tolerance",
  ]);
});

test("legacy static outcomes cannot execute and role scope remains enforced", () => {
  const scope = {
    role: "ac" as const,
    cases: planCases,
    checks: functionalChecks,
    figmaProperties: null,
    designCapture: null,
  };
  assert.throws(
    () =>
      createUseBrowserTool({
        ...scope,
        fixture: {
          identity: fixtureIdentity,
          adapterVersion,
          outcomes: { "check-pass": { state: "observed", observed: "fabricated" } },
        } as unknown as BrowserAdapter,
      }),
    /requires a live runner/,
  );
  assert.throws(
    () =>
      createUseBrowserTool({
        role: "ac",
        cases: planCases,
        checks: [styleChecks[0]!],
        fixture: {
          ...functionalFixture,
        },
        figmaProperties: null,
        designCapture: null,
      }),
    /not a functional check/,
  );
  assert.throws(
    () =>
      createUseBrowserTool({
        role: "ui",
        cases: planCases,
        checks: [styleChecks[0]!],
        fixture: {
          ...styleFixture,
        },
        figmaProperties: {},
        designCapture: {
          reference: { fileKey: "CheckoutDemo", nodeId: "12:34" },
          propertiesDigest: digestOf({}),
          complete: true,
          capturedAt: "2026-10-09T00:00:00Z",
        },
      }),
    /no property padding-left/,
  );
});

test("the factory rejects unknown case assignments and untrusted capture metadata", () => {
  const scopedStyle = {
    role: "ui" as const,
    cases: planCases,
    checks: [styleChecks[0]!],
    fixture: {
      identity: fixtureIdentity,
      adapterVersion,
      run: runner({ "check-inside": { state: "observed", observed: "15px" } }),
    },
    figmaProperties: { "padding-left": "16px" },
  };
  assert.throws(
    () =>
      createUseBrowserTool({
        role: "ac",
        cases: [],
        checks: [functionalChecks[0]!],
        fixture: functionalFixture,
        figmaProperties: null,
        designCapture: null,
      }),
    /not assigned to a canonical case/,
  );
  assert.throws(
    () =>
      createUseBrowserTool({
        role: "ac",
        cases: [{ ...planCases[0]!, actions: [] }],
        checks: [functionalChecks[0]!],
        fixture: functionalFixture,
        figmaProperties: null,
        designCapture: null,
      }),
    /no planned actions/,
  );
  assert.throws(
    () =>
      createUseBrowserTool({
        ...scopedStyle,
        designCapture: {
          reference: { fileKey: "Other", nodeId: "1:1" },
          propertiesDigest: digestOf({ "padding-left": "16px" }),
          complete: true,
          capturedAt: "2026-10-09T00:00:00Z",
        },
      }),
    /does not reference the captured design/,
  );
  assert.throws(
    () =>
      createUseBrowserTool({
        ...scopedStyle,
        designCapture: {
          reference: { fileKey: "CheckoutDemo", nodeId: "12:34" },
          propertiesDigest: "0".repeat(64),
          complete: true,
          capturedAt: "2026-10-09T00:00:00Z",
        },
      }),
    /digest does not match/,
  );
});

test("the tool rejects unknown, unassigned and malformed input", async () => {
  const tool = createUseBrowserTool({
    role: "ac",
    cases: planCases,
    checks: functionalChecks,
    fixture: functionalFixture,
    figmaProperties: null,
    designCapture: null,
  });
  await assert.rejects(async () => {
    await tool.execute!({ checkId: "check-other" });
  }, /Unknown scoped check/);
  assert.equal(
    useBrowserInputSchema.safeParse({ checkId: "check-pass", observed: "fabricated" }).success,
    false,
  );
  assert.equal(useBrowserInputSchema.safeParse({}).success, false);
});
