import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdapterYieldChunk, UIMessage } from "@tanstack/ai";
import type { AgentChatStream } from "../../../server/harness/agent-loop";
import {
  estimateInputTokens,
  planCompaction,
  prepareCompaction,
  publishCompaction,
  readCompactionPolicy,
  summaryMessage,
  type CompactionOutcome,
  type CompactionPolicy,
} from "../../../server/harness/compaction";
import { compactionSystemPrompt } from "../../../server/harness/prompts";
import type { RunTools } from "../../../server/harness/tools";
import type { ModelTool } from "../../../server/harness/tools/atlassian";

const base = { model: "offline", timestamp: 0 };

const user = (id: string, text: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", content: text }],
});
const assistant = (id: string, text: string): UIMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "text", content: text }],
});
const toolAssistant = (id: string, callId: string, result: string, state = "complete"): UIMessage =>
  ({
    id,
    role: "assistant",
    parts: [
      { type: "tool-call", id: callId, name: "read", arguments: "{}", state },
      { type: "tool-result", toolCallId: callId, content: result, state: "complete" },
    ],
  }) as UIMessage;

const policy: CompactionPolicy = { triggerTokens: 1_000, keepRecentTokens: 200 };
const long = (label: string) => `${label} ${"x".repeat(900)}`;

function textReply(text: string, finishReason = "stop"): AdapterYieldChunk[] {
  return [
    { ...base, type: "RUN_STARTED", runId: "summary", threadId: "summary" },
    { ...base, type: "TEXT_MESSAGE_START", messageId: "s", role: "assistant" },
    { ...base, type: "TEXT_MESSAGE_CONTENT", messageId: "s", delta: text },
    { ...base, type: "TEXT_MESSAGE_END", messageId: "s" },
    { ...base, type: "RUN_FINISHED", runId: "summary", threadId: "summary", finishReason },
  ] as AdapterYieldChunk[];
}

function toolReply(): AdapterYieldChunk[] {
  return [
    { ...base, type: "RUN_STARTED", runId: "summary", threadId: "summary" },
    { ...base, type: "TOOL_CALL_START", toolCallId: "t", toolCallName: "read", toolName: "read" },
    { ...base, type: "TOOL_CALL_ARGS", toolCallId: "t", delta: "{}" },
    {
      ...base,
      type: "TOOL_CALL_END",
      toolCallId: "t",
      toolCallName: "read",
      toolName: "read",
      input: {},
    },
    {
      ...base,
      type: "RUN_FINISHED",
      runId: "summary",
      threadId: "summary",
      finishReason: "tool_calls",
    },
  ] as AdapterYieldChunk[];
}

function fakeModel(replies: AdapterYieldChunk[][]) {
  const requests: Parameters<AgentChatStream>[0][] = [];
  const chatStream: AgentChatStream = async (options) => {
    requests.push(options);
    const events = replies[requests.length - 1] ?? textReply("summary");

    return (async function* () {
      yield* events;
    })();
  };

  return { requests, chatStream };
}

function tools(definitions: ModelTool[] = []): RunTools {
  return {
    getModelTools: async () => ({ definitions, systemPrompt: "code mode" }),
    executeTool: async () => {
      throw new Error("No tools in compaction tests");
    },
  };
}

function prepare(
  messages: UIMessage[],
  replies: AdapterYieldChunk[][],
  overrides: Partial<Parameters<typeof prepareCompaction>[0]> = {},
) {
  const model = fakeModel(replies);
  const started: string[] = [];
  const outcome = prepareCompaction({
    runId: "run",
    operationId: "run/compact/0",
    reason: "threshold",
    messages,
    prompt: "base prompt",
    policy,
    tools: tools(),
    summary: { chatStream: model.chatStream, model: "offline" },
    started: async () => {
      started.push("started");
    },
    ...overrides,
  });

  return { outcome, model, started };
}

const history = [
  user("u1", long("first question")),
  assistant("a1", long("first answer")),
  user("u2", long("second question")),
  assistant("a2", long("second answer")),
  user("u3", "third question"),
  assistant("a3", "third answer"),
];

test("the policy reads positive integers from the environment and rejects bad values", () => {
  assert.deepEqual(readCompactionPolicy({}), { triggerTokens: 48_000, keepRecentTokens: 20_000 });
  assert.deepEqual(
    readCompactionPolicy({ COMPACT_TRIGGER_TOKENS: "9000", COMPACT_KEEP_RECENT_TOKENS: "4000" }),
    { triggerTokens: 9_000, keepRecentTokens: 4_000 },
  );

  for (const env of [
    { COMPACT_TRIGGER_TOKENS: "0" },
    { COMPACT_TRIGGER_TOKENS: "-1" },
    { COMPACT_TRIGGER_TOKENS: "1.5" },
    { COMPACT_KEEP_RECENT_TOKENS: "abc" },
    { COMPACT_TRIGGER_TOKENS: "1000", COMPACT_KEEP_RECENT_TOKENS: "1000" },
  ]) {
    assert.throws(() => readCompactionPolicy(env), /COMPACT_/);
  }
});

