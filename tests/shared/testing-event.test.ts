import assert from "node:assert/strict";
import { test } from "node:test";
import { EventType } from "@tanstack/ai";

import {
  artifactRefSchema,
  testRunIdSchema,
  type ProgressRow,
  type PublicCheckResult,
  type PublicTestReport,
  type RoleId,
  type TestView,
} from "../../shared/testing";
import {
  TESTING_PROJECTION_EVENT,
  parsePublishedTesting,
  parsePublishedTasks,
  parseTestView,
  parseTestingProjectionEvent,
  testingProjectionEvent,
} from "../../shared/testing-event";

import {
  assembleRequirements,
  canonicalizePlan,
  digestOf,
  publicTaskArtifact,
  projectProgress,
  deriveReport,
} from "../../server/harness/testing-domain";

const runId = testRunIdSchema.parse("run-1");
const otherRunId = testRunIdSchema.parse("run-2");
const artifact = artifactRefSchema.parse("artifact:requirements:1");
const otherArtifact = artifactRefSchema.parse("artifact:plan:2");

function rows(): Record<RoleId, ProgressRow> {
  return {
    atlassian: {
      status: "reused",
      artifact,
      provenance: {
        originalRunId: otherRunId,
        role: "atlassian",
        issuedAt: "2025-01-01T00:00:00Z",
      },
    },
    planner: { status: "running", activity: "model", checks: { completed: 1, total: 4 } },
    ac: {
      status: "tool_activity",
      active: [{ toolName: "use_browser", route: "codemode", startedAt: "2025-01-01T00:00:01Z" }],
      checks: { completed: 2, total: 4 },
    },
    ui: { status: "terminal", outcome: "completed", reasonCode: "coverage_complete" },
  };
}

const acResult: PublicCheckResult = {
  caseId: "case-1",
  checkId: "check-1",
  judgment: "simulated_pass",
  evidence: [
    {
      kind: "functional",
      outcome: "pass",
      expected: "顯示成功",
      observed: "顯示成功",
      actionIndex: 0,
      caseId: "case-1",
      checkId: "check-1",
      origin: "mock",
      fixture: { id: "host-browser-mock", version: "v1" },
      adapterVersion: "mock-adapter-v1",
    },
  ],
};

const uiResult: PublicCheckResult = {
  caseId: "case-1",
  checkId: "check-2",
  judgment: "simulated_fail",
  evidence: [
    {
      kind: "style",
      outcome: "outside_tolerance",
      property: "color",
      expected: "#000000",
      observed: "#111111",
      tolerance: { kind: "numeric", unit: "ratio", maxDelta: 0.01 },
      capturedDesign: {
        reference: { fileKey: "file-1", nodeId: "node-1" },
        propertiesDigest: "digest-design-1",
        complete: true,
        capturedAt: "2025-01-01T00:00:02Z",
      },
      caseId: "case-1",
      checkId: "check-2",
      origin: "mock",
      fixture: { id: "host-browser-mock", version: "v1" },
      adapterVersion: "mock-adapter-v1",
    },
  ],
};

const report: PublicTestReport = {
  runId,
  requirements: {
    goal: "驗證儀表板",
    sources: [
      {
        reference: { kind: "jira", issueKey: "ABC-1" },
        text: "ABC-1 儀表板\n\n## 驗收條件\n1. 按下送出後顯示成功",
        links: [],
        digest: "digest-requirement-1",
        capturedAt: "2025-01-01T00:00:00Z",
      },
    ],
  },
  plan: {
    criteria: [{ id: "criterion-1", statement: "按下送出後顯示成功" }],
    unresolved: ["送出失敗時的提示文字未定義"],
    cases: [
      {
        id: "case-1",
        title: "送出表單",
        preconditions: ["已登入"],
        actions: [
          { kind: "navigate", path: "/dashboard" },
          { kind: "click", target: "#submit" },
          { kind: "fill", target: "#name", value: "測試" },
        ],
        checks: [
          {
            id: "check-1",
            criterionId: "criterion-1",
            kind: "functional",
            expectedObservation: "顯示成功",
          },
          {
            id: "check-2",
            criterionId: "criterion-1",
            kind: "style",
            design: { fileKey: "file-1", nodeId: "node-1" },
            property: "color",
            tolerance: { kind: "exact" },
          },
        ],
      },
    ],
    assignments: { ac: ["case-1"], ui: ["case-1"] },
  },
  results: { ac: [acResult], ui: [uiResult] },
  coverage: [
    { criterionId: "criterion-1", caseId: "case-1", checkId: "check-1", state: "simulated_pass" },
    { criterionId: "criterion-1", caseId: null, checkId: null, state: "uncovered" },
  ],
  unresolvedSources: [{ kind: "jira", issueKey: "ABC-1" }],
  artifacts: [artifact, otherArtifact],
  roleOutcomes: rows(),
  acceptance: { verdict: "blocked", reasons: ["root_cancelled"] },
};

