import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Pane } from "../../../src/components/pane";
import type { ChatMessage, Pane as PaneModel, RunStatus } from "../../../src/components/types";
import {
  testRunIdSchema,
  type ProgressRow,
  type PublicTestReport,
  type RoleId,
  type TestView,
} from "../../../shared/testing";

const COMPACT_MARKER = /<span[^>]*data-slot="marker-content"[^>]*>compact\.\.\.<\/span>/;
const CONTINUE_BUTTON_RESPONSE = `root = Stack([continueButton])
continueButton = Button("Continue", Action([@ToAssistant("Continue")]), "primary")`;

function transcriptMessage(id: string, role: ChatMessage["role"], text: string): ChatMessage {
  return {
    id,
    role,
    parts: [{ type: "text", content: text }],
  } as ChatMessage;
}

function paneFixture(status: RunStatus, messages: ChatMessage[]): PaneModel {
  return {
    id: "pane-1",
    title: "主對話",
    agent: "demo-agent",
    status,
    progress: [],
    messages,
    kind: "main",
  };
}

function renderPane(pane: PaneModel): string {
  return renderToStaticMarkup(<Pane pane={pane} onOpenAgentPane={() => undefined} />);
}

test("compacting adds one exact compact status row after the original messages", () => {
  const pane = paneFixture("compacting", [transcriptMessage("u1", "user", "原始使用者問題")]);
  const html = renderPane(pane);

  assert.match(html, /data-message-id="u1"/);
  assert.match(html, /原始使用者問題/);
  assert.match(html, /role="status"/);
  assert.match(html, COMPACT_MARKER);
  assert.equal(html.match(new RegExp(COMPACT_MARKER.source, "g"))?.length, 1);
  assert.ok(html.indexOf("原始使用者問題") < html.indexOf('data-slot="marker-content"'));
});

test("compacting shows the status row even when no history is loaded yet", () => {
  const html = renderPane(paneFixture("compacting", []));

  assert.match(html, /role="status"/);
  assert.match(html, COMPACT_MARKER);
  assert.match(html, /還沒有訊息/);
});

test("resolving removes the status row and keeps the agent reply after original messages", () => {
  const messages = [
    transcriptMessage("u1", "user", "原始使用者問題"),
    transcriptMessage("a1", "assistant", "代理回覆內容"),
  ];
  const original = structuredClone(messages);

  const html = renderPane(paneFixture("idle", messages));

  assert.doesNotMatch(html, /role="status"/);
  assert.doesNotMatch(html, COMPACT_MARKER);
  assert.doesNotMatch(html, /compact\.\.\./);
  assert.match(html, /data-message-id="u1"/);
  assert.match(html, /data-message-id="a1"/);
  assert.match(html, /原始使用者問題/);
  assert.match(html, /代理回覆內容/);
  assert.ok(html.indexOf("原始使用者問題") < html.indexOf("代理回覆內容"));
  assert.deepEqual(messages, original);
});

test("an empty ready draft cannot submit and exposes no command list", () => {
  const html = renderToStaticMarkup(
    <Pane
      pane={paneFixture("idle", [])}
      onSend={async () => "succeeded"}
      onOpenAgentPane={() => undefined}
    />,
  );
  assert.match(
    html,
    /<button(?=[^>]*type="submit")(?=[^>]*disabled="")[^>]*>[\s\S]*?送出<\/button>/,
  );
  assert.doesNotMatch(html, /role="listbox"/);
  assert.match(html, /還沒有訊息/);
});

test("all archived summaries render as plain text on the left without OpenUI interpretation", () => {
  const first = {
    ...transcriptMessage("summary-1", "user", 'root = Text("保留完整摘要一")'),
    metadata: { fromSummary: true },
  };
  const second = {
    ...transcriptMessage("summary-2", "user", "完整摘要二\nEXACT-42"),
    metadata: { fromSummary: true },
  };
  const html = renderPane(
    paneFixture("idle", [transcriptMessage("original", "user", "保留原文"), first, second]),
  );
  assert.match(html, /root = Text\(&quot;保留完整摘要一&quot;\)/);
  assert.match(html, /完整摘要二\nEXACT-42/);
  assert.equal(html.match(/>壓縮摘要</g)?.length, 2);
  assert.equal(html.match(/data-slot="message" data-align="start"/g)?.length, 2);
  assert.ok(html.indexOf("保留原文") < html.indexOf("保留完整摘要一"));
  assert.ok(html.indexOf("保留完整摘要一") < html.indexOf("完整摘要二"));
  assert.doesNotMatch(html, /無法解析|historical reference|discover_atlassian_tools/);
});

