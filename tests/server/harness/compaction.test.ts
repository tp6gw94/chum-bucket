import assert from "node:assert/strict";
import { test, mock } from "node:test";
import {
  EventType,
  convertMessagesToModelMessages,
  type AdapterYieldChunk,
  type StreamChunk,
  type UIMessage,
} from "@tanstack/ai";
import { parseCompactionEvent } from "../../../shared/compaction-event";
import {
  COMPACT_TOKEN_THRESHOLD,
  estimateInputTokens,
  planCompaction,
  prepareCompaction,
  type CompactionEmit,
} from "../../../server/harness/compaction";
import { MODEL } from "../../../server/harness/run-store";
import type { ModelTool } from "../../../server/harness/tools/atlassian";
import type { RunTools } from "../../../server/harness/tools";

process.env.MODEL_API_KEY = "offline";

function text(id: string, role: UIMessage["role"], content: string): UIMessage {
  return { id, role, parts: [{ type: "text", content }] };
}

function fakeTools(definitions: ModelTool[] = [], systemPrompt = "tool-system"): RunTools {
  return {
    getModelTools: async () => ({ definitions, systemPrompt }),
    executeTool: async () => ({}),
  };
}

function capture() {
  const emitted: StreamChunk[] = [];
  const emittedMessages: (UIMessage[] | undefined)[] = [];

  const emit: CompactionEmit = async (event, messages) => {
    emitted.push(event);
    emittedMessages.push(messages);
  };

  return { emitted, emittedMessages, emit };
}

function summaryEvents(
  delta: string,
  finishReason?: "content_filter" | "length" | "stop" | "tool_calls" | null,
): AdapterYieldChunk[] {
  return [
    { type: EventType.RUN_STARTED, threadId: "provider", runId: "provider" },
    { type: EventType.TEXT_MESSAGE_START, messageId: "summary", role: "assistant" },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "summary", delta },
    { type: EventType.TEXT_MESSAGE_END, messageId: "summary" },
    {
      type: EventType.RUN_FINISHED,
      threadId: "provider",
      runId: "provider",
      ...(finishReason === undefined ? {} : { finishReason }),
    },
  ];
}

async function mockSummaryStream(events: AdapterYieldChunk[]) {
  const { deepinfra } = await import("../../../server/harness/provider");
  const adapter = deepinfra(MODEL);

  return mock.method(
    Object.getPrototypeOf(adapter),
    "chatStream",
    async function* (_request: Parameters<typeof adapter.chatStream>[0]) {
      yield* events;
    },
  );
}

function longMessages(): UIMessage[] {
  const filler = "字".repeat(COMPACT_TOKEN_THRESHOLD + 1_000);

  return [
    text("u1", "user", filler),
    text("a1", "assistant", filler),
    text("u2", "user", filler),
    text("a2", "assistant", filler),
    text("u3", "user", "目前的問題"),
  ];
}

test("compaction preserves a small single user span", () => {
  assert.equal(planCompaction([text("u1", "user", "一"), text("a1", "assistant", "回")]), null);
  const plan = planCompaction([
    text("u1", "user", "一"),
    text("a1", "assistant", "回"),
    text("u2", "user", "二"),
  ]);
  assert.deepEqual(
    plan?.tail.map((message) => message.id),
    ["u2"],
  );
});

test("compaction retains the earliest safe user boundary within budget", () => {
  const plan = planCompaction([
    text("u1", "user", "一"),
    text("a1", "assistant", "回一"),
    text("u2", "user", "二"),
    text("a2", "assistant", "回二"),
    text("u3", "user", "三"),
  ]);
  assert.ok(plan);
  assert.deepEqual(
    plan.transcript.map((message) => message.id),
    ["u1", "a1"],
  );
  assert.deepEqual(
    plan.tail.map((message) => message.id),
    ["u2", "a2", "u3"],
  );
});

test("a previous summary is extracted separately from the new transcript", () => {
  const summary: UIMessage = {
    id: "summary",
    role: "user",
    parts: [{ type: "text", content: "舊摘要" }],
    metadata: { fromSummary: true },
  };
  const plan = planCompaction([
    summary,
    text("u1", "user", "一"),
    text("a1", "assistant", "回"),
    text("u2", "user", "二"),
  ]);
  assert.equal(plan?.previousSummary, "舊摘要");
  assert.deepEqual(
    plan?.transcript.map((message) => message.id),
    ["u1", "a1"],
  );
});

