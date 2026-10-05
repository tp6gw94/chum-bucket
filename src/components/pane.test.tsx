import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Pane } from "./pane";
import type { ChatMessage, Pane as PaneModel, RunStatus } from "./types";

const COMPACT_MARKER = /<span[^>]*data-slot="marker-content"[^>]*>compact\.\.\.<\/span>/;

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
