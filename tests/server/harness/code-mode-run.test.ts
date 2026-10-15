import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AdapterYieldChunk, StreamChunk, UIMessage } from "@tanstack/ai";
import {
  runAgentLoop,
  type AgentChatStream,
  type AgentCheckpoint,
} from "../../../server/harness/agent-loop";
import { withRunTools } from "../../../server/harness/tools/index";
import { withMcpEnvironment } from "../../fixtures/mcp-fixture";

const base = { model: "offline", timestamp: 0 };

function toolTurn(code: string): AdapterYieldChunk[] {
  const input = { code };

  return [
    { ...base, type: "RUN_STARTED", runId: "model-0", threadId: "thread" },
    {
      ...base,
      type: "TOOL_CALL_START",
      toolCallId: "call-0",
      toolCallName: "codemode",
      toolName: "codemode",
    },
    { ...base, type: "TOOL_CALL_ARGS", toolCallId: "call-0", delta: JSON.stringify(input) },
    {
      ...base,
      type: "TOOL_CALL_END",
      toolCallId: "call-0",
      toolCallName: "codemode",
      toolName: "codemode",
      input,
    },
    {
      ...base,
      type: "RUN_FINISHED",
      runId: "model-0",
      threadId: "thread",
      finishReason: "tool_calls",
    },
  ] as AdapterYieldChunk[];
}

function answerTurn(text: string): AdapterYieldChunk[] {
  return [
    { ...base, type: "RUN_STARTED", runId: "model-1", threadId: "thread" },
    { ...base, type: "TEXT_MESSAGE_START", messageId: "answer", role: "assistant" },
    { ...base, type: "TEXT_MESSAGE_CONTENT", messageId: "answer", delta: text },
    { ...base, type: "TEXT_MESSAGE_END", messageId: "answer" },
    {
      ...base,
      type: "RUN_FINISHED",
      runId: "model-1",
      threadId: "thread",
      finishReason: "stop",
    },
  ] as AdapterYieldChunk[];
}

const directCheckpoint: AgentCheckpoint = ({ work }) => work();

test("one codemode step reads a file, stores projected events, and feeds one result to the model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code-mode-run-"));
  const path = join(directory, "report.txt");
  const body = `status: green\n${"confidential detail line\n".repeat(40)}`;

  try {
    await writeFile(path, body);
    const requests: Parameters<AgentChatStream>[0][] = [];
    const emitted: StreamChunk[] = [];
    const code = `const file = await external_read({ path: ${JSON.stringify(path)} });
const text = file.content.map((part) => part.text).join("");
return text.split("\\n")[0];`;
    const turns = [toolTurn(code), answerTurn("The report is green.")];
    const messages: UIMessage[] = [
      { id: "user", role: "user", parts: [{ type: "text", content: "Summarise the report" }] },
    ];

    const result = await withMcpEnvironment(
      () =>
        withRunTools((tools) =>
          runAgentLoop({
            session: {
              runId: "run",
              emit: async (_runId, event) => {
                emitted.push(event);
              },
              chatStream: async (options) => {
                requests.push(options);
                const events = turns[requests.length - 1]!;

                return (async function* () {
                  yield* events;
                })();
              },
              tools,
            },
            messages,
            model: "offline",
            prompt: "base prompt",
            checkpoint: directCheckpoint,
          }),
        ),
      false,
    );

    assert.equal(result.state, "done");
    assert.equal(requests.length, 2);
    assert.equal(requests[0]!.systemPrompts[0], "base prompt");
    assert.match(requests[0]!.systemPrompts[1]!, /## Code Mode/);
    assert.ok(requests[0]!.tools.some((tool) => tool.name === "codemode"));

    const toolMessages = requests[1]!.messages.filter((message) => message.role === "tool");
    assert.equal(toolMessages.length, 1);
    assert.equal(
      JSON.stringify(toolMessages[0]!.content),
      JSON.stringify(JSON.stringify({ success: true, result: "status: green", logs: [] })),
    );

    const custom = emitted.filter((event) => event.type === "CUSTOM");
    assert.ok(custom.length >= 4);
    assert.ok(
      custom.every(
        (event) =>
          (event as { value: { parentToolCallId: string } }).value.parentToolCallId === "call-0",
      ),
    );
    assert.deepEqual(
      custom.map((event) => (event as { value: { sequence: number } }).value.sequence),
      custom.map((_, index) => index),
    );
    const finished = emitted.findIndex(
      (event) => event.type === "CUSTOM" && event.name === "code_mode:execution_finished",
    );
    const toolResult = emitted.findIndex((event) => event.type === "TOOL_CALL_RESULT");
    assert.ok(finished >= 0 && finished < toolResult);
    assert.equal(emitted.filter((event) => event.type === "TOOL_CALL_RESULT").length, 1);
    assert.doesNotMatch(JSON.stringify(custom), /confidential detail|external_read\(\{ path/);
    assert.match(JSON.stringify(result.messages), /The report is green\./);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
