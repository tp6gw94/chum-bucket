import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SummaryPreview } from "../../../src/components/side-chat-pane";
import {
  SideChatOperationError,
  summaryTransferFailure,
  type SummaryTransfer,
} from "@/shared/side-chat";
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

test("an unknown transfer locks its original text and exposes a same-operation retry even while main is busy", () => {
  const draft: SummaryTransfer = {
    kind: "draft",
    draft: {
      id: "6f468531-5da6-4d21-85c9-27c6fd9c40cc",
      sideRevision: 1,
      through: 2,
      text: "原始摘要",
    },
    text: "保留的編輯草稿",
    key: "2f7f288b-a1fb-47d2-b24b-075a26835baf",
  };
  const unresolved = summaryTransferFailure(draft, new TypeError("Response lost after commit"));
  assert.deepEqual(unresolved, { ...draft, kind: "unresolved" });
  const html = renderToStaticMarkup(
    <SummaryPreview
      id="side-1"
      title="附屬對話 1"
      text={unresolved.text}
      confirming={false}
      unresolved={unresolved.kind === "unresolved"}
      ready
      mainBusy
      onEdit={() => assert.fail("A frozen transfer cannot be edited")}
      onConfirm={() => {}}
    />,
  );
  assert.match(html, /<textarea[^>]*disabled[^>]*>保留的編輯草稿<\/textarea>/);
  assert.match(html, /回填結果尚未確認/);
  assert.match(html, /重試同一筆回填/);
  assert.doesNotMatch(html, /<button[^>]*\sdisabled=""/);
  assert.deepEqual(
    summaryTransferFailure(unresolved, new SideChatOperationError("blocked", "Main busy")),
    unresolved,
  );
  assert.deepEqual(
    summaryTransferFailure(unresolved, new SideChatOperationError("rejected", "Stale draft")),
    draft,
  );
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