test("the estimate grows with message text and tool definitions", () => {
  const small = estimateInputTokens({
    messages: [user("u", "hi")],
    systemPrompts: [],
    definitions: [],
  });
  const longer = estimateInputTokens({
    messages: [user("u", "hi".repeat(1_000))],
    systemPrompts: [],
    definitions: [],
  });
  const withTools = estimateInputTokens({
    messages: [user("u", "hi")],
    systemPrompts: [],
    definitions: [{ name: "big", description: "d".repeat(3_000), inputSchema: { type: "object" } }],
  });
  assert.ok(small >= 2_048);
  assert.ok(longer > small);
  assert.ok(withTools > small);
});

test("planning keeps whole question-and-answer groups and never cuts a single exchange", () => {
  assert.equal(planCompaction([user("u", "q"), assistant("a", "a")], policy), null);

  const plan = planCompaction(history, policy)!;
  assert.deepEqual(
    plan.transcript.map((message) => message.id),
    ["u1", "a1", "u2", "a2"],
  );
  assert.deepEqual(
    plan.tail.map((message) => message.id),
    ["u3", "a3"],
  );
  assert.equal(plan.previousSummary, null);

  const wider = planCompaction(history, { triggerTokens: 5_000, keepRecentTokens: 4_000 })!;
  assert.deepEqual(
    wider.tail.map((message) => message.id),
    ["u2", "a2", "u3", "a3"],
  );
  assert.ok(wider.tail.every((message) => history.includes(message)));
});

test("planning never splits a tool call from its result and rejects broken tool history", () => {
  const split: UIMessage[] = [
    user("u1", long("q1")),
    {
      id: "call",
      role: "assistant",
      parts: [{ type: "tool-call", id: "c1", name: "read", arguments: "{}", state: "complete" }],
    } as UIMessage,
    user("u2", "interjection"),
    {
      id: "result",
      role: "assistant",
      parts: [{ type: "tool-result", toolCallId: "c1", content: "ok", state: "complete" }],
    } as UIMessage,
    user("u3", "last"),
  ];
  const plan = planCompaction(split, policy)!;
  assert.deepEqual(
    plan.tail.map((message) => message.id),
    ["u3"],
  );

  assert.equal(
    planCompaction(
      [user("u1", long("q")), toolAssistant("a1", "c1", "r", "input-complete"), user("u2", "q")],
      policy,
    ),
    null,
  );
  assert.equal(
    planCompaction(
      [
        user("u1", long("q")),
        toolAssistant("a1", "c1", "r"),
        toolAssistant("a2", "c1", "r"),
        user("u2", "q"),
      ],
      policy,
    ),
    null,
  );
});

test("a single question followed by a long tool loop is cut at an assistant message", () => {
  const loop = [
    user("u1", "investigate"),
    toolAssistant("a1", "c1", long("result one")),
    toolAssistant("a2", "c2", long("result two")),
    toolAssistant("a3", "c3", "short"),
    assistant("a4", "wrapping up"),
  ];
  const plan = planCompaction(loop, policy)!;
  assert.equal(plan.tail[0]!.role, "assistant");
  assert.deepEqual(
    plan.tail.map((message) => message.id),
    ["a3", "a4"],
  );
});

test("an earlier summary is carried forward and a misplaced summary blocks planning", () => {
  const summary = summaryMessage("run/compact/0", "Earlier goal and decisions");
  const plan = planCompaction([summary, ...history], policy)!;
  assert.equal(plan.previousSummary, "Earlier goal and decisions");
  assert.ok(plan.transcript.every((message) => message.id !== summary.id));
  assert.equal(planCompaction([history[0]!, summary, ...history.slice(1)], policy), null);
});

test("below the threshold nothing is summarized", async () => {
  const { outcome, model, started } = prepare([user("u", "hi"), assistant("a", "hello")], []);
  assert.deepEqual(await outcome, { state: "skipped" });
  assert.deepEqual(model.requests, []);
  assert.deepEqual(started, []);
});

