import { generateSystemPrompt, type LibrarySpec } from "@openuidev/lang-core";
import { readFileSync } from "fs";
import { join } from "path";
import { openuiPromptOptions as promptOptions } from "@openuidev/react-ui/genui-lib/prompt-options";

export type CodeModeFunction = Readonly<{ name: string; summary: string }>;

export type CodeModePromptInput = Readonly<{
  toolName: string;
  functions: readonly CodeModeFunction[];
  declarations: string;
}>;

export function codeModeToolDescription(functions: readonly CodeModeFunction[]): string {
  return [
    "Run a TypeScript program body in an isolated QuickJS sandbox to orchestrate several tool calls in one step.",
    `Available async functions: ${functions.map((entry) => entry.name).join(", ")}.`,
    "Await every call, return a JSON-serializable value, and use console.log for short notes.",
  ].join(" ");
}

export function codeModeSystemPrompt({
  toolName,
  functions,
  declarations,
}: CodeModePromptInput): string {
  const list = functions.map((entry) => `- \`${entry.name}(input)\`: ${entry.summary}`).join("\n");

  return `## Code Mode

The \`${toolName}\` tool runs a TypeScript program body inside an isolated QuickJS sandbox. Use it when a task needs several tool calls, loops, parallel requests with \`Promise.all\`, or filtering of large tool output before it reaches the conversation. Call a tool directly when a single request is enough.

### Functions

${list}

### Type declarations

\`\`\`typescript
${declarations}
\`\`\`

### Rules

- Write only the program body; top-level \`await\` and \`return\` are allowed.
- Every function above is async and must be awaited. Each one calls the matching tool with the same validation and permissions as a direct call.
- Return a JSON-serializable value; it becomes the tool result. Large results are truncated, so return only the fields you need.
- \`console.log\` output is captured and returned with the result.
- The sandbox has no network, filesystem, timers, or imports beyond these functions, and every run starts with fresh state.
- Execution time, memory, and the number of function calls are limited.
- Tools that require discovery appear here only after their discovery tool has been called directly; never call discovery tools from code.`;
}

export function openuiInstructions(extra?: string): string {
  const library = JSON.parse(
    readFileSync(join(process.cwd(), "src/generated/spec.json"), "utf-8"),
  ) as LibrarySpec;

  return generateSystemPrompt({
    cloud: false,
    library,
    promptOptions,
    ...(extra ? { instructions: extra } : {}),
  });
}
