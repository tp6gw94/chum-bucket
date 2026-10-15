import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TestView } from "../../../shared/testing";
import { MessageList } from "../../../src/components/message-list";
import { TestingPanel } from "../../../src/components/testing-panel";
import type { ChatMessage } from "../../../src/components/types";

const running: TestView = {
  operationId: "testing-0123456789abcdef0123456789abcdef",
  threadId: "11111111-1111-4111-8111-111111111111",
  requestKey: "call-1",
  version: 4,
  role: "planner",
  summary: "Plan checkout tests",
  state: "running",
  cancelRequested: false,
  outcome: null,
  task: {
    status: "running",
    reasonCode: null,
    issues: [],
    activity: { kind: "model", name: null },
    modelSteps: 2,
    toolCalls: 0,
  },
  artifact: null,
};

const ignore = () => undefined;

test("running tasks show progress and a cancel button", () => {
  const html = renderToStaticMarkup(<TestingPanel view={running} onUpdate={ignore} />);

  assert.match(html, /測試計畫（planner）/);
  assert.match(html, /執行中/);
  assert.match(html, /模型思考中/);
  assert.match(html, /模型 2 回合 · 工具 0 次/);
  assert.match(html, /取消/);
  assert.match(html, /animate-spin/);
});

test("finished tasks show their artifact or failure", () => {
  const ready = renderToStaticMarkup(
    <TestingPanel
      view={{
        ...running,
        state: "finished",
        outcome: "satisfied",
        task: { ...running.task!, status: "ready", activity: null },
        artifact: {
          ref: "art-123",
          kind: "plan",
          payload: { criteria: [1, 2], cases: [1], unresolved: [] },
        },
      }}
      onUpdate={ignore}
    />,
  );

  assert.match(ready, /已完成/);
  assert.match(ready, /art-123/);
  assert.match(ready, /2 條驗收條件、1 個測試案例/);
  assert.doesNotMatch(ready, /animate-spin|<button/);

  const failed = renderToStaticMarkup(
    <TestingPanel
      view={{
        ...running,
        state: "finished",
        outcome: "failed",
        task: {
          ...running.task!,
          status: "failed",
          reasonCode: "proposal_rejected",
          issues: ["cases: empty"],
        },
      }}
      onUpdate={ignore}
    />,
  );

  assert.match(failed, /失敗/);
  assert.match(failed, /proposal_rejected/);
  assert.match(failed, /cases: empty/);
});

test("delegate_task calls render their testing panel", () => {
  const messages: ChatMessage[] = [
    {
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: "call-1",
          name: "delegate_task",
          arguments: "{}",
          state: "input-complete",
        },
        {
          type: "tool-call",
          id: "call-2",
          name: "read",
          arguments: "{}",
          state: "input-complete",
        },
      ],
    },
  ] as ChatMessage[];
  const html = renderToStaticMarkup(
    <MessageList
      messages={messages}
      agent="main"
      testing={{ "call-1": running, "call-2": { ...running, role: "ui", requestKey: "call-2" } }}
      onTestingUpdate={ignore}
    />,
  );

  assert.match(html, /測試計畫（planner）/);
  assert.doesNotMatch(html, /樣式驗證（ui）/);
  assert.doesNotMatch(
    renderToStaticMarkup(<MessageList messages={messages} agent="main" />),
    /測試計畫（planner）/,
  );
});