for (const [notice, copy] of [
  ["done", "上下文已整理"],
  ["skipped", "目前沒有足夠"],
  ["failed", "整理上下文失敗"],
] as const) {
  test(`compaction outcome ${notice} remains visible independently of chat state`, () => {
    const html = renderToStaticMarkup(
      <Pane
        pane={paneFixture("idle", [])}
        compactNotice={notice}
        onOpenAgentPane={() => undefined}
      />,
    );
    assert.ok(html.includes(copy));
    assert.match(html, new RegExp(`role="${notice === "failed" ? "alert" : "status"}"`));
  });
}

test("historical OpenUI controls stay inert when the pane cannot send", () => {
  const html = renderToStaticMarkup(
    <Pane
      pane={paneFixture("idle", [
        transcriptMessage("old-assistant", "assistant", CONTINUE_BUTTON_RESPONSE),
      ])}
      onSend={async () => "succeeded"}
      sendDisabled
    />,
  );

  assert.match(
    html,
    /<fieldset(?=[^>]*disabled="")(?=[^>]*inert="")[^>]*>[\s\S]*Continue[\s\S]*<\/fieldset>/,
  );
});

test("a separate hydration error does not disable actions while the pane is ready", () => {
  const html = renderToStaticMarkup(
    <Pane
      pane={paneFixture("idle", [
        transcriptMessage("old-assistant", "assistant", CONTINUE_BUTTON_RESPONSE),
      ])}
      onSend={async () => "succeeded"}
      hydrationError="附屬對話載入失敗"
    />,
  );
  const controls = html.match(/<fieldset([^>]*)>[\s\S]*?<\/fieldset>/)?.[0];

  assert.ok(controls);
  assert.match(controls, /Continue/);
  assert.doesNotMatch(controls, /\sdisabled(?:="")?/);
  assert.doesNotMatch(controls, /\sinert(?:="")?/);
});

test("the transcript view shows only public messages without summary headers", () => {
  const messages = [
    transcriptMessage("u1", "user", "公開問題"),
    transcriptMessage("a1", "assistant", "公開回覆"),
  ];

  const html = renderPane(paneFixture("idle", messages));

  assert.doesNotMatch(html, /摘要/);
  assert.match(html, /公開問題/);
  assert.match(html, /公開回覆/);
});

const testingRunId = testRunIdSchema.parse("run-1");
const otherTestingRunId = testRunIdSchema.parse("run-2");

function testingRows(): Record<RoleId, ProgressRow> {
  return {
    atlassian: { status: "terminal", outcome: "completed", reasonCode: "ok" },
    planner: { status: "running", activity: "model", checks: { completed: 1, total: 4 } },
    ac: {
      status: "tool_activity",
      active: [{ toolName: "use_browser", route: "codemode", startedAt: "2025-01-01T00:00:00Z" }],
    },
    ui: { status: "not_required", reason: "no_style_checks" },
  };
}

function testingReport(): PublicTestReport {
  return {
    runId: testingRunId,
    requirements: {
      goal: "公開測試報告目標",
      sources: [
        {
          reference: { kind: "jira", issueKey: "CHUM-42" },
          text: "CHUM-42 結帳\n\n1. AC-1 訂單建立後顯示確認",
          links: [],
          digest: "digest-1",
          capturedAt: "2025-01-01T00:00:00Z",
        },
      ],
    },
    plan: {
      criteria: [{ id: "criterion-1", statement: "訂單建立後顯示確認" }],
      unresolved: [],
      cases: [
        {
          id: "case-1",
          title: "結帳案例",
          preconditions: ["購物車已有商品"],
          actions: [{ kind: "navigate", path: "/checkout" }],
          checks: [
            {
              id: "check-1",
              criterionId: "criterion-1",
              kind: "functional",
              expectedObservation: "顯示訂單確認",
            },
          ],
        },
      ],
      assignments: { ac: ["check-1"], ui: [] },
    },
    results: {
      ac: [{ caseId: "case-1", checkId: "check-1", judgment: "simulated_pass", evidence: [] }],
      ui: [],
    },
    coverage: [],
    unresolvedSources: [],
    artifacts: [],
    roleOutcomes: testingRows(),
    acceptance: { verdict: "not_verified", reason: "mock_only" },
  };
}

