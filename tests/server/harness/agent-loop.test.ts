import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdapterYieldChunk, StreamChunk, UIMessage } from "@tanstack/ai";
import {
  runAgentLoop,
  type AgentCheckpoint,
  type AgentCompact,
  type AgentSession,
} from "../../../server/harness/agent-loop";
import type { RunTools } from "../../../server/harness/tools";
import { applyCompaction, compactor } from "../../../server/harness/compaction";
import { ContextOverflowError } from "../../../server/harness/model-turn";
import { compactionSystemPrompt } from "../../../server/harness/prompts";
import { codeModeToolName, withCodeMode } from "../../../server/harness/tools/code-mode";

type Step = { tool: string; input: Record<string, unknown> } | { text: string };

const messages: UIMessage[] = [
  { id: "user", role: "user", parts: [{ type: "text", content: "Read PROJ-1" }] },
];
const conversation = { display: messages, context: messages };
const skipCompact: AgentCompact = async ({ conversation }) => ({
  state: "skipped",
  conversation,
});

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
      getModelTools: async () => [
        {
          name: "jira_get_issue",
          description: "Read an issue",
          inputSchema: { type: "object", properties: { issue_key: { type: "string" } } },
        },
      ],
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
    conversation,
    compact: skipCompact,
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
    conversation,
    compact: skipCompact,
    model: "offline",
    prompt: "prompt",
    checkpoint: cachedCheckpoint(cache, []),
  });
  cache.delete("model:1");

  const second = scriptedSession([steps[1], steps[1]]);
  const result = await runAgentLoop({
    session: second.session,
    conversation,
    compact: skipCompact,
    model: "offline",
    prompt: "prompt",
    checkpoint: cachedCheckpoint(cache, []),
  });

  assert.equal(result.state, "done");
  assert.deepEqual(second.counts, { model: 1, tool: 0 });
  assert.match(JSON.stringify(result.conversation.display), /"issue":"PROJ-1"/);
});

const program = `
  const files = await Promise.all(["a.md", "b.md"].map((path) => external_read({ path })));
  return files.map((file) => (file as { path: string }).path).join(",");
`;
const codeSteps: Step[] = [
  { tool: codeModeToolName, input: { typescriptCode: program } },
  { text: "Read a.md and b.md" },
];

function codeModeSession(steps: Step[], tools: RunTools) {
  const counts = { model: 0 };
  const emitted: StreamChunk[] = [];
  const session: AgentSession = {
    runId: "run",
    emit: async (_runId, event) => {
      emitted.push(structuredClone(event));
    },
    chatStream: async () => {
      const events = modelEvents(steps[counts.model]!, counts.model);
      counts.model++;
      return (async function* () {
        yield* events;
      })();
    },
    tools,
  };
  return { session, counts, emitted };
}

