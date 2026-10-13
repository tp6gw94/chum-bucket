import assert from "node:assert/strict";
import { test } from "node:test";
import { testRunIdSchema } from "../../../shared/testing";
import type { DeferredCase, PlanCheck } from "../../../shared/testing";
import {
  assembleRequirements,
  canonicalizePlan,
  deriveReport,
  digestOf,
  planPayloadSchema,
  planScopeDigest,
  projectProgress,
  publicIssues,
  publicTaskArtifact,
  validateReuse,
  type CanonicalPlan,
  type PlanContext,
  type Requirements,
  type Validation,
} from "../../../server/harness/testing-domain";

function accept<T>(validation: Validation<T>): T {
  if (validation.kind !== "accepted") {
    throw new Error(`setup failed: ${validation.issues.join(", ")}`);
  }

  return validation.value;
}

const source = { kind: "jira" as const, issueKey: "FETM-78" };
const functionalKeys = ["AC-1", "AC-2", "AC-3", "AC-4", "AC-5", "AC-6", "AC-7"] as const;
const uiKeys = ["UI-AC-1", "UI-AC-2", "UI-AC-3"] as const;
const fetmCriteria = [...functionalKeys, ...uiKeys].map((key) => ({
  id: key,
  statement: `Statement for ${key}`,
}));

function fetmRequirements(remoteLinks: readonly unknown[] = []): Requirements {
  const output = {
    result: JSON.stringify({
      key: "FETM-78",
      summary: "司康小舖：商品與購物車",
      description: [...functionalKeys, ...uiKeys].map((key) => `- ${key}`).join("\n"),
      remote_links: remoteLinks,
    }),
  };

  return accept(
    assembleRequirements({ goal: "Plan FETM-78", sources: [source] }, [
      {
        nativeName: "jira_get_issue",
        input: { issue_key: "FETM-78", include: "remote_links" },
        output,
        outputDigest: digestOf(output),
        bindings: { capturedAt: "2026-10-13T00:00:00.000Z" },
      },
    ]),
  );
}

const requirements = fetmRequirements();

const context: PlanContext = {
  requirementsDigest: digestOf(requirements),
  goal: "Plan FETM-78",
  targetUrl: null,
  design: null,
};

function functionalCase(key: string) {
  return {
    id: `case-${key}`,
    title: `Verify ${key}`,
    preconditions: [],
    actions: [{ kind: "navigate" as const, path: "/" }],
    checks: [
      {
        id: `check-${key}`,
        criterionId: key,
        kind: "functional" as const,
        expectedObservation: `Observable result for ${key}`,
        observation: {
          kind: "text" as const,
          target: `Result for ${key}`,
          comparison: "equals" as const,
        },
      },
    ],
  };
}

function deferredCase(key: string, overrides: Partial<DeferredCase> = {}): DeferredCase {
  return {
    id: `deferred-${key}`,
    title: `Style expectation for ${key}`,
    steps: ["Open the product page at desktop width", "Inspect the add-to-cart button"],
    expectations: [
      {
        criterionId: key,
        expectedObservation: "Button background is #2D6A4F and label is white 16px",
      },
    ],
    reason: "Style values come from Jira text and no design is bound",
    ...overrides,
  };
}

const fetmProposal = {
  criteria: fetmCriteria,
  unresolved: [],
  cases: functionalKeys.map(functionalCase),
  deferredCases: uiKeys.map((key) => deferredCase(key)),
};

test("a planner-defined plan covers 7 functional and 3 UI criteria without a URL or design", () => {
  const plan = accept(canonicalizePlan(fetmProposal, context));
  assert.deepEqual(plan.criteria, fetmCriteria);
  assert.deepEqual(plan.unresolved, []);
  assert.equal(plan.targetUrl, null);
  assert.equal(plan.design, null);
  assert.deepEqual(plan.assignments, {
    ac: functionalKeys.map((key) => `check-${key}`),
    ui: [],
  });
  assert.deepEqual(plan.deferredCases, fetmProposal.deferredCases);
  assert.equal(plan.cases.length, 7);
});

