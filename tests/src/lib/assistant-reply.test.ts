import assert from "node:assert/strict";
import { test } from "node:test";
import { assistantReplySegments } from "../../../src/lib/assistant-reply";

const ui = 'root = Stack([title])\ntitle = TextContent("UI content")';
const fixtures = [
  "The planner rejects references in this thread. Here's the current status.\n\n" +
    ui +
    "\nAfter prose.",
  "Here's x = 1 and it's fine.\nMore prose.\n" + ui,
  'root = Stack([a, b])\n\na = TextContent("A")\nb = TextContent("B")',
  "\`\`\`js\n" + ui + "\n\`\`\`\nAfter",
  "\`\`\`\n" + ui + "\n\`\`\`",
  "\`\`\`openui-lang\n" + ui + "\n\`\`\`\nAfter",
  "~~~openui-lang\n" + ui + "\n~~~",
  "> " + ui.replaceAll("\n", "\n> "),
  "    " + ui.replaceAll("\n", "\n    "),
  "\t" + ui.replaceAll("\n", "\n\t"),
  "Example \`root = Stack([])\` stays text.",
  'root = Stack([TextContent("A")]) trailing prose',
  'root = Stack([TextContent("A")]) + unknown',
  'root = Stack([TextContent("A")])]',
  'root = Stack([TextContent("A")])\nMiddle\nroot = Stack([TextContent("B")])\nAfter',
  'root = Stack([TextContent("root = Stack([]) and \\"quotes\\"")])',
  'root = Stack([\n true ? TextContent("A")\n : TextContent("B")\n])',
  '$label = "Reactive"\nroot = Stack([TextContent($label)])',
  'root = Stack([TextContent("bad")})',
  'root = Stack([UnknownThing("x")])',
  'root = Stack([TextContent("unfinished',
  "Plain prose only.",
  'root = Stack([title])\n// don\'t change the frame\ntitle = TextContent("UI content")',
  '# heading comment\nroot = Stack([title])\n# note\ntitle = TextContent("UI content")',
  'root = Stack([TextContent("UI content")]) // don\'t\nTrailing prose.',
  'root = Stack([TextContent("UI content")]) # don\'t\nTrailing prose.',
];

for (const [index, source] of fixtures.entries()) {
  test(`framing fixture ${index} preserves every source prefix`, () => {
    for (let length = 0; length <= source.length; length++) {
      const prefix = source.slice(0, length);
      const segments = assistantReplySegments(prefix, true);
      assert.equal(segments.map((segment) => segment.source).join(""), prefix);
      let offset = 0;
      for (const segment of segments) {
        assert.equal(segment.start, offset);
        assert.equal(segment.source, prefix.slice(segment.start, segment.end));
        offset = segment.end;
      }
    }
    assert.deepEqual(assistantReplySegments(source, false), assistantReplySegments(source));
  });
}

test("scalar suffix prose is never swallowed by a successful UI parse", () => {
  for (const value of ['"Hello" trailing prose', "42 trailing prose", "1 + 2 trailing prose"]) {
    const source = `title = ${value}\nroot = Stack([TextContent(title)])`;
    const segments = assistantReplySegments(source);
    assert.deepEqual(
      segments.map((segment) => segment.kind),
      ["text"],
    );
    assert.equal(segments[0]?.source, source);
  }
  for (const source of [
    'title = "Hello"\nroot = Stack([TextContent(title)])',
    "title = 42\nroot = Stack([TextContent(title)])",
    'root = panel\nlabel = "Hello"\npanel = Stack([TextContent(label)])',
  ]) {
    assert.deepEqual(
      assistantReplySegments(source).map((segment) => segment.kind),
      ["openui"],
    );
  }
});

test("forward definitions stay in one UI block across blank lines", () => {
  const segments = assistantReplySegments(fixtures[2]!);
  assert.deepEqual(
    segments.map((segment) => segment.kind),
    ["openui"],
  );
  assert.equal(segments[0]?.source, fixtures[2]);
});