function readOnlyTools(dispatched: string[]): RunTools {
  return withCodeMode(
    {
      getModelTools: async () => [
        {
          name: "read",
          description: "Read a file",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
        },
        {
          name: "write",
          description: "Write a file",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
      executeTool: async (_messages, call) => {
        dispatched.push(`${call.name}:${(call.input as { path: string }).path}`);
        return { path: (call.input as { path: string }).path };
      },
    },
    { sandboxed: new Set(["read"]) },
  );
}

test("a Code Mode program is one checkpoint and recovery replays it whole", async () => {
  const cache = new Map<string, unknown>();
  const dispatched: string[] = [];
  const crashing: AgentCheckpoint = async ({ name, work }) => {
    if (cache.has(name)) {
      return structuredClone(cache.get(name)) as Awaited<ReturnType<typeof work>>;
    }
    const result = await work();
    if (name === "tool:0:0") {
      throw new Error("process exited before the checkpoint committed");
    }
    cache.set(name, structuredClone(result));
    return result;
  };
  const first = codeModeSession(codeSteps, readOnlyTools(dispatched));
  await assert.rejects(
    runAgentLoop({
      session: first.session,
      conversation,
      compact: skipCompact,
      model: "offline",
      prompt: "prompt",
      checkpoint: crashing,
    }),
    /before the checkpoint committed/,
  );
  assert.deepEqual(dispatched, ["read:a.md", "read:b.md"]);

  const names: string[] = [];
  const second = codeModeSession([codeSteps[1]!, codeSteps[1]!], readOnlyTools(dispatched));
  const result = await runAgentLoop({
    session: second.session,
    conversation,
    compact: skipCompact,
    model: "offline",
    prompt: "prompt",
    checkpoint: cachedCheckpoint(cache, names),
  });

  assert.equal(result.state, "done");
  assert.deepEqual(names, ["model:0", "tool:0:0", "model:1"]);
  assert.equal(second.counts.model, 1);
  assert.deepEqual(dispatched, ["read:a.md", "read:b.md", "read:a.md", "read:b.md"]);
  const toolResult = result.conversation.display
    .flatMap((message) => message.parts)
    .find((part) => part.type === "tool-result");
  assert.ok(toolResult && toolResult.type === "tool-result");
  assert.deepEqual(JSON.parse(String(toolResult.content)), {
    success: true,
    result: "a.md,b.md",
    logs: [],
    toolCalls: 2,
  });

  const settled = second.emitted.filter(
    (event) => event.type === "CUSTOM" || event.type === "TOOL_CALL_RESULT",
  );
  assert.equal(settled.at(-1)!.type, "TOOL_CALL_RESULT");
  assert.deepEqual(
    settled.slice(0, -1).map((event) => event.type === "CUSTOM" && event.name),
    [
      "code_mode:external_call",
      "code_mode:external_call",
      "code_mode:external_result",
      "code_mode:external_result",
      "code_mode:execution_finished",
    ],
  );
  assert.ok(
    settled.every((event) => event.type !== "CUSTOM" || event.value.toolCallId === "call-0"),
  );
});

test("tool custom events are persisted in order and capped per tool call", async () => {
  const tools: RunTools = {
    getModelTools: async () => [
      { name: "noisy", description: "Emit events", inputSchema: { type: "object" } },
    ],
    executeTool: async (_messages, _call, context) => {
      for (let index = 0; index < 100; index++) {
        context.emitCustomEvent("noisy:tick", { index });
      }
      return "done";
    },
  };
  const { session, emitted } = codeModeSession(
    [{ tool: "noisy", input: {} }, { text: "done" }],
    tools,
  );
  await runAgentLoop({
    session,
    conversation,
    compact: skipCompact,
    model: "offline",
    prompt: "prompt",
    checkpoint: cachedCheckpoint(new Map(), []),
  });
  const custom = emitted.filter((event) => event.type === "CUSTOM");

  assert.equal(custom.length, 64);
  assert.deepEqual(
    custom.map((event) => event.type === "CUSTOM" && event.value.index),
    [...Array(64).keys()],
  );
});

const longHistory: UIMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", content: "x".repeat(900) }] },
  { id: "a1", role: "assistant", parts: [{ type: "text", content: "y".repeat(900) }] },
  { id: "u2", role: "user", parts: [{ type: "text", content: "continue" }] },
];

function summaryEvents(): AdapterYieldChunk[] {
  const base = { model: "offline", timestamp: 0 };
  return [
    { ...base, type: "RUN_STARTED", runId: "summary", threadId: "thread" },
    { ...base, type: "TEXT_MESSAGE_START", messageId: "summary", role: "assistant" },
    { ...base, type: "TEXT_MESSAGE_CONTENT", messageId: "summary", delta: "short summary" },
    { ...base, type: "TEXT_MESSAGE_END", messageId: "summary" },
    { ...base, type: "RUN_FINISHED", runId: "summary", threadId: "thread", finishReason: "stop" },
  ] as AdapterYieldChunk[];
}

type ModelAttempt = Step | { fail: unknown } | { runError: string };

function overflowSession(attempts: ModelAttempt[]) {
  const counts = { model: 0, summary: 0 };
  const session: AgentSession = {
    runId: "run",
    emit: async () => undefined,
    chatStream: async (options) => {
      if (options.systemPrompts[0] === compactionSystemPrompt) {
        counts.summary++;
        const events = summaryEvents();
        return (async function* () {
          yield* events;
        })();
      }
      const attempt = attempts[counts.model]!;
      counts.model++;
      if ("fail" in attempt) {
        throw attempt.fail;
      }
      const events: AdapterYieldChunk[] =
        "runError" in attempt
          ? ([
              { type: "RUN_STARTED", runId: "model", threadId: "thread" },
              { type: "RUN_ERROR", message: "too long", code: attempt.runError },
            ] as AdapterYieldChunk[])
          : modelEvents(attempt, counts.model);
      return (async function* () {
        yield* events;
      })();
    },
    tools: { getModelTools: async () => [], executeTool: async () => null },
  };
  return { session, counts };
}

function overflowLoop(attempts: ModelAttempt[]) {
  const names: string[] = [];
  const { session, counts } = overflowSession(attempts);
  const checkpoint = cachedCheckpoint(new Map(), names);
  const run = runAgentLoop({
    session,
    conversation: { display: longHistory, context: longHistory },
    model: "offline",
    prompt: "prompt",
    checkpoint,
    compact: compactor({
      session,
      model: "offline",
      prompt: "prompt",
      policy: { triggerTokens: 100_000, keepRecentTokens: 100 },
      checkpoint,
      publish: async ({ outcome, conversation }) => applyCompaction(conversation, outcome),
    }),
  });
  return { run, names, counts };
}

test("a context overflow compacts once and retries the model with the summary", async () => {
  const { run, names, counts } = overflowLoop([
    { fail: { code: "context_length_exceeded", message: "too long" } },
    { text: "recovered" },
  ]);
  const result = await run;

  assert.equal(result.state, "done");
  assert.deepEqual(names, [
    "compact:0",
    "model:0",
    "reset-model:0:overflow",
    "compact-overflow:0",
    "publish-compact-overflow:0",
    "model-overflow:0",
  ]);
  assert.deepEqual(counts, { model: 2, summary: 1 });
  assert.equal(result.conversation.context[0]!.metadata?.fromSummary, true);
  assert.deepEqual(result.conversation.display.map((message) => message.id).slice(0, 3), [
    "u1",
    "a1",
    "u2",
  ]);
  assert.match(JSON.stringify(result.conversation.display), /recovered/);
});

test("a second overflow after compaction fails the run without a third request", async () => {
  const { run, names, counts } = overflowLoop([
    { fail: { code: "context_length_exceeded", message: "too long" } },
    { runError: "context_length_exceeded" },
    { text: "never" },
  ]);

  await assert.rejects(run, ContextOverflowError);
  assert.equal(names.at(-1), "reset-model:0:exhausted");
  assert.deepEqual(counts, { model: 2, summary: 1 });
});

for (const fail of [
  { status: 429, message: "maximum context length is 10 tokens" },
  new TypeError("fetch failed"),
]) {
  test(`provider failure ${JSON.stringify(fail.message)} is not treated as overflow`, async () => {
    const { run, names, counts } = overflowLoop([{ fail }]);

    await assert.rejects(run, (error: unknown) => !(error instanceof ContextOverflowError));
    assert.deepEqual(names, ["compact:0", "model:0"]);
    assert.deepEqual(counts, { model: 1, summary: 0 });
  });
}

test("orchestration runs outside tool checkpoints and settles without native dispatch", async () => {
  const { session, counts } = scriptedSession([
    { tool: "delegate_task", input: {} },
    { text: "Delegated" },
  ]);
  let inCheckpoint = false;
  let orchestrations = 0;
  const result = await runAgentLoop({
    session,
    conversation,
    compact: skipCompact,
    model: "offline",
    prompt: "prompt",
    checkpoint: async ({ work }) => {
      inCheckpoint = true;
      try {
        return await work();
      } finally {
        inCheckpoint = false;
      }
    },
    orchestration: async () => {
      assert.equal(inCheckpoint, false);
      orchestrations++;
      return { state: "handled", output: { ref: "artifact" } };
    },
  });
  assert.equal(result.state, "done");
  assert.equal(orchestrations, 1);
  assert.equal(counts.tool, 0);
  assert.match(JSON.stringify(result.conversation.context), /artifact/);
});
