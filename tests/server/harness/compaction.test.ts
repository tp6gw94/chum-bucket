import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdapterYieldChunk, StreamChunk, UIMessage } from "@tanstack/ai";
import type { AgentCheckpoint, AgentSession } from "../../../server/harness/agent-loop";
import {
  applyCompaction,
  compactor,
  estimateInputTokens,
  planCompaction,
  prepareCompaction,
  COMPACTION_POLICY,
  type CompactionOutcome,
  type CompactionPolicy,
} from "../../../server/harness/compaction";
import { isSummary, type ConversationState } from "../../../server/harness/conversation";
import { summaryPreamble } from "../../../server/harness/prompts";
import type { ModelTool } from "../../../server/harness/tools/atlassian";
import { parseCompactionEvent } from "../../../shared/compaction-event";

function text(id: string, role: "user" | "assistant", content: string): UIMessage {
  return { id, role, parts: [{ type: "text", content }] };
}

function toolCall(callId: string, state: "complete" | "error" | "input-complete" = "complete") {
  return {
    type: "tool-call" as const,
    id: callId,
    name: "read",
    arguments: "{}",
    state,
    input: {},
  };
}

function toolResult(callId: string, content = "{}") {
  return { type: "tool-result" as const, toolCallId: callId, content, state: "complete" as const };
}

function toolMessage(id: string, callId: string, content = "{}"): UIMessage {
  return { id, role: "assistant", parts: [toolCall(callId), toolResult(callId, content)] };
}

function summaryMessage(content: string): UIMessage {
  return {
    id: "summary:earlier",
    role: "user",
    parts: [{ type: "text", content: `${summaryPreamble}\n\n${content}` }],
    metadata: { fromSummary: true },
  };
}

const long = (size: number) => "x".repeat(size);
const policy: CompactionPolicy = { triggerTokens: 200, keepRecentTokens: 100 };

function summaryReply(content: string, finishReason = "stop"): AdapterYieldChunk[] {
  return [
    { type: "RUN_STARTED", runId: "summary", threadId: "summary" },
    { type: "TEXT_MESSAGE_START", messageId: "summary", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "summary", delta: content },
    { type: "TEXT_MESSAGE_END", messageId: "summary" },
    { type: "RUN_FINISHED", runId: "summary", threadId: "summary", finishReason },
  ] as AdapterYieldChunk[];
}

const toolCallReply = [
  { type: "RUN_STARTED", runId: "summary", threadId: "summary" },
  { type: "TOOL_CALL_START", toolCallId: "call", toolCallName: "read", toolName: "read" },
  { type: "TOOL_CALL_ARGS", toolCallId: "call", delta: "{}" },
  { type: "TOOL_CALL_END", toolCallId: "call", toolCallName: "read", toolName: "read", input: {} },
  { type: "RUN_FINISHED", runId: "summary", threadId: "summary", finishReason: "tool_calls" },
] as AdapterYieldChunk[];

type SummaryRequest = Parameters<AgentSession["chatStream"]>[0];

function fakeSession(replies: AdapterYieldChunk[][], definitions: ModelTool[] = []) {
  const requests: SummaryRequest[] = [];
  const emitted: StreamChunk[] = [];
  const session: AgentSession = {
    runId: "run",
    emit: async (_runId, event) => {
      emitted.push(event);
    },
    chatStream: async (options) => {
      requests.push(options);
      const events = replies.shift() ?? [];
      return (async function* () {
        yield* events;
      })();
    },
    tools: { getModelTools: async () => definitions, executeTool: async () => null },
  };
  return { session, requests, emitted };
}

const history: UIMessage[] = [
  text("u1", "user", long(600)),
  text("a1", "assistant", long(600)),
  text("u2", "user", "second"),
  text("a2", "assistant", "answer"),
];

function prepare(
  session: AgentSession,
  conversation: ConversationState,
  overrides: Partial<Parameters<typeof prepareCompaction>[0]> = {},
) {
  return prepareCompaction({
    session,
    operationId: "run/compact/0",
    reason: "threshold",
    conversation,
    policy,
    model: "offline",
    prompt: "prompt",
    ...overrides,
  });
}

test("the recent budget stays well below the trigger", () => {
  assert.ok(COMPACTION_POLICY.keepRecentTokens < COMPACTION_POLICY.triggerTokens / 2);
});

