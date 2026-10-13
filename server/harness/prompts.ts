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

type CodeModePromptInput = Readonly<{
  functions: readonly Readonly<{ name: string; description: string }>[];
  typeDefinitions: string;
}>;

export function codeModeDescription(functionNames: readonly string[]): string {
  return `Execute TypeScript in a secure sandbox. Pass the program as JSON \`{"code": "<typescript>"}\`. The code can call these async external functions: ${functionNames.join(", ")}. All external_* calls must be awaited. Return a value to pass results back. Use console.log() for debugging.`;
}

export function codeModeSystemPrompt(input: CodeModePromptInput): string {
  const catalog = input.functions
    .map((definition) => `- \`${definition.name}(input)\`: ${definition.description}`)
    .join("\n");

  return `## Code Execution Tool

Call \`codemode\` with JSON \`{ "code": "<typescript>" }\`. The \`code\` field runs in a sandboxed environment.

Inside the code, these async functions are available:

${catalog}

### Type Definitions

\`\`\`typescript
${input.typeDefinitions}
\`\`\`

### Notes

- All \`external_*\` calls are async and must be awaited.
- Await calls that depend on each other in order. Use \`Promise.all\` only for independent reads.
- Return a value to pass results back.
- \`console.log()\` output is captured.
- The sandbox has no direct network or filesystem access. Every file, network, or service operation goes through an \`external_*\` function.
- Each execution is independent.`;
}
