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

  const escaped = renderToStaticMarkup(
    <ToolCall part={{ ...part, arguments: "<script>alert(1)</script>" }} />,
  );
  assert.doesNotMatch(escaped, /<script>/);
  assert.match(escaped, /&lt;script&gt;/);
});

test("multi-line string arguments render as code blocks that keep their line breaks", () => {
  const code = 'const file = await external_read({ path: "a.txt" });\nreturn file.content[0].text;';
  const html = renderToStaticMarkup(
    <ToolCall
      part={{
        type: "tool-call",
        id: "call-2",
        name: "codemode",
        arguments: JSON.stringify({ code }),
        state: "complete",
      }}
    />,
  );
  assert.match(
    html,
    /<code>const file = await external_read\(\{ path: &quot;a\.txt&quot; \}\);\nreturn file/,
  );
  assert.doesNotMatch(html, /\\n/);
  assert.doesNotMatch(html, /等待參數/);
});