const finishedView: TestView = {
  runId,
  state: "finished",
  report,
  progress: { version: 3, rows: rows() },
  reuse: [
    {
      ref: artifact,
      kind: "accepted",
      artifactKind: "requirements",
      provenance: {
        originalRunId: otherRunId,
        role: "atlassian",
        issuedAt: "2025-01-01T00:00:00Z",
      },
    },
    { ref: otherArtifact, kind: "rejected", reason: "incompatible_snapshot" },
  ],
  availableArtifacts: [artifact],
};

const activeView: TestView = {
  runId,
  state: "active",
  report: null,
  progress: { version: 1, rows: rows() },
  reuse: [],
  availableArtifacts: [],
};

function chunk(value: unknown) {
  return { type: EventType.CUSTOM, name: TESTING_PROJECTION_EVENT, value, timestamp: 1 };
}

test("six authorized sources retain more than 100 source-bound links through projection and hydration", () => {
  const sources = Array.from({ length: 6 }, (_, index) => ({
    kind: "jira" as const,
    issueKey: `FETM-${78 + index}`,
  }));
  const links = (index: number) =>
    Array.from({ length: 20 }, (_, node) => ({
      url: `https://www.figma.com/design/File${index}?node-id=1-${node}`,
      fileKey: `File${index}`,
      nodeId: `1:${node}`,
    }));
  const receipts = sources.map((source, index) => {
    const output = {
      result: JSON.stringify({
        key: source.issueKey,
        summary: `Linked page ${index}`,
        remote_links: links(index).map((link, id) => ({ id, object: { url: link.url } })),
      }),
    };

    return {
      nativeName: "jira_get_issue",
      input: { issue_key: source.issueKey },
      output,
      outputDigest: digestOf(output),
      bindings: { capturedAt: "2026-10-13T00:00:00.000Z" },
    };
  });
  const validated = assembleRequirements({ goal: "Plan linked sources", sources }, receipts);
  assert.equal(validated.kind, "accepted");
  if (validated.kind !== "accepted") return;
  const result = publicTaskArtifact({
    ref: artifact,
    kind: "requirements",
    payload: validated.value,
  });
  assert.equal(result.kind, "requirements");
  if (result.kind !== "requirements") return;
  const expectedLinks = sources.flatMap((source, index) =>
    links(index).map((link) => ({ source, ...link })),
  );
  assert.equal(expectedLinks.length, 120);
  assert.deepEqual(result.payload.links, expectedLinks);
  const view: TestView = {
    runId,
    state: "finished",
    report: null,
    reuse: [],
    availableArtifacts: [],
    progress: projectProgress(1, {}, null),
    task: { version: 2, role: "atlassian", summary: "Read linked requirements", result },
  };
  assert.deepEqual(parseTestView(view), view);
  assert.deepEqual(parseTestingProjectionEvent(testingProjectionEvent(view)), view);
  assert.deepEqual(parsePublishedTasks({ publishedTasks: [view] }), [view]);
  const projectedReport = deriveReport({
    runId,
    rootOutcome: "completed",
    requirements: validated.value,
    plan: null,
    acResults: null,
    uiResults: null,
    unresolvedSources: [],
    artifacts: [],
    progressVersion: 1,
    outcomes: {},
  });
  const reportView: TestView = {
    ...view,
    state: "finished",
    task: undefined,
    report: projectedReport,
  };
  assert.deepEqual(parseTestView(reportView)?.report?.requirements?.links, expectedLinks);
  assert.deepEqual(
    parsePublishedTasks({ publishedTasks: [reportView] })[0]?.report?.requirements?.links,
    expectedLinks,
  );
});

