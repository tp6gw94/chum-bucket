import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SummaryPreview } from "../../../src/components/side-chat-pane";
import { Pane } from "../../../src/components/pane";

const preview = (mainBusy: boolean, confirming = false, text = "保留的編輯草稿") =>
  renderToStaticMarkup(
    <SummaryPreview
      id="side-1"
      title="附屬對話 1"
      text={text}
      confirming={confirming}
      ready
      mainBusy={mainBusy}
      onEdit={() => {}}
      onConfirm={() => {}}
    />,
  );

test("a busy main thread preserves the editable child summary and its explicit confirmation action", () => {
  const idle = preview(false);
  const busy = preview(true);
  assert.match(idle, /保留的編輯草稿/);
  assert.match(busy, /<textarea[^>]*>保留的編輯草稿<\/textarea>/);
  assert.match(busy, /主對話忙碌中，草稿已保留/);
  assert.match(busy, /確認回填並送出/);
  assert.doesNotMatch(busy, /<textarea[^>]*disabled/);
});

test("confirmation fences editing and empty summaries cannot be submitted", () => {
  assert.match(preview(false, true), /<textarea[^>]*disabled/);
  assert.match(preview(false, true), /回填中/);
  assert.match(preview(false, false, ""), /<button[^>]*\sdisabled=""[^>]*>確認回填並送出/);
  assert.doesNotMatch(preview(false), /<button[^>]*\sdisabled=""/);
});

test("an independent child has a close action but no nested fork control", () => {
  const pane = {
    id: "child",
    title: "附屬對話 1",
    agent: "獨立討論",
    kind: "agent" as const,
    status: "idle" as const,
    progress: [],
    messages: [],
  };
  const html = renderToStaticMarkup(
    <Pane
      pane={pane}
      onSend={async () => "succeeded"}
      onClose={() => {}}
      onOpenAgentPane={() => {}}
    />,
  );
  assert.match(html, /關閉/);
  assert.match(html, /固定主對話快照/);
  assert.doesNotMatch(html, /開啟附屬對話/);
  const main = renderToStaticMarkup(
    <Pane pane={{ ...pane, kind: "main" }} onOpenAgentPane={() => {}} openDisabled />,
  );
  assert.match(main, /<button[^>]*\sdisabled=""[^>]*>[\s\S]*開啟附屬對話/);
});