test("a cut skips a split tool cycle and preserves the complete pair", () => {
  const call: UIMessage = {
    id: "a1",
    role: "assistant",
    parts: [{ type: "tool-call", id: "c1", name: "read", arguments: "{}", state: "complete" }],
  };
  const result: UIMessage = {
    id: "a2",
    role: "assistant",
    parts: [{ type: "tool-result", toolCallId: "c1", content: "{}", state: "complete" }],
  };
  const plan = planCompaction([
    text("u1", "user", "一"),
    call,
    text("u2", "user", "二"),
    result,
    text("a3", "assistant", "回"),
    text("u3", "user", "三"),
  ]);
  assert.deepEqual(
    plan?.transcript.map((message) => message.id),
    ["u1", "a1", "u2", "a2", "a3"],
  );
  assert.deepEqual(
    plan?.tail.map((message) => message.id),
    ["u3"],
  );
});

test("a completed tool call with inline output needs no separate result part", () => {
  const call: UIMessage = {
    id: "a1",
    role: "assistant",
    parts: [
      {
        type: "tool-call",
        id: "c1",
        name: "read",
        arguments: "{}",
        state: "complete",
        output: { content: "ok" },
      },
    ],
  };
  const plan = planCompaction([
    text("u1", "user", "一"),
    call,
    text("u2", "user", "二"),
    text("a2", "assistant", "回"),
    text("u3", "user", "三"),
  ]);
  assert.ok(plan);
  assert.deepEqual(
    plan.transcript.map((message) => message.id),
    ["u1", "a1"],
  );
});

test("duplicate tool call identifiers are rejected", () => {
  const duplicate: UIMessage = {
    id: "a1",
    role: "assistant",
    parts: [
      { type: "tool-call", id: "c1", name: "read", arguments: "{}", state: "complete", output: {} },
      { type: "tool-call", id: "c1", name: "read", arguments: "{}", state: "complete", output: {} },
    ],
  };
  assert.equal(
    planCompaction([
      text("u1", "user", "一"),
      duplicate,
      text("u2", "user", "二"),
      text("a2", "assistant", "回"),
      text("u3", "user", "三"),
    ]),
    null,
  );
});

test("retention budgets change the raw tail without slicing messages", () => {
  const messages = [
    text("u1", "user", "old"),
    text("a1", "assistant", "字".repeat(2_000)),
    text("u2", "user", "字".repeat(500)),
    text("a2", "assistant", "字".repeat(500)),
    text("u3", "user", "new"),
  ];
  assert.deepEqual(
    planCompaction(messages, { triggerTokens: 48_000, keepRecentTokens: 2_000 })?.tail,
    messages.slice(2),
  );
  assert.deepEqual(
    planCompaction(messages, { triggerTokens: 48_000, keepRecentTokens: 100 })?.tail,
    messages.slice(4),
  );
  assert.throws(
    () => planCompaction(messages, { triggerTokens: 0, keepRecentTokens: 100 }),
    /Invalid compaction policy/,
  );
});

test("an oversized single span can cut at a safe assistant boundary", () => {
  const messages = [
    text("u", "user", "字".repeat(30_000)),
    text("a", "assistant", "recent result"),
  ];
  assert.deepEqual(planCompaction(messages), {
    previousSummary: null,
    transcript: messages.slice(0, 1),
    tail: messages.slice(1),
  });
  assert.equal(planCompaction(messages.slice(0, 1)), null);
  const unfinished: UIMessage = {
    id: "unfinished",
    role: "assistant",
    parts: [
      { type: "tool-call", id: "c", name: "read", arguments: "{}", state: "input-streaming" },
    ],
  };
  assert.equal(planCompaction([...messages, unfinished]), null);
});