test("raw source text and plan unresolved notes survive hydration without private receipt metadata", () => {
  const requirements = report.requirements!;
  const view = {
    ...finishedView,
    report: {
      ...report,
      requirements: {
        ...requirements,
        sources: [{ ...requirements.sources[0]!, text: "  ABC-1 儀表板\n\n- 保留 Markdown  \n" }],
      },
    },
  };
  const parsed = parsePublishedTasks({ publishedTasks: [view] })[0];
  assert.deepEqual(
    parsed?.report?.requirements?.sources[0]?.text,
    "  ABC-1 儀表板\n\n- 保留 Markdown  \n",
  );
  assert.deepEqual(parsed?.report?.plan?.unresolved, ["送出失敗時的提示文字未定義"]);
  for (const privateSource of [
    { ...requirements.sources[0]!, bindings: { capturedAt: "2025-01-01T00:00:00Z" } },
    { ...requirements.sources[0]!, output: { result: "{}" } },
  ]) {
    assert.equal(
      parseTestingProjectionEvent(
        chunk({
          ...finishedView,
          report: { ...report, requirements: { ...requirements, sources: [privateSource] } },
        }),
      ),
      null,
    );
  }
});

test("500 criteria with repeated checks round-trip every planned and uncovered coverage row", () => {
  const criteria = Array.from({ length: 500 }, (_, index) => ({
    id: `C-${index + 1}`,
    statement: `Statement ${index + 1}`,
  }));
  const plan = canonicalizePlan(
    {
      criteria,
      unresolved: [],
      cases: Array.from({ length: 8 }, (_, caseIndex) => ({
        id: `case-${caseIndex}`,
        title: `Case ${caseIndex}`,
        preconditions: [],
        actions: [{ kind: "navigate", path: "/" }],
        checks: Array.from({ length: 10 }, (_, checkIndex) => ({
          id: `check-${caseIndex}-${checkIndex}`,
          criterionId: "C-1",
          kind: "functional",
          expectedObservation: "Visible",
        })),
      })),
    },
    {
      requirementsDigest: "requirements",
      goal: "Plan",
      targetUrl: null,
      design: null,
    },
  );
  assert.equal(plan.kind, "accepted");
  if (plan.kind !== "accepted") return;
  const derived = deriveReport({
    runId,
    rootOutcome: "completed",
    requirements: { goal: "Plan", sources: report.requirements!.sources },
    plan: plan.value,
    acResults: null,
    uiResults: null,
    unresolvedSources: [],
    artifacts: [],
    progressVersion: 1,
    outcomes: {},
  });
  assert.equal(derived.coverage.length, 579);
  assert.deepEqual(derived.coverage.at(-1), {
    criterionId: "C-500",
    caseId: null,
    checkId: null,
    state: "uncovered",
  });
  const view: TestView = { ...finishedView, report: derived };
  assert.deepEqual(parseTestingProjectionEvent(testingProjectionEvent(view)), view);
  assert.deepEqual(parsePublishedTasks({ publishedTasks: [view] }), [view]);
});

