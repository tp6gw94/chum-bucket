import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdapterYieldChunk, UIMessage } from "@tanstack/ai";
import {
  runAgentLoop,
  type AgentCheckpoint,
  type AgentSession,
} from "../../../server/harness/agent-loop";
import { ContextOverflowError } from "../../../server/harness/model-turn";

type Step = { tool: string; input: Record<string, unknown> } | { text: string };

const messages: UIMessage[] = [
  { id: "user", role: "user", parts: [{ type: "text", content: "Read PROJ-1" }] },
];

function modelEvents(step: Step, turn: number): AdapterYieldChunk[] {
  const base = { model: "offline", timestamp: 0 };
  const started = { ...base, type: "RUN_STARTED", runId: `model-${turn}`, threadId: "thread" };
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
  const session: AgentSession = {
    runId: "run",
    emit: async () => undefined,
    chatStream: async () => {
      const events = modelEvents(steps[counts.model], counts.model);
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
      executeTool: async (_messages, call) => {
        counts.tool++;
        return { issue: (call.input as { issue_key: string }).issue_key };
      },
    },
  };
  return { session, counts };
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

const steps: Step[] = [
  { tool: "jira_get_issue", input: { issue_key: "PROJ-1" } },
  { text: "PROJ-1 read" },
];

test("each model call and tool call runs as its own named checkpoint", async () => {
  const { session, counts } = scriptedSession(steps);
  const names: string[] = [];
  const result = await runAgentLoop({
    session,
    conversation: { display: messages, context: messages },
    model: "offline",
    prompt: "prompt",
    checkpoint: cachedCheckpoint(new Map(), names),
  });

  assert.equal(result.state, "done");
  assert.deepEqual(names, ["model:0", "tool:0:0", "model:1"]);
  assert.deepEqual(counts, { model: 2, tool: 1 });
  assert.match(JSON.stringify(result.conversation.display), /PROJ-1 read/);
});

test("a rerun reuses completed checkpoints and only executes unfinished steps", async () => {
  const cache = new Map<string, unknown>();
  const first = scriptedSession(steps);
  await runAgentLoop({
    session: first.session,
    conversation: { display: messages, context: messages },
    model: "offline",
    prompt: "prompt",
    checkpoint: cachedCheckpoint(cache, []),
  });
  cache.delete("model:1");

  const second = scriptedSession([steps[1], steps[1]]);
  const result = await runAgentLoop({
    session: second.session,
    conversation: { display: messages, context: messages },
    model: "offline",
    prompt: "prompt",
    checkpoint: cachedCheckpoint(cache, []),
  });

  assert.equal(result.state, "done");
  assert.deepEqual(second.counts, { model: 1, tool: 0 });
  assert.match(JSON.stringify(result.conversation.display), /"issue":"PROJ-1"/);
});

function overflowSession(failures: unknown[]) {
  const requests: number[] = [];
  const emitted: string[] = [];
  const session: AgentSession = {
    runId: "run",
    emit: async (_runId, event) => {
      emitted.push(event.type);
    },
    chatStream: async () => {
      requests.push(requests.length);
      const failure = failures[requests.length - 1];

      if (failure) {
        throw failure;
      }

      const events = modelEvents({ text: "answered" }, requests.length);

      return (async function* () {
        yield* events;
      })();
    },
    tools: {
      getModelTools: async () => ({ definitions: [], systemPrompt: "" }),
      executeTool: async () => ({}),
    },
  };

  return { session, requests, emitted };
}

function recordingCompact(state: "done" | "failed" | "skipped", calls: string[]) {
  return async (input: {
    conversation: { display: UIMessage[]; context: UIMessage[] };
    reason: "threshold" | "overflow";
    turn: number;
  }) => {
    calls.push(`${input.reason}:${input.turn}`);

    if (input.reason === "threshold" || state !== "done") {
      return {
        state: input.reason === "threshold" ? ("skipped" as const) : state,
        conversation: input.conversation,
      };
    }

    return {
      state,
      conversation: {
        display: input.conversation.display,
        context: input.conversation.context.slice(-1),
      },
    };
  };
}

test("a context overflow resets the stream, compacts once, and retries the model", async () => {
  const { session, requests, emitted } = overflowSession([{ code: "context_length_exceeded" }]);
  const names: string[] = [];
  const compactions: string[] = [];
  const result = await runAgentLoop({
    session,
    conversation: { display: messages, context: messages },
    model: "offline",
    prompt: "prompt",
    checkpoint: cachedCheckpoint(new Map(), names),
    compact: recordingCompact("done", compactions),
  });
  assert.equal(result.state, "done");
  assert.deepEqual(names, ["model:0", "reset-model:0:overflow", "model-overflow:0"]);
  assert.deepEqual(compactions, ["threshold:0", "overflow:0"]);
  assert.equal(requests.length, 2);
  assert.ok(emitted.includes("MESSAGES_SNAPSHOT"));
});

test("a second overflow after compaction fails the run without a third request", async () => {
  const { session, requests } = overflowSession([
    { code: "context_length_exceeded" },
    { status: 400, message: "This model's maximum context length is 8192 tokens" },
  ]);
  const names: string[] = [];
  await assert.rejects(
    runAgentLoop({
      session,
      conversation: { display: messages, context: messages },
      model: "offline",
      prompt: "prompt",
      checkpoint: cachedCheckpoint(new Map(), names),
      compact: recordingCompact("done", []),
    }),
    ContextOverflowError,
  );
  assert.deepEqual(names, [
    "model:0",
    "reset-model:0:overflow",
    "model-overflow:0",
    "reset-model:0:exhausted",
  ]);
  assert.equal(requests.length, 2);
});

test("an overflow that cannot be compacted fails without retrying", async () => {
  const { session, requests } = overflowSession([{ code: "context_window_exceeded" }]);
  await assert.rejects(
    runAgentLoop({
      session,
      conversation: { display: messages, context: messages },
      model: "offline",
      prompt: "prompt",
      checkpoint: cachedCheckpoint(new Map(), []),
      compact: recordingCompact("skipped", []),
    }),
    ContextOverflowError,
  );
  assert.equal(requests.length, 1);
});

test("rate limits and network failures keep their normal retry path and never compact", async () => {
  for (const failure of [{ status: 429, message: "rate limited" }, new TypeError("fetch failed")]) {
    const { session } = overflowSession([failure]);
    const compactions: string[] = [];
    const names: string[] = [];
    await assert.rejects(
      runAgentLoop({
        session,
        conversation: { display: messages, context: messages },
        model: "offline",
        prompt: "prompt",
        checkpoint: cachedCheckpoint(new Map(), names),
        compact: recordingCompact("done", compactions),
      }),
      (error: Error) => !(error instanceof ContextOverflowError),
    );
    assert.deepEqual(compactions, ["threshold:0"]);
    assert.deepEqual(names, ["model:0"]);
  }
});