test("code examples and ambiguous or unresolved islands remain visible text", () => {
  for (const index of [3, 4, 7, 8, 9, 10, 11, 12, 13, 18, 20, 21]) {
    assert.equal(
      assistantReplySegments(fixtures[index]!).every((segment) => segment.kind === "text"),
      true,
      String(index),
    );
  }
  for (const index of [5, 6, 15, 16, 17, 19]) {
    assert.equal(
      assistantReplySegments(fixtures[index]!).some((segment) => segment.kind === "openui"),
      true,
      String(index),
    );
  }
  const unknown = assistantReplySegments(fixtures[19]!)[0];
  assert.equal(unknown?.kind, "openui");
  if (unknown?.kind === "openui") assert.deepEqual(unknown.errorNames, ["UnknownThing"]);
});

test("confirmed boundaries stay stable while the last UI block grows", () => {
  const initial = ui + "\nMiddle prose.\nroot = Stack([";
  const before = assistantReplySegments(initial, true);
  const after = assistantReplySegments(initial + 'TextContent("B")])', true);
  assert.deepEqual(after.slice(0, 2), before.slice(0, 2));
  assert.deepEqual(
    before.slice(0, 2).map((segment) => segment.kind),
    ["openui", "text"],
  );
});

test("forward-reference UI kind stays stable through every definition prefix", () => {
  for (const source of [
    'Status.\n\nroot = Stack([title, detail])\ntitle = TextContent("First")\ndetail = TextContent("Second")',
    'Status.\n\nroot = Stack([title])\n// don\'t interrupt\ntitle = TextContent("First")',
    'Status.\n\nroot = Stack([title])\n# don\'t interrupt\ntitle = TextContent("First")',
    'Status.\n\nroot = Stack([_title])\n_title = TextContent("First")',
    'Status.\n\nroot = Stack([TextContent($label)])\n$label = "Reactive"',
  ]) {
    for (let length = source.indexOf("[") + 1; length <= source.length; length++) {
      const prefix = source.slice(0, length);
      const segments = assistantReplySegments(prefix, true);
      assert.deepEqual(
        segments.map((segment) => segment.kind),
        ["text", "openui"],
        prefix,
      );
      assert.equal(segments[0]?.source, "Status.\n\n");
      assert.equal(segments.map((segment) => segment.source).join(""), prefix);
      const frame = segments[1];
      if (frame?.kind === "openui") assert.equal(frame.isStreaming, true);
    }
    const settled = assistantReplySegments(source + "\nTrailing prose.");
    assert.deepEqual(
      settled.map((segment) => segment.kind),
      ["text", "openui", "text"],
    );
    assert.equal(settled[2]?.source, "Trailing prose.");
  }
});

test("a Markdown heading before a bare UI assignment remains visible text", () => {
  const source = '# Current status\n\nroot = Stack([TextContent("Ready")])\nNext step.';
  for (const streaming of [false, true]) {
    const segments = assistantReplySegments(source, streaming);
    assert.deepEqual(
      segments.map((segment) => segment.kind),
      ["text", "openui", "text"],
    );
    assert.equal(segments[0]?.source, "# Current status\n\n");
    assert.equal(segments[1]?.source, 'root = Stack([TextContent("Ready")])\n');
    assert.equal(segments[2]?.source, "Next step.");
    assert.equal(segments.map((segment) => segment.source).join(""), source);
  }
  assert.equal(assistantReplySegments('root = Stack([TextContent("Ready")])')[0]?.kind, "openui");
});

test("an open streaming assignment stays visible without a premature failure warning", () => {
  const source = "root = Sta";
  assert.deepEqual(assistantReplySegments(source, true), [
    { kind: "text", start: 0, end: 10, source: "root = Sta" },
  ]);
  assert.deepEqual(assistantReplySegments(source), [
    {
      kind: "text",
      start: 0,
      end: 10,
      source: "root = Sta",
      warning: "無法完整解析 UI，原文已保留。",
    },
  ]);
  const invalid = 'root = Stack([TextContent("Ready")])]';
  const segments = assistantReplySegments(invalid, true);
  assert.equal(segments[0]?.kind, "text");
  assert.equal(segments[0]?.source, invalid);
  if (segments[0]?.kind === "text") {
    assert.equal(segments[0].warning, "無法完整解析 UI，原文已保留。");
  }
});