test("an atomic oversized tool cycle cannot be split to satisfy a budget", () => {
  const call: UIMessage = {
    id: "call",
    role: "assistant",
    parts: [{ type: "tool-call", id: "atomic", name: "read", arguments: "{}", state: "complete" }],
  };
  const result: UIMessage = {
    id: "result",
    role: "assistant",
    parts: [
      {
        type: "tool-result",
        toolCallId: "atomic",
        content: "字".repeat(30_000),
        state: "complete",
      },
    ],
  };
  assert.equal(planCompaction([text("u", "user", "read"), call, result]), null);
  const latest = text("latest", "user", "字".repeat(30_000));
  assert.deepEqual(
    planCompaction([text("old", "user", "old"), text("answer", "assistant", "answer"), latest])
      ?.tail,
    [latest],
  );
});

test("ambiguous summary placement is never silently discarded", () => {
  const summary: UIMessage = { ...text("summary", "user", "old"), metadata: { fromSummary: true } };
  assert.equal(planCompaction([text("u", "user", "hello"), summary]), null);
  assert.equal(planCompaction([summary, summary, ...longMessages()]), null);
});

test("the estimate grows with message text and tool definitions", () => {
  const small = estimateInputTokens({
    messages: [text("u", "user", "hi")],
    systemPrompts: ["prompt"],
    definitions: [],
  });
  const large = estimateInputTokens({
    messages: [text("u", "user", "字".repeat(10_000))],
    systemPrompts: ["prompt"],
    definitions: [],
  });
  const withTools = estimateInputTokens({
    messages: [text("u", "user", "hi")],
    systemPrompts: ["prompt"],
    definitions: [
      { name: "read", description: "d".repeat(20_000), inputSchema: { type: "object" } },
    ],
  });
  assert.ok(large > small);
  assert.ok(withTools > small);
});

test("a small history is left untouched", async () => {
  const captured = capture();
  const outcome = await prepareCompaction({
    runId: "run-1",
    operationId: "run-1/compact/0",
    messages: [text("u1", "user", "一"), text("a1", "assistant", "回"), text("u2", "user", "二")],
    prompt: "prompt",
    model: MODEL,
    tools: fakeTools(),
    emit: captured.emit,
  });
  assert.equal(outcome.state, "skipped");
  assert.deepEqual(captured.emitted, []);
});

test("input estimates use exact serialized bytes and include the framing reserve", () => {
  const messages = longMessages();
  const systemPrompts = ["prompt", "tool-system"];
  const bytes = [convertMessagesToModelMessages(messages), systemPrompts, []].reduce(
    (total, value) => total + Buffer.byteLength(JSON.stringify(value)),
    0,
  );
  assert.equal(
    estimateInputTokens({ messages, systemPrompts, definitions: [] }),
    Math.ceil(bytes / 3) + 2_048,
  );
  assert.equal(estimateInputTokens({ messages: [], systemPrompts: [], definitions: [] }), 2_050);
});

test("a large history is replaced by a summary plus the retained tail", async () => {
  const chatStream = await mockSummaryStream(summaryEvents("重點摘要"));
  const captured = capture();

  try {
    const outcome = await prepareCompaction({
      runId: "run-1",
      operationId: "run-1/compact/0",
      messages: longMessages(),
      prompt: "prompt",
      model: MODEL,
      tools: fakeTools(),
      emit: captured.emit,
    });
    assert.deepEqual(parseCompactionEvent(captured.emitted[0]), {
      runId: "run-1",
      operationId: "run-1/compact/0",
      state: "started",
    });
    assert.equal(captured.emitted.length, 1);

    if (outcome.state !== "done") {
      assert.fail(`expected a completed compaction, received ${outcome.state}`);
    }

    assert.equal(outcome.messages[0]!.metadata?.fromSummary, true);
    assert.deepEqual(
      outcome.messages.map((message) => message.id),
      ["summary:run-1/compact/0", "u3"],
    );
    const before = estimateInputTokens({
      messages: longMessages(),
      systemPrompts: ["prompt", "tool-system"],
      definitions: [],
    });
    const after = estimateInputTokens({
      messages: outcome.messages,
      systemPrompts: ["prompt", "tool-system"],
      definitions: [],
    });
    assert.ok(after < before);
  } finally {
    chatStream.mock.restore();
  }
});

