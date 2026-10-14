import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  createEditTool,
  createReadTool,
  createWriteTool,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { toolDefinition, type JSONSchema } from "@tanstack/ai";

type PiTool = {
  name: string;
  description: string;
  parameters: object;
  prepareArguments?: (args: unknown) => unknown;
  execute: (
    toolCallId: string,
    params: never,
    signal?: AbortSignal,
  ) => Promise<AgentToolResult<unknown>>;
};

function insideRoot(root: string, absolutePath: string): string {
  const path = relative(root, absolutePath);

  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error(`路徑超出工作區範圍：${absolutePath}`);
  }

  return absolutePath;
}

function contentToText(result: AgentToolResult<unknown>): string {
  return result.content
    .map((part) => (part.type === "text" ? part.text : `[image ${part.mimeType}]`))
    .join("\n");
}

function toTanStackTool(tool: PiTool) {
  return toolDefinition({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as JSONSchema,
  }).server(async (args, context) => {
    const params = tool.prepareArguments ? tool.prepareArguments(args) : args;
    const result = await tool.execute(
      context?.toolCallId ?? crypto.randomUUID(),
      params as never,
      context?.abortSignal,
    );

    return contentToText(result);
  });
}

export function createFsTools(workspace: string) {
  const root = resolve(workspace);
  const guard = (absolutePath: string) => insideRoot(root, absolutePath);

  const read = createReadTool(root, {
    operations: {
      readFile: (path) => readFile(guard(path)),
      access: (path) => access(guard(path), constants.R_OK),
    },
  });

  const write = createWriteTool(root, {
    operations: {
      writeFile: (path, content) => writeFile(guard(path), content, "utf-8"),
      mkdir: async (dir) => {
        await mkdir(guard(dir), { recursive: true });
      },
    },
  });

  const edit = createEditTool(root, {
    operations: {
      readFile: (path) => readFile(guard(path)),
      writeFile: (path, content) => writeFile(guard(path), content, "utf-8"),
      access: (path) => access(guard(path), constants.R_OK | constants.W_OK),
    },
  });

  return [read, write, edit].map(toTanStackTool);
}
