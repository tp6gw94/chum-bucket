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

export const summaryPreambles = {
  compaction: "以下是先前對話的摘要。較早的訊息已移出模型上下文，請以這份摘要接續對話。",
  sideChat:
    "以下是主對話目前的摘要。這是附屬對話，使用者想在不打斷主對話的情況下討論相關問題；需要時請引用摘要中的內容。",
} as const;

const summaryFormat = `Use this exact structure and keep every section, writing "None" when a section is empty:

## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps
## Critical Context`;

export const compactionSystemPrompt = `You compress a long conversation between a user and an AI assistant into a checkpoint summary. Another model will continue the conversation from this summary alone, without the original messages.

Preserve everything needed to continue the work: the user's goals and requests, constraints and preferences, decisions with their reasons, file paths, identifiers, issue keys, URLs, commands, tool results that still matter, errors, and open questions. Drop pleasantries, repetition, and tool output that no longer matters.

If a previous summary is provided, merge it with the new messages into one updated summary instead of summarizing the summary.

Write in the same language the user writes in. Output only the summary.

${summaryFormat}`;

export const sideChatSummarySystemPrompt = `You summarize the main conversation between a user and an AI assistant so that a separate side chat can start with the right background. The side chat will answer the user's follow-up questions without access to the original messages.

Focus on what a newcomer needs to discuss the main conversation: its goal, the current state of the work, decisions and their reasons, important names, file paths, identifiers, URLs, and unresolved questions. If the main conversation already starts with a summary, fold it into yours.

Write in the same language the user writes in. Output only the summary.

${summaryFormat}`;

export type SummaryRequestInput = Readonly<{
  transcript: string;
  previousSummary?: string;
  instructions?: string;
}>;

export function summaryRequestPrompt({
  transcript,
  previousSummary,
  instructions,
}: SummaryRequestInput): string {
  return [
    previousSummary ? `<previous-summary>\n${previousSummary}\n</previous-summary>` : "",
    `<conversation>\n${transcript}\n</conversation>`,
    instructions ? `<user-instructions>\n${instructions}\n</user-instructions>` : "",
    "Write the summary now.",
  ]
    .filter(Boolean)
    .join("\n\n");
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
