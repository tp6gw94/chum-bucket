import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdapterYieldChunk, UIMessage } from "@tanstack/ai";
import {
  runAgentLoop,
  type AgentCheckpoint,
  type AgentSession,
} from "../../../server/harness/agent-loop";
import { browserAgentId } from "../../../server/harness/browser-agent";
import { browserObservations } from "../../../server/harness/tools/browser";
import {
  DELEGATE_TASK_TOOL,
  delegationInputSchema,
  withDelegation,
} from "../../../server/harness/tools/delegate-task";
import type { RunTools } from "../../../server/harness/tools";

type Step = { tool: string; input: Record<string, unknown> } | { text: string };

function modelEvents(step: Step, turn: number): AdapterYieldChunk[] {
  const base = { model: "offline", timestamp: 0 };
  const run = { runId: `model-${turn}`, threadId: "thread" };
  const started = { ...base, ...run, type: "RUN_STARTED" };

  if ("tool" in step) {
    const call = { toolCallId: `call-${turn}`, toolCallName: step.tool, toolName: step.tool };

    return [
      started,
      { ...base, ...call, type: "TOOL_CALL_START" },
      {
        ...base,
        type: "TOOL_CALL_ARGS",
        toolCallId: call.toolCallId,
        delta: JSON.stringify(step.input),
      },
      { ...base, ...call, type: "TOOL_CALL_END", input: step.input },
      { ...base, ...run, type: "RUN_FINISHED", finishReason: "tool_calls" },
    ] as AdapterYieldChunk[];
  }

  const messageId = `answer-${turn}`;

  return [
    started,
    { ...base, type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
    { ...base, type: "TEXT_MESSAGE_CONTENT", messageId, delta: step.text },
    { ...base, type: "TEXT_MESSAGE_END", messageId },
    { ...base, ...run, type: "RUN_FINISHED", finishReason: "stop" },
  ] as AdapterYieldChunk[];
}

function scripted(steps: Step[], tools: RunTools): AgentSession {
  let turn = 0;

  return {
    runId: "run",
    emit: async () => undefined,
    chatStream: async () => {
      const events = modelEvents(steps[turn]!, turn);
      turn++;

      return (async function* () {
        yield* events;
      })();
    },
    tools,
  };
}

function cachedCheckpoint(cache: Map<string, unknown>): AgentCheckpoint {
  return async ({ name, work }) => {
    if (cache.has(name)) {
      return structuredClone(cache.get(name)) as Awaited<ReturnType<typeof work>>;
    }

    const result = await work();
    cache.set(name, structuredClone(result));

    return result;
  };
}

const user: UIMessage[] = [
  { id: "user", role: "user", parts: [{ type: "text", content: "Check the cart" }] },
];
const delegation = {
  summary: "Increase quantity and expect 2",
  targetUrl: "http://127.0.0.1:8080/",
};

function baseTools(executed: string[]): RunTools {
  return {
    getModelTools: async () => ({ definitions: [], systemPrompt: "base" }),
    executeTool: async (_messages, call) => {
      executed.push(call.name);

      return { state: "observed", observation: { id: "o1", observed: "Quantity: 2" } };
    },
  };
}

test("delegate_task is advertised to main but never reaches the tool dispatcher", async () => {
  const executed: string[] = [];
  const tools = withDelegation(baseTools(executed));
  const offered = await tools.getModelTools([]);

  assert.deepEqual(
    offered.definitions.map((definition) => definition.name),
    [DELEGATE_TASK_TOOL],
  );
  assert.match(offered.systemPrompt, /^base\n\n## Browser sub-agent/);
  assert.throws(() =>
    tools.executeTool(
      [],
      { id: "x", name: DELEGATE_TASK_TOOL, arguments: "{}", input: delegation },
      { toolCallId: "x", emitCustomEvent: () => {} },
    ),
  );
});

test("an orchestrated call settles as a tool result and replays onto the same step", async () => {
  const executed: string[] = [];
  const delegated: string[] = [];
  const cache = new Map<string, unknown>();
  const steps: Step[] = [
    { tool: DELEGATE_TASK_TOOL, input: delegation },
    { text: "Quantity is 2" },
  ];
  const run = () =>
    runAgentLoop({
      session: scripted(steps, withDelegation(baseTools(executed))),
      conversation: { display: user, context: user },
      model: "offline",
      prompt: "main",
      checkpoint: cachedCheckpoint(cache),
      orchestrate: async (call, step) => {
        if (call.name !== DELEGATE_TASK_TOOL) {
          return undefined;
        }

        delegated.push(step);

        return { output: { agent: "browser", state: "completed" }, error: false };
      },
    });

  const first = await run();
  assert.equal(first.state, "done");
  assert.deepEqual(executed, []);
  assert.deepEqual(delegated, ["tool:0:0"]);

  const results = first.conversation.context.flatMap((message) =>
    message.parts.filter((part) => part.type === "tool-result"),
  );
  assert.equal(results.length, 1);
  assert.deepEqual(JSON.parse(results[0]!.content as string), {
    agent: "browser",
    state: "completed",
  });

  const replay = await run();
  assert.deepEqual(replay.conversation, first.conversation);
  assert.deepEqual(delegated, ["tool:0:0", "tool:0:0"]);
});

test("observations are collected from the browser tool results in the child context", async () => {
  const executed: string[] = [];
  const result = await runAgentLoop({
    session: scripted(
      [{ tool: "browser", input: { action: "read", observation: "url" } }, { text: "PASS" }],
      baseTools(executed),
    ),
    conversation: { display: user, context: user },
    model: "offline",
    prompt: "browser",
    checkpoint: cachedCheckpoint(new Map()),
  });

  assert.deepEqual(browserObservations(result.conversation.context), [
    { id: "o1", observed: "Quantity: 2" },
  ]);
});

test("delegation input is strict and only accepts credential-free allowlisted targets", () => {
  assert.equal(delegationInputSchema.safeParse(delegation).success, true);

  for (const input of [
    { ...delegation, role: "ac" },
    { ...delegation, targetUrl: "file:///etc/passwd" },
    { ...delegation, targetUrl: "http://user:pass@127.0.0.1/" },
    { ...delegation, targetUrl: "http://10.0.0.1/" },
    { ...delegation, targetUrl: "http://127.0.0.1:3000/" },
    { ...delegation, summary: " " },
    { summary: delegation.summary },
  ]) {
    assert.equal(delegationInputSchema.safeParse(input).success, false, JSON.stringify(input));
  }
});

test("each tool step gets its own stable child workflow id", () => {
  const id = browserAgentId("run-1", "tool:0:0");

  assert.match(id, /^browser-[0-9a-f]{32}$/);
  assert.equal(browserAgentId("run-1", "tool:0:0"), id);
  assert.notEqual(browserAgentId("run-1", "tool:1:0"), id);
  assert.notEqual(browserAgentId("run-2", "tool:0:0"), id);
});