for (const marker of ["//", "#"]) {
  test(`leading ${marker} comments stay text while frame comments support forward definitions`, () => {
    const heading = `${marker} heading\n`;
    const response = `root = Stack([title])\n  ${marker} don't open a quote\ntitle = TextContent("UI content")`;
    for (const streaming of [false, true]) {
      const segments = assistantReplySegments(heading + response, streaming);
      assert.deepEqual(
        segments.map((segment) => segment.kind),
        ["text", "openui"],
      );
      assert.equal(segments[0]?.source, heading);
      assert.equal(segments[1]?.source, response);
    }
  });

  test(`${marker} comment apostrophes leave trailing prose visible`, () => {
    for (const response of [
      `root = Stack([TextContent("UI content")]) ${marker} don't`,
      `title = "UI content" ${marker} don't\nroot = Stack([TextContent(title)])`,
      `title = 'UI content' ${marker} don't\nroot = Stack([TextContent(title)])`,
      `root = Stack([\n${marker} don't leave ([{ open\nTextContent("UI content")\n])`,
    ]) {
      const source = response + "\nTrailing prose stays visible.";
      for (const streaming of [false, true]) {
        const segments = assistantReplySegments(source, streaming);
        assert.deepEqual(
          segments.map((segment) => segment.kind),
          ["openui", "text"],
          source,
        );
        assert.equal(segments[0]?.source, response + "\n");
        assert.equal(segments[1]?.source, "Trailing prose stays visible.");
        assert.equal(segments.map((segment) => segment.source).join(""), source);
      }
    }
  });
}

test("a terminated identifier line cannot hide settled or streaming prose", () => {
  const source = 'root = Stack([TextContent("UI content")])\nAfter\n';
  for (const streaming of [false, true]) {
    const segments = assistantReplySegments(source, streaming);
    assert.deepEqual(
      segments.map((segment) => segment.kind),
      ["openui", "text"],
    );
    assert.equal(segments[1]?.source, "After\n");
  }
  const unresolved = "root = Stack([title])\ntitle";
  const segments = assistantReplySegments(unresolved);
  assert.deepEqual(
    segments.map((segment) => segment.kind),
    ["text", "text"],
  );
  assert.equal(segments.map((segment) => segment.source).join(""), unresolved);
});

test("explicit UI fences respect comment syntax without activating ordinary code fences", () => {
  for (const marker of ["//", "#"]) {
    const response = `${marker} heading\nroot = Stack([title]) ${marker} don't\n${marker} don't leave ([{ open\ntitle = TextContent("UI content")`;
    const source = "```openui-lang\n" + response + "\n```\nTrailing prose.";
    const segments = assistantReplySegments(source);
    assert.deepEqual(
      segments.map((segment) => segment.kind),
      ["openui", "text"],
    );
    assert.equal(segments[0]?.source, "```openui-lang\n" + response + "\n```\n");
    assert.equal(segments[1]?.source, "Trailing prose.");
    const example = source.replace("openui-lang", "js");
    assert.deepEqual(
      assistantReplySegments(example).map((segment) => segment.kind),
      ["text"],
    );
    assert.equal(assistantReplySegments(example)[0]?.source, example);
  }
});

test("comment markers inside strings remain UI content", () => {
  const source = 'root = Stack([TextContent("https://example.test/#don\'t")])\nAfter prose.';
  const segments = assistantReplySegments(source);
  assert.deepEqual(
    segments.map((segment) => segment.kind),
    ["openui", "text"],
  );
  assert.equal(segments[0]?.source, source.slice(0, source.indexOf("\n") + 1));
  assert.equal(segments[1]?.source, "After prose.");
});

test("the stored apostrophe regression renders its forward definitions", () => {
  const source = fixtures[0]!;
  const segments = assistantReplySegments(source);
  assert.equal(segments[0]?.kind, "text");
  assert.equal(segments[1]?.kind, "openui");
  assert.equal(segments.map((segment) => segment.source).join(""), source);
});