test("above the threshold the context becomes summary plus tail and shrinks", async () => {
  const { outcome, model, started } = prepare(history, [textReply("Goal: compare answers")]);
  const result = (await outcome) as Extract<CompactionOutcome, { state: "done" }>;
  assert.equal(result.state, "done");
  assert.deepEqual(started, ["started"]);
  assert.equal(result.messages[0]!.metadata?.fromSummary, true);
  assert.match(JSON.stringify(result.messages[0]), /Goal: compare answers/);
  assert.deepEqual(
    result.messages.slice(1).map((message) => message.id),
    ["u3", "a3"],
  );
  assert.ok(result.after < result.before);
  assert.deepEqual(model.requests[0]!.tools, []);
  assert.deepEqual(model.requests[0]!.systemPrompts, [compactionSystemPrompt]);
  assert.deepEqual(model.requests[0]!.modelOptions, { max_tokens: 2_000 });

  const again = prepare(
    [
      result.messages[0]!,
      ...history.slice(0, 4).map((message) => ({ ...message, id: `${message.id}-2` })),
      ...result.messages.slice(1),
    ],
    [textReply("Merged")],
  );
  assert.equal((await again.outcome).state, "done");
  const payload = JSON.parse(String(again.model.requests[0]!.messages[0]!.content)) as {
    previousSummary: string;
  };
  assert.equal(payload.previousSummary, "Goal: compare answers");
  assert.deepEqual(again.model.requests[0]!.tools, []);
});

test("bad summaries fail the compaction and keep the original messages", async () => {
  for (const reply of [
    textReply("cut off", "length"),
    toolReply(),
    textReply("   "),
    textReply("y".repeat(8_001)),
    textReply("unsafe\nS1"),
    textReply("safe"),
  ]) {
    const { outcome } = prepare(history, [reply]);
    const result = await outcome;
    assert.equal(result.state, "failed");
    assert.ok(!("messages" in result));
  }
});

test("a summary that does not shrink the request fails", async () => {
  const bulky = tools([
    { name: "bulky", description: "d".repeat(9_000), inputSchema: { type: "object" } },
  ]);
  const { outcome } = prepare(
    [user("u1", "a"), assistant("a1", "b"), user("u2", "c"), assistant("a2", "d")],
    [textReply("A much longer summary than the tiny transcript it replaces. ".repeat(20))],
    { tools: bulky, policy: { triggerTokens: 100, keepRecentTokens: 50 } },
  );
  assert.deepEqual(await outcome, {
    state: "failed",
    error: "Summary did not reduce the context",
  });
});

test("storage failures propagate instead of becoming failed compactions", async () => {
  const { outcome } = prepare(history, [textReply("ok")], {
    started: async () => {
      throw new Error("database unavailable");
    },
  });
  await assert.rejects(outcome, /database unavailable/);

  const conversation = { display: history, context: history };
  await assert.rejects(
    publishCompaction({
      runId: "run",
      operationId: "run/compact/0",
      reason: "threshold",
      outcome: { state: "failed", error: "x" },
      conversation,
      checkpoint: async () => {
        throw new Error("write failed");
      },
    }),
    /write failed/,
  );
});

test("cancellation is rethrown rather than reported as a failed summary", async () => {
  const controller = new AbortController();
  controller.abort();
  const { outcome } = prepare(history, [], {
    summary: {
      chatStream: async () => {
        throw new Error("aborted");
      },
      model: "offline",
      signal: controller.signal,
    },
  });
  await assert.rejects(outcome, /aborted/);
});

test("publishing appends the summary to display and swaps the context only when done", async () => {
  const saved: string[] = [];
  const conversation = { display: history, context: history };
  const summary = summaryMessage("op", "Summary");
  const done = await publishCompaction({
    runId: "run",
    operationId: "op",
    reason: "manual",
    outcome: {
      state: "done",
      summary,
      messages: [summary, ...history.slice(4)],
      before: 10,
      after: 5,
    },
    conversation,
    checkpoint: async (_runId, operationId, _conversation, state, reason) => {
      saved.push(`${operationId}:${state}:${reason}`);
    },
  });
  assert.deepEqual(
    done.display.map((message) => message.id),
    [...history.map((message) => message.id), summary.id],
  );
  assert.deepEqual(
    done.context.map((message) => message.id),
    [summary.id, "u3", "a3"],
  );

  const kept = await publishCompaction({
    runId: "run",
    operationId: "op2",
    reason: "manual",
    outcome: { state: "skipped" },
    conversation,
    checkpoint: async (_runId, operationId, _conversation, state) => {
      saved.push(`${operationId}:${state}`);
    },
  });
  assert.equal(kept, conversation);
  assert.deepEqual(saved, ["op:done:manual", "op2:skipped"]);
});
