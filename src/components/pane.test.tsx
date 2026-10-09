import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Pane } from "./pane";
import type { ChatMessage, Pane as PaneModel, RunStatus } from "./types";

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