test("public plan and result projections round-trip beyond the removed count caps", () => {
  const criteria = Array.from({ length: 25 }, (_, index) => ({
    id: `C-${index + 1}`,
    statement: `Requirement ${index + 1}`,
  }));
  const plan = canonicalizePlan(
    {
      criteria,
      unresolved: Array.from({ length: 60 }, (_, index) => `Open question ${index + 1}`),
      cases: Array.from({ length: 25 }, (_, caseIndex) => ({
        id: `case-${caseIndex + 1}`,
        title: `Case ${caseIndex + 1}`,
        preconditions: [],
        actions: [{ kind: "navigate", path: "/" }],
        checks: Array.from({ length: 4 }, (_, checkIndex) => ({
          id: `check-${caseIndex + 1}-${checkIndex + 1}`,
          criterionId: criteria[caseIndex]!.id,
          kind: "functional",
          expectedObservation: "Visible",
        })),
      })),
      deferredCases: Array.from({ length: 25 }, (_, index) => ({
        id: `deferred-${index + 1}`,
        title: `Deferred ${index + 1}`,
        steps: ["Inspect the outcome"],
        reason: "Requires manual verification",
        expectations: [
          { criterionId: criteria[index]!.id, expectedObservation: "Expected outcome" },
        ],
      })),
    },
    {
      requirementsDigest: "requirements",
      goal: "Plan",
      targetUrl: null,
      design: null,
    },
  );
  assert.equal(plan.kind, "accepted");
  if (plan.kind !== "accepted") return;
  assert.equal(plan.value.assignments.ac.length, 100);
  const planArtifact = publicTaskArtifact({ ref: artifact, kind: "plan", payload: plan.value });
  const planView: TestView = {
    runId,
    state: "finished",
    report: null,
    reuse: [],
    availableArtifacts: [],
    progress: { version: 1, rows: rows() },
    task: { version: 2, role: "planner", summary: "Plan", result: planArtifact },
  };
  assert.deepEqual(parseTestView(planView), planView);
  assert.deepEqual(parseTestingProjectionEvent(testingProjectionEvent(planView)), planView);
  assert.deepEqual(parsePublishedTasks({ publishedTasks: [planView] }), [planView]);

  const results = {
    role: "ac" as const,
    checks: Array.from({ length: 81 }, (_, index) => ({
      ...acResult,
      checkId: `check-${index + 1}`,
      evidence: [acResult.evidence[0]!] as const,
    })),
  };
  const resultArtifact = publicTaskArtifact({
    ref: otherArtifact,
    kind: "ac-result",
    payload: results,
  });
  const resultView: TestView = {
    runId,
    state: "finished",
    report: null,
    reuse: [],
    availableArtifacts: [],
    progress: { version: 1, rows: rows() },
    task: { version: 2, role: "ac", summary: "Run checks", result: resultArtifact },
  };
  assert.deepEqual(parseTestView(resultView), resultView);
  assert.deepEqual(parseTestingProjectionEvent(testingProjectionEvent(resultView)), resultView);

  const derived = deriveReport({
    runId,
    rootOutcome: "completed",
    requirements: { goal: "Plan", sources: report.requirements!.sources },
    plan: plan.value,
    acResults: results,
    uiResults: null,
    unresolvedSources: [],
    artifacts: [],
    progressVersion: 1,
    outcomes: {},
  });
  assert.equal(derived.results.ac.length, 81);
  const reportView: TestView = { ...finishedView, report: derived };
  assert.deepEqual(parseTestingProjectionEvent(testingProjectionEvent(reportView)), reportView);
});

test("the factory round-trips a finished public view with all metadata preserved", () => {
  assert.deepEqual(parseTestingProjectionEvent(testingProjectionEvent(finishedView)), finishedView);
});

test("the factory round-trips active and cancelling views with a null report", () => {
  const cancellingView: TestView = {
    ...activeView,
    state: "cancelling",
    progress: { version: 2, rows: rows() },
  };
  assert.deepEqual(parseTestingProjectionEvent(testingProjectionEvent(activeView)), activeView);
  assert.deepEqual(
    parseTestingProjectionEvent(testingProjectionEvent(cancellingView)),
    cancellingView,
  );
});

test("malformed or foreign events are ignored without throwing", () => {
  const hostile = [
    null,
    undefined,
    42,
    "testing.projection",
    [],
    {},
    { type: EventType.CUSTOM, name: "other.event", value: finishedView },
    { type: "TEXT_MESSAGE_CONTENT", name: TESTING_PROJECTION_EVENT, value: finishedView },
    chunk(null),
    chunk({}),
    chunk({ runId: "run-1" }),
    chunk({ ...activeView, progress: { version: "1", rows: rows() } }),
    chunk({ ...activeView, progress: { version: 1, rows: { atlassian: rows().atlassian } } }),
    chunk({
      ...activeView,
      progress: { version: 1, rows: { ...rows(), atlassian: { status: "unknown" } } },
    }),
    chunk({ ...finishedView, state: "unexpected" }),
    chunk({
      ...finishedView,
      report: { ...report, acceptance: { verdict: "blocked", reasons: [] } },
    }),
  ];

  for (const event of hostile) {
    assert.equal(parseTestingProjectionEvent(event), null);
  }
});

