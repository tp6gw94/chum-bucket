import { parseAssistantReply, splitAssistantReply } from "../src/components/message-list";

const valid =
  'root = Stack([\n  Card([\n    CardHeader("報告", "摘要"),\n    TextContent("內容")\n  ])\n])';

const cases: [name: string, text: string, hasRoot: boolean][] = [
  ["OpenUI Lang reply", valid, true],
  ["non-OpenUI prose", "這是一段普通文字，不是 OpenUI Lang。", false],
  ["truncated before root", "root = Stack", false],
  ["empty reply", "", false],
];

for (const [name, text, hasRoot] of cases) {
  const result = parseAssistantReply(text);

  if ((result.root !== null) !== hasRoot) {
    throw new Error(`${name}: hasRoot=${result.root !== null}, expected ${hasRoot}`);
  }
}

for (const [name, text] of cases) {
  const result = parseAssistantReply(text);

  if (result.root !== null && result.meta.errors.length > 0) {
    throw new Error(`${name}: settled reply carried parse errors`);
  }
}

const unknown = parseAssistantReply('root = Stack([UnknownThing("x")])');

if (unknown.root === null || unknown.meta.errors.length === 0) {
  throw new Error("unknown component did not report a parse error");
}

const prefixed = splitAssistantReply(`讀到了！整理成介面：\n\n${valid}`);

if (prefixed.prose !== "讀到了！整理成介面：" || prefixed.code !== valid) {
  throw new Error("prose before OpenUI Lang was not split off");
}

if (splitAssistantReply("這是一段普通文字。").code !== null) {
  throw new Error("plain prose was treated as OpenUI Lang");
}

console.log("openui settled parse OK");
