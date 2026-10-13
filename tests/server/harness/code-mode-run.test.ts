import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { EventType, type AdapterYieldChunk, type StreamChunk } from "@tanstack/ai";
import {
  runAgentLoop,
  type AgentChatStream,
  type AgentCheckpoint,
} from "../../../server/harness/agent-loop";
import { withRunTools } from "../../../server/harness/tools";

type ChatOptions = Parameters<AgentChatStream>[0];

const checkpoint: AgentCheckpoint = ({ work }) => work();

function codeModeCall(code: string): AdapterYieldChunk[] {
  const id = "code-mode-source";

  return [
    { type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: "codemode" },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: JSON.stringify({ code }) },
    { type: EventType.TOOL_CALL_END, toolCallId: id, input: { code } },
    { type: EventType.RUN_FINISHED, threadId: "provider", runId: "provider" },
  ] as AdapterYieldChunk[];
}

function answer(): AdapterYieldChunk[] {
  return [
    { type: EventType.TEXT_MESSAGE_START, messageId: "answer", role: "assistant" },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "answer", delta: "read" },
    { type: EventType.TEXT_MESSAGE_END, messageId: "answer" },
    { type: EventType.RUN_FINISHED, threadId: "provider", runId: "provider" },
  ] as AdapterYieldChunk[];
}

function assertCodeModeAdvertised(options: ChatOptions): void {
  assert.equal(options.systemPrompts[0], "base prompt");
  assert.match(options.systemPrompts[1] ?? "", /external_read/);
  const codeMode = options.tools.find((tool) => tool.name === "codemode");
  assert.ok(codeMode);
  assert.deepEqual(codeMode.inputSchema.required, ["code"]);
  assert.equal("typescriptCode" in (codeMode.inputSchema.properties ?? {}), false);
}

test("the agent loop runs codemode and persists its events before the result", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chum-code-mode-run-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "durable.txt");
  await writeFile(path, "durable-payload");
  const code = `
    const file = await external_read({ path: ${JSON.stringify(relative(process.cwd(), path))} });
    return file.content.map((part) => part.text).join("");
  `;
  const persisted: StreamChunk[] = [];
  const toolMessages: unknown[][] = [];
  const chatStream: AgentChatStream = async (options) => {
    assertCodeModeAdvertised(options);
    const tools = options.messages.filter((message) => message.role === "tool");
    toolMessages.push(tools.map((message) => message.content));
    const events = toolMessages.length === 1 ? codeModeCall(code) : answer();

    return (async function* () {
      yield* events;
    })();
  };

  const result = await withRunTools((tools) =>
    runAgentLoop({
      session: {
        runId: "code-mode-run",
        emit: async (_runId, event) => {
          persisted.push(event);
        },
        chatStream,
        tools,
      },
      messages: [{ id: "user-1", role: "user", parts: [{ type: "text", content: "read" }] }],
      model: "offline",
      prompt: "base prompt",
      checkpoint,
    }),
  );

  assert.equal(result.state, "done");
  assert.equal(toolMessages.length, 2);
  assert.equal(toolMessages[1]!.length, 1);
  assert.match(String(toolMessages[1]![0]), /durable-payload/);
  const custom = persisted.filter((event) => event.type === EventType.CUSTOM);
  assert.deepEqual(
    custom.map((event) => (event as { name: string }).name),
    [
      "code_mode:execution_started",
      "code_mode:external_call",
      "code_mode:external_result",
      "code_mode:execution_finished",
    ],
  );
  assert.ok(custom.every((event) => !JSON.stringify(event).includes("durable-payload")));
  const finishedIndex = persisted.indexOf(custom.at(-1)!);
  const resultIndex = persisted.findIndex((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.ok(resultIndex > finishedIndex);
  const output = JSON.parse((persisted[resultIndex] as { content: string }).content) as {
    success: boolean;
    result: unknown;
  };
  assert.deepEqual([output.success, output.result], [true, "durable-payload"]);
});
