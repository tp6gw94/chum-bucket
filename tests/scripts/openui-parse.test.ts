import assert from "node:assert/strict";
import test from "node:test";
import { parseAssistantReply } from "../../src/components/message-list";

const valid =
  'root = Stack([\n  Card([\n    CardHeader("報告", "摘要"),\n    TextContent("內容")\n  ])\n])';

const cases: [name: string, text: string, hasRoot: boolean][] = [
  ["OpenUI Lang reply", valid, true],
  ["non-OpenUI prose", "這是一段普通文字，不是 OpenUI Lang。", false],
  ["truncated before root", "root = Stack", false],
  ["empty reply", "", false],
];

for (const [name, text, hasRoot] of cases) {
  test(`assistant reply parsing: ${name}`, () => {
    const result = parseAssistantReply(text);
    assert.equal(result.root !== null, hasRoot);

    if (result.root !== null) {
      assert.deepEqual(result.meta.errors, []);
    }
  });
}

test("assistant reply parsing reports unknown components", () => {
  const result = parseAssistantReply('root = Stack([UnknownThing("x")])');
  assert.notEqual(result.root, null);
  assert.ok(result.meta.errors.length > 0);
});