test("an all-deferred plan is valid, has empty assignments and no executable cases", () => {
  const plan = accept(
    canonicalizePlan(
      {
        criteria: fetmCriteria,
        unresolved: [],
        cases: [],
        deferredCases: [...functionalKeys, ...uiKeys].map((key) => deferredCase(key)),
      },
      context,
    ),
  );
  assert.deepEqual(plan.cases, []);
  assert.deepEqual(plan.assignments, { ac: [], ui: [] });
  assert.equal(plan.deferredCases?.length, 10);
  assert.equal(planPayloadSchema.safeParse(plan).success, true);
});

test("style-only coverage is valid and a mixed plan assigns each executable kind exactly", () => {
  const design = { fileKey: "DiPISvcpFmaPsK9QonpeDf", nodeId: "1:81" };
  const style: PlanCheck = {
    id: "check-style",
    criterionId: "UI-AC-1",
    kind: "style",
    design,
    property: "width",
    target: "Add to cart button",
    tolerance: { kind: "exact" },
  };
  const plan = accept(
    canonicalizePlan(
      {
        criteria: fetmCriteria,
        unresolved: [],
        cases: [
          ...functionalKeys.map(functionalCase),
          {
            id: "case-style",
            title: "Button style",
            preconditions: [],
            actions: [{ kind: "navigate", path: "/" }],
            checks: [style],
          },
        ],
        deferredCases: ["UI-AC-2", "UI-AC-3"].map((key) => deferredCase(key)),
      },
      { ...context, design },
    ),
  );
  assert.deepEqual(plan.assignments.ui, ["check-style"]);
  assert.equal(plan.assignments.ac.length, 7);
  assert.deepEqual(
    plan.deferredCases?.flatMap((item) =>
      item.expectations.map((expectation) => expectation.criterionId),
    ),
    ["UI-AC-2", "UI-AC-3"],
  );
});

test("a style check without the requested design is still rejected", () => {
  const result = canonicalizePlan(
    {
      criteria: fetmCriteria,
      unresolved: [],
      cases: [
        ...functionalKeys.map(functionalCase),
        {
          id: "case-style",
          title: "Button style",
          preconditions: [],
          actions: [{ kind: "navigate", path: "/" }],
          checks: [
            {
              id: "check-style",
              criterionId: "UI-AC-1",
              kind: "style",
              design: { fileKey: "__blocked__", nodeId: "0:0" },
              property: "width",
              target: "Button",
              tolerance: { kind: "exact" },
            },
          ],
        },
      ],
      deferredCases: ["UI-AC-2", "UI-AC-3"].map((key) => deferredCase(key)),
    },
    context,
  );
  assert.equal(result.kind, "rejected");
  assert.deepEqual(result.kind === "rejected" ? result.issues : [], [
    "style check check-style does not reference the requested design",
  ]);
});

test("deferred cases reject unknown and duplicate identities", () => {
  const result = canonicalizePlan(
    {
      criteria: fetmCriteria,
      unresolved: [],
      cases: functionalKeys.map(functionalCase),
      deferredCases: [
        ...uiKeys.map((key) => deferredCase(key)),
        deferredCase("AC-1", {
          expectations: [
            { criterionId: "missing", expectedObservation: "Missing criterion outcome" },
          ],
          id: "deferred-missing",
        }),
        deferredCase("AC-1", { id: "case-AC-1" }),
        deferredCase("AC-1", { id: "deferred-AC-1" }),
        deferredCase("AC-1", { id: "deferred-AC-1" }),
      ],
    },
    context,
  );
  assert.deepEqual(result, {
    kind: "rejected",
    issues: [
      "deferred case deferred-missing references an unknown criterion",
      "duplicate case id case-AC-1",
      "duplicate case id deferred-AC-1",
    ],
  });
});

