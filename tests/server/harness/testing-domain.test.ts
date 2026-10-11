import assert from "node:assert/strict";
import { test } from "node:test";
import { artifactRefSchema, testRunIdSchema } from "../../../shared/testing";
import type {
  CriteriaSelection,
  Judgment,
  PlanCheck,
  PublicEvidence,
} from "../../../shared/testing";
import {
  canonicalizePlan,
  deriveReport,
  digestOf,
  planScopeDigest,
  projectProgress,
  requirementsScopeDigest,
  sourceCaptureView,
  validateRequirements,
  validateResults,
  validateReuse,
  type CanonicalPlan,
  type PlanContext,
  type Requirements,
  type Results,
  type SourceCapture,
  type TrustedToolReceipt,
  type Validation,
} from "../../../server/harness/testing-domain";

function accept<T>(
  validation: Validation<T> | Readonly<{ kind: "not_extractable"; unresolved: readonly string[] }>,
): T {
  if (validation.kind !== "accepted") {
    throw new Error(
      `setup failed: ${validation.kind === "rejected" ? validation.issues.join(", ") : "not extractable"}`,
    );
  }

  return validation.value;
}

const capture: SourceCapture = {
  reference: { kind: "jira", issueKey: "CHUM-42" },
  digest: "capture-1",
  anchors: ["AC-1", "AC-2"],
  capturedAt: "2026-10-09T00:00:00Z",
};

test("anchor IDs resolve seven criteria without copying a 456-character source", () => {
  const anchor = "a".repeat(456);
  const longCapture = { ...capture, anchors: [anchor] };
  const anchorId = digestOf({
    namespace: "requirements-anchor-v1",
    reference: capture.reference,
    digest: capture.digest,
    anchor,
  });
  const context = {
    goal: "Verify checkout",
    selection: { kind: "all" as const },
    captures: [longCapture],
  };
  const criteria = Array.from({ length: 7 }, (_, index) => ({
    key: `AC-${index + 1}`,
    statement: `Requirement ${index + 1}`,
    source: capture.reference,
    anchorId,
  }));
  const result = accept(validateRequirements({ criteria, unresolved: [] }, context));
  assert.deepEqual(
    result.criteria.map((criterion) => criterion.key),
    ["AC-1", "AC-2", "AC-3", "AC-4", "AC-5", "AC-6", "AC-7"],
  );
  assert.equal(result.criteria[6]?.anchor, anchor);
  const legacy = accept(
    validateRequirements(
      {
        criteria: criteria.map(({ anchorId: _, ...criterion }) => ({ ...criterion, anchor })),
        unresolved: [],
      },
      context,
    ),
  );
  assert.deepEqual(result, legacy);
  assert.equal(digestOf(result), digestOf(legacy));
  const selected = accept(
    validateRequirements(
      { criteria, unresolved: [] },
      { ...context, selection: { kind: "selected", keys: ["AC-2"] } },
    ),
  );
  assert.deepEqual(selected.selection, { kind: "selected", keys: ["AC-2"] });
  assert.equal(selected.criteria.length, 7);
});

test("source capture views bind IDs to source and digest without changing receipts", () => {
  const view = sourceCaptureView(capture);
  assert.deepEqual(view.anchorRefs, [
    {
      id: digestOf({
        namespace: "requirements-anchor-v1",
        reference: capture.reference,
        digest: capture.digest,
        anchor: "AC-1",
      }),
      text: "AC-1",
    },
    {
      id: digestOf({
        namespace: "requirements-anchor-v1",
        reference: capture.reference,
        digest: capture.digest,
        anchor: "AC-2",
      }),
      text: "AC-2",
    },
  ]);
  assert.deepEqual(
    sourceCaptureView({ ...capture, capturedAt: "later", anchors: ["AC-2", "AC-1"] }).anchorRefs,
    [...view.anchorRefs].reverse(),
  );
  assert.equal("anchorRefs" in capture, false);
  const criterion = {
    key: "AC-1",
    statement: "Checkout succeeds",
    source: capture.reference,
    anchorId: view.anchorRefs[0]!.id,
  };
  const context = {
    goal: "Verify checkout",
    selection: { kind: "all" as const },
    captures: [capture],
  };
  for (const captures of [
    [{ ...capture, digest: "other" }],
    [{ ...capture, reference: { kind: "jira" as const, issueKey: "OTHER" } }],
    [{ ...capture, digest: "other" }, capture],
  ]) {
    const result = validateRequirements(
      { criteria: [criterion], unresolved: [] },
      { ...context, captures },
    );
    assert.equal(result.kind, "rejected");
  }
  const foreign = sourceCaptureView({
    ...capture,
    reference: { kind: "jira", issueKey: "OTHER" },
  });
  assert.equal(
    validateRequirements(
      { criteria: [{ ...criterion, anchorId: foreign.anchorRefs[0]!.id }], unresolved: [] },
      context,
    ).kind,
    "rejected",
  );
  const issueKeyCriterion = accept(
    validateRequirements(
      { criteria: [{ ...criterion, key: "CHUM-42" }], unresolved: [] },
      { ...context, selection: { kind: "selected", keys: ["CHUM-42"] } },
    ),
  );
  assert.deepEqual(issueKeyCriterion.selection, { kind: "selected", keys: ["CHUM-42"] });
  assert.equal(issueKeyCriterion.criteria[0]?.key, "CHUM-42");
  for (const invalid of [
    { ...criterion, anchorId: "fake" },
    { ...criterion, anchor: "AC-1" },
    { key: "AC-1", statement: "Checkout succeeds", source: capture.reference, anchor: "AC" },
  ]) {
    assert.equal(
      validateRequirements({ criteria: [invalid], unresolved: [] }, context).kind,
      "rejected",
    );
  }
});