test("private child fields never reach the parsed view or its report", () => {
  const withPrivateView = {
    ...finishedView,
    privateChildToken: "private-token",
    rawFrame: { secret: "raw" },
  };
  const parsedView = parseTestingProjectionEvent(chunk(withPrivateView));
  assert.ok(parsedView);
  assert.equal("privateChildToken" in parsedView, false);
  assert.equal("rawFrame" in parsedView, false);
  assert.equal(JSON.stringify(parsedView).includes("private-token"), false);

  const withPrivateReport = {
    ...finishedView,
    report: { ...report, privateChildToken: "report-secret" },
  };
  const parsedReport = parseTestingProjectionEvent(chunk(withPrivateReport));
  assert.ok(parsedReport && parsedReport.state === "finished" && parsedReport.report);
  assert.equal("privateChildToken" in parsedReport.report, false);
  assert.equal(JSON.stringify(parsedReport).includes("report-secret"), false);
});

test("private fields nested in strict shared shapes reject the whole event", () => {
  const planCase = report.plan!.cases[0]!;
  for (const plan of [
    { ...report.plan!, cases: [{ ...planCase, privateChildToken: "case-secret" }] },
    {
      ...report.plan!,
      criteria: [{ id: "criterion-1", statement: "按下送出後顯示成功", sourceDigest: "digest" }],
    },
    {
      ...report.plan!,
      criteria: [{ id: "criterion-1", statement: "按下送出後顯示成功", anchor: "a" }],
    },
  ]) {
    assert.equal(
      parseTestingProjectionEvent(chunk({ ...finishedView, report: { ...report, plan } })),
      null,
    );
  }
});

test("hydration retains every individual task and legacy view", () => {
  const first = {
    ...activeView,
    runId: testRunIdSchema.parse("operation-one"),
    task: { version: 2 as const, role: "planner" as const, summary: "Plan checkout", result: null },
  };
  const second = { ...finishedView, runId: testRunIdSchema.parse("operation-two") };
  assert.deepEqual(parsePublishedTasks({ publishedTasks: [first, second] }), [first, second]);
  assert.deepEqual(parsePublishedTasks({ publishedTesting: finishedView }), [finishedView]);
  assert.deepEqual(parseTestingProjectionEvent(testingProjectionEvent(first)), first);
});

test("task origin survives stream and hydration parsing while private evidence is stripped", () => {
  const origin = {
    parentRunId: "parent-one",
    requestKey: "call-one",
    parentMessageId: "assistant-one",
  };
  const view = {
    ...activeView,
    task: {
      version: 2 as const,
      role: "planner" as const,
      summary: "Plan checkout",
      result: null,
      origin,
    },
  };
  assert.deepEqual(parseTestingProjectionEvent(testingProjectionEvent(view)), view);
  assert.deepEqual(parsePublishedTasks({ publishedTasks: [view] }), [view]);
  const privateOrigin = {
    ...view,
    task: { ...view.task, origin: { ...origin, rawEvent: "secret" } },
  };
  assert.deepEqual(parseTestingProjectionEvent(chunk(privateOrigin)), view);
  for (const invalid of [
    { ...origin, parentMessageId: "" },
    { ...origin, parentRunId: 3 },
  ]) {
    assert.equal(
      parseTestingProjectionEvent(chunk({ ...view, task: { ...view.task, origin: invalid } })),
      null,
    );
  }
  const unresolved = { ...view, task: { ...view.task, origin: null } };
  assert.deepEqual(parseTestingProjectionEvent(chunk(unresolved)), unresolved);
});

test("hydration payloads expose only a structurally valid published view", () => {
  assert.deepEqual(
    parsePublishedTesting({ messages: [], revision: 4, publishedTesting: finishedView }),
    finishedView,
  );
  assert.equal(parsePublishedTesting({ messages: [], revision: 4, publishedTesting: null }), null);
  assert.equal(parsePublishedTesting({ messages: [], revision: 4 }), null);
  assert.equal(parsePublishedTesting({ publishedTesting: { runId: "run-1" } }), null);
  assert.equal(
    parsePublishedTesting({ publishedTesting: { ...finishedView, report: null } }),
    null,
  );
  assert.equal(parsePublishedTesting("unexpected"), null);
});

const deferredCase = {
  id: "deferred-ui-1",
  title: "按鈕樣式",
  steps: ["開啟商品頁", "檢查加入購物車按鈕"],
  expectations: [{ criterionId: "criterion-1", expectedObservation: "背景色 #2D6A4F，文字白色" }],
  reason: "Jira 描述的樣式值沒有綁定設計稿",
};

