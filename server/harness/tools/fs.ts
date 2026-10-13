import { createReadTool, createWriteTool, createEditTool } from "@earendil-works/pi-coding-agent";
import { toolDefinition, type ToolExecutionContext } from "@tanstack/ai";
import { z } from "zod";
import { Worker } from "node:worker_threads";

const nativeRead = createReadTool(process.cwd());
const nativeWrite = createWriteTool(process.cwd());
const nativeEdit = createEditTool(process.cwd());

const readInput = z.object({
  path: z.string(),
  offset: z.number().optional(),
  limit: z.number().optional(),
});
const writeInput = z.object({ path: z.string(), content: z.string() });
const editInput = z.object({
  path: z.string(),
  edits: z.array(z.object({ oldText: z.string(), newText: z.string() })),
});

export const fileToolOutput = z.object({
  content: z.array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
    ]),
  ),
});

function requireToolCallId(context?: ToolExecutionContext) {
  if (!context?.toolCallId) {
    throw new Error("Missing tool call ID");
  }

  return context.toolCallId;
}

export const read = toolDefinition({
  name: nativeRead.name,
  description: nativeRead.description,
  inputSchema: nativeRead.parameters,
}).server(async (input, context) => {
  context?.abortSignal?.throwIfAborted();
  const worker = new Worker(new URL("./read-worker.mjs", import.meta.url), {
    workerData: {
      cwd: process.cwd(),
      id: requireToolCallId(context),
      input: readInput.parse(input),
    },
  });
  let onAbort: (() => void) | undefined;

  try {
    return await new Promise<unknown>((resolve, reject) => {
      onAbort = () => reject(new Error("Read was cancelled"));
      context?.abortSignal?.addEventListener("abort", onAbort, { once: true });
      worker.once("message", (message: { result?: unknown; error?: string }) =>
        message.error ? reject(new Error(message.error)) : resolve(message.result),
      );
      worker.once("error", reject);
      worker.once("exit", () => reject(new Error("Read worker exited")));

      if (context?.abortSignal?.aborted) {
        onAbort();
      }
    });
  } finally {
    if (onAbort) {
      context?.abortSignal?.removeEventListener("abort", onAbort);
    }

    await worker.terminate();
  }
});

export const write = toolDefinition({
  name: nativeWrite.name,
  description: nativeWrite.description,
  inputSchema: nativeWrite.parameters,
}).server(async (input, context) =>
  nativeWrite.execute(requireToolCallId(context), writeInput.parse(input), context?.abortSignal),
);

export const edit = toolDefinition({
  name: nativeEdit.name,
  description: nativeEdit.description,
  inputSchema: nativeEdit.parameters,
}).server(async (input, context) =>
  nativeEdit.execute(requireToolCallId(context), editInput.parse(input), context?.abortSignal),
);
