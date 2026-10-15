import { createReadTool, createWriteTool, createEditTool } from "@earendil-works/pi-coding-agent";
import { toolDefinition, type ToolExecutionContext } from "@tanstack/ai";
import { z } from "zod";

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

const toolOutput = z.object({
  content: z.array(
    z.object({
      type: z.string(),
      text: z.string().optional(),
      data: z.string().optional(),
      mimeType: z.string().optional(),
    }),
  ),
  details: z.unknown().optional(),
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
  outputSchema: toolOutput,
}).server(async (input, context) =>
  nativeRead.execute(requireToolCallId(context), readInput.parse(input), context?.abortSignal),
);

export const write = toolDefinition({
  name: nativeWrite.name,
  description: nativeWrite.description,
  inputSchema: nativeWrite.parameters,
  outputSchema: toolOutput,
}).server(async (input, context) =>
  nativeWrite.execute(requireToolCallId(context), writeInput.parse(input), context?.abortSignal),
);

export const edit = toolDefinition({
  name: nativeEdit.name,
  description: nativeEdit.description,
  inputSchema: nativeEdit.parameters,
  outputSchema: toolOutput,
}).server(async (input, context) =>
  nativeEdit.execute(requireToolCallId(context), editInput.parse(input), context?.abortSignal),
);
