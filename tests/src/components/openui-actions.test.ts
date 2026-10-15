import assert from "node:assert/strict";
import { test } from "node:test";
import { BuiltinActionType, type ActionEvent } from "@openuidev/react-lang";
import { actionMessage, runAction } from "../../../src/components/openui-actions";

function event(overrides: Partial<ActionEvent>): ActionEvent {
  return {
    type: BuiltinActionType.ContinueConversation,
    params: {},
    humanFriendlyMessage: "提交",
    ...overrides,
  };
}

function capture(send = true) {
  const calls = { open: [] as string[], send: [] as string[] };
  const handlers = {
    open: (url: string) => calls.open.push(url),
    send: send ? (text: string) => calls.send.push(text) : undefined,
  };

  return { calls, handlers };
}

test("continue_conversation becomes a message with the form state attached", () => {
  assert.equal(actionMessage(event({})), "提交");
  assert.equal(
    actionMessage(event({ formState: { profile: { name: { value: "小明" } } } })),
    '提交\n\n```json\n{\n  "profile": {\n    "name": {\n      "value": "小明"\n    }\n  }\n}\n```',
  );
  assert.equal(actionMessage(event({ humanFriendlyMessage: "  " })), null);
  assert.equal(actionMessage(event({ type: BuiltinActionType.OpenUrl })), null);
});

test("runAction sends conversation actions and opens URLs", () => {
  const { calls, handlers } = capture();

  runAction(event({ humanFriendlyMessage: "幫我畫圖表" }), handlers);
  runAction(
    event({ type: BuiltinActionType.OpenUrl, params: { url: "https://example.com" } }),
    handlers,
  );
  runAction(event({ type: BuiltinActionType.OpenUrl, params: {} }), handlers);

  assert.deepEqual(calls.send, ["幫我畫圖表"]);
  assert.deepEqual(calls.open, ["https://example.com"]);
});

test("runAction does nothing when sending is unavailable", () => {
  const { calls, handlers } = capture(false);

  runAction(event({}), handlers);

  assert.deepEqual(calls, { open: [], send: [] });
});