test("requirements feedback reports ID, duplicate, selected and schema field paths privately", () => {
  const criterion = {
    key: "AC-1",
    statement: "Checkout succeeds",
    source: capture.reference,
    anchorId: "fake",
  };
  const result = validateRequirements(
    { criteria: [criterion, criterion], unresolved: [] },
    { goal: "Verify", selection: { kind: "selected", keys: ["AC-9"] }, captures: [capture] },
  );
  assert.equal(result.kind, "rejected");
  if (result.kind === "rejected") {
    assert.match(result.issues.join(";"), /criteria\[0\]\.anchorId/);
    assert.match(result.issues.join(";"), /criteria\[1\]\.key/);
    assert.match(result.issues.join(";"), /task\.criteria\.keys\[0\]/);
  }
  const malformed = validateRequirements(
    { criteria: [], unresolved: ["x".repeat(513)] },
    { goal: "Verify", selection: { kind: "all" }, captures: [capture] },
  );
  assert.equal(malformed.kind, "rejected");
  if (malformed.kind === "rejected") {
    assert.match(malformed.issues.join(";"), /criteria.*1/);
    assert.match(malformed.issues.join(";"), /unresolved\[0\].*512/);
  }
});

test("requirements preserve ordered diagnostics across duplicate and invalid criteria", () => {
  const criterion = {
    key: "AC-1",
    statement: "Checkout succeeds",
    source: capture.reference,
    anchor: "AC-1",
  };
  const result = validateRequirements(
    {
      criteria: [
        criterion,
        { ...criterion, source: { kind: "jira", issueKey: "CHUM-99" } },
        { ...criterion, anchor: "missing" },
      ],
      unresolved: [],
    },
    {
      goal: "Verify",
      selection: { kind: "selected", keys: ["AC-1", "AC-9"] },
      captures: [capture],
    },
  );

  assert.deepEqual(result, {
    kind: "rejected",
    issues: [
      "criteria[1].key: duplicate criterion key AC-1",
      "criteria[1].source: criterion AC-1 references an uncaptured source",
      "criteria[2].key: duplicate criterion key AC-1",
      "criteria[2].anchor: criterion AC-1 references an unknown anchor for this source capture",
      "task.criteria.keys[1]: selected criterion AC-9 is missing from the extraction",
    ],
  });
});

test("not extractable is a named decision only with bounded nonempty reasons and captures", () => {
  const context = { goal: "Verify", selection: { kind: "all" as const }, captures: [capture] };
  assert.deepEqual(
    validateRequirements(
      { kind: "not_extractable", unresolved: ["No testable behavior"] },
      context,
    ),
    { kind: "not_extractable", unresolved: ["No testable behavior"] },
  );
  for (const proposal of [
    { kind: "not_extractable", unresolved: [] },
    { kind: "not_extractable", unresolved: ["x".repeat(513)] },
    { kind: "not_extractable", unresolved: ["No behavior"], criteria: [] },
    { criteria: [], unresolved: ["No behavior"] },
  ]) {
    assert.equal(validateRequirements(proposal, context).kind, "rejected");
  }
  assert.equal(
    validateRequirements(
      { kind: "not_extractable", unresolved: ["No behavior"] },
      { ...context, captures: [] },
    ).kind,
    "rejected",
  );
});

const runOne = testRunIdSchema.parse("run-1");
const requirementsRef = artifactRefSchema.parse("artifact-req");

function buildRequirements(selection: CriteriaSelection = { kind: "all" }): Requirements {
  return accept(
    validateRequirements(
      {
        criteria: [
          {
            key: "AC-1",
            statement: "Checkout succeeds",
            source: { kind: "jira", issueKey: "CHUM-42" },
            anchor: "AC-1",
          },
          {
            key: "AC-2",
            statement: "Summary panel is styled",
            source: { kind: "jira", issueKey: "CHUM-42" },
            anchor: "AC-2",
          },
        ],
        unresolved: [],
      },
      { goal: "Verify checkout", selection, captures: [capture] },
    ),
  );
}

const requirements = buildRequirements();
const selectedRequirements = buildRequirements({ kind: "selected", keys: ["AC-1"] });
const requirementsDigest = digestOf(requirements);

const functionalCheck: PlanCheck = {
  id: "check-1",
  criterionId: "crit:AC-1",
  kind: "functional",
  expectedObservation: "Order confirmation is visible",
};
const styleCheck: PlanCheck = {
  id: "check-2",
  criterionId: "crit:AC-1",
  kind: "style",
  design: { fileKey: "CheckoutDemo", nodeId: "12:34" },
  property: "background-color",
  tolerance: { kind: "exact" },
};
const secondFunctionalCheck: PlanCheck = {
  id: "check-3",
  criterionId: "crit:AC-2",
  kind: "functional",
  expectedObservation: "Summary lists two line items",
};

const planContext: PlanContext = {
  requirements,
  requirementsDigest,
  goal: "Verify checkout",
  targetUrl: "https://preview.example.test/checkout",
  design: { fileKey: "CheckoutDemo", nodeId: "12:34" },
  bounds: { maxCases: 10, maxChecks: 50, maxChecksPerCase: 20 },
};

function buildPlan(): CanonicalPlan {
  return accept(
    canonicalizePlan(
      {
        cases: [
          {
            id: "case-1",
            title: "Checkout",
            preconditions: [],
            actions: [{ kind: "navigate", path: "/checkout" }],
            checks: [functionalCheck, secondFunctionalCheck, styleCheck],
          },
        ],
      },
      planContext,
    ),
  );
}

const plan = buildPlan();

