import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdapterYieldChunk, UIMessage } from "@tanstack/ai";
import {
  runAgentLoop,
  type AgentCheckpoint,
  type AgentSession,
} from "../../../server/harness/agent-loop";

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
    session,
    messages,
    model: "offline",
    prompt: "prompt",
    checkpoint: cachedCheckpoint(new Map(), names),
  });

  assert.equal(result.state, "done");
  assert.deepEqual(names, ["model:0", "tool:0:0", "model:1"]);
  assert.deepEqual(counts, { model: 2, tool: 1 });
  assert.match(JSON.stringify(result.messages), /PROJ-1 read/);
});

test("a rerun reuses completed checkpoints and only executes unfinished steps", async () => {
  const cache = new Map<string, unknown>();
  const first = scriptedSession(steps);
  await runAgentLoop({
    session: first.session,
    messages,
    model: "offline",
    prompt: "prompt",
    checkpoint: cachedCheckpoint(cache, []),
  });
  cache.delete("model:1");

  const second = scriptedSession([steps[1], steps[1]]);
  const result = await runAgentLoop({
    session: second.session,
    messages,
    model: "offline",
    prompt: "prompt",
    checkpoint: cachedCheckpoint(cache, []),
  });

  assert.equal(result.state, "done");
  assert.deepEqual(second.counts, { model: 1, tool: 0 });
  assert.match(JSON.stringify(result.messages), /"issue":"PROJ-1"/);
});
