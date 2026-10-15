import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdapterYieldChunk, StreamChunk, UIMessage } from "@tanstack/ai";
import {
  runAgentLoop,
  type AgentCheckpoint,
  type AgentCompact,
  type AgentSession,
} from "../../../server/harness/agent-loop";
import type { ConversationState } from "../../../server/harness/conversation";
import { ContextOverflowError } from "../../../server/harness/model-turn";

type Step =
  | { tool: string; input: Record<string, unknown> }
  | { text: string }
  | { overflow: true };

const messages: UIMessage[] = [
  { id: "user", role: "user", parts: [{ type: "text", content: "Read PROJ-1" }] },
];
const conversation: ConversationState = { display: messages, context: messages };

function modelEvents(step: Step, turn: number): AdapterYieldChunk[] {
  const base = { model: "offline", timestamp: 0 };
  const started = { ...base, type: "RUN_STARTED", runId: `model-${turn}`, threadId: "thread" };
  if ("overflow" in step) {
    return [
      started,
      {
        ...base,
        type: "RUN_ERROR",
        message: "This model's maximum context length is 131072 tokens",
        code: "context_length_exceeded",
      },
    ] as AdapterYieldChunk[];
  }
  if ("tool" in step) {
    const id = `call-${turn}`;
    return [
      started,
      {
        ...base,
        type: "TOOL_CALL_START",
        toolCallId: id,
        toolCallName: step.tool,
        toolName: step.tool,
      },
      { ...base, type: "TOOL_CALL_ARGS", toolCallId: id, delta: JSON.stringify(step.input) },
      {
        ...base,
        type: "TOOL_CALL_END",
        toolCallId: id,
        toolCallName: step.tool,
        toolName: step.tool,
        input: step.input,
      },
      {
        ...base,
        type: "RUN_FINISHED",
        runId: `model-${turn}`,
        threadId: "thread",
        finishReason: "tool_calls",
      },
    ] as AdapterYieldChunk[];
  }
  const messageId = `answer-${turn}`;
  return [
    started,
    { ...base, type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
    { ...base, type: "TEXT_MESSAGE_CONTENT", messageId, delta: step.text },
    { ...base, type: "TEXT_MESSAGE_END", messageId },
    {
      ...base,
      type: "RUN_FINISHED",
      runId: `model-${turn}`,
      threadId: "thread",
      finishReason: "stop",
    },
  ] as AdapterYieldChunk[];
}

function scriptedSession(steps: Step[]) {
  const counts = { model: 0, tool: 0 };
  const emitted: StreamChunk[] = [];
  const prompts: string[][] = [];
  const contexts: unknown[][] = [];
  const session: AgentSession = {
    runId: "run",
    emit: async (_runId, event) => {
      emitted.push(event);
    },
    chatStream: async (options) => {
      prompts.push(options.systemPrompts);
      contexts.push(options.messages);
      const events = modelEvents(steps[counts.model]!, counts.model);
      counts.model++;
      return (async function* () {
        yield* events;
      })();
    },
    tools: {
      getModelTools: async () => ({
        definitions: [
          {
            name: "jira_get_issue",
            description: "Read an issue",
            inputSchema: { type: "object", properties: { issue_key: { type: "string" } } },
          },
        ],
        systemPrompt: "code mode prompt",
      }),
      executeTool: async (_messages, call, context) => {
        counts.tool++;
        context.emitCustomEvent("code_mode:external_call", { function: "external_jira_get_issue" });
        return { issue: (call.input as { issue_key: string }).issue_key };
      },
    },
  };
  return { session, counts, emitted, prompts, contexts };
}

function cachedCheckpoint(cache: Map<string, unknown>, names: string[]): AgentCheckpoint {
  return async ({ name, work }) => {
    names.push(name);
    if (cache.has(name)) {
      return structuredClone(cache.get(name)) as Awaited<ReturnType<typeof work>>;
    }
    const result = await work();
    cache.set(name, structuredClone(result));
    return result;
  };
}

const summary: UIMessage = {
  id: "summary",
  role: "user",
  parts: [{ type: "text", content: "Summary of earlier work" }],
  metadata: { fromSummary: true },
};

function summarizingCompact(calls: Parameters<AgentCompact>[0][]): AgentCompact {
  return async (input) => {
    calls.push(input);
    const kept = input.conversation.context.slice(-1);
    const position = input.conversation.display.findIndex((message) => message.id === kept[0]!.id);
    return {
      status: "done",
      conversation: {
        display: [
          ...input.conversation.display.slice(0, position),
          summary,
          ...input.conversation.display.slice(position),
        ],
        context: [summary, ...kept],
      },
      event: {
        phase: "done",
        trigger: input.trigger,
        tokensBefore: 100,
        tokensAfter: 10,
        summaryMessageId: summary.id,
        compactedMessages: input.conversation.context.length - 1,
      },
    };
  };
}

const unusedCompact: AgentCompact = async () => {
  throw new Error("Compaction was not expected");
};

const steps: Step[] = [
  { tool: "jira_get_issue", input: { issue_key: "PROJ-1" } },
  { text: "PROJ-1 read" },
];

test("each model call and tool call runs as its own named checkpoint", async () => {
  const { session, counts } = scriptedSession(steps);
  const names: string[] = [];
  const result = await runAgentLoop({
    session,
    conversation,
    model: "offline",
    prompt: "prompt",
    checkpoint: cachedCheckpoint(new Map(), names),
    compact: unusedCompact,
  });

  assert.equal(result.outcome, "done");
  assert.deepEqual(names, ["model:0", "tool:0:0", "model:1"]);
  assert.deepEqual(counts, { model: 2, tool: 1 });
  assert.match(JSON.stringify(result.conversation.display), /PROJ-1 read/);
  assert.deepEqual(result.conversation.display, result.conversation.context);
});

test("model calls receive the code mode prompt and tool events are stored before the tool result", async () => {
  const { session, emitted, prompts } = scriptedSession(steps);
  await runAgentLoop({
    session,
    conversation,
    model: "offline",
    prompt: "prompt",
    checkpoint: cachedCheckpoint(new Map(), []),
    compact: unusedCompact,
  });

  assert.deepEqual(prompts, [
    ["prompt", "code mode prompt"],
    ["prompt", "code mode prompt"],
  ]);
  const custom = emitted.findIndex((event) => event.type === "CUSTOM");
  const result = emitted.findIndex((event) => event.type === "TOOL_CALL_RESULT");
  assert.ok(custom >= 0 && custom < result);
  assert.deepEqual(
    { ...emitted[custom], timestamp: 0 },
    {
      type: "CUSTOM",
      name: "code_mode:external_call",
      value: { function: "external_jira_get_issue" },
      timestamp: 0,
    },
  );
});

test("a rerun reuses completed checkpoints and only executes unfinished steps", async () => {
  const cache = new Map<string, unknown>();
  const first = scriptedSession(steps);
  await runAgentLoop({
    session: first.session,
    conversation,
    model: "offline",
    prompt: "prompt",
    checkpoint: cachedCheckpoint(cache, []),
    compact: unusedCompact,
  });
  cache.delete("model:1");

  const second = scriptedSession([steps[1]!, steps[1]!]);
  const result = await runAgentLoop({
    session: second.session,
    conversation,
    model: "offline",
    prompt: "prompt",
    checkpoint: cachedCheckpoint(cache, []),
    compact: unusedCompact,
  });

  assert.equal(result.outcome, "done");
  assert.deepEqual(second.counts, { model: 1, tool: 0 });
  assert.match(JSON.stringify(result.conversation.display), /"issue":"PROJ-1"/);
});

test("a context above the threshold is compacted before the model request", async () => {
  const large: UIMessage[] = [
    { id: "old", role: "user", parts: [{ type: "text", content: "x".repeat(480_000) }] },
    ...messages,
  ];
  const { session, contexts } = scriptedSession([{ text: "done" }]);
  const names: string[] = [];
  const calls: Parameters<AgentCompact>[0][] = [];
  const result = await runAgentLoop({
    session,
    conversation: { display: large, context: large },
    model: "offline",
    prompt: "prompt",
    checkpoint: cachedCheckpoint(new Map(), names),
    compact: summarizingCompact(calls),
  });

  assert.deepEqual(
    calls.map(({ trigger, name }) => [trigger, name]),
    [["threshold", "compact:0"]],
  );
  assert.deepEqual(names, ["model:0"]);
  assert.equal(JSON.stringify(contexts[0]).includes("x".repeat(100)), false);
  assert.deepEqual(
    result.conversation.display.map((message) => message.id),
    ["old", "summary", "user", "answer-0"],
  );
  assert.deepEqual(
    result.conversation.context.map((message) => message.id),
    ["summary", "user", "answer-0"],
  );
});

test("a provider context overflow compacts and retries the model request once", async () => {
  const { session, counts, contexts } = scriptedSession([
    { overflow: true },
    { text: "recovered" },
  ]);
  const names: string[] = [];
  const calls: Parameters<AgentCompact>[0][] = [];
  const history: UIMessage[] = [
    { id: "earlier", role: "user", parts: [{ type: "text", content: "Earlier request" }] },
    ...messages,
  ];
  const result = await runAgentLoop({
    session,
    conversation: { display: history, context: history },
    model: "offline",
    prompt: "prompt",
    checkpoint: cachedCheckpoint(new Map(), names),
    compact: summarizingCompact(calls),
  });

  assert.deepEqual(names, ["model:0", "model:0:retry"]);
  assert.deepEqual(
    calls.map(({ trigger, name }) => [trigger, name]),
    [["overflow", "compact:0:overflow"]],
  );
  assert.equal(counts.model, 2);
  assert.match(JSON.stringify(contexts[1]), /Summary of earlier work/);
  assert.equal(JSON.stringify(contexts[1]).includes("Earlier request"), false);
  assert.deepEqual(
    result.conversation.display.map((message) => message.id),
    ["earlier", "summary", "user", "answer-1"],
  );
});

test("a second overflow after compaction fails the run", async () => {
  const { session } = scriptedSession([{ overflow: true }, { overflow: true }]);
  await assert.rejects(
    runAgentLoop({
      session,
      conversation,
      model: "offline",
      prompt: "prompt",
      checkpoint: cachedCheckpoint(new Map(), []),
      compact: summarizingCompact([]),
    }),
    ContextOverflowError,
  );
});

test("an overflow without a successful compaction fails without retrying", async () => {
  const { session, counts } = scriptedSession([{ overflow: true }, { text: "unused" }]);
  await assert.rejects(
    runAgentLoop({
      session,
      conversation,
      model: "offline",
      prompt: "prompt",
      checkpoint: cachedCheckpoint(new Map(), []),
      compact: async ({ trigger }) => ({
        status: "skipped",
        event: { phase: "skipped", trigger, tokensBefore: 10, reason: "nothing-to-compact" },
      }),
    }),
    ContextOverflowError,
  );
  assert.equal(counts.model, 1);
});
