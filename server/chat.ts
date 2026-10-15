import { DBOS } from "@dbos-inc/dbos-sdk";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { StreamChunk } from "@tanstack/ai";
import {
  toolApprovalDecisionRequestSchema,
  toolApprovalIdSchema,
  toolApprovalTopic,
} from "../shared/tool-approval";
import { acceptRun } from "./harness/run";
import {
  checkCursor,
  compactInstructionsSchema,
  hydrateThread,
  observeRun,
  pendingToolApproval,
  revisionSchema,
  runIdSchema,
  RunRequestError,
  runInputSchema,
} from "./harness/run-store";
import { publishedTasks } from "./harness/testing-store";

const app = new Hono();
const bodySchema = z.object({
  threadId: z.uuid(),
  runId: runIdSchema,
  forwardedProps: z.object({
    baseRevision: revisionSchema,
    kind: z.literal("compact").optional(),
    instructions: compactInstructionsSchema.optional(),
  }),
  messages: z.array(z.unknown()).min(1).max(1000),
  tools: z.array(z.never()).optional(),
  context: z.array(z.never()).optional(),
});
const userSchema = z.object({
  id: z.string().min(1).max(200),
  role: z.literal("user"),
  content: z.union([
    z.string(),
    z.tuple([z.object({ type: z.literal("text"), text: z.string() })]),
  ]),
});

export function parseRunBody(body: unknown, header?: string) {
  const parsed = bodySchema.safeParse(body);

  if (!parsed.success) {
    throw new RunRequestError(400, "Invalid AG-UI run input");
  }

  const input = parsed.data;

  if (header !== undefined && header !== input.runId) {
    throw new RunRequestError(409, "Run header mismatch");
  }

  const { baseRevision, kind, instructions } = input.forwardedProps;

  if (kind === "compact") {
    return runInputSchema.parse({
      kind,
      threadId: input.threadId,
      runId: input.runId,
      baseRevision,
      ...(instructions ? { instructions } : {}),
    });
  }

  const user = userSchema.safeParse(input.messages.at(-1));

  if (!user.success) {
    throw new RunRequestError(400, "A single user text message is required");
  }

  const result = runInputSchema.safeParse({
    threadId: input.threadId,
    runId: input.runId,
    baseRevision,
    message: {
      id: user.data.id,
      text: typeof user.data.content === "string" ? user.data.content : user.data.content[0].text,
    },
  });

  if (!result.success) {
    throw new RunRequestError(400, "Invalid user message");
  }

  return result.data;
}

export function parseCursor(header?: string, offset?: string) {
  const value = header ?? offset;

  if (value === undefined || (header === undefined && value === "-1")) {
    return -1;
  }

  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new RunRequestError(400, "Invalid event cursor");
  }

  const cursor = Number(value);

  if (!Number.isSafeInteger(cursor)) {
    throw new RunRequestError(400, "Invalid event cursor");
  }

  return cursor;
}

export function eventResponse(
  source: (signal: AbortSignal) => AsyncIterable<{ sequence: number; event: StreamChunk }>,
  requestSignal: AbortSignal,
) {
  const detached = new AbortController();
  const signal = AbortSignal.any([requestSignal, detached.signal]);
  const iterator = source(signal)[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();

        if (next.done) {
          controller.close();
        } else {
          controller.enqueue(
            encoder.encode(
              `id: ${next.value.sequence}\ndata: ${JSON.stringify(next.value.event)}\n\n`,
            ),
          );
        }
      } catch (error) {
        controller.error(error);
        detached.abort();
      }
    },
    async cancel() {
      detached.abort();
      await iterator.return?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

app.onError((error, c) => {
  if (error instanceof RunRequestError) {
    return c.json({ error: error.message }, error.status);
  }

  console.error("Chat request failed", error);

  return c.json({ error: "Chat service unavailable" }, 503);
});

app.post("/", async (c) => {
  const input = parseRunBody(await c.req.json().catch(() => null), c.req.header("X-Run-Id"));
  const cursor = parseCursor(c.req.header("Last-Event-ID"));
  await acceptRun(input);
  await checkCursor(input.runId, cursor);

  return eventResponse((signal) => observeRun(input.runId, cursor, signal), c.req.raw.signal);
});

app.post(
  "/approvals/:id/decision",
  bodyLimit({ maxSize: 4_000, onError: (c) => c.json({ error: "Request too large" }, 413) }),
  async (c) => {
    const id = toolApprovalIdSchema.safeParse(c.req.param("id"));
    const body = toolApprovalDecisionRequestSchema.safeParse(await c.req.json().catch(() => null));

    if (!id.success || !body.success) {
      throw new RunRequestError(400, "Invalid approval decision");
    }

    const approval = await pendingToolApproval(id.data, body.data.threadId);
    await DBOS.send(
      approval.workflowId,
      body.data.decision,
      toolApprovalTopic(approval.id),
      `${approval.id}:decision`,
    );

    return c.json({ state: "sent" }, 202);
  },
);

app.get("/", async (c) => {
  const runId = c.req.query("runId");
  const threadId = c.req.query("threadId");

  if (runId !== undefined) {
    const cursor = parseCursor(c.req.header("Last-Event-ID"), c.req.query("offset"));
    await checkCursor(runId, cursor, threadId);

    return eventResponse((signal) => observeRun(runId, cursor, signal), c.req.raw.signal);
  }

  if (threadId === undefined) {
    throw new RunRequestError(400, "A thread or run ID is required");
  }

  const hydrated = await hydrateThread(threadId);

  return c.json({ ...hydrated, publishedTasks: await publishedTasks(threadId) });
});

export default app;