function testingView(viewRunId = testingRunId, version = 1): TestView {
  return {
    runId: viewRunId,
    state: "active",
    report: null,
    progress: { version, rows: testingRows() },
    reuse: [],
    availableArtifacts: [],
  };
}

function finishedTestingView(): TestView {
  return {
    runId: testingRunId,
    state: "finished",
    report: testingReport(),
    progress: { version: 5, rows: testingRows() },
    reuse: [],
    availableArtifacts: [],
  };
}

test("the main pane renders each testing operation inside the message scroller in role order", () => {
  const html = renderToStaticMarkup(
    <Pane
      pane={paneFixture("idle", [])}
      onOpenAgentPane={() => undefined}
      testingViews={[testingView(), testingView(otherTestingRunId, 1)]}
      onCancelTesting={async () => undefined}
    />,
  );

  assert.equal(html.match(/data-testid="testing-progress"/g)?.length, 2);
  assert.match(html, /data-message-id="testing-run-1"/);
  assert.match(html, /data-message-id="testing-run-2"/);
  assert.match(html, /data-slot="message-scroller-content"/);
  assert.ok(html.indexOf("testing-run-1") < html.indexOf("testing-run-2"));
  assert.ok(html.indexOf('data-role="atlassian"') < html.indexOf('data-role="planner"'));
  assert.ok(html.indexOf('data-role="planner"') < html.indexOf('data-role="ac"'));
  assert.ok(html.indexOf('data-role="ac"') < html.indexOf('data-role="ui"'));
  assert.doesNotMatch(html, /主對話進度/);
});

test("a finished testing operation renders its public report next to unrelated progress", () => {
  const html = renderToStaticMarkup(
    <Pane
      pane={{ ...paneFixture("idle", []), progress: ["排隊中"] }}
      onOpenAgentPane={() => undefined}
      testingViews={[finishedTestingView()]}
      onCancelTesting={async () => undefined}
    />,
  );

  assert.match(html, /data-testid="testing-progress"/);
  assert.match(html, /data-testid="testing-report"/);
  assert.match(html, /排隊中/);
  assert.ok(html.indexOf('data-testid="testing-progress"') < html.indexOf("排隊中"));
});

test("a finished pane keeps public report details outside inherited live announcements", () => {
  const activeHtml = renderToStaticMarkup(
    <Pane
      pane={paneFixture("idle", [])}
      testingViews={[testingView()]}
      onCancelTesting={async () => undefined}
    />,
  );
  const finishedHtml = renderToStaticMarkup(
    <Pane
      pane={paneFixture("idle", [])}
      testingViews={[finishedTestingView()]}
      onCancelTesting={async () => undefined}
    />,
  );
  const reportMatch = finishedHtml.match(
    /<section(?=[^>]*aria-live="off")(?=[^>]*data-testid="testing-report")[^>]*>[\s\S]*?<\/section>/,
  );

  assert.match(activeHtml, /data-state="active"/);
  assert.doesNotMatch(activeHtml, /data-testid="testing-report"/);
  assert.match(finishedHtml, /data-state="finished"/);
  assert.match(
    finishedHtml,
    /<div(?=[^>]*data-slot="message-scroller-content")(?=[^>]*role="log")(?=[^>]*aria-relevant="additions")[^>]*>/,
  );
  assert.doesNotMatch(
    finishedHtml,
    /<div(?=[^>]*data-slot="message-scroller-content")(?=[^>]*aria-live="off")[^>]*>/,
  );
  assert.ok(reportMatch);
  assert.doesNotMatch(reportMatch[0], /aria-hidden="true"|\sinert(?:="")?/);
  assert.match(reportMatch[0], /公開測試報告目標/);
  assert.match(reportMatch[0], /結帳案例（案例 case-1）/);
  assert.match(reportMatch[0], /前置條件：購物車已有商品/);
  assert.match(reportMatch[0], /顯示訂單確認/);
  assert.match(reportMatch[0], /可用既有參照/);
  assert.match(reportMatch[0], /重用與相容性由伺服器判定/);
  const statusIndex = finishedHtml.indexOf('aria-label="測試狀態摘要"');
  const reportIndex = finishedHtml.indexOf('data-testid="testing-report"');
  assert.ok(statusIndex >= 0 && statusIndex < reportIndex);
  assert.match(
    finishedHtml,
    /<p(?=[^>]*role="status")(?=[^>]*aria-live="polite")(?=[^>]*aria-label="測試狀態摘要")[^>]*>/,
  );
});

