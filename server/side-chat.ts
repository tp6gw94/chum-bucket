import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { sideTransferSchema } from "../shared/side-chat";
import {
  RunRequestError,
  openSideChat,
  readSideTranscript,
  transferSideSummary,
} from "./harness/run-store";
import { discardSideChat, ensureStarted, trackSideSummary } from "./harness/run";
import { summarizeTranscript } from "./harness/compaction";

const FRAGMENT_CHARS = 12_000;
const BATCH_BYTES = 60_000;

const app = new Hono();
app.use("*", bodyLimit({ maxSize: 40_000 }));
app.onError((error, c) => {
  if (error instanceof RunRequestError) {
    return c.json({ error: error.message }, error.status);
  }

  console.error("Side chat request failed", error);

  return c.json({ error: "附屬對話操作失敗，草稿已保留。" }, 503);
});

function sideId(value: string) {
  const parsed = z.uuid().safeParse(value);

  if (!parsed.success) {
    throw new RunRequestError(400, "Invalid side chat ID");
  }

  return parsed.data;
}

app.post("/open/:parentId", async (c) =>
  c.json(await openSideChat(sideId(c.req.param("parentId")))),
);

app.post("/:id/summary", async (c) => {
  const id = sideId(c.req.param("id"));

  return c.json(
    await trackSideSummary(id, async (signal) => {
      const transcript = await readSideTranscript(id);
      let text: string | null = null;
      let batch = [] as typeof transcript;
      let bytes = 0;

      async function flush() {
        if (!batch.length) {
          return;
        }

        text = await summarizeTranscript(
          { previousSummary: text, transcript: batch },
          "side-summary",
          signal,
        );
        batch = [];
        bytes = 0;
      }

      for (const message of transcript) {
        const original = JSON.stringify(message);

        for (let offset = 0; offset < original.length; offset += FRAGMENT_CHARS) {
          const fragment = {
            id: `${message.id}/fragment/${offset}`,
            role: "user" as const,
            parts: [
              { type: "text" as const, content: original.slice(offset, offset + FRAGMENT_CHARS) },
            ],
          };
          const size = Buffer.byteLength(JSON.stringify(fragment));

          if (bytes + size > BATCH_BYTES) {
            await flush();
          }

          batch.push(fragment);
          bytes += size;
        }
      }

      await flush();

      return { text: text! };
    }),
  );
});

app.post("/:id/transfer", async (c) => {
  const input = sideTransferSchema.safeParse(await c.req.json().catch(() => null));

  if (!input.success) {
    throw new RunRequestError(400, "Invalid summary transfer");
  }

  const id = sideId(c.req.param("id"));
  const accepted = await transferSideSummary(id, input.data.text);

  if (accepted.pending) {
    await ensureStarted(accepted.run).catch((error: unknown) =>
      console.error("Accepted transfer awaits reconciliation", error),
    );
  }

  void discardSideChat(id).catch((error: unknown) =>
    console.error("Accepted transfer cleanup retries via the side scanner", error),
  );

  return c.json({ runId: accepted.run.runId });
});

app.delete("/:id", async (c) => {
  await discardSideChat(sideId(c.req.param("id")));

  return c.json({ discarded: true });
});

export default app;