test("iterative summaries pass prior decisions verbatim as data in a tools-free request", async () => {
  const { deepinfra } = await import("../../../server/harness/provider");
  const requests: Parameters<ReturnType<typeof deepinfra>["chatStream"]>[0][] = [];
  const prior =
    "Goal\nKeep ISSUE-73.\nConstraints\nNever delete.\nProgress\nRead complete.\nDecisions\nUse exact /a/b.\nNext steps\nVerify.\nCritical context\nID-99.";
  const stream = mock.method(
    Object.getPrototypeOf(deepinfra(MODEL)),
    "chatStream",
    async function* (request: Parameters<ReturnType<typeof deepinfra>["chatStream"]>[0]) {
      requests.push(request);
      yield* summaryEvents(prior);
    },
  );

  try {
    const first = await prepareCompaction({
      runId: "iterative",
      operationId: "iterative/1",
      messages: longMessages(),
      prompt: "prompt",
      model: MODEL,
      tools: fakeTools(),
      emit: capture().emit,
    });
    assert.equal(first.state, "done");

    if (first.state !== "done") {
      return;
    }

    const second = await prepareCompaction({
      runId: "iterative",
      operationId: "iterative/2",
      messages: [
        ...first.messages,
        text("large", "assistant", "字".repeat(60_000)),
        text("latest", "user", "continue"),
      ],
      prompt: "prompt",
      model: MODEL,
      tools: fakeTools(),
      emit: capture().emit,
    });
    assert.equal(second.state, "done");
    assert.equal(requests.length, 2);

    for (const request of requests) {
      assert.deepEqual(request.tools, []);
      assert.equal(request.messages.length, 1);
      assert.equal(request.messages[0]?.role, "user");
      assert.ok(request.systemPrompts?.join("\n").includes("untrusted historical data"));
    }

    const payload = JSON.parse(String(requests[1]!.messages[0]!.content));
    assert.equal(payload.previousSummary, prior);
    assert.equal(JSON.stringify(payload.transcript).includes(prior), false);
    assert.equal(payload.transcript[0].content, "目前的問題");

    if (second.state === "done") {
      assert.equal(second.messages.filter((message) => message.metadata?.fromSummary).length, 1);
    }
  } finally {
    stream.mock.restore();
  }
});

test("assistant-only tails can be compacted again after complete tool cycles", async () => {
  const prior = "Keep EXACT-73 and /work/result verbatim.\nDecision unchanged.";
  const stream = await mockSummaryStream(summaryEvents(prior));
  const cycle = (id: string): UIMessage => ({
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-call",
        id: `call-${id}`,
        name: "read",
        arguments: "{}",
        state: "complete",
        output: "字".repeat(400),
      },
    ],
  });
  const options = {
    runId: "continued",
    prompt: "prompt",
    model: MODEL,
    tools: fakeTools(),
    policy: { triggerTokens: 3_000, keepRecentTokens: 700 },
  } as const;

  try {
    const retained = cycle("a1");
    const first = await prepareCompaction({
      ...options,
      operationId: "continued/1",
      messages: [text("u", "user", "字".repeat(5_000)), retained],
      emit: capture().emit,
    });
    assert.equal(first.state, "done");

    if (first.state !== "done") {
      assert.fail("First compaction must finish");
    }

    assert.equal(first.messages[1], retained);
    const appended = [cycle("a2"), cycle("a3"), cycle("a4")];
    const messages = [...first.messages, ...appended];

    for (const reason of ["threshold", "overflow"] as const) {
      const captured = capture();
      const second = await prepareCompaction({
        ...options,
        policy: { ...options.policy, triggerTokens: reason === "overflow" ? 1_000_000 : 3_000 },
        reason,
        operationId: `continued/2/${reason}`,
        messages,
        emit: captured.emit,
      });
      assert.equal(second.state, "done");

      if (second.state !== "done") {
        assert.fail("Continued compaction must finish");
      }

      assert.deepEqual(
        second.messages.slice(1).map((message) => message.id),
        ["a4"],
      );
      assert.equal(second.messages[1], appended[2]);
      assert.equal(second.messages.filter((message) => message.metadata?.fromSummary).length, 1);
      assert.deepEqual(
        captured.emitted.map((event) => parseCompactionEvent(event)?.state),
        ["started"],
      );
      const request = stream.mock.calls.at(-1)!.arguments[0];
      const payload = JSON.parse(String(request.messages[0].content));
      assert.equal(payload.previousSummary, prior);
      assert.deepEqual(
        payload.transcript,
        convertMessagesToModelMessages([retained, ...appended.slice(0, 2)]),
      );
      const estimate = (context: UIMessage[]) =>
        estimateInputTokens({
          messages: context,
          systemPrompts: ["prompt", "tool-system"],
          definitions: [],
        });
      assert.ok(estimate(second.messages) < estimate(messages));
    }
  } finally {
    stream.mock.restore();
  }
});