const figmaLink = {
  source: { kind: "jira" as const, issueKey: "FETM-78" },
  url: "https://www.figma.com/design/DiPISvcpFmaPsK9QonpeDf?node-id=1-81",
  label: "商品頁 桌面",
  fileKey: "DiPISvcpFmaPsK9QonpeDf",
  nodeId: "1:81",
};

function taskView(
  result: NonNullable<TestView["task"]>["result"],
  rowsOverride = rows(),
): TestView {
  return {
    runId,
    state: "finished",
    report: null,
    reuse: [],
    availableArtifacts: [],
    progress: { version: 4, rows: rowsOverride },
    task: { version: 2, role: "planner", summary: "Plan FETM-78", result },
  };
}

test("task plans round-trip criteria, unresolved and deferred cases and requirements round-trip host Figma links", () => {
  const plan = taskView({
    ref: otherArtifact,
    kind: "plan",
    payload: {
      criteria: report.plan!.criteria,
      unresolved: report.plan!.unresolved,
      cases: [],
      deferredCases: [deferredCase],
      assignments: { ac: [], ui: [] },
    },
  });
  assert.deepEqual(parseTestingProjectionEvent(testingProjectionEvent(plan)), plan);
  assert.deepEqual(parsePublishedTasks({ publishedTasks: [plan] }), [plan]);
  const requirements = taskView({
    ref: artifact,
    kind: "requirements",
    payload: { ...report.requirements!, links: [figmaLink] },
  });
  assert.deepEqual(parseTestingProjectionEvent(testingProjectionEvent(requirements)), requirements);
});

test("plans and requirements without the optional fields keep their exact shape", () => {
  const executable = taskView({
    ref: otherArtifact,
    kind: "plan",
    payload: {
      criteria: report.plan!.criteria,
      unresolved: [],
      cases: report.plan!.cases,
      assignments: { ac: ["check-1"], ui: [] },
    },
  });
  const parsed = parseTestingProjectionEvent(testingProjectionEvent(executable));
  assert.deepEqual(parsed, executable);
  assert.equal(
    parsed?.task?.result?.kind === "plan" && "deferredCases" in parsed.task.result.payload,
    false,
  );
  const hostile = taskView({
    ref: otherArtifact,
    kind: "plan",
    payload: {
      criteria: report.plan!.criteria,
      unresolved: [],
      cases: [],
      deferredCases: [{ ...deferredCase, steps: [] }],
      assignments: { ac: [], ui: [] },
    },
  });
  assert.equal(parseTestingProjectionEvent(chunk(hostile)), null);
  const previousPlan = taskView({
    ref: otherArtifact,
    kind: "plan",
    payload: { cases: report.plan!.cases, assignments: { ac: ["check-1"], ui: [] } },
  } as unknown as NonNullable<TestView["task"]>["result"]);
  assert.equal(parseTestingProjectionEvent(chunk(previousPlan)), null);
});

test("reports round-trip deferred coverage, not-required roles and bounded failure issues", () => {
  const issues = ["criteria[1].id: duplicate criterion id UI-AC-2"];
  const view: TestView = {
    ...finishedView,
    report: {
      ...report,
      plan: {
        criteria: report.plan!.criteria,
        unresolved: [],
        cases: [],
        deferredCases: [deferredCase],
        assignments: { ac: [], ui: [] },
      },
      coverage: [
        { criterionId: "criterion-1", caseId: "deferred-ui-1", checkId: null, state: "deferred" },
      ],
      roleOutcomes: {
        ...rows(),
        ac: { status: "not_required", reason: "no_functional_checks" },
        planner: { status: "terminal", outcome: "failed", reasonCode: "proposal_rejected", issues },
      },
    },
    progress: {
      version: 3,
      rows: {
        ...rows(),
        ac: { status: "not_required", reason: "no_functional_checks" },
        planner: { status: "terminal", outcome: "failed", reasonCode: "proposal_rejected", issues },
      },
    },
  };
  assert.deepEqual(parseTestingProjectionEvent(testingProjectionEvent(view)), view);
  const tooMany = {
    ...view,
    progress: {
      version: 3,
      rows: {
        ...rows(),
        planner: {
          status: "terminal" as const,
          outcome: "failed" as const,
          reasonCode: "proposal_rejected",
          issues: Array.from({ length: 9 }, (_, index) => `issue ${index}`),
        },
      },
    },
  };
  assert.equal(parseTestingProjectionEvent(chunk(tooMany)), null);
});
