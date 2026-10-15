import { generateSystemPrompt, type LibrarySpec } from "@openuidev/lang-core";
import { readFileSync } from "fs";
import { join } from "path";
import { openuiPromptOptions as promptOptions } from "@openuidev/react-ui/genui-lib/prompt-options";

export function codeModeDescription(functionNames: readonly string[]): string {
  return `Run TypeScript in an isolated sandbox to orchestrate tools. Available async functions: ${functionNames.join(", ")}. Await every call and return the final value. The sandbox has no direct network or file API; all file, network, and service operations go through these functions.`;
}

export function codeModeSystemPrompt(input: {
  functions: readonly string[];
  typeDefinitions: string;
}): string {
  return `## Code Mode

Call \`codemode\` with \`{ "code": "<TypeScript>" }\` to run a program that calls several tools and returns only the data you need. For a single simple lookup, call the tool directly.

### Available functions

${input.functions.map((name) => `- \`${name}\``).join("\n")}

### Type definitions

\`\`\`typescript
${input.typeDefinitions}
\`\`\`

### Rules

- Await every \`external_*\` call. Await dependent calls in order; use \`Promise.all\` only for independent reads.
- Use \`return\` to hand back the result. Each execution is independent and keeps no state.
- The sandbox has no direct network or file API. Files, network, and services are reachable only through the \`external_*\` functions.
- Return filtered or summarized data instead of raw tool output.
- Atlassian tools must be discovered with \`discover_atlassian_tools\` in a separate step before they appear as functions.
`;
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
