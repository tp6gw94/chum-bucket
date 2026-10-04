import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolCall } from "./tool-call";

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

function renderArguments(argumentsText: string) {
  return renderToStaticMarkup(
    <ToolCall
      part={{
        type: "tool-call",
        id: "formatted-call",
        name: "codemode",
        arguments: argumentsText,
        state: "complete",
      }}
    />,
  );
}

test("multiline code displays real line breaks and preserves the original arguments", () => {
  const code = "const out = {};\n  return out;";
  const part = {
    type: "tool-call" as const,
    id: "code-call",
    name: "codemode",
    arguments: JSON.stringify({ code }),
    state: "complete" as const,
  };
  const original = structuredClone(part);
  const html = renderToStaticMarkup(<ToolCall part={part} />);
  assert.ok(html.includes(`<code>${code}</code>`));
  assert.doesNotMatch(html, /\\n/);
  assert.doesNotMatch(html, /等待參數…/);
  assert.match(html, />code<\/p>/);
  assert.deepEqual(part, original);
});

test("multiline fields remain separate from other formatted JSON arguments", () => {
  const html = renderArguments(
    JSON.stringify({ path: "/tmp/demo.txt", content: "alpha\nbeta", note: "first\r\n  second" }),
  );
  assert.match(html, /\n  &quot;path&quot;: &quot;\/tmp\/demo.txt&quot;\n/);
  assert.ok(html.includes("<code>alpha\nbeta</code>"));
  assert.ok(html.includes("<code>first\r\n  second</code>"));
  assert.match(html, />content<\/p>/);
  assert.match(html, />note<\/p>/);
  assert.doesNotMatch(html, /&quot;content&quot;:/);
});

test("literal backslash sequences stay literal rather than becoming newlines", () => {
  const html = renderArguments(JSON.stringify({ content: String.raw`alpha\nbeta` }));
  assert.match(html, /alpha\\\\nbeta/);
  assert.doesNotMatch(html, /<code>/);
  assert.doesNotMatch(html, /alpha\nbeta/);
});

test("multiline strings are escaped as inert text", () => {
  const html = renderArguments(JSON.stringify({ code: "<script>\nalert(1)\n</script>" }));
  assert.ok(html.includes("<code>&lt;script&gt;\nalert(1)\n&lt;/script&gt;</code>"));
  assert.doesNotMatch(html, /<script>/);
});

test("empty and non-object arguments keep their existing display", () => {
  assert.match(renderArguments(""), /等待參數…/);
  assert.match(renderArguments("null"), />null<\/pre>/);
  assert.match(renderArguments("{}"), />\{\}<\/pre>/);
  assert.match(renderArguments('[1,"two"]'), /\[\n  1,\n  &quot;two&quot;\n\]/);
  assert.match(renderArguments('"alpha"'), /&quot;alpha&quot;/);
});

test("incomplete multiline JSON remains raw until parsing succeeds", () => {
  const html = renderArguments('{"code":"const out = {};\\n');
  assert.match(html, /&quot;code&quot;:&quot;const out = \{\};\\n/);
  assert.doesNotMatch(html, /<code>/);
});
