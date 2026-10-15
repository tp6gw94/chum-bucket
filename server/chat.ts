import { DBOS } from "@dbos-inc/dbos-sdk";
import { Hono, type Context, type ErrorHandler } from "hono";
import { z } from "zod";
import type { StreamChunk } from "@tanstack/ai";
import { approvalDecisionKey, toolApprovalDecisionSchema } from "../shared/tool-approval";
import { acceptRun } from "./harness/run";
import {
  checkCursor,
  hydrateThread,
  observeRun,
  RunRequestError,
  chatInputSchema,
  compactInputSchema,
} from "./harness/run-store";
import { readToolApprovalRequest, readToolApprovals } from "./harness/tool-approval-store";

const app = new Hono();
const bodySchema = z.object({
  threadId: z.uuid(),
  runId: chatInputSchema.shape.runId,
  forwardedProps: z.object({ baseRevision: chatInputSchema.shape.baseRevision }),
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

  const user = userSchema.safeParse(input.messages.at(-1));

  if (!user.success) {
    throw new RunRequestError(400, "A single user text message is required");
  }

  const result = chatInputSchema.safeParse({
    threadId: input.threadId,
    runId: input.runId,
    baseRevision: input.forwardedProps.baseRevision,
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

export function parseCompactBody(body: unknown, header?: string) {
  const parsed = compactInputSchema.safeParse(body);

  if (!parsed.success) {
    throw new RunRequestError(400, "Invalid compact input");
  }

  if (header !== parsed.data.runId) {
    throw new RunRequestError(409, "Run header mismatch");
  }

  return parsed.data;
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

const handleError: ErrorHandler = (error, c) => {
  if (error instanceof RunRequestError) {
    return c.json({ error: error.message }, error.status);
  }

  console.error("Chat request failed", error);

  return c.json({ error: "Chat service unavailable" }, 503);
};

async function startRun(c: Context, input: Parameters<typeof acceptRun>[0]) {
  const cursor = parseCursor(c.req.header("Last-Event-ID"));
  await acceptRun(input);
  await checkCursor(input.runId, cursor);

  return eventResponse((signal) => observeRun(input.runId, cursor, signal), c.req.raw.signal);
}

function trustedApprovalRequest(c: Context): boolean {
  return (
    c.req.header("X-Tool-Approval") === "1" &&
    (c.req.header("Sec-Fetch-Site") === "same-origin" ||
      c.req.header("Origin") === new URL(c.req.url).origin)
  );
}

function parseApprovalDecision(c: Context, id: string, body: unknown) {
  if (!trustedApprovalRequest(c)) {
    throw new RunRequestError(409, "Approval request is not from this application");
  }

  const approvalId = z.uuid().safeParse(id);
  const decision = toolApprovalDecisionSchema.safeParse(body);

  if (!approvalId.success || !decision.success) {
    throw new RunRequestError(400, "Invalid approval decision");
  }

  return { approvalId: approvalId.data, decision: decision.data };
}

app.onError(handleError);

app.post("/approvals/:id/decision", async (c) => {
  const { approvalId, decision } = parseApprovalDecision(
    c,
    c.req.param("id"),
    await c.req.json().catch(() => null),
  );
  const approval = await readToolApprovalRequest(approvalId);

  if (
    !approval ||
    approval.state !== "pending" ||
    approval.tool !== decision.tool ||
    approval.digest !== decision.digest ||
    approval.threadId !== decision.threadId
  ) {
    throw new RunRequestError(409, "Approval is not pending or does not match");
  }

  try {
    await DBOS.send(
      approval.childWorkflowId,
      { approvalId, tool: decision.tool, digest: decision.digest, approved: decision.approved },
      approval.topic,
      approvalDecisionKey(approvalId),
    );
  } catch {
    throw new RunRequestError(409, "Approval decision was not recorded");
  }

  return c.json({ accepted: true }, 202);
});

app.post("/", async (c) =>
  startRun(c, parseRunBody(await c.req.json().catch(() => null), c.req.header("X-Run-Id"))),
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

  return c.json({ ...hydrated, approvals: await readToolApprovals(threadId) });
});

export const compact = new Hono();

compact.onError(handleError);

compact.post("/", async (c) =>
  startRun(c, parseCompactBody(await c.req.json().catch(() => null), c.req.header("X-Run-Id"))),
);

export default app;
