import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdapterYieldChunk, UIMessage } from "@tanstack/ai";
import {
  runAgentLoop,
  type AgentCheckpoint,
  type AgentCompact,
  type AgentSession,
} from "../../../server/harness/agent-loop";
import { ContextOverflowError } from "../../../server/harness/model-turn";

type Step =
  | { tool: string; input: Record<string, unknown> }
  | { text: string }
  | { error: unknown };

const messages: UIMessage[] = [
  { id: "user", role: "user", parts: [{ type: "text", content: "Read PROJ-1" }] },
];
const conversation = { display: messages, context: messages };
const keep: AgentCompact = async (input) => input.conversation;
const loop = { model: "offline", prompt: "prompt", signal: new AbortController().signal };

function modelEvents(step: Exclude<Step, { error: unknown }>, turn: number): AdapterYieldChunk[] {
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
    assertExecution: async () => undefined,
    emit: async () => undefined,
    chatStream: async () => {
      const step = steps[counts.model]!;
      counts.model++;

      if ("error" in step) {
        throw step.error;
      }

      const events = modelEvents(step, counts.model - 1);
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
        systemPrompt: "",
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
    ...loop,
    session,
    conversation,
    compact: keep,
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
    ...loop,
    session: first.session,
    conversation,
    compact: keep,
    checkpoint: cachedCheckpoint(cache, []),
  });
  cache.delete("model:1");

  const second = scriptedSession([steps[1], steps[1]]);
  const result = await runAgentLoop({
    ...loop,
    session: second.session,
    conversation,
    compact: keep,
    checkpoint: cachedCheckpoint(cache, []),
  });

  assert.equal(result.state, "done");
  assert.deepEqual(second.counts, { model: 1, tool: 0 });
  assert.match(JSON.stringify(result.conversation.display), /"issue":"PROJ-1"/);
});

const overflow = { error: { code: "context_length_exceeded", message: "too long" } };

test("every turn checks the compaction threshold before calling the model", async () => {
  const { session } = scriptedSession(steps);
  const reasons: string[] = [];
  await runAgentLoop({
    ...loop,
    session,
    conversation,
    checkpoint: cachedCheckpoint(new Map(), []),
    compact: async (input) => {
      reasons.push(`${input.reason}:${input.turn}`);

      return input.conversation;
    },
  });

  assert.deepEqual(reasons, ["threshold:0", "threshold:1"]);
});

test("a context overflow compacts and retries the model once", async () => {
  const { session, counts } = scriptedSession([overflow, { text: "after compaction" }]);
  const names: string[] = [];
  const reasons: string[] = [];
  const result = await runAgentLoop({
    ...loop,
    session,
    conversation,
    checkpoint: cachedCheckpoint(new Map(), names),
    compact: async (input) => {
      reasons.push(input.reason);

      return input.conversation;
    },
  });

  assert.equal(result.state, "done");
  assert.deepEqual(names, ["model:0", "reset-model:0:overflow", "model-overflow:0"]);
  assert.deepEqual(reasons, ["threshold", "overflow"]);
  assert.equal(counts.model, 2);
});

test("a second overflow fails the run without a third request", async () => {
  const { session, counts } = scriptedSession([overflow, overflow, { text: "never" }]);
  const names: string[] = [];

  await assert.rejects(
    runAgentLoop({
      ...loop,
      session,
      conversation,
      compact: keep,
      checkpoint: cachedCheckpoint(new Map(), names),
    }),
    ContextOverflowError,
  );
  assert.deepEqual(names, [
    "model:0",
    "reset-model:0:overflow",
    "model-overflow:0",
    "reset-model:0:exhausted",
  ]);
  assert.equal(counts.model, 2);
});

test("rate limits and network failures do not trigger compaction", async () => {
  for (const error of [
    { status: 429, message: "Too Many Requests" },
    new TypeError("fetch failed"),
  ]) {
    const { session } = scriptedSession([{ error }]);
    const reasons: string[] = [];

    await assert.rejects(
      runAgentLoop({
        ...loop,
        session,
        conversation,
        checkpoint: cachedCheckpoint(new Map(), []),
        compact: async (input) => {
          reasons.push(input.reason);

          return input.conversation;
        },
      }),
    );
    assert.deepEqual(reasons, ["threshold"]);
  }
});
