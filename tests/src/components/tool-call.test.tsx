import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolCall } from "../../../src/components/tool-call";

test("tool calls expose their name, partial arguments and lifecycle state", () => {
  const part = {
    type: "tool-call" as const,
    id: "call-1",
    name: "getTicket",
    arguments: '{"issueKey":"DEMO-1',
    state: "input-streaming" as const,
  };
  const pending = renderToStaticMarkup(<ToolCall part={part} />);
  assert.match(pending, /getTicket/);
  assert.match(pending, /接收參數中/);
  assert.match(pending, /DEMO-1/);
  assert.match(pending, /<details open/);

  for (const [state, label] of [
    ["input-complete", "等待執行結果"],
    ["complete", "已完成"],
    ["error", "執行失敗"],
  ] as const) {
    const html = renderToStaticMarkup(
      <ToolCall part={{ ...part, arguments: '{"issueKey":"DEMO-1"}', state }} />,
    );
    assert.match(html, new RegExp(label));
    assert.match(html, /\n  &quot;issueKey&quot;: &quot;DEMO-1&quot;\n/);
  }

  const code =
    'const issue = await external_jira_get_issue({ issue_key: "DEMO-1" });\nreturn issue.key;';
  const codemode = renderToStaticMarkup(
    <ToolCall
      part={{
        ...part,
        name: "codemode",
        arguments: JSON.stringify({ code, label: "multi\nline", limit: 2 }),
        state: "complete",
      }}
    />,
  );
  assert.match(
    codemode,
    /<code>const issue = await external_jira_get_issue\(\{ issue_key: &quot;DEMO-1&quot; \}\);\nreturn issue.key;<\/code>/,
  );
  assert.match(codemode, /<code>multi\nline<\/code>/);
  assert.match(codemode, /\{\n {2}&quot;limit&quot;: 2\n\}/);
  assert.doesNotMatch(codemode, /\\n/);

  const codeOnly = renderToStaticMarkup(
    <ToolCall part={{ ...part, arguments: JSON.stringify({ code }), state: "complete" }} />,
  );
  assert.doesNotMatch(codeOnly, /等待參數/);
  assert.match(codeOnly, /<code>/);

  const escaped = renderToStaticMarkup(
    <ToolCall part={{ ...part, arguments: "<script>alert(1)</script>" }} />,
  );
  assert.doesNotMatch(escaped, /<script>/);
  assert.match(escaped, /&lt;script&gt;/);
});