const functionalEvidence: PublicEvidence = {
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
const functionalOutput = { checkId: "check-1", evidence: functionalEvidence };
const functionalReceipt: TrustedToolReceipt = {
  id: "receipt-1",
  role: "ac",
  checkId: "check-1",
  inputDigest: digestOf({ checkId: "check-1" }),
  outputDigest: digestOf(functionalOutput),
  output: functionalOutput,
  fixture: { id: "fixture-1", version: "1" },
};

const functional2Evidence: PublicEvidence = {
  kind: "functional",
  outcome: "pass",
  caseId: "case-1",
  checkId: "check-3",
  actionIndex: 0,
  expected: "Summary lists two line items",
  observed: "Summary lists two line items",
  origin: "mock",
  fixture: { id: "fixture-1", version: "1" },
  adapterVersion: "browser-mock-1",
};
const functional2Output = { checkId: "check-3", evidence: functional2Evidence };
const functional2Receipt: TrustedToolReceipt = {
  id: "receipt-3",
  role: "ac",
  checkId: "check-3",
  inputDigest: digestOf({ checkId: "check-3" }),
  outputDigest: digestOf(functional2Output),
  output: functional2Output,
  fixture: { id: "fixture-1", version: "1" },
};

const styleEvidence: PublicEvidence = {
  kind: "style",
  outcome: "inside_tolerance",
  caseId: "case-1",
  checkId: "check-2",
  property: "background-color",
  expected: "#ffffff",
  observed: "#ffffff",
  tolerance: { kind: "exact" },
  capturedDesign: {
    reference: { fileKey: "CheckoutDemo", nodeId: "12:34" },
    propertiesDigest: digestOf({ "background-color": "#ffffff" }),
    complete: true,
    capturedAt: "2026-10-09T00:00:00Z",
  },
  origin: "mock",
  fixture: { id: "fixture-1", version: "1" },
  adapterVersion: "browser-mock-1",
};
const styleOutput = { checkId: "check-2", evidence: styleEvidence };
const styleReceipt: TrustedToolReceipt = {
  id: "receipt-2",
  role: "ui",
  checkId: "check-2",
  inputDigest: digestOf({ checkId: "check-2" }),
  outputDigest: digestOf(styleOutput),
  output: styleOutput,
  fixture: { id: "fixture-1", version: "1" },
};
const failedFunctionalOutput = {
  checkId: "check-1",
  evidence: {
    ...functionalEvidence,
    outcome: "fail",
    observed: "Order confirmation is missing",
  },
};
const failedFunctionalReceipt: TrustedToolReceipt = {
  ...functionalReceipt,
  id: "receipt-fail",
  outputDigest: digestOf(failedFunctionalOutput),
  output: failedFunctionalOutput,
};
const blockedFunctionalOutput = {
  checkId: "check-1",
  evidence: {
    kind: "functional",
    outcome: "blocked",
    caseId: "case-1",
    checkId: "check-1",
    actionIndex: 0,
    reason: "Target page was unavailable",
    origin: "mock",
    fixture: { id: "fixture-1", version: "1" },
    adapterVersion: "browser-mock-1",
  },
};
const blockedFunctionalReceipt: TrustedToolReceipt = {
  ...functionalReceipt,
  id: "receipt-blocked",
  outputDigest: digestOf(blockedFunctionalOutput),
  output: blockedFunctionalOutput,
};

function completeAcResults(
  firstReceipt: TrustedToolReceipt = functionalReceipt,
  firstJudgment: Judgment = "simulated_pass",
): Results {
  return accept(
    validateResults(
      {
        checks: [
          {
            caseId: "case-1",
            checkId: "check-1",
            judgment: firstJudgment,
            evidence: [{ receiptId: firstReceipt.id, digest: firstReceipt.outputDigest }],
          },
          {
            caseId: "case-1",
            checkId: "check-3",
            judgment: "simulated_pass",
            evidence: [
              { receiptId: functional2Receipt.id, digest: functional2Receipt.outputDigest },
            ],
          },
        ],
      },
      {
        role: "ac",
        cases: plan.cases,
        checks: [functionalCheck, secondFunctionalCheck],
        receipts: [firstReceipt, functional2Receipt],
      },
    ),
  );
}

function completeUiResults(): Results {
  return accept(
    validateResults(
      {
        checks: [
          {
            caseId: "case-1",
            checkId: "check-2",
            judgment: "simulated_pass",
            evidence: [{ receiptId: styleReceipt.id, digest: styleReceipt.outputDigest }],
          },
        ],
      },
      { role: "ui", cases: plan.cases, checks: [styleCheck], receipts: [styleReceipt] },
    ),
  );
}

test("requirements freeze captured inputs and reject fabricated sources and anchors", () => {
  assert.deepEqual(requirements.criteria, [
    {
      id: "crit:AC-1",
      key: "AC-1",
      statement: "Checkout succeeds",
      sourceDigest: "capture-1",
      anchor: "AC-1",
    },
    {
      id: "crit:AC-2",
      key: "AC-2",
      statement: "Summary panel is styled",
      sourceDigest: "capture-1",
      anchor: "AC-2",
    },
  ]);
  const fabricatedSource = validateRequirements(
    {
      criteria: [
        {
          key: "AC-9",
          statement: "Invented",
          source: { kind: "jira", issueKey: "OTHER-1" },
          anchor: "AC-1",
        },
      ],
      unresolved: [],
    },
    { goal: "Verify checkout", selection: { kind: "all" }, captures: [capture] },
  );
  assert.equal(fabricatedSource.kind, "rejected");
  assert.match(fabricatedSource.issues[0], /uncaptured source/);
  const fabricatedAnchor = validateRequirements(
    {
      criteria: [
        {
          key: "AC-9",
          statement: "Invented",
          source: { kind: "jira", issueKey: "CHUM-42" },
          anchor: "AC-9",
        },
      ],
      unresolved: [],
    },
    { goal: "Verify checkout", selection: { kind: "all" }, captures: [capture] },
  );
  assert.equal(fabricatedAnchor.kind, "rejected");
  assert.match(fabricatedAnchor.issues[0], /unknown anchor/);
  const missingSelection = validateRequirements(
    {
      criteria: [
        {
          key: "AC-1",
          statement: "Checkout succeeds",
          source: { kind: "jira", issueKey: "CHUM-42" },
          anchor: "AC-1",
        },
      ],
      unresolved: [],
    },
    {
      goal: "Verify checkout",
      selection: { kind: "selected", keys: ["AC-2"] },
      captures: [capture],
    },
  );
  assert.equal(missingSelection.kind, "rejected");
  assert.deepEqual(missingSelection.issues, [
    "task.criteria.keys[0]: selected criterion AC-2 is missing from the extraction",
  ]);
});

test("plan canonicalization assigns functional checks to AC and style checks to UI", () => {
  assert.deepEqual(plan.assignments, { ac: ["check-1", "check-3"], ui: ["check-2"] });
  assert.deepEqual(plan.design, { fileKey: "CheckoutDemo", nodeId: "12:34" });
  const noFunctional = canonicalizePlan(
    {
      cases: [
        {
          id: "case-1",
          title: "Checkout",
          preconditions: [],
          actions: [{ kind: "navigate", path: "/" }],
          checks: [styleCheck],
        },
      ],
    },
    planContext,
  );
  assert.equal(noFunctional.kind, "rejected");
  assert.ok(noFunctional.issues.some((issue) => /has no functional check/.test(issue)));
  const duplicate = canonicalizePlan(
    {
      cases: [
        {
          id: "case-1",
          title: "Checkout",
          preconditions: [],
          actions: [{ kind: "navigate", path: "/" }],
          checks: [functionalCheck, { ...functionalCheck, criterionId: "crit:AC-2" }],
        },
      ],
    },
    planContext,
  );
  assert.equal(duplicate.kind, "rejected");
  assert.ok(duplicate.issues.some((issue) => /duplicate check id/.test(issue)));
  const foreignDesign = canonicalizePlan(
    {
      cases: [
        {
          id: "case-1",
          title: "Checkout",
          preconditions: [],
          actions: [{ kind: "navigate", path: "/" }],
          checks: [functionalCheck, { ...styleCheck, design: { fileKey: "Other", nodeId: "1:1" } }],
        },
      ],
    },
    planContext,
  );
  assert.equal(foreignDesign.kind, "rejected");
  const unknownCriterion = canonicalizePlan(
    {
      cases: [
        {
          id: "case-1",
          title: "Checkout",
          preconditions: [],
          actions: [{ kind: "navigate", path: "/" }],
          checks: [{ ...functionalCheck, criterionId: "crit:unknown" }],
        },
      ],
    },
    planContext,
  );
  assert.equal(unknownCriterion.kind, "rejected");
  assert.ok(unknownCriterion.issues.includes("check check-1 references an unknown criterion"));
});

test("selected plans retain the frozen universe but cover only selected criteria", () => {
  const context: PlanContext = {
    ...planContext,
    requirements: selectedRequirements,
    requirementsDigest: digestOf(selectedRequirements),
  };
  assert.deepEqual(
    selectedRequirements.criteria.map((criterion) => criterion.key),
    ["AC-1", "AC-2"],
  );
  const selected = canonicalizePlan(
    {
      cases: [
        {
          id: "case-1",
          title: "Checkout",
          preconditions: [],
          actions: [{ kind: "navigate", path: "/" }],
          checks: [functionalCheck],
        },
      ],
    },
    context,
  );
  assert.equal(selected.kind, "accepted");

  if (selected.kind === "accepted") {
    assert.deepEqual(selected.value.assignments, { ac: ["check-1"], ui: [] });
  }

  const nonselected = canonicalizePlan(
    {
      cases: [
        {
          id: "case-1",
          title: "Checkout",
          preconditions: [],
          actions: [{ kind: "navigate", path: "/" }],
          checks: [functionalCheck, secondFunctionalCheck],
        },
      ],
    },
    context,
  );
  assert.deepEqual(nonselected, {
    kind: "rejected",
    issues: ["check check-3 references an unselected criterion"],
  });
});

test("results coverage derives judgments from trusted receipt outputs", () => {
  const results = accept(
    validateResults(
      {
        checks: [
          {
            caseId: "case-1",
            checkId: "check-1",
            judgment: "simulated_pass",
            evidence: [{ receiptId: "receipt-1", digest: digestOf(functionalOutput) }],
          },
        ],
      },
      { role: "ac", cases: plan.cases, checks: [functionalCheck], receipts: [functionalReceipt] },
    ),
  );
  assert.deepEqual(results, {
    role: "ac",
    checks: [
      {
        caseId: "case-1",
        checkId: "check-1",
        judgment: "simulated_pass",
        evidence: [functionalEvidence],
      },
    ],
  });
});

test("results validation rejects fabricated evidence, wrong judgments and missing coverage", () => {
  const context = {
    role: "ac" as const,
    cases: plan.cases,
    checks: [functionalCheck, secondFunctionalCheck],
    receipts: [functionalReceipt],
  };
  const forgedDigest = validateResults(
    {
      checks: [
        {
          caseId: "case-1",
          checkId: "check-1",
          judgment: "simulated_pass",
          evidence: [{ receiptId: "receipt-1", digest: "0".repeat(64) }],
        },
      ],
    },
    context,
  );
  assert.equal(forgedDigest.kind, "rejected");
  assert.ok(forgedDigest.issues.some((issue) => /digest mismatch/.test(issue)));
  const wrongJudgment = validateResults(
    {
      checks: [
        {
          caseId: "case-1",
          checkId: "check-1",
          judgment: "simulated_fail",
          evidence: [{ receiptId: "receipt-1", digest: digestOf(functionalOutput) }],
        },
      ],
    },
    context,
  );
  assert.equal(wrongJudgment.kind, "rejected");
  assert.ok(wrongJudgment.issues.some((issue) => /not supported by trusted evidence/.test(issue)));
  const fabricatedFields = validateResults(
    {
      checks: [
        {
          caseId: "case-1",
          checkId: "check-1",
          judgment: "simulated_pass",
          observed: "Order confirmation is visible",
          evidence: [],
        },
      ],
    },
    context,
  );
  assert.equal(fabricatedFields.kind, "rejected");
  const missing = validateResults(
    {
      checks: [
        {
          caseId: "case-1",
          checkId: "check-1",
          judgment: "simulated_pass",
          evidence: [{ receiptId: "receipt-1", digest: digestOf(functionalOutput) }],
        },
      ],
    },
    { ...context, receipts: [functionalReceipt, styleReceipt, functional2Receipt] },
  );
  assert.equal(missing.kind, "rejected");
  assert.ok(missing.issues.some((issue) => /missing check check-3/.test(issue)));
});

const requirementsScope = requirementsScopeDigest({
  goal: requirements.goal,
  sources: requirements.captures.map((item) => item.reference),
  selection: requirements.selection,
});
const requirementsArtifact = {
  kind: "requirements",
  ref: "artifact-req",
  digest: requirementsDigest,
  threadId: "thread-1",
  payload: requirements,
  scopeDigest: requirementsScope,
  dependencies: [],
  origin: {
    runId: "run-1",
    threadId: "thread-1",
    role: "atlassian",
    issuedAt: "2026-10-09T00:00:00Z",
  },
};
const planDigest = digestOf(plan);
const planScope = planScopeDigest({
  goal: plan.goal,
  targetUrl: plan.targetUrl,
  design: plan.design,
  requirementsDigest,
});
const planArtifact = {
  kind: "plan",
  ref: "artifact-plan",
  digest: planDigest,
  threadId: "thread-1",
  payload: plan,
  scopeDigest: planScope,
  dependencies: ["artifact-req"],
  origin: {
    runId: "run-1",
    threadId: "thread-1",
    role: "planner",
    issuedAt: "2026-10-09T00:00:00Z",
  },
};

test("reuse accepts only compatible same-thread requirements and preserves provenance", () => {
  const bound = accept(
    validateReuse(requirementsArtifact, {
      requested: "requirements",
      threadId: "thread-1",
      expectedScopeDigest: requirementsScope,
    }),
  );
  assert.equal(bound.kind, "requirements");
  assert.deepEqual(bound.provenance, {
    originalRunId: "run-1",
    originalThreadId: "thread-1",
    role: "atlassian",
    issuedAt: "2026-10-09T00:00:00Z",
  });
});

test("reuse rejects cross-run results, wrong threads, scope drift and tampered digests", () => {
  const crossRun = validateReuse(
    { ...requirementsArtifact, kind: "ac-result" },
    {
      requested: "requirements",
      threadId: "thread-1",
      expectedScopeDigest: requirementsScope,
    },
  );
  assert.equal(crossRun.kind, "rejected");
  assert.equal(crossRun.issues[0], "cross_run_result_forbidden");
  const wrongThread = validateReuse(requirementsArtifact, {
    requested: "requirements",
    threadId: "thread-2",
    expectedScopeDigest: requirementsScope,
  });
  assert.equal(wrongThread.kind, "rejected");
  assert.equal(wrongThread.issues[0], "not_accessible");
  const scopeDrift = validateReuse(requirementsArtifact, {
    requested: "requirements",
    threadId: "thread-1",
    expectedScopeDigest: "other-scope",
  });
  assert.equal(scopeDrift.kind, "rejected");
  assert.equal(scopeDrift.issues[0], "scope_mismatch");
  const tampered = validateReuse(
    { ...requirementsArtifact, digest: "0".repeat(64) },
    {
      requested: "requirements",
      threadId: "thread-1",
      expectedScopeDigest: requirementsScope,
    },
  );
  assert.equal(tampered.kind, "rejected");
  assert.equal(tampered.issues[0], "invalid_evidence");
  const missingSelectionPayload = {
    ...requirementsArtifact.payload,
    selection: { kind: "selected" as const, keys: ["AC-9"] },
  };
  const missingSelectionScope = requirementsScopeDigest({
    goal: missingSelectionPayload.goal,
    sources: missingSelectionPayload.captures.map((item) => item.reference),
    selection: missingSelectionPayload.selection,
  });
  const missingSelection = validateReuse(
    {
      ...requirementsArtifact,
      payload: missingSelectionPayload,
      digest: digestOf(missingSelectionPayload),
      scopeDigest: missingSelectionScope,
    },
    {
      requested: "requirements",
      threadId: "thread-1",
      expectedScopeDigest: missingSelectionScope,
    },
  );
  assert.deepEqual(missingSelection, {
    kind: "rejected",
    issues: ["selected criterion AC-9 is missing from the extraction"],
  });
});

test("plan reuse requires the current typed plan context and preserves provenance", () => {
  const context = {
    requested: "plan" as const,
    threadId: "thread-1",
    expectedScopeDigest: planScope,
    planContext,
  };
  const bound = accept(validateReuse(planArtifact, context));
  assert.equal(bound.kind, "plan");
  assert.deepEqual(bound.provenance, {
    originalRunId: "run-1",
    originalThreadId: "thread-1",
    role: "planner",
    issuedAt: "2026-10-09T00:00:00Z",
  });
  const wrongDependency = validateReuse(planArtifact, {
    ...context,
    planContext: { ...planContext, requirementsDigest: "other-digest" },
  });
  assert.equal(wrongDependency.kind, "rejected");
  assert.equal(wrongDependency.issues[0], "dependency_rejected");
  const missingCriterion = validateReuse(planArtifact, {
    ...context,
    planContext: {
      ...planContext,
      requirements: selectedRequirements,
      requirementsDigest: digestOf(selectedRequirements),
    },
  });
  assert.equal(missingCriterion.kind, "rejected");
  assert.equal(missingCriterion.issues[0], "dependency_rejected");
});

test("plan reuse rejects plans outside current bounds and noncanonical assignments", () => {
  const currentBounds = validateReuse(planArtifact, {
    requested: "plan",
    threadId: "thread-1",
    expectedScopeDigest: planScope,
    planContext: {
      ...planContext,
      bounds: { maxCases: 1, maxChecks: 2, maxChecksPerCase: 3 },
    },
  });
  assert.equal(currentBounds.kind, "rejected");
  assert.ok(currentBounds.issues.includes("plan exceeds the check bound"));

  const tamperedPayload = {
    ...planArtifact.payload,
    assignments: { ac: ["check-1"], ui: ["check-2"] },
  };
  const tampered = validateReuse(
    { ...planArtifact, payload: tamperedPayload, digest: digestOf(tamperedPayload) },
    {
      requested: "plan",
      threadId: "thread-1",
      expectedScopeDigest: planScope,
      planContext,
    },
  );
  assert.deepEqual(tampered, { kind: "rejected", issues: ["invalid_evidence"] });
});

test("plan reuse canonicalization rejects duplicate checks and missing selected coverage", () => {
  const firstCase = plan.cases[0];
  assert.ok(firstCase);
  const duplicatePayload = {
    ...plan,
    cases: [{ ...firstCase, checks: [...firstCase.checks, functionalCheck] }],
  };
  const duplicate = validateReuse(
    { ...planArtifact, payload: duplicatePayload, digest: digestOf(duplicatePayload) },
    {
      requested: "plan",
      threadId: "thread-1",
      expectedScopeDigest: planScope,
      planContext,
    },
  );
  assert.equal(duplicate.kind, "rejected");
  assert.ok(duplicate.issues.includes("duplicate check id check-1"));

  const missingCoveragePayload = {
    ...plan,
    cases: [{ ...firstCase, checks: firstCase.checks.filter((check) => check.id !== "check-3") }],
    assignments: { ac: ["check-1"], ui: ["check-2"] },
  };
  const missingCoverage = validateReuse(
    { ...planArtifact, payload: missingCoveragePayload, digest: digestOf(missingCoveragePayload) },
    {
      requested: "plan",
      threadId: "thread-1",
      expectedScopeDigest: planScope,
      planContext,
    },
  );
  assert.equal(missingCoverage.kind, "rejected");
  assert.ok(missingCoverage.issues.includes("criterion crit:AC-2 has no functional check"));
});

test("a missing plan lists every selected criterion as uncovered", () => {
  const all = deriveReport({
    runId: runOne,
    rootOutcome: "failed",
    requirements,
    plan: null,
    acResults: null,
    uiResults: null,
    unresolvedSources: [],
    artifacts: [],
    progressVersion: 2,
    outcomes: { planner: { kind: "terminal", outcome: "failed", reasonCode: "model_error" } },
  });
  assert.deepEqual(all.coverage, [
    { criterionId: "crit:AC-1", caseId: null, checkId: null, state: "uncovered" },
    { criterionId: "crit:AC-2", caseId: null, checkId: null, state: "uncovered" },
  ]);
  assert.deepEqual(all.acceptance, {
    verdict: "blocked",
    reasons: ["plan_missing", "coverage_incomplete", "root_failed", "role_planner_failed"],
  });

  const selected = deriveReport({
    runId: runOne,
    rootOutcome: "cancelled",
    requirements: selectedRequirements,
    plan: null,
    acResults: null,
    uiResults: null,
    unresolvedSources: [],
    artifacts: [],
    progressVersion: 2,
    outcomes: {},
  });
  assert.deepEqual(selected.coverage, [
    { criterionId: "crit:AC-1", caseId: null, checkId: null, state: "uncovered" },
  ]);
  assert.deepEqual(selected.acceptance, {
    verdict: "blocked",
    reasons: ["plan_missing", "coverage_incomplete", "root_cancelled"],
  });
});

test("results validation binds evidence case, check, action index and design metadata", () => {
  const wrongCaseOutput = {
    checkId: "check-1",
    evidence: { ...functionalEvidence, caseId: "case-other" },
  };
  const wrongCase = validateResults(
    {
      checks: [
        {
          caseId: "case-1",
          checkId: "check-1",
          judgment: "simulated_pass",
          evidence: [{ receiptId: "receipt-wrong-case", digest: digestOf(wrongCaseOutput) }],
        },
      ],
    },
    {
      role: "ac",
      cases: plan.cases,
      checks: [functionalCheck],
      receipts: [
        {
          ...functionalReceipt,
          id: "receipt-wrong-case",
          outputDigest: digestOf(wrongCaseOutput),
          output: wrongCaseOutput,
        },
      ],
    },
  );
  assert.equal(wrongCase.kind, "rejected");
  assert.ok(wrongCase.issues.some((issue) => /not bound/.test(issue)));

  const wrongActionOutput = {
    checkId: "check-1",
    evidence: { ...functionalEvidence, actionIndex: 1 },
  };
  const wrongAction = validateResults(
    {
      checks: [
        {
          caseId: "case-1",
          checkId: "check-1",
          judgment: "simulated_pass",
          evidence: [{ receiptId: "receipt-wrong-action", digest: digestOf(wrongActionOutput) }],
        },
      ],
    },
    {
      role: "ac",
      cases: plan.cases,
      checks: [functionalCheck],
      receipts: [
        {
          ...functionalReceipt,
          id: "receipt-wrong-action",
          outputDigest: digestOf(wrongActionOutput),
          output: wrongActionOutput,
        },
      ],
    },
  );
  assert.equal(wrongAction.kind, "rejected");
  assert.ok(wrongAction.issues.some((issue) => /action index/.test(issue)));

  const wrongDesignOutput = {
    checkId: "check-2",
    evidence: {
      ...styleEvidence,
      capturedDesign: {
        reference: { fileKey: "Other", nodeId: "1:1" },
        propertiesDigest: digestOf({ "background-color": "#ffffff" }),
        complete: true,
        capturedAt: "2026-10-09T00:00:00Z",
      },
    },
  };
  const wrongDesign = validateResults(
    {
      checks: [
        {
          caseId: "case-1",
          checkId: "check-2",
          judgment: "simulated_pass",
          evidence: [{ receiptId: "receipt-wrong-design", digest: digestOf(wrongDesignOutput) }],
        },
      ],
    },
    {
      role: "ui",
      cases: plan.cases,
      checks: [styleCheck],
      receipts: [
        {
          ...styleReceipt,
          id: "receipt-wrong-design",
          outputDigest: digestOf(wrongDesignOutput),
          output: wrongDesignOutput,
        },
      ],
    },
  );
  assert.equal(wrongDesign.kind, "rejected");
  assert.ok(wrongDesign.issues.some((issue) => /design does not match/.test(issue)));
});

test("progress marks UI not_required without style checks and preserves explicit outcomes", () => {
  const card = projectProgress(7, {}, { assignments: { ac: ["check-1"], ui: [] } });
  assert.deepEqual(card, {
    version: 7,
    rows: {
      atlassian: { status: "waiting", reason: "dispatch" },
      planner: { status: "waiting", reason: "dispatch" },
      ac: { status: "waiting", reason: "dispatch" },
      ui: { status: "not_required", reason: "no_style_checks" },
    },
  });
  const reused = projectProgress(
    8,
    {
      atlassian: {
        kind: "reused",
        artifact: requirementsRef,
        provenance: { originalRunId: runOne, role: "atlassian", issuedAt: "now" },
      },
    },
    { assignments: { ac: ["check-1"], ui: ["check-2"] } },
  );
  assert.deepEqual(reused.rows.atlassian, {
    status: "reused",
    artifact: "artifact-req",
    provenance: { originalRunId: "run-1", role: "atlassian", issuedAt: "now" },
  });
  assert.deepEqual(reused.rows.ui, { status: "waiting", reason: "dispatch" });
});

test("the public report is mock-only and never claims a real pass", () => {
  const acResults = accept(
    validateResults(
      {
        checks: [
          {
            caseId: "case-1",
            checkId: "check-1",
            judgment: "simulated_pass",
            evidence: [{ receiptId: "receipt-1", digest: digestOf(functionalOutput) }],
          },
          {
            caseId: "case-1",
            checkId: "check-3",
            judgment: "simulated_pass",
            evidence: [{ receiptId: "receipt-3", digest: digestOf(functional2Output) }],
          },
        ],
      },
      {
        role: "ac",
        cases: plan.cases,
        checks: [functionalCheck, secondFunctionalCheck],
        receipts: [functionalReceipt, functional2Receipt],
      },
    ),
  );
  const uiResults = accept(
    validateResults(
      {
        checks: [
          {
            caseId: "case-1",
            checkId: "check-2",
            judgment: "simulated_pass",
            evidence: [{ receiptId: "receipt-2", digest: digestOf(styleOutput) }],
          },
        ],
      },
      { role: "ui", cases: plan.cases, checks: [styleCheck], receipts: [styleReceipt] },
    ),
  );
  const report = deriveReport({
    runId: runOne,
    rootOutcome: "completed",
    requirements,
    plan,
    acResults,
    uiResults,
    unresolvedSources: [],
    artifacts: [requirementsRef],
    progressVersion: 3,
    outcomes: {},
  });
  assert.deepEqual(report.acceptance, { verdict: "not_verified", reason: "mock_only" });
  assert.deepEqual(report.coverage, [
    { criterionId: "crit:AC-1", caseId: "case-1", checkId: "check-1", state: "simulated_pass" },
    { criterionId: "crit:AC-2", caseId: "case-1", checkId: "check-3", state: "simulated_pass" },
    { criterionId: "crit:AC-1", caseId: "case-1", checkId: "check-2", state: "simulated_pass" },
  ]);
  assert.deepEqual(report.roleOutcomes.ui, { status: "waiting", reason: "dispatch" });
});

test("partial outcomes are retained and gaps block acceptance", () => {
  const acResults = accept(
    validateResults(
      {
        checks: [
          {
            caseId: "case-1",
            checkId: "check-1",
            judgment: "simulated_pass",
            evidence: [{ receiptId: "receipt-1", digest: digestOf(functionalOutput) }],
          },
          {
            caseId: "case-1",
            checkId: "check-3",
            judgment: "simulated_pass",
            evidence: [{ receiptId: "receipt-3", digest: digestOf(functional2Output) }],
          },
        ],
      },
      {
        role: "ac",
        cases: plan.cases,
        checks: [functionalCheck, secondFunctionalCheck],
        receipts: [functionalReceipt, functional2Receipt],
      },
    ),
  );
  const report = deriveReport({
    runId: runOne,
    rootOutcome: "completed",
    requirements,
    plan,
    acResults,
    uiResults: null,
    unresolvedSources: [capture.reference],
    artifacts: [],
    progressVersion: 3,
    outcomes: {},
  });
  assert.equal(report.acceptance.verdict, "blocked");
  assert.deepEqual(report.acceptance.reasons, [
    "ui_results_missing",
    "sources_unresolved",
    "coverage_incomplete",
  ]);
  assert.equal(report.results.ac.length, 2);
  assert.deepEqual(report.coverage[2], {
    criterionId: "crit:AC-1",
    caseId: "case-1",
    checkId: "check-2",
    state: "uncovered",
  });
  assert.deepEqual(report.unresolvedSources, [capture.reference]);
});

test("root cancellation blocks acceptance without discarding completed role results", () => {
  const report = deriveReport({
    runId: runOne,
    rootOutcome: "cancelled",
    requirements,
    plan,
    acResults: completeAcResults(),
    uiResults: completeUiResults(),
    unresolvedSources: [],
    artifacts: [],
    progressVersion: 4,
    outcomes: {
      atlassian: { kind: "terminal", outcome: "completed", reasonCode: "completed" },
      planner: { kind: "terminal", outcome: "completed", reasonCode: "completed" },
      ac: { kind: "terminal", outcome: "completed", reasonCode: "completed" },
      ui: { kind: "terminal", outcome: "completed", reasonCode: "completed" },
    },
  });
  assert.deepEqual(report.acceptance, { verdict: "blocked", reasons: ["root_cancelled"] });
  assert.deepEqual(
    report.results.ac.map(({ checkId, judgment }) => ({ checkId, judgment })),
    [
      { checkId: "check-1", judgment: "simulated_pass" },
      { checkId: "check-3", judgment: "simulated_pass" },
    ],
  );
  assert.deepEqual(
    report.results.ui.map(({ checkId, judgment }) => ({ checkId, judgment })),
    [{ checkId: "check-2", judgment: "simulated_pass" }],
  );
});

test("complete simulated failures remain not_verified while blocked evidence blocks", () => {
  const failed = deriveReport({
    runId: runOne,
    rootOutcome: "completed",
    requirements,
    plan,
    acResults: completeAcResults(failedFunctionalReceipt, "simulated_fail"),
    uiResults: completeUiResults(),
    unresolvedSources: [],
    artifacts: [],
    progressVersion: 4,
    outcomes: {},
  });
  assert.deepEqual(failed.acceptance, { verdict: "not_verified", reason: "mock_only" });
  assert.equal(failed.coverage[0]?.state, "simulated_fail");

  const blocked = deriveReport({
    runId: runOne,
    rootOutcome: "completed",
    requirements,
    plan,
    acResults: completeAcResults(blockedFunctionalReceipt, "simulated_blocked"),
    uiResults: completeUiResults(),
    unresolvedSources: [],
    artifacts: [],
    progressVersion: 4,
    outcomes: {},
  });
  assert.deepEqual(blocked.acceptance, { verdict: "blocked", reasons: ["blocked_evidence"] });
  assert.equal(blocked.coverage[0]?.state, "simulated_blocked");
});

test("unresolved requirement and source facts block otherwise complete results", () => {
  const report = deriveReport({
    runId: runOne,
    rootOutcome: "completed",
    requirements: { ...requirements, unresolved: ["Source section could not be extracted"] },
    plan,
    acResults: completeAcResults(),
    uiResults: completeUiResults(),
    unresolvedSources: [capture.reference],
    artifacts: [],
    progressVersion: 4,
    outcomes: {},
  });
  assert.deepEqual(report.acceptance, {
    verdict: "blocked",
    reasons: ["requirements_unresolved", "sources_unresolved"],
  });
  assert.equal(report.results.ac.length, 2);
  assert.equal(report.results.ui.length, 1);
});

test("required failed or undispatched roles block acceptance", () => {
  const failed = deriveReport({
    runId: runOne,
    rootOutcome: "completed",
    requirements,
    plan,
    acResults: completeAcResults(),
    uiResults: completeUiResults(),
    unresolvedSources: [],
    artifacts: [],
    progressVersion: 4,
    outcomes: { ac: { kind: "terminal", outcome: "failed", reasonCode: "model_error" } },
  });
  assert.deepEqual(failed.acceptance, { verdict: "blocked", reasons: ["role_ac_failed"] });

  const undispatched = deriveReport({
    runId: runOne,
    rootOutcome: "completed",
    requirements,
    plan,
    acResults: completeAcResults(),
    uiResults: completeUiResults(),
    unresolvedSources: [],
    artifacts: [],
    progressVersion: 4,
    outcomes: { ui: { kind: "undispatched", reason: "incompatible" } },
  });
  assert.deepEqual(undispatched.acceptance, {
    verdict: "blocked",
    reasons: ["role_ui_undispatched_incompatible"],
  });
});

test("terminal cancellation, timeout, missing and incompatibility facts block acceptance", () => {
  const cases = [
    { outcome: "cancelled", expectedReason: "role_ac_cancelled" },
    { outcome: "timed_out", expectedReason: "role_ac_timed_out" },
    { outcome: "missing", expectedReason: "role_ac_missing" },
    { outcome: "incompatible", expectedReason: "role_ac_incompatible" },
  ] as const;

  for (const item of cases) {
    const report = deriveReport({
      runId: runOne,
      rootOutcome: "completed",
      requirements,
      plan,
      acResults: completeAcResults(),
      uiResults: completeUiResults(),
      unresolvedSources: [],
      artifacts: [],
      progressVersion: 4,
      outcomes: {
        ac: { kind: "terminal", outcome: item.outcome, reasonCode: "terminal" },
      },
    });
    assert.deepEqual(report.acceptance, {
      verdict: "blocked",
      reasons: [item.expectedReason],
    });
  }
});

test("no-style UI not_required does not block a complete functional report", () => {
  const noStylePlan = accept(
    canonicalizePlan(
      {
        cases: [
          {
            id: "case-1",
            title: "Checkout",
            preconditions: [],
            actions: [{ kind: "navigate", path: "/" }],
            checks: [functionalCheck, secondFunctionalCheck],
          },
        ],
      },
      planContext,
    ),
  );
  const report = deriveReport({
    runId: runOne,
    rootOutcome: "completed",
    requirements,
    plan: noStylePlan,
    acResults: completeAcResults(),
    uiResults: null,
    unresolvedSources: [],
    artifacts: [],
    progressVersion: 4,
    outcomes: { ui: { kind: "not_required", reason: "no_style_checks" } },
  });
  assert.deepEqual(report.acceptance, { verdict: "not_verified", reason: "mock_only" });
  assert.deepEqual(report.roleOutcomes.ui, { status: "not_required", reason: "no_style_checks" });
});
