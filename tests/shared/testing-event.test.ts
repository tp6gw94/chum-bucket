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
  parseTestingProjectionEvent,
  testingProjectionEvent,
} from "../../shared/testing-event";

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
    criteria: [
      {
        id: "criterion-1",
        key: "AC-1",
        statement: "按下送出後顯示成功",
        sourceDigest: "digest-requirement-1",
        anchor: "anchor-1",
      },
    ],
    selection: { kind: "selected", keys: ["AC-1"] },
    unresolved: ["AC-2"],
  },
  plan: {
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
  const withPrivateCase = {
    ...finishedView,
    report: {
      ...report,
      plan: { ...report.plan!, cases: [{ ...planCase, privateChildToken: "case-secret" }] },
    },
  };
  assert.equal(parseTestingProjectionEvent(chunk(withPrivateCase)), null);
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
