import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMessage } from "../../../src/components/types";
import { testRunIdSchema, type TestView } from "../../../shared/testing";
import { testingTimeline } from "../../../src/lib/testing-timeline";

function message(id: string, calls: string[], name = "delegate_task"): ChatMessage {
  return {
    id,
    role: "assistant",
    parts: calls.map((callId) => ({
      type: "tool-call",
      id: callId,
      name,
      arguments: "{}",
      state: "input-complete",
    })),
  } as ChatMessage;
}

function view(
  id: string,
  messageId: string | null,
  callId = "call",
  state: TestView["state"] = "active",
): TestView {
  return {
    runId: testRunIdSchema.parse(id),
    state,
    report: null,
    reuse: [],
    availableArtifacts: [],
    progress: {
      version: 1,
      rows: {
        atlassian: { status: "waiting", reason: "dependency" },
        planner: { status: "running", activity: "model" },
        ac: { status: "waiting", reason: "dependency" },
        ui: { status: "not_required", reason: "no_style_checks" },
      },
    },
    task: {
      version: 2,
      role: "planner",
      summary: id,
      result: null,
      origin:
        messageId === null
          ? null
          : { parentRunId: `parent-${messageId}`, parentMessageId: messageId, requestKey: callId },
    },
  };
}

function keys(
  messages: ChatMessage[],
  views: TestView[],
  streaming = false,
  activeRunId: string | null = null,
) {
  return testingTimeline(messages, views, streaming, activeRunId).map((row) =>
    row.kind === "message" ? row.message.id : row.view.runId,
  );
}

test("cards follow their own turns and tool-part order rather than publication order", () => {
  assert.deepEqual(
    keys(
      [message("a", ["second", "first"]), message("b", ["call"])],
      [
        view("first-task", "a", "first"),
        view("later-task", "b"),
        view("second-task", "a", "second"),
      ],
    ),
    ["a", "second-task", "first-task", "b", "later-task"],
  );
});

test("duplicate views, messages and parts place each operation only once", () => {
  const task = view("task", "a");
  assert.deepEqual(keys([message("a", ["call", "call"]), message("a", ["call"])], [task, task]), [
    "a",
    "task",
    "a",
  ]);
});

test("only assistant delegate parts own a card", () => {
  assert.deepEqual(keys([message("a", ["call"], "read")], [view("task", "a")]), ["a", "task"]);
  assert.deepEqual(keys([{ ...message("a", ["call"]), role: "user" }], [view("task", "a")]), [
    "a",
    "task",
  ]);
  assert.deepEqual(keys([message("a", ["other"]), message("b", ["call"])], [view("task", "a")]), [
    "a",
    "b",
    "task",
  ]);
});

test("streaming defers known active origins but never terminal or legacy views", () => {
  assert.deepEqual(
    keys(
      [],
      [view("pending", "a"), view("terminal", "missing", "call", "finished"), view("legacy", null)],
      true,
      "parent-a",
    ),
    ["terminal", "legacy"],
  );
  assert.deepEqual(keys([], [view("pending", "a")]), ["pending"]);
  assert.deepEqual(keys([message("a", ["call"])], [view("pending", "a")], true, "parent-a"), [
    "a",
    "pending",
  ]);
});

test("a missing part waits only for its own streaming parent and stays visible for another or unknown run", () => {
  const messages = [message("a", ["other"])];
  const views = [view("pending", "a")];
  assert.deepEqual(keys(messages, views, true, "parent-a"), ["a"]);
  assert.deepEqual(keys(messages, views, true, "parent-b"), ["a", "pending"]);
  assert.deepEqual(keys(messages, views, true, null), ["a", "pending"]);
  assert.deepEqual(keys(messages, [view("terminal", "a", "call", "finished")], true, "parent-a"), [
    "a",
    "terminal",
  ]);
});
