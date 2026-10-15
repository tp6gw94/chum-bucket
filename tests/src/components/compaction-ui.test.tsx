import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CommandMenu } from "../../../src/components/command-menu";
import { CompactionNotice } from "../../../src/components/compaction-notice";
import { MessageList } from "../../../src/components/message-list";
import { StatusBadge } from "../../../src/components/status-badge";
import { commandSuggestions } from "../../../src/composer-commands";
import { compactionNotice } from "../../../src/hooks/use-threads";

test("the status badge shows compact... while the context is compacting", () => {
  const badge = (status: "running" | "compacting" | "idle") =>
    renderToStaticMarkup(<StatusBadge status={status} runningLabel="執行中" idleLabel="待命" />);

  assert.match(badge("compacting"), /compact\.\.\./);
  assert.match(badge("compacting"), /animate-spin/);
  assert.match(badge("running"), /執行中/);
  assert.match(badge("idle"), /待命/);
  assert.doesNotMatch(badge("idle"), /animate-spin/);
});

test("compaction notices use alert only for failures", () => {
  assert.equal(renderToStaticMarkup(<CompactionNotice notice={null} />), "");
  assert.match(
    renderToStaticMarkup(<CompactionNotice notice={compactionNotice("done")} />),
    /role="status"[^>]*>上下文已整理/,
  );
  assert.match(
    renderToStaticMarkup(<CompactionNotice notice={compactionNotice("skipped")} />),
    /role="status"/,
  );
  assert.match(
    renderToStaticMarkup(<CompactionNotice notice={compactionNotice("failed")} />),
    /role="alert"[^>]*>整理上下文失敗/,
  );
});

test("the command menu is a named listbox that marks the highlighted option", () => {
  const commands = commandSuggestions({ text: "/comp", focused: true, composing: false });
  const html = renderToStaticMarkup(
    <CommandMenu
      id="menu"
      commands={commands}
      highlighted={0}
      onHighlight={() => {}}
      onSelect={() => {}}
    />,
  );

  assert.match(html, /role="listbox" aria-label="對話命令"/);
  assert.match(html, /id="menu-0" role="option" aria-selected="true"/);
  assert.match(html, /\/compact/);
  assert.equal(
    renderToStaticMarkup(
      <CommandMenu
        id="menu"
        commands={[]}
        highlighted={0}
        onHighlight={() => {}}
        onSelect={() => {}}
      />,
    ),
    "",
  );
});

test("summary messages render under a 壓縮摘要 heading after the original messages", () => {
  const html = renderToStaticMarkup(
    <MessageList
      agent="main"
      messages={[
        { id: "u1", role: "user", parts: [{ type: "text", content: "原始問題" }] },
        {
          id: "summary:run/compact/0",
          role: "user",
          parts: [{ type: "text", content: "完整摘要內容" }],
          metadata: { fromSummary: true },
        },
      ]}
    />,
  );

  assert.ok(html.indexOf("原始問題") < html.indexOf("壓縮摘要"));
  assert.match(html, /壓縮摘要[\s\S]*完整摘要內容/);
});