test("many short messages retain the earliest fitting complete user exchange", () => {
  const messages = Array.from({ length: 10_000 }, (_, index) =>
    text(`m${index}`, index % 2 === 0 ? "user" : "assistant", "x".repeat(30)),
  );
  const plan = planCompaction(messages, { triggerTokens: 48_000, keepRecentTokens: 200 });
  assert.ok(plan);
  assert.deepEqual(
    plan.tail.map((message) => message.id),
    ["m9992", "m9993", "m9994", "m9995", "m9996", "m9997", "m9998", "m9999"],
  );
  assert.equal(plan.transcript.length, 9_992);
  assert.equal(plan.tail[0], messages[9_992]);
  assert.ok(Buffer.byteLength(JSON.stringify(convertMessagesToModelMessages(plan.tail))) <= 600);
  assert.ok(
    Buffer.byteLength(JSON.stringify(convertMessagesToModelMessages(messages.slice(9_990)))) > 600,
  );
  assert.equal(plan.transcript[0], messages[0]);
});

test("tool cycles require terminal states and results after their calls", () => {
  const call = (state: "input-streaming" | "input-complete" | "complete" | "error"): UIMessage => ({
    id: "call",
    role: "assistant",
    parts: [{ type: "tool-call", id: "c", name: "read", arguments: "{}", state, output: {} }],
  });
  const first = text("u1", "user", "old");
  const last = text("u2", "user", "new");

  for (const state of ["input-streaming", "input-complete"] as const) {
    assert.equal(planCompaction([first, call(state), last]), null);
  }

  for (const state of ["complete", "error"] as const) {
    assert.deepEqual(planCompaction([first, call(state), last])?.tail, [last]);
  }

  const result: UIMessage = {
    id: "result",
    role: "assistant",
    parts: [{ type: "tool-result", toolCallId: "c", content: "{}", state: "complete" }],
  };
  assert.equal(planCompaction([first, result, call("complete"), last]), null);
  assert.equal(
    planCompaction([
      first,
      { ...call("complete"), parts: [...result.parts, ...call("complete").parts] },
      last,
    ]),
    null,
  );
  assert.deepEqual(planCompaction([first, call("complete"), result, last])?.tail, [last]);
  assert.equal(planCompaction([first, call("complete"), result, result, last]), null);
  assert.equal(planCompaction([first, result, last]), null);
  assert.equal(
    planCompaction([
      first,
      {
        ...call("complete"),
        parts: [{ type: "tool-call", id: "c", name: "read", arguments: "{}", state: "complete" }],
      },
      last,
    ]),
    null,
  );
  assert.equal(
    planCompaction([
      first,
      call("complete"),
      {
        ...result,
        parts: [{ type: "tool-result", toolCallId: "c", content: "partial", state: "streaming" }],
      },
      last,
    ]),
    null,
  );
  assert.deepEqual(
    planCompaction([
      first,
      call("error"),
      {
        ...result,
        parts: [{ type: "tool-result", toolCallId: "c", content: "failed", state: "error" }],
      },
      last,
    ])?.tail,
    [last],
  );
});

test("a truncated summary keeps the original history", async () => {
  const chatStream = await mockSummaryStream(summaryEvents("部分摘要", "length"));
  const captured = capture();

  try {
    const outcome = await prepareCompaction({
      runId: "run-1",
      operationId: "run-1/compact/0",
      messages: longMessages(),
      prompt: "prompt",
      model: MODEL,
      tools: fakeTools(),
      emit: captured.emit,
    });
    assert.equal(outcome.state, "failed");
    assert.deepEqual(
      captured.emitted.map((event) => parseCompactionEvent(event)?.state),
      ["started"],
    );
  } finally {
    chatStream.mock.restore();
  }
});

