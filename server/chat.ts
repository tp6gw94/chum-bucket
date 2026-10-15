import { DBOS } from "@dbos-inc/dbos-sdk";
import { Hono } from "hono";
import { z } from "zod";
import type { StreamChunk } from "@tanstack/ai";
import { toolApprovalDecisionSchema, type ToolApprovalDecision } from "../shared/tool-approval";
import { acceptRun } from "./harness/run";
import {
  baseRevisionSchema,
  chatInputSchema,
  checkCursor,
  compactInputSchema,
  hydrateThread,
  observeRun,
  RunRequestError,
  runIdSchema,
} from "./harness/run-store";
import { findToolApproval, readRunApprovals } from "./harness/tool-approval-store";

const app = new Hono();
export const compact = new Hono();
const bodySchema = z.object({
  threadId: z.uuid(),
  runId: runIdSchema,
  forwardedProps: z.object({ baseRevision: baseRevisionSchema }),
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

function parseCompactBody(body: unknown, header?: string) {
  const parsed = compactInputSchema.safeParse(body);

  if (!parsed.success) {
    throw new RunRequestError(400, "Invalid compact run input");
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

function onRunError(error: Error, c: Parameters<Parameters<typeof app.onError>[0]>[1]) {
  if (error instanceof RunRequestError) {
    return c.json({ error: error.message }, error.status);
  }

  console.error("Chat request failed", error);

  return c.json({ error: "Chat service unavailable" }, 503);
}

app.onError(onRunError);
compact.onError(onRunError);

compact.post("/", async (c) => {
  const input = parseCompactBody(await c.req.json().catch(() => null), c.req.header("X-Run-Id"));
  const cursor = parseCursor(c.req.header("Last-Event-ID"));
  await acceptRun(input);
  await checkCursor(input.runId, cursor);

  return eventResponse((signal) => observeRun(input.runId, cursor, signal), c.req.raw.signal);
});

app.post("/", async (c) => {
  const input = parseRunBody(await c.req.json().catch(() => null), c.req.header("X-Run-Id"));
  const cursor = parseCursor(c.req.header("Last-Event-ID"));
  await acceptRun(input);
  await checkCursor(input.runId, cursor);

  return eventResponse((signal) => observeRun(input.runId, cursor, signal), c.req.raw.signal);
});

function assertSameOrigin(headers: Headers, url: string) {
  if (headers.get("X-Tool-Approval") !== "1") {
    throw new RunRequestError(409, "Approval header is required");
  }

  if (
    headers.get("Sec-Fetch-Site") !== "same-origin" &&
    headers.get("Origin") !== new URL(url).origin
  ) {
    throw new RunRequestError(409, "Approval must come from this site");
  }
}

function parseDecision(id: string, body: unknown): ToolApprovalDecision {
  const decision = toolApprovalDecisionSchema.safeParse(body);

  if (!z.uuid().safeParse(id).success || !decision.success) {
    throw new RunRequestError(400, "Invalid approval decision");
  }

  return decision.data;
}

async function deliverDecision(id: string, decision: ToolApprovalDecision) {
  const approval = await findToolApproval(id);
  const request = approval?.request;

  if (
    !request ||
    approval.state !== "pending" ||
    request.threadId !== decision.threadId ||
    request.tool !== decision.tool ||
    request.digest !== decision.digest
  ) {
    throw new RunRequestError(409, "Approval is not pending or does not match");
  }

  await DBOS.send(
    request.workflowId,
    { approvalId: id, tool: decision.tool, digest: decision.digest, approved: decision.approved },
    request.topic,
    `approval-decision:${id}`,
  ).catch(() => {
    throw new RunRequestError(409, "Approval decision was not delivered");
  });
}

app.post("/approvals/:id/decision", async (c) => {
  assertSameOrigin(c.req.raw.headers, c.req.url);
  const decision = parseDecision(c.req.param("id"), await c.req.json().catch(() => null));
  await deliverDecision(c.req.param("id"), decision);

  return c.json({ delivered: true }, 202);
});

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
  const approvals = hydrated.activeRun ? await readRunApprovals(hydrated.activeRun.runId) : [];

  return c.json({ ...hydrated, approvals });
});

export default app;