test("estimates grow with message text and tool definitions", () => {
  const base = { messages: [text("u", "user", "hi")], systemPrompts: ["prompt"], definitions: [] };
  const estimate = estimateInputTokens(base);
  const tool: ModelTool = { name: "read", description: long(300), inputSchema: { type: "object" } };

  assert.ok(estimate > 2_048);
  assert.ok(estimateInputTokens({ ...base, messages: [text("u", "user", long(300))] }) > estimate);
  assert.ok(estimateInputTokens({ ...base, definitions: [tool] }) > estimate);
});

test("a single question and answer is never split", () => {
  assert.equal(
    planCompaction([text("u", "user", "hi"), text("a", "assistant", "hello")], policy),
    null,
  );
});

test("the tail starts at the earliest user message that fits the recent budget", () => {
  const plan = planCompaction(history, policy);

  assert.deepEqual(plan?.transcript, history.slice(0, 2));
  assert.deepEqual(plan?.tail, history.slice(2));
  assert.equal(plan?.previousSummary, null);
});

test("a larger recent budget moves the split earlier without truncating messages", () => {
  const messages = [
    text("u1", "user", long(300)),
    text("a1", "assistant", long(300)),
    text("u2", "user", long(300)),
    text("a2", "assistant", "short"),
    text("u3", "user", "short"),
    text("a3", "assistant", "short"),
  ];
  const narrow = planCompaction(messages, { triggerTokens: 1_000, keepRecentTokens: 50 });
  const wide = planCompaction(messages, { triggerTokens: 1_000, keepRecentTokens: 300 });

  assert.equal(narrow?.tail[0]?.id, "u3");
  assert.equal(wide?.tail[0]?.id, "u2");
  assert.deepEqual([...wide!.transcript, ...wide!.tail], messages);
});

test("the split never separates a tool call from its result", () => {
  const messages: UIMessage[] = [
    text("u1", "user", "start"),
    {
      id: "call",
      role: "assistant",
      parts: [{ type: "text", content: long(900) }, toolCall("c1")],
    },
    { id: "result", role: "assistant", parts: [toolResult("c1")] },
    text("a2", "assistant", "short"),
  ];
  const plan = planCompaction(messages, policy);

  assert.equal(plan?.tail[0]?.id, "a2");
});

test("unfinished or duplicated tool calls are not compacted", () => {
  const unfinished: UIMessage = {
    id: "a1",
    role: "assistant",
    parts: [toolCall("c1", "input-complete"), toolResult("c1")],
  };
  const duplicated: UIMessage = {
    id: "a2",
    role: "assistant",
    parts: [toolCall("c1"), toolResult("c1")],
  };

  assert.equal(planCompaction([...history, unfinished], policy), null);
  assert.equal(planCompaction([...history, toolMessage("a1", "c1"), duplicated], policy), null);
  assert.equal(
    planCompaction([...history, { id: "r", role: "assistant", parts: [toolResult("c9")] }], policy),
    null,
  );
});

test("a long tool loop after one user message splits at an assistant message", () => {
  const messages = [
    text("u1", "user", "do the work"),
    toolMessage("a1", "c1", long(600)),
    toolMessage("a2", "c2", long(600)),
    text("a3", "assistant", "done"),
  ];
  const plan = planCompaction(messages, policy);

  assert.equal(plan?.tail[0]?.role, "assistant");
  assert.equal(plan?.tail[0]?.id, "a3");
});

test("an earlier summary becomes previousSummary and a misplaced one stops compaction", () => {
  const summary = summaryMessage("earlier summary");
  const plan = planCompaction([summary, ...history], policy);

  assert.equal(plan?.previousSummary, "earlier summary");
  assert.ok(!plan?.transcript.some(isSummary));
  assert.equal(planCompaction([history[0]!, summary, ...history.slice(1)], policy), null);
  assert.equal(planCompaction([{ ...summary, parts: [toolCall("c1")] }, ...history], policy), null);
});

test("below the trigger nothing is requested", async () => {
  const { session, requests } = fakeSession([]);
  const outcome = await prepare(
    session,
    { display: history, context: history },
    {
      policy: { triggerTokens: 100_000, keepRecentTokens: 100 },
    },
  );

  assert.deepEqual(outcome, { state: "skipped" });
  assert.equal(requests.length, 0);
});