test("an oversized summary keeps the original history", async () => {
  const chatStream = await mockSummaryStream(summaryEvents("字".repeat(9_000)));
  const captured = capture();

  try {
    const outcome = await prepareCompaction({
      runId: "run-1",
      operationId: "run-1/compact/0",
      messages: longMessages(),
      prompt: "prompt",
      model: MODEL,
      tools: fakeTools(),
      emit: captured.emit,
    });
    assert.equal(outcome.state, "failed");
  } finally {
    chatStream.mock.restore();
  }
});

test("a failing summary keeps the original history", async () => {
  const chatStream = await mockSummaryStream([]);
  const captured = capture();

  try {
    const outcome = await prepareCompaction({
      runId: "run-1",
      operationId: "run-1/compact/0",
      messages: longMessages(),
      prompt: "prompt",
      model: MODEL,
      tools: fakeTools(),
      emit: captured.emit,
    });
    assert.equal(outcome.state, "failed");
    assert.deepEqual(
      captured.emitted.map((event) => parseCompactionEvent(event)?.state),
      ["started"],
    );
  } finally {
    chatStream.mock.restore();
  }
});

test("empty or filtered summaries do not replace history", async () => {
  for (const events of [
    summaryEvents(""),
    summaryEvents("Filtered context", "content_filter"),
    summaryEvents("Incomplete handoff").slice(0, -1),
    summaryEvents("Tool request", "tool_calls"),
    [
      { type: EventType.TOOL_CALL_START, toolCallId: "summary-tool", toolCallName: "read" },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "summary-tool", delta: "{}" },
      { type: EventType.TOOL_CALL_END, toolCallId: "summary-tool" },
      { type: EventType.RUN_FINISHED, threadId: "provider", runId: "provider" },
    ] satisfies AdapterYieldChunk[],
  ]) {
    const stream = await mockSummaryStream(events);
    const captured = capture();

    try {
      const outcome = await prepareCompaction({
        runId: "invalid-summary",
        operationId: "invalid-summary/compact/0",
        messages: longMessages(),
        prompt: "prompt",
        model: MODEL,
        tools: fakeTools(),
        emit: captured.emit,
      });
      assert.equal(outcome.state, "failed");
      assert.deepEqual(
        captured.emitted.map((event) => parseCompactionEvent(event)?.state),
        ["started"],
      );
      assert.deepEqual(captured.emittedMessages, [undefined]);
    } finally {
      stream.mock.restore();
    }
  }
});

test("oversized fixed prompts trigger compaction but non-shrinking summaries are rejected", async () => {
  const stream = await mockSummaryStream(summaryEvents("x".repeat(2_000)));
  const captured = capture();

  try {
    const outcome = await prepareCompaction({
      runId: "fixed-prompt",
      operationId: "fixed-prompt/compact/0",
      messages: [
        text("u1", "user", "one"),
        text("a1", "assistant", "answer"),
        text("u2", "user", "two"),
        text("u3", "user", "current request"),
      ],
      prompt: "字".repeat(COMPACT_TOKEN_THRESHOLD),
      model: MODEL,
      tools: fakeTools(),
      emit: captured.emit,
    });
    assert.equal(outcome.state, "failed");
    assert.deepEqual(
      captured.emitted.map((event) => parseCompactionEvent(event)?.state),
      ["started"],
    );
  } finally {
    stream.mock.restore();
  }
});

test("persistence failures propagate instead of becoming summary failures", async () => {
  const emit: CompactionEmit = async () => {
    throw new Error("Offline persistence");
  };

  await assert.rejects(
    prepareCompaction({
      runId: "persistence",
      operationId: "persistence/compact/0",
      messages: longMessages(),
      prompt: "prompt",
      model: MODEL,
      tools: fakeTools(),
      emit,
    }),
    /Offline persistence/,
  );
});

test("safety classifications are rejected without changing original content", async () => {
  for (const summary of ["Safe", "Unsafe.", "<ds_safety>safe</ds_safety>Useful text"]) {
    const stream = await mockSummaryStream(summaryEvents(summary));
    const messages = longMessages();
    const original = structuredClone(messages);

    try {
      const outcome = await prepareCompaction({
        runId: "safety",
        operationId: "safety/compact/0",
        messages,
        prompt: "prompt",
        model: MODEL,
        tools: fakeTools(),
        emit: capture().emit,
      });
      assert.deepEqual(outcome, { state: "failed" });
      assert.deepEqual(messages, original);
    } finally {
      stream.mock.restore();
    }
  }
});