test("deferred cases cannot hide an empty plan", () => {
  const empty = canonicalizePlan({ criteria: fetmCriteria, unresolved: [], cases: [] }, context);
  assert.equal(empty.kind, "rejected");
});

test("schema failures report field paths", () => {
  const result = canonicalizePlan(
    {
      criteria: fetmCriteria,
      unresolved: [],
      cases: [],
      deferredCases: [{ ...deferredCase("UI-AC-1"), steps: [], reason: "" }],
    },
    context,
  );
  assert.equal(result.kind, "rejected");
  const issues = result.kind === "rejected" ? result.issues : [];
  assert.ok(issues.some((issue) => issue.startsWith("deferredCases[0].steps")));
  assert.ok(issues.some((issue) => issue.startsWith("deferredCases[0].reason")));
});

const executableProposal = {
  criteria: fetmCriteria,
  unresolved: [],
  cases: [...functionalKeys, ...uiKeys].map(functionalCase),
};

function storedPlan(plan: CanonicalPlan) {
  return {
    kind: "plan",
    ref: "artifact-plan",
    digest: digestOf(plan),
    threadId: "thread-1",
    payload: plan,
    scopeDigest: planScopeDigest({
      goal: plan.goal,
      targetUrl: plan.targetUrl,
      design: plan.design,
      requirementsDigest: plan.requirementsDigest,
    }),
    dependencies: ["artifact-req"],
    origin: {
      runId: "run-1",
      threadId: "thread-1",
      role: "planner",
      issuedAt: "2026-10-13T00:00:00Z",
    },
  };
}

const reuseContext = (planContext: PlanContext, plan: CanonicalPlan) => ({
  requested: "plan" as const,
  threadId: "thread-1",
  expectedScopeDigest: planScopeDigest({
    goal: plan.goal,
    targetUrl: plan.targetUrl,
    design: plan.design,
    requirementsDigest: plan.requirementsDigest,
  }),
  planContext,
});

test("plans without deferredCases keep their digest and reuse unchanged", () => {
  const executable = accept(canonicalizePlan(executableProposal, context));
  assert.equal("deferredCases" in executable, false);
  const parsed = planPayloadSchema.parse(executable);
  assert.equal("deferredCases" in parsed, false);
  assert.equal(digestOf(parsed), digestOf(executable));
  const reused = accept(validateReuse(storedPlan(executable), reuseContext(context, executable)));
  assert.equal(reused.kind, "plan");
  assert.equal(digestOf(reused.payload), digestOf(executable));
  assert.equal("deferredCases" in reused.payload, false);
});

test("plans with deferredCases round-trip through reuse and tampering is rejected", () => {
  const plan = accept(canonicalizePlan(fetmProposal, context));
  const reused = accept(validateReuse(storedPlan(plan), reuseContext(context, plan)));
  assert.equal(digestOf(reused.payload), digestOf(plan));
  assert.deepEqual((reused.payload as CanonicalPlan).deferredCases, plan.deferredCases);
  const tampered = {
    ...plan,
    deferredCases: plan.deferredCases?.map((item, index) =>
      index === 0
        ? {
            ...item,
            expectations: [{ criterionId: "UI-AC-1", expectedObservation: "Different" }],
          }
        : item,
    ),
  };
  assert.deepEqual(
    validateReuse({ ...storedPlan(plan), payload: tampered }, reuseContext(context, plan)),
    { kind: "rejected", issues: ["invalid_evidence"] },
  );
  const { deferredCases: _deferredCases, ...stripped } = plan;
  const restored = accept(
    validateReuse(
      { ...storedPlan(plan), payload: stripped, digest: digestOf(stripped) },
      reuseContext(context, plan),
    ),
  );
  assert.deepEqual(restored.payload, stripped);
});