test("above the trigger the context becomes a summary followed by the tail", async () => {
  const { session, requests, emitted } = fakeSession([summaryReply("first summary")]);
  const outcome = await prepare(session, { display: history, context: history });

  assert.equal(outcome.state, "done");
  assert.ok(outcome.state === "done");
  assert.ok(isSummary(outcome.context[0]!));
  assert.equal(outcome.context[0]!.id, "summary:run/compact/0");
  assert.deepEqual(outcome.context.slice(1), history.slice(2));
  assert.ok(outcome.after < outcome.before);
  assert.deepEqual(requests[0]!.tools, []);
  assert.deepEqual(requests[0]!.modelOptions, { max_tokens: 2_000 });
  assert.deepEqual(
    emitted.map(
      (event) => event.type === "CUSTOM" && parseCompactionEvent(event.name, event.value),
    ),
    [{ runId: "run", operationId: "run/compact/0", state: "started" }],
  );

  const compacted = applyCompaction({ display: history, context: history }, outcome);
  assert.deepEqual(compacted.display, [...history, outcome.summary]);

  const more = [
    ...compacted.context,
    text("u3", "user", long(600)),
    text("a3", "assistant", long(600)),
    text("u4", "user", "fourth"),
  ];
  const second = fakeSession([summaryReply("second summary")]);
  const again = await prepare(second.session, { display: compacted.display, context: more });
  const request = JSON.parse(String(second.requests[0]!.messages[0]!.content)) as {
    previousSummary: string;
    transcript: unknown[];
  };

  assert.equal(again.state, "done");
  assert.equal(request.previousSummary, "first summary");
  assert.ok(!JSON.stringify(request.transcript).includes(summaryPreamble));
  assert.deepEqual(second.requests[0]!.tools, []);
});

test("unusable summaries fail and leave the conversation untouched", async () => {
  const conversation = { display: history, context: history };
  const before = structuredClone(conversation);

  for (const reply of [
    summaryReply("cut off", "length"),
    toolCallReply,
    summaryReply("   "),
    summaryReply(long(8_001)),
    summaryReply("unsafe\nS1"),
  ]) {
    const { session } = fakeSession([reply]);
    const outcome = await prepare(session, conversation);

    assert.equal(outcome.state, "failed");
    assert.deepEqual(applyCompaction(conversation, outcome), before);
  }
});

test("a summary that does not shrink the context fails", async () => {
  const short = [text("u1", "user", "a"), text("a1", "assistant", "b"), text("u2", "user", "c")];
  const { session } = fakeSession([summaryReply(long(7_000))]);
  const outcome = await prepare(
    session,
    { display: short, context: short },
    { policy: { triggerTokens: 10, keepRecentTokens: 5 } },
  );

  assert.equal(outcome.state, "failed");
});

test("storage failures and cancellation propagate instead of failing the compaction", async () => {
  const storage = fakeSession([summaryReply("summary")]);
  const broken: AgentSession = {
    ...storage.session,
    emit: async () => {
      throw new Error("database unavailable");
    },
  };

  await assert.rejects(prepare(broken, { display: history, context: history }), /database/);

  const controller = new AbortController();
  controller.abort();
  const aborted: AgentSession = {
    ...storage.session,
    chatStream: async () => {
      throw new DOMException("aborted", "AbortError");
    },
  };

  await assert.rejects(
    prepare(aborted, { display: history, context: history }, { signal: controller.signal }),
    /aborted/,
  );
});

test("threshold skips write nothing while manual and overflow outcomes are published", async () => {
  const names: string[] = [];
  const checkpoint: AgentCheckpoint = async ({ name, work }) => {
    names.push(name);
    return work();
  };
  const published: CompactionOutcome["state"][] = [];
  const { session } = fakeSession([]);
  const compact = compactor({
    session,
    model: "offline",
    prompt: "prompt",
    policy: { triggerTokens: 100_000, keepRecentTokens: 100 },
    checkpoint,
    publish: async ({ outcome, conversation }) => {
      published.push(outcome.state);
      return conversation;
    },
  });
  const conversation = { display: [text("u", "user", "hi")], context: [text("u", "user", "hi")] };

  assert.equal((await compact({ conversation, reason: "threshold", turn: 2 })).state, "skipped");
  assert.equal((await compact({ conversation, reason: "manual", turn: 0 })).state, "skipped");
  assert.equal((await compact({ conversation, reason: "overflow", turn: 1 })).state, "skipped");
  assert.deepEqual(names, [
    "compact:2",
    "compact:0",
    "publish-compact:0",
    "compact-overflow:1",
    "publish-compact-overflow:1",
  ]);
  assert.deepEqual(published, ["skipped", "skipped"]);
});
