import { Hono, type Context } from "hono";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { z } from "zod";
import type { StreamChunk } from "@tanstack/ai";
import { acceptRun } from "./harness/run";
import { approvalDecisionKey, toolApprovalDecisionSchema } from "../shared/tool-approval";
import type {
  ToolApprovalDecision,
  ToolApprovalRequest,
  ToolApprovalView,
} from "../shared/tool-approval";
import {
  checkCursor,
  hydrateThread,
  observeRun,
  readToolApprovalRequest,
  readToolApprovals,
  RunRequestError,
  chatInputSchema,
  compactInputSchema,
} from "./harness/run-store";

const app = new Hono();
export const compact = new Hono();
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
  const result = compactInputSchema.safeParse(body);

  if (!result.success) {
    throw new RunRequestError(400, "Invalid compact command");
  }

  if (header !== undefined && header !== result.data.runId) {
    throw new RunRequestError(409, "Run header mismatch");
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

const requestError: Parameters<typeof app.onError>[0] = (error, c) => {
  if (error instanceof RunRequestError) {
    return c.json({ error: error.message }, error.status);
  }

  console.error("Chat request failed", error);

  return c.json({ error: "對話服務暫時無法使用" }, 503);
};

app.onError(requestError);
compact.onError(requestError);
compact.post("/", async (c) => {
  const input = parseCompactBody(await c.req.json().catch(() => null), c.req.header("X-Run-Id"));
  const cursor = parseCursor(c.req.header("Last-Event-ID"));
  await acceptRun(input);
  await checkCursor(input.runId, cursor);

  return eventResponse((signal) => observeRun(input.runId, cursor, signal), c.req.raw.signal);
});

function requireApprovalDecisionOrigin(c: Context) {
  if (c.req.header("X-Tool-Approval") !== "1") {
    throw new RunRequestError(409, "Same-origin main thread required");
  }

  const origin = c.req.header("Origin");
  const referer = c.req.header("Referer");
  const claimed = origin || (referer ? URL.parse(referer)?.origin : undefined);
  const sameFetchSite = c.req.header("Sec-Fetch-Site") === "same-origin";
  const sameOrigin = claimed !== undefined && claimed === new URL(c.req.url).origin;

  if (!sameFetchSite && !sameOrigin) {
    throw new RunRequestError(409, "Invalid approval origin");
  }
}

async function approvalDecisionCommand(c: Context) {
  const id = z.uuid().safeParse(c.req.param("id"));
  const command = toolApprovalDecisionSchema.safeParse(await c.req.json().catch(() => null));

  if (!id.success || !command.success) {
    throw new RunRequestError(400, "Invalid approval decision");
  }

  return { approvalId: id.data, command: command.data };
}

function boundApproval(
  view: ToolApprovalView | undefined,
  command: ToolApprovalDecision,
): view is ToolApprovalView {
  return (
    !!view &&
    view.tool === command.tool &&
    view.digest === command.digest &&
    view.threadId === command.threadId
  );
}

async function deliverApprovalDecision(
  approval: ToolApprovalView,
  request: ToolApprovalRequest,
  approved: boolean,
): Promise<void> {
  try {
    await DBOS.send(
      request.childWorkflowId,
      {
        approvalId: approval.approvalId,
        tool: approval.tool,
        digest: approval.digest,
        approved,
      },
      request.topic,
      approvalDecisionKey(approval.approvalId),
    );
  } catch {
    throw new RunRequestError(409, "Approval delivery was not accepted");
  }
}

app.post("/approvals/:id/decision", async (c) => {
  requireApprovalDecisionOrigin(c);

  const { approvalId, command } = await approvalDecisionCommand(c);
  const approval = (await readToolApprovals(command.threadId)).find(
    (view) => view.approvalId === approvalId,
  );

  if (!boundApproval(approval, command)) {
    throw new RunRequestError(409, "Approval request mismatch");
  }

  if (approval.state !== "pending") {
    throw new RunRequestError(409, "Approval is no longer pending");
  }

  const request = await readToolApprovalRequest(command.threadId, approvalId);

  if (!request) {
    throw new RunRequestError(409, "Approval request mismatch");
  }

  await deliverApprovalDecision(approval, request, command.approved);

  return c.json({ ok: true, approvalId });
});

app.post("/", async (c) => {
  const input = parseRunBody(await c.req.json().catch(() => null), c.req.header("X-Run-Id"));
  const cursor = parseCursor(c.req.header("Last-Event-ID"));
  await acceptRun(input);
  await checkCursor(input.runId, cursor);

  return eventResponse((signal) => observeRun(input.runId, cursor, signal), c.req.raw.signal);
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

  return c.json(await hydrateThread(threadId));
});

export default app;