test("deferred cases appear in coverage without becoming results, passes or assignments", () => {
  const allDeferred = [...functionalKeys, ...uiKeys].map((key) => deferredCase(key));
  const plan = accept(
    canonicalizePlan(
      { criteria: fetmCriteria, unresolved: [], cases: [], deferredCases: allDeferred },
      context,
    ),
  );
  const report = deriveReport({
    runId: testRunIdSchema.parse("run-1"),
    rootOutcome: "completed",
    requirements,
    plan,
    acResults: null,
    uiResults: null,
    unresolvedSources: [],
    artifacts: [],
    progressVersion: 1,
    outcomes: {},
  });
  assert.deepEqual(
    report.coverage,
    [...functionalKeys, ...uiKeys].map((key) => ({
      criterionId: key,
      caseId: `deferred-${key}`,
      checkId: null,
      state: "deferred",
    })),
  );
  assert.deepEqual(report.results, { ac: [], ui: [] });
  assert.deepEqual(report.plan?.deferredCases, allDeferred);
  assert.deepEqual(report.plan?.assignments, { ac: [], ui: [] });
  assert.deepEqual(report.acceptance, { verdict: "not_verified", reason: "release_not_assessed" });
  assert.deepEqual(report.roleOutcomes.ac, {
    status: "not_required",
    reason: "no_functional_checks",
  });
  assert.deepEqual(report.roleOutcomes.ui, { status: "not_required", reason: "no_style_checks" });
});

test("a mixed plan keeps unexecuted executable checks uncovered while deferred criteria are covered", () => {
  const plan = accept(canonicalizePlan(fetmProposal, context));
  const report = deriveReport({
    runId: testRunIdSchema.parse("run-1"),
    rootOutcome: "completed",
    requirements,
    plan,
    acResults: null,
    uiResults: null,
    unresolvedSources: [],
    artifacts: [],
    progressVersion: 1,
    outcomes: {},
  });
  assert.deepEqual(
    report.coverage.filter((row) => row.state === "deferred").map((row) => row.criterionId),
    uiKeys.map((key) => key),
  );
  assert.equal(report.acceptance.verdict, "blocked");
});

test("empty assignments make both execution roles not required", () => {
  const card = projectProgress(3, {}, { assignments: { ac: [], ui: [] } });
  assert.deepEqual(card.rows.ac, { status: "not_required", reason: "no_functional_checks" });
  assert.deepEqual(card.rows.ui, { status: "not_required", reason: "no_style_checks" });
  assert.deepEqual(card.rows.planner, { status: "waiting", reason: "dispatch" });
});

test("public plan artifacts carry deferred cases only when the plan has them", () => {
  const withDeferred = accept(canonicalizePlan(fetmProposal, context));
  const without = accept(canonicalizePlan(executableProposal, context));
  const publicWith = publicTaskArtifact({ ref: "a", kind: "plan", payload: withDeferred });
  const publicWithout = publicTaskArtifact({ ref: "b", kind: "plan", payload: without });
  assert.deepEqual(
    publicWith.kind === "plan" ? publicWith.payload.deferredCases : null,
    fetmProposal.deferredCases,
  );
  assert.equal(publicWithout.kind === "plan" && "deferredCases" in publicWithout.payload, false);
});

test("host-captured Figma links persist in the requirements artifact and its public view", () => {
  const links = [
    {
      url: "https://www.figma.com/design/DiPISvcpFmaPsK9QonpeDf?node-id=1-81",
      label: "商品頁 桌面",
      fileKey: "DiPISvcpFmaPsK9QonpeDf",
      nodeId: "1:81",
    },
    {
      url: "https://www.figma.com/design/DiPISvcpFmaPsK9QonpeDf?node-id=1-82",
      label: "購物車 桌面",
      fileKey: "DiPISvcpFmaPsK9QonpeDf",
      nodeId: "1:82",
    },
  ];
  const linked = fetmRequirements(
    links.map((link, id) => ({ id, object: { url: link.url, title: link.label } })),
  );
  assert.deepEqual(linked.sources[0]?.links, links);
  const view = publicTaskArtifact({ ref: "r", kind: "requirements", payload: linked });
  assert.deepEqual(
    view.kind === "requirements" ? view.payload.links : null,
    links.map((link) => ({ ...link, source })),
  );
  const plain = publicTaskArtifact({ ref: "r", kind: "requirements", payload: requirements });
  assert.equal(plain.kind === "requirements" && "links" in plain.payload, false);
  assert.deepEqual(requirements.sources[0]?.links, []);
});

