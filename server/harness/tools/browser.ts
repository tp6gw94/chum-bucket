import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { convertSchemaToJsonSchema, type UIMessage } from "@tanstack/ai";
import { z } from "zod";
import { BrowserSession, type BrowserSessionOptions } from "../browser-session";
import type { ModelTool } from "./atlassian";
import type { RunTools } from ".";

const BROWSER_TOOL = "browser";

const target = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .describe(
    "Semantic description of the element, e.g. 'the add to cart button'. Never a CSS selector.",
  );
const candidateId = z
  .string()
  .regex(/^c\d+$/)
  .optional()
  .describe("Only after selection_required: the candidate id you picked from that list.");
const offset = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe("Only after selection_required with nextOffset: list the next page of candidates.");

const browserInputSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("navigate"), path: z.string().trim().min(1).max(2000) }),
  z.strictObject({ action: z.literal("click"), target, candidateId, offset }),
  z.strictObject({
    action: z.literal("fill"),
    target,
    value: z.string().max(2000),
    candidateId,
    offset,
  }),
  z.strictObject({
    action: z.literal("read"),
    observation: z.enum(["url", "text", "value", "visible", "operable"]),
    target: target.optional(),
    candidateId,
    offset,
  }),
]);

const inputSchema = convertSchemaToJsonSchema(browserInputSchema);

if (!inputSchema) {
  throw new Error("Browser tool schema is unavailable");
}

const definition: ModelTool = {
  name: BROWSER_TOOL,
  description:
    "Operate the page under test in a real browser. navigate opens a same-origin path. click, fill and read take a semantic target; Jev maps it to one element. When Jev is unsure the result is selection_required with candidates: pick one by calling again with the same action, target and candidateId, page with offset when nextOffset is present, or report the step as blocked. read url needs no target. Every observed result has an observation id; cite those ids in your report.",
  inputSchema,
};

function browserStateOf(part: UIMessage["parts"][number]): unknown {
  if (part.type !== "tool-result" || typeof part.content !== "string") {
    return undefined;
  }

  try {
    return (JSON.parse(part.content) as { state?: unknown }).state;
  } catch {
    return undefined;
  }
}

export function browserObservations(messages: readonly UIMessage[]): unknown[] {
  return messages.flatMap((message) =>
    message.parts.flatMap((part) =>
      part.type === "tool-result" && browserStateOf(part) === "observed"
        ? [(JSON.parse(part.content as string) as { observation: unknown }).observation]
        : [],
    ),
  );
}

function sessionExistedBefore(messages: readonly UIMessage[]): boolean {
  return messages.some((message) =>
    message.parts.some((part) =>
      ["observed", "selection_required"].includes(String(browserStateOf(part))),
    ),
  );
}

type BrowserTools = Readonly<{ tools: RunTools; close: () => Promise<void> }>;

type BrowserToolOptions = BrowserSessionOptions &
  Readonly<{ executionId: string; markerDir: string }>;

function priorResults(messages: readonly UIMessage[]): number {
  return messages.reduce(
    (count, message) => count + message.parts.filter((part) => part.type === "tool-result").length,
    0,
  );
}

async function claimExecution(
  options: BrowserToolOptions,
  messages: readonly UIMessage[],
  callId: string,
): Promise<void> {
  const digest = createHash("sha256")
    .update(`${options.executionId}\0${callId}\0${priorResults(messages)}`)
    .digest("hex");
  await mkdir(options.markerDir, { recursive: true });

  try {
    await writeFile(join(options.markerDir, digest), "", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Prior browser execution may have produced effects; replay is forbidden");
    }

    throw error;
  }
}

export function createBrowserTools(options: BrowserToolOptions): BrowserTools {
  let session: Promise<BrowserSession> | undefined;

  function openSession(): Promise<BrowserSession> {
    const opening = BrowserSession.open(options);
    session = opening;
    opening.catch(() => {
      if (session === opening) {
        session = undefined;
      }
    });

    return opening;
  }

  return {
    tools: {
      getModelTools: async () => ({ definitions: [definition], systemPrompt: "" }),
      async executeTool(messages, call, context) {
        if (call.name !== BROWSER_TOOL) {
          throw new Error(`Unknown tool ${call.name}`);
        }

        const action = browserInputSchema.parse(call.input);

        if (!session && sessionExistedBefore(messages)) {
          throw new Error(
            "The browser session was lost after a restart; earlier actions cannot be replayed. Report the remaining checks as blocked.",
          );
        }

        await claimExecution(options, messages, call.id);
        const browser: BrowserSession = await (session ?? openSession());

        return browser.perform(action, context.abortSignal ?? AbortSignal.timeout(35_000));
      },
    },
    async close() {
      const opened: BrowserSession | undefined = await session?.catch(() => undefined);
      await opened?.close();
    },
  };
}
