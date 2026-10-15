import { generateSystemPrompt, type LibrarySpec } from "@openuidev/lang-core";
import { readFileSync } from "fs";
import { join } from "path";
import { openuiPromptOptions as promptOptions } from "@openuidev/react-ui/genui-lib/prompt-options";

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

export function codeModeDescription(functionNames: readonly string[]): string {
  return [
    "Run TypeScript in an isolated sandbox to orchestrate several tool calls in one step.",
    `Call with { code }. Available async functions: ${functionNames.join(", ")}.`,
    "Await every external_* call and use `return` to hand back a compact result.",
  ].join(" ");
}

export function codeModeSystemPrompt(input: {
  functions: readonly string[];
  typeDefinitions: string;
}): string {
  return [
    "## Code Mode",
    "",
    "Use the `codemode` tool with `{ code }` when a task needs loops, conditions, or combining results from several tools. Simple single lookups can still call the original tools directly.",
    "",
    "Rules:",
    "- The code runs as the body of an async function; `await` every `external_*` call.",
    "- Await calls that depend on each other in order. Use `Promise.all` only for independent reads.",
    "- Use `return` to hand back the result. Return only what the answer needs, not raw tool payloads.",
    "- Every execution starts fresh; variables do not survive between `codemode` calls.",
    "- The sandbox has no direct network, file, process, or module APIs. Every file, network, or service operation goes through an `external_*` function, and those functions can still read and write files with the same permissions as the original tools.",
    "- Atlassian functions only appear after `discover_atlassian_tools` has returned them in an earlier step; call discovery outside `codemode`.",
    "",
    `Available functions: ${input.functions.join(", ")}`,
    "",
    "```typescript",
    input.typeDefinitions,
    "```",
  ].join("\n");
}