test("grouped expectations and steps beyond the removed budgets still canonicalize", () => {
  const keys = [...functionalKeys, ...uiKeys];
  const scenarios = (count: number, perCase: number) =>
    Array.from({ length: Math.ceil(count / perCase) }, (_, index) => ({
      ...deferredCase("AC-1"),
      id: `group-${index}`,
      expectations: Array.from(
        { length: Math.min(perCase, count - index * perCase) },
        (_, offset) => ({
          criterionId: keys[(index * perCase + offset) % keys.length],
          expectedObservation: `Criterion-linked expected outcome ${index * perCase + offset}`,
        }),
      ),
    }));
  const plan = accept(
    canonicalizePlan(
      { criteria: fetmCriteria, unresolved: [], cases: [], deferredCases: scenarios(81, 12) },
      context,
    ),
  );
  assert.equal(plan.deferredCases?.length, 7);
  assert.equal(plan.deferredCases?.flatMap((item) => item.expectations).length, 81);
  assert.deepEqual(plan.assignments, { ac: [], ui: [] });
  const wide = accept(
    canonicalizePlan(
      { criteria: fetmCriteria, unresolved: [], cases: [], deferredCases: scenarios(13, 13) },
      context,
    ),
  );
  assert.equal(wide.deferredCases?.length, 1);
  assert.equal(wide.deferredCases?.[0]?.expectations.length, 13);
  const longSteps = accept(
    canonicalizePlan(
      {
        criteria: fetmCriteria,
        unresolved: [],
        cases: [],
        deferredCases: [
          {
            ...deferredCase("AC-1"),
            steps: Array.from({ length: 25 }, (_, index) => `Manual step ${index + 1}`),
          },
        ],
      },
      context,
    ),
  );
  assert.equal(longSteps.deferredCases?.[0]?.steps.length, 25);
});

test("every grouped expectation is validated and empty expectation lists are rejected", () => {
  const result = canonicalizePlan(
    {
      ...fetmProposal,
      deferredCases: fetmProposal.deferredCases.map((scenario, index) =>
        index === 0
          ? {
              ...scenario,
              expectations: [
                ...scenario.expectations,
                { criterionId: "unknown", expectedObservation: "Unknown criterion outcome" },
              ],
            }
          : scenario,
      ),
    },
    context,
  );
  assert.deepEqual(result, {
    kind: "rejected",
    issues: ["deferred case deferred-UI-AC-1 references an unknown criterion"],
  });
  const empty = canonicalizePlan(
    { cases: [], deferredCases: [{ ...deferredCase("AC-1"), expectations: [] }] },
    context,
  );
  assert.equal(empty.kind, "rejected");
  assert.ok(
    empty.kind === "rejected" &&
      empty.issues.some((issue) => issue.startsWith("deferredCases[0].expectations")),
  );
});

test("public issues are bounded, trimmed and deduplicated", () => {
  const long = `criterion ${"x".repeat(600)}`;
  const issues = publicIssues([
    "  first issue  ",
    "first issue",
    "",
    long,
    ...Array.from({ length: 20 }, (_, index) => `issue ${index}`),
  ]);
  assert.equal(issues.length, 8);
  assert.equal(issues[0], "first issue");
  assert.ok(issues.every((issue) => issue.length <= 240 && issue.trim() === issue));
});
