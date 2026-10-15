import { Hono, type Context } from "hono";
import type { UIMessage } from "@tanstack/ai";
import { z } from "zod";
import { sideChatTransferBodySchema } from "../shared/side-chat";
import { summarizeTranscript } from "./harness/compaction";
import { modelChatStream } from "./harness/model-turn";
import { discardSideChat, ensureStarted } from "./harness/run";
import { MODEL, RunRequestError } from "./harness/run-store";
import {
  openSideChat,
  releaseSideChatSummary,
  sideChatAdditions,
  trackSideChatSummary,
  transferSideChat,
} from "./harness/side-chat-store";

const FRAGMENT_CHARS = 12_000;
const BATCH_BYTES = 60_000;

const app = new Hono();

function threadId(c: Context, name: string) {
  const value = c.req.param(name);

  if (!z.uuid().safeParse(value).success) {
    throw new RunRequestError(400, "Invalid thread ID");
  }

  return value!;
}

export function summaryBatches(messages: readonly UIMessage[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let bytes = 0;

  for (const message of messages) {
    const json = JSON.stringify(message);

    for (let start = 0; start < json.length; start += FRAGMENT_CHARS) {
      const fragment = json.slice(start, start + FRAGMENT_CHARS);
      const size = Buffer.byteLength(fragment, "utf8");

      if (current.length > 0 && bytes + size > BATCH_BYTES) {
        batches.push(current);
        current = [];
        bytes = 0;
      }

      current.push(fragment);
      bytes += size;
    }
  }

  return current.length > 0 ? [...batches, current] : batches;
}

async function summarizeAdditions(messages: readonly UIMessage[], signal: AbortSignal) {
  let summary: string | null = null;

  for (const transcript of summaryBatches(messages)) {
    summary = await summarizeTranscript({ previousSummary: summary, transcript }, "side-summary", {
      chatStream: modelChatStream,
      model: MODEL,
      signal,
    });
  }

  return summary ?? "";
}

app.onError((error, c) => {
  if (error instanceof RunRequestError) {
    return c.json({ error: error.message }, error.status);
  }

  console.error("Side chat request failed", error);

  return c.json({ error: "Side chat service unavailable" }, 503);
});

app.post("/open/:parentId", async (c) => c.json(await openSideChat(threadId(c, "parentId"))));

app.post("/:id/summary", async (c) => {
  const id = threadId(c, "id");
  const additions = await sideChatAdditions(id);
  const controller = trackSideChatSummary(id);

  try {
    return c.json({ text: await summarizeAdditions(additions, controller.signal) });
  } finally {
    releaseSideChatSummary(id, controller);
  }
});

app.post("/:id/transfer", async (c) => {
  const id = threadId(c, "id");
  const body = sideChatTransferBodySchema.safeParse(await c.req.json().catch(() => null));

  if (!body.success) {
    throw new RunRequestError(400, "Invalid summary text");
  }

  const accepted = await transferSideChat(id, body.data.text);

  if (accepted.pending) {
    await ensureStarted(accepted.run);
  }

  await discardSideChat(id);

  return c.json({ runId: accepted.run.runId });
});

app.delete("/:id", async (c) => {
  await discardSideChat(threadId(c, "id"));

  return c.body(null, 204);
});

export default app;