function originatingMessage(id: string, callId: string): ChatMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-call",
        id: callId,
        name: "delegate_task",
        arguments: "{}",
        state: "input-complete",
      },
    ],
  } as ChatMessage;
}

function originatingView(state: TestView["state"] = "active"): TestView {
  return {
    ...testingView(),
    state,
    report: null,
    task: {
      version: 2,
      role: "planner",
      summary: "Originating delegation",
      result: null,
      origin: {
        parentRunId: "parent-one",
        requestKey: "call-one",
        parentMessageId: "assistant-one",
      },
    },
  };
}

test("a delegation stays after its originating assistant and before a later turn", () => {
  const html = renderToStaticMarkup(
    <Pane
      pane={paneFixture("idle", [
        originatingMessage("assistant-one", "call-one"),
        transcriptMessage("later", "user", "Later turn"),
      ])}
      testingViews={[originatingView(), originatingView()]}
      onCancelTesting={async () => undefined}
    />,
  );
  assert.ok(
    html.indexOf('data-message-id="assistant-one"') <
      html.indexOf('data-message-id="testing-run-1"'),
  );
  assert.ok(
    html.indexOf('data-message-id="testing-run-1"') < html.indexOf('data-message-id="later"'),
  );
  assert.equal(html.match(/data-testid="testing-progress"/g)?.length, 1);
});

test("a resolved active projection waits during streaming and appears at the arriving message", () => {
  const pending = renderToStaticMarkup(
    <Pane
      pane={paneFixture("running", [])}
      testingViews={[originatingView()]}
      activeRunId="parent-one"
    />,
  );
  assert.doesNotMatch(pending, /data-testid="testing-progress"/);
  const arrived = renderToStaticMarkup(
    <Pane
      pane={paneFixture("running", [originatingMessage("assistant-one", "call-one")])}
      testingViews={[originatingView()]}
    />,
  );
  assert.equal(arrived.match(/data-testid="testing-progress"/g)?.length, 1);
  const terminal = renderToStaticMarkup(
    <Pane pane={paneFixture("running", [])} testingViews={[originatingView("finished")]} />,
  );
  assert.equal(terminal.match(/data-testid="testing-progress"/g)?.length, 1);
  assert.match(terminal, /data-state="finished"/);
  const idle = renderToStaticMarkup(
    <Pane pane={paneFixture("idle", [])} testingViews={[originatingView()]} />,
  );
  assert.equal(idle.match(/data-testid="testing-progress"/g)?.length, 1);
});

test("the pane defers a missing delegate part only for the matching active parent", () => {
  const pane = paneFixture("running", [originatingMessage("assistant-one", "other-call")]);
  const matching = renderToStaticMarkup(
    <Pane pane={pane} testingViews={[originatingView()]} activeRunId="parent-one" />,
  );
  const other = renderToStaticMarkup(
    <Pane pane={pane} testingViews={[originatingView()]} activeRunId="parent-two" />,
  );
  const unknown = renderToStaticMarkup(<Pane pane={pane} testingViews={[originatingView()]} />);
  assert.match(matching, /data-message-id="assistant-one"/);
  assert.doesNotMatch(matching, /data-testid="testing-progress"/);
  assert.equal(other.match(/data-testid="testing-progress"/g)?.length, 1);
  assert.equal(unknown.match(/data-testid="testing-progress"/g)?.length, 1);
});

test("an agent pane never renders testing panels even when testing views are passed", () => {
  const html = renderToStaticMarkup(
    <Pane
      pane={{ ...paneFixture("idle", []), kind: "agent" }}
      onOpenAgentPane={() => undefined}
      testingViews={[testingView()]}
      onCancelTesting={async () => undefined}
    />,
  );

  assert.doesNotMatch(html, /data-testid="testing-progress"/);
  assert.doesNotMatch(html, /data-testid="testing-report"/);
  assert.doesNotMatch(html, /測試角色進度/);
});
