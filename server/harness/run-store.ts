import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { EventType, type StreamChunk, type UIMessage } from "@tanstack/ai";
import { z } from "zod";
import {
  chatEventsTable,
  chatModelSlotsTable,
  chatRunsTable,
  sideChatsTable,
  sideTransfersTable,
  threadsTable,
} from "../db/schema";
import {
  SIDE_LEASE_MS,
  classifySideConversation,
  originalSideTranscript,
  type SideAccess,
  type SideChatSeed,
  type SideFence,
  type SummaryDraft,
  type TransferReceipt,
} from "../../shared/side-chat";
import { openuiInstructions } from "./prompts";
import { snapshot } from "./model-turn";
import { projectConversation, readProjection, type ConversationState } from "./conversation";
import { compactionEvent, parseCompactionEvent } from "../../shared/compaction-event";

export const PREVIOUS_BUILD = "durable-chat-loop-v9";
export const BUILD = "durable-chat-loop-v10";
export const MODEL = "deepseek-ai/DeepSeek-V4.1-Flash";
const runIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
const runIdentity = {
  threadId: z.uuid(),
  runId: runIdSchema,
  baseRevision: z.number().int().nonnegative().max(2_000_000_000),
};
export const chatInputSchema = z
  .object({
    ...runIdentity,
    kind: z.literal("chat").default("chat"),
    message: z
      .object({ id: z.string().min(1).max(200), text: z.string().trim().min(1).max(32_000) })
      .strict(),
  })
  .strict();
export const compactInputSchema = z.object({ ...runIdentity, kind: z.literal("compact") }).strict();
const runInputSchema = z.union([chatInputSchema, compactInputSchema]);
export type RunInput = z.input<typeof runInputSchema>;
export type AcceptedRun = z.output<typeof runInputSchema> & {
  messages: UIMessage[];
  context: UIMessage[];
  prompt: string;
  model: typeof MODEL;
  build: typeof BUILD | typeof PREVIOUS_BUILD;
  side?: SideFence;
};
type RunRow = typeof chatRunsTable.$inferSelect;
type ThreadRow = typeof threadsTable.$inferSelect;
type SideRow = typeof sideChatsTable.$inferSelect;
type Transaction = Parameters<Parameters<typeof import("../db").db.transaction>[0]>[0];
export const database = async () => (await import("../db")).db;

export class RunRequestError extends Error {
  constructor(
    public status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

async function lockRun(tx: Transaction, id: string): Promise<{ run: RunRow; thread: ThreadRow }> {
  const [found] = await tx
    .select({ thread_id: chatRunsTable.thread_id })
    .from(chatRunsTable)
    .where(eq(chatRunsTable.id, id));
  if (!found) {
    throw new RunRequestError(404, "Unknown run");
  }
  const side = await lockSide(tx, found.thread_id);
  const [thread] = await tx
    .select()
    .from(threadsTable)
    .where(eq(threadsTable.id, found.thread_id))
    .for("update");
  const [run] = await tx.select().from(chatRunsTable).where(eq(chatRunsTable.id, id)).for("update");
  if (side) {
    assertSideOpen(side, { scope: run?.accepted.side?.scope ?? "" });
    if (run?.accepted.side?.epoch !== side.epoch) {
      throw new RunRequestError(409, "Side chat execution expired");
    }
  }
  return { run: run!, thread: thread! };
}

function assertThreadClaim(run: RunRow, thread: ThreadRow) {
  if (thread.active_run_id !== run.id || thread.revision !== run.request.baseRevision) {
    throw new Error("Thread claim changed");
  }
}

async function appendEvent(tx: Transaction, run: RunRow, key: string, event: StreamChunk) {
  if (run.state !== "pending") {
    throw new Error("Run is terminal");
  }
  const bytes = Buffer.byteLength(JSON.stringify(event));
  await tx.insert(chatEventsTable).values({
    run_id: run.id,
    sequence: run.next_sequence,
    event_key: key,
    payload: event,
  });
  await tx
    .update(chatRunsTable)
    .set({
      next_sequence: sql`${chatRunsTable.next_sequence} + 1`,
      log_bytes: sql`${chatRunsTable.log_bytes} + ${bytes}`,
    })
    .where(eq(chatRunsTable.id, run.id));
  run.next_sequence++;
  run.log_bytes += bytes;
}

async function committedModelContext(tx: Transaction, thread: ThreadRow): Promise<UIMessage[]> {
  if (thread.revision === 0 && thread.parent_thread_id) {
    const [side] = await tx.select().from(sideChatsTable).where(eq(sideChatsTable.id, thread.id));
    if (!side?.seed || !isDeepStrictEqual(side.seed.display, thread.messages)) {
      throw new RunRequestError(409, "Invalid side chat seed anchor");
    }
    return side.seed.context;
  }
  const marked = await tx
    .select()
    .from(chatRunsTable)
    .where(
      and(
        eq(chatRunsTable.thread_id, thread.id),
        sql`${chatRunsTable.projection}->>'committedRevision' = ${String(thread.revision)}`,
      ),
    );
  const anchors = marked.length
    ? marked
    : await tx
        .select()
        .from(chatRunsTable)
        .where(
          and(
            eq(chatRunsTable.thread_id, thread.id),
            eq(chatRunsTable.state, "succeeded"),
            sql`${chatRunsTable.request}->>'baseRevision' = ${String(thread.revision - 1)}`,
          ),
        );
  if (anchors.length > 1) {
    throw new RunRequestError(409, "Ambiguous conversation context anchor");
  }
  const anchor = anchors[0];
  if (!anchor || Array.isArray(anchor.projection)) {
    if (thread.messages.some((message) => message.metadata?.fromSummary === true)) {
      throw new RunRequestError(409, "Archived summaries require a conversation context anchor");
    }
    return thread.messages;
  }
  if (anchor.state === "pending" || anchor.request.baseRevision !== thread.revision - 1) {
    throw new RunRequestError(409, "Invalid conversation context anchor");
  }
  const prior = readProjection(anchor.projection);
  if (!isDeepStrictEqual(prior.display, thread.messages)) {
    throw new RunRequestError(409, "Conversation context anchor does not match saved history");
  }
  return prior.context;
}

export async function persistRun(value: RunInput, access?: SideAccess) {
  const parsed = runInputSchema.safeParse(value);
  if (!parsed.success) {
    throw new RunRequestError(400, "Invalid run input");
  }
  const input = parsed.data;
  const db = await database();
  const accepted = await db.transaction(async (tx) => {
    const side = await lockSide(tx, input.threadId);
    if (side) {
      assertSideOpen(side, access);
    }
    const [thread] = await tx
      .select()
      .from(threadsTable)
      .where(eq(threadsTable.id, input.threadId))
      .for("update");
    if (!thread) {
      throw new RunRequestError(404, "Unknown thread");
    }
    const [existing] = await tx
      .select()
      .from(chatRunsTable)
      .where(eq(chatRunsTable.id, input.runId));
    if (existing) {
      if (!isDeepStrictEqual(runInputSchema.parse(existing.request), input)) {
        throw new RunRequestError(409, "Run input collision");
      }
      return { run: existing.accepted, pending: existing.state === "pending" };
    }
    return acceptInTransaction(tx, thread, input, side);
  });
  return accepted;
}

async function acceptInTransaction(
  tx: Transaction,
  thread: ThreadRow,
  input: z.output<typeof runInputSchema>,
  side?: SideRow,
  metadata?: Record<string, unknown>,
) {
  if (thread.revision !== input.baseRevision || thread.active_run_id) {
    throw new RunRequestError(409, "Thread revision or claim conflict");
  }
  const priorContext = await committedModelContext(tx, thread);
  const additions: UIMessage[] =
    input.kind === "chat"
      ? [
          {
            id: input.message.id,
            role: "user",
            parts: [{ type: "text", content: input.message.text }],
            ...(metadata ? { metadata } : {}),
          },
        ]
      : [];
  if (
    additions.some((message) =>
      [...thread.messages, ...priorContext].some((entry) => entry.id === message.id),
    )
  ) {
    throw new RunRequestError(409, "Message ID already exists in history or context");
  }
  const run: AcceptedRun = {
    ...input,
    messages: [...thread.messages, ...additions],
    context: [...priorContext, ...additions],
    prompt: openuiInstructions(),
    model: MODEL,
    build: BUILD,
    ...(side ? { side: { epoch: side.epoch, scope: side.page_scope } } : {}),
  };
  if (side?.seed) {
    run.messages = classifySideConversation(run.messages, side.seed, thread.id);
    const byId = new Map(run.messages.map((message) => [message.id, message]));
    run.context = run.context.map((message) => ({
      ...message,
      metadata: byId.get(message.id)?.metadata ?? message.metadata,
    }));
  }
  const [inserted] = await tx
    .insert(chatRunsTable)
    .values({
      id: run.runId,
      thread_id: run.threadId,
      request: input,
      accepted: run,
      projection: projectConversation({ display: run.messages, context: run.context }),
    })
    .onConflictDoNothing({ target: chatRunsTable.id })
    .returning();
  if (!inserted) {
    throw new RunRequestError(409, "Run ID collision");
  }
  await tx
    .update(threadsTable)
    .set({ active_run_id: run.runId })
    .where(eq(threadsTable.id, run.threadId));
  await appendEvent(tx, inserted, "started", {
    type: EventType.RUN_STARTED,
    threadId: run.threadId,
    runId: run.runId,
  });
  return { run, pending: true };
}

export async function emit(runId: string, event: StreamChunk, conversation?: ConversationState) {
  const db = await database();
  await db.transaction(async (tx) => {
    const { run } = await lockRun(tx, runId);
    if (conversation) {
      conversation = await classifyProjection(tx, run, conversation);
      if (event.type === EventType.MESSAGES_SNAPSHOT) {
        event = snapshot(conversation.display);
      }
    }
    await appendEvent(tx, run, randomUUID(), event);
    if (conversation) {
      await tx
        .update(chatRunsTable)
        .set({ projection: projectConversation(conversation) })
        .where(eq(chatRunsTable.id, runId));
    }
  });
}

export async function checkpointCompaction(
  runId: string,
  operationId: string,
  conversation: ConversationState,
  state: "done" | "failed" | "skipped",
) {
  const db = await database();
  await db.transaction(async (tx) => {
    const { run, thread } = await lockRun(tx, runId);
    conversation = await classifyProjection(tx, run, conversation);
    const key = `compact:${operationId}`;
    const [receipt] = await tx
      .select()
      .from(chatEventsTable)
      .where(and(eq(chatEventsTable.run_id, runId), eq(chatEventsTable.event_key, key)));
    if (receipt) {
      if (
        !isDeepStrictEqual(parseCompactionEvent(receipt.payload), { runId, operationId, state })
      ) {
        throw new Error("Compaction receipt outcome mismatch");
      }
      return;
    }
    assertThreadClaim(run, thread);
    if (state === "done") {
      await tx
        .update(chatRunsTable)
        .set({ projection: projectConversation(conversation) })
        .where(eq(chatRunsTable.id, runId));
      await appendEvent(tx, run, `${key}:snapshot`, snapshot(conversation.display));
    }
    await appendEvent(tx, run, key, compactionEvent({ runId, operationId, state }));
  });
}

export function nextThreadTitle(input: {
  current: string;
  history: readonly UIMessage[];
  accepted: readonly UIMessage[];
}): string {
  if (input.current !== "" && input.history.length > 0) {
    return input.current;
  }
  return threadTitle(input.accepted);
}

function threadTitle(messages: readonly UIMessage[]): string {
  for (const message of messages) {
    if (message.role !== "user" || message.metadata?.fromSummary === true) {
      continue;
    }
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.content)
      .join("");
    if (text !== "") {
      return text.slice(0, 10);
    }
  }
  return "新對話";
}

async function failedConversation(
  tx: Transaction,
  run: RunRow,
): Promise<ConversationState | undefined> {
  const receipts = await tx
    .select()
    .from(chatEventsTable)
    .where(eq(chatEventsTable.run_id, run.id));
  const committed = receipts.some((receipt) => {
    const event = parseCompactionEvent(receipt.payload);
    return (
      receipt.event_key === `compact:${event?.operationId}` &&
      event?.runId === run.id &&
      event.state === "done"
    );
  });
  return committed ? readProjection(run.projection) : undefined;
}

export async function finishRun(
  runId: string,
  conversation?: ConversationState,
  code = "execution_failed",
) {
  const succeeded = conversation !== undefined;
  const db = await database();
  await db.transaction(async (tx) => {
    const { run, thread } = await lockRun(tx, runId);
    if (run.state !== "pending") {
      return;
    }
    assertThreadClaim(run, thread);
    let committed =
      conversation ??
      (await failedConversation(tx, run)) ??
      (run.accepted.messages.at(-1)?.metadata?.sideChatTransfer
        ? { display: run.accepted.messages, context: run.accepted.context }
        : undefined);
    if (committed) {
      committed = await classifyProjection(tx, run, committed);
    }
    const messages = committed?.display;
    if (messages) {
      const title =
        run.request.kind === "compact"
          ? thread.title
          : nextThreadTitle({
              current: thread.title,
              history: thread.messages,
              accepted: run.accepted.messages,
            });
      await appendEvent(tx, run, "finished:snapshot", snapshot(messages));
      await tx
        .update(threadsTable)
        .set({
          messages,
          title,
          revision: sql`${threadsTable.revision} + 1`,
          active_run_id: null,
          updated_at: sql`now()`,
        })
        .where(eq(threadsTable.id, thread.id));
    } else {
      await appendEvent(
        tx,
        run,
        "failed:snapshot",
        snapshot(readProjection(run.projection).display),
      );
      await tx
        .update(threadsTable)
        .set({ active_run_id: null })
        .where(eq(threadsTable.id, thread.id));
    }
    await appendEvent(
      tx,
      run,
      "terminal",
      succeeded
        ? { type: EventType.RUN_FINISHED, threadId: thread.id, runId }
        : {
            type: EventType.RUN_ERROR,
            message: "執行失敗，請重新連線查看已儲存的內容。",
            code,
            metadata: { tanstack: { runId, threadId: thread.id } },
          },
    );
    if (committed) {
      await tx
        .update(chatRunsTable)
        .set({
          projection: { ...projectConversation(committed), committedRevision: thread.revision + 1 },
        })
        .where(eq(chatRunsTable.id, runId));
    }
    await tx
      .update(chatRunsTable)
      .set({ state: succeeded ? "succeeded" : "failed" })
      .where(eq(chatRunsTable.id, runId));
  });
}

export async function listPendingRuns() {
  const db = await database();
  return db
    .select()
    .from(chatRunsTable)
    .where(
      and(
        eq(chatRunsTable.state, "pending"),
        sql`not exists (select 1 from ${sideChatsTable} where ${sideChatsTable.id} = ${chatRunsTable.thread_id} and (${sideChatsTable.state} <> 'open' or ${sideChatsTable.lease_until} <= now()))`,
      ),
    )
    .orderBy(chatRunsTable.created_at);
}

export async function hydrateThread(threadId: string, access?: SideAccess) {
  if (!z.uuid().safeParse(threadId).success) {
    throw new RunRequestError(400, "Invalid thread ID");
  }
  const db = await database();
  return db.transaction(async (tx) => {
    const side = await lockSide(tx, threadId);
    if (side) {
      assertSideOpen(side, access);
    }
    const [thread] = await tx
      .select()
      .from(threadsTable)
      .where(eq(threadsTable.id, threadId))
      .for("share");
    if (!thread) {
      throw new RunRequestError(404, "Unknown thread");
    }
    let messages = thread.messages;
    if (thread.active_run_id) {
      const [run] = await tx
        .select()
        .from(chatRunsTable)
        .where(eq(chatRunsTable.id, thread.active_run_id));
      if (!run) {
        throw new Error("Missing active run");
      }
      messages = readProjection(run.projection).display;
    }
    return {
      messages,
      revision: thread.revision,
      activeRun: thread.active_run_id ? { runId: thread.active_run_id } : null,
    };
  });
}

export async function checkCursor(
  runId: string,
  cursor: number,
  threadId?: string,
  access?: SideAccess,
) {
  if (!runIdSchema.safeParse(runId).success || !Number.isSafeInteger(cursor) || cursor < -1) {
    throw new RunRequestError(400, "Invalid run cursor");
  }
  const db = await database();
  const [run] = await db.select().from(chatRunsTable).where(eq(chatRunsTable.id, runId));
  if (!run) {
    throw new RunRequestError(404, "Unknown run");
  }
  const [side] = await db.select().from(sideChatsTable).where(eq(sideChatsTable.id, run.thread_id));
  if (side) {
    assertSideOpen(side, access);
  }
  if (threadId !== undefined && run.thread_id !== threadId) {
    throw new RunRequestError(409, "Run thread mismatch");
  }
  if (cursor >= run.next_sequence) {
    throw new RunRequestError(400, "Cursor is ahead of run");
  }
}

async function lockSide(tx: Transaction, id: string): Promise<SideRow | undefined> {
  const [side] = await tx
    .select()
    .from(sideChatsTable)
    .where(eq(sideChatsTable.id, id))
    .for("update");
  return side;
}

function assertSideOpen(side: SideRow, access?: SideAccess) {
  if (access?.scope !== side.page_scope) {
    throw new RunRequestError(404, "Unknown side chat scope");
  }
  if (side.state !== "open" || side.lease_until.getTime() <= Date.now() || !side.seed) {
    throw new RunRequestError(409, "Side chat is closed or expired");
  }
}

async function classifyProjection(tx: Transaction, run: RunRow, state: ConversationState) {
  if (!run.accepted.side) {
    return state;
  }
  const [side] = await tx.select().from(sideChatsTable).where(eq(sideChatsTable.id, run.thread_id));
  if (!side?.seed) {
    throw new RunRequestError(409, "Side chat seed is discarded");
  }
  const display = classifySideConversation(state.display, side.seed, run.thread_id);
  const originals = new Map(display.map((message) => [message.id, message]));
  return {
    display,
    context: state.context.map((message) => ({
      ...message,
      metadata: originals.get(message.id)?.metadata ?? message.metadata,
    })),
  };
}

export async function assertExecution(run: AcceptedRun) {
  if (!run.side) {
    return;
  }
  const db = await database();
  const [side] = await db.select().from(sideChatsTable).where(eq(sideChatsTable.id, run.threadId));
  if (!side || side.epoch !== run.side.epoch) {
    throw new RunRequestError(409, "Side chat execution expired");
  }
  assertSideOpen(side, { scope: run.side.scope });
}

export async function openSideChat(parentThreadId: string, openKey: string, access: SideAccess) {
  const db = await database();
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${access.scope}), hashtext(${openKey}))`,
    );
    const [prior] = await tx
      .select()
      .from(sideChatsTable)
      .where(and(eq(sideChatsTable.page_scope, access.scope), eq(sideChatsTable.open_key, openKey)))
      .for("update");
    if (prior) {
      if (prior.parent_thread_id !== parentThreadId) {
        throw new RunRequestError(409, "Open key collision");
      }
      assertSideOpen(prior, access);
      return { id: prior.id, parentRevision: prior.seed!.parentRevision };
    }
    if (await lockSide(tx, parentThreadId)) {
      throw new RunRequestError(409, "Nested side chats are not supported");
    }
    const [parent] = await tx
      .select()
      .from(threadsTable)
      .where(eq(threadsTable.id, parentThreadId))
      .for("update");
    if (!parent) {
      throw new RunRequestError(404, "Unknown parent thread");
    }
    if (parent.parent_thread_id || parent.active_run_id) {
      throw new RunRequestError(409, "Parent thread must be ready");
    }
    const seed: SideChatSeed = {
      parentRevision: parent.revision,
      display: parent.messages,
      context: await committedModelContext(tx, parent),
    };
    const id = randomUUID();
    await tx.insert(sideChatsTable).values({
      id,
      parent_thread_id: parentThreadId,
      page_scope: access.scope,
      open_key: openKey,
      lease_until: new Date(Date.now() + SIDE_LEASE_MS),
      seed,
    });
    await tx.insert(threadsTable).values({
      id,
      parent_thread_id: parentThreadId,
      title: "附屬對話",
      agent: parent.agent,
      messages: seed.display,
    });
    return { id, parentRevision: seed.parentRevision };
  });
}

export async function readSideSummaryRange(id: string, access: SideAccess) {
  const db = await database();
  return db.transaction(async (tx) => {
    const side = await lockSide(tx, id);
    if (!side) {
      throw new RunRequestError(404, "Unknown side chat");
    }
    assertSideOpen(side, access);
    const [thread] = await tx
      .select()
      .from(threadsTable)
      .where(eq(threadsTable.id, id))
      .for("update");
    if (!thread || thread.active_run_id) {
      throw new RunRequestError(409, "Side chat must be idle");
    }
    const transcript = originalSideTranscript(thread.messages, id);
    if (!transcript.length) {
      throw new RunRequestError(409, "Side chat has no original discussion");
    }
    return {
      epoch: side.epoch,
      sideRevision: thread.revision,
      through: transcript.length,
      transcript,
    };
  });
}

export async function saveSideDraft(
  id: string,
  access: SideAccess,
  epoch: number,
  draft: SummaryDraft,
) {
  const db = await database();
  return db.transaction(async (tx) => {
    const side = await lockSide(tx, id);
    if (!side) {
      throw new RunRequestError(404, "Unknown side chat");
    }
    assertSideOpen(side, access);
    const [thread] = await tx
      .select()
      .from(threadsTable)
      .where(eq(threadsTable.id, id))
      .for("update");
    if (
      side.epoch !== epoch ||
      !thread ||
      thread.active_run_id ||
      thread.revision !== draft.sideRevision
    ) {
      throw new RunRequestError(409, "Summary draft is stale");
    }
    await tx.update(sideChatsTable).set({ draft }).where(eq(sideChatsTable.id, id));
    return draft;
  });
}

export async function transferSideSummary(
  id: string,
  access: SideAccess,
  input: { draftId: string; transferKey: string; text: string },
) {
  const db = await database();
  const digest = createHash("sha256")
    .update(JSON.stringify({ id, draftId: input.draftId, text: input.text }))
    .digest("hex");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.transferKey}))`);
    const [prior] = await tx
      .select()
      .from(sideTransfersTable)
      .where(eq(sideTransfersTable.transfer_key, input.transferKey));
    if (prior) {
      if (prior.page_scope !== access.scope || prior.digest !== digest) {
        throw new RunRequestError(409, "Transfer key collision");
      }
      const [run] = await tx
        .select()
        .from(chatRunsTable)
        .where(eq(chatRunsTable.id, prior.receipt.mainRunId));
      if (!run) {
        throw new RunRequestError(409, "Accepted main run is unavailable");
      }
      return { receipt: prior.receipt, run: run.accepted, pending: run.state === "pending" };
    }
    const side = await lockSide(tx, id);
    if (!side) {
      throw new RunRequestError(404, "Unknown side chat");
    }
    assertSideOpen(side, access);
    const [child] = await tx
      .select()
      .from(threadsTable)
      .where(eq(threadsTable.id, id))
      .for("update");
    const draft = side.draft;
    if (
      !child ||
      child.active_run_id ||
      !draft ||
      draft.id !== input.draftId ||
      draft.sideRevision !== child.revision ||
      draft.through !== originalSideTranscript(child.messages, id).length
    ) {
      throw new RunRequestError(409, "Summary draft is stale or side chat is busy");
    }
    const [parent] = await tx
      .select()
      .from(threadsTable)
      .where(eq(threadsTable.id, side.parent_thread_id))
      .for("update");
    if (!parent || parent.active_run_id) {
      throw new RunRequestError(409, "Main thread is busy");
    }
    const receipt: TransferReceipt = {
      transferKey: input.transferKey,
      parentThreadId: parent.id,
      sideChatId: id,
      messageId: `transfer-${input.transferKey}`,
      mainRunId: `transfer-${input.transferKey}`,
    };
    const accepted = await acceptInTransaction(
      tx,
      parent,
      {
        kind: "chat",
        threadId: parent.id,
        runId: receipt.mainRunId,
        baseRevision: parent.revision,
        message: { id: receipt.messageId, text: input.text },
      },
      undefined,
      {
        sideChatTransfer: {
          sideChatId: id,
          draftId: draft.id,
          through: draft.through,
          transferKey: input.transferKey,
        },
      },
    );
    await tx
      .insert(sideTransfersTable)
      .values({ transfer_key: input.transferKey, page_scope: access.scope, digest, receipt });
    await tx
      .update(sideChatsTable)
      .set({ state: "closing", epoch: side.epoch + 1 })
      .where(eq(sideChatsTable.id, id));
    return { ...accepted, receipt };
  });
}

export async function heartbeatSideScope(access: SideAccess) {
  const db = await database();
  await db
    .update(sideChatsTable)
    .set({ lease_until: new Date(Date.now() + SIDE_LEASE_MS) })
    .where(
      and(
        eq(sideChatsTable.page_scope, access.scope),
        eq(sideChatsTable.state, "open"),
        gt(sideChatsTable.lease_until, new Date()),
      ),
    );
}

export async function beginSideDiscard(id: string, access?: SideAccess) {
  const db = await database();
  return db.transaction(async (tx) => {
    const side = await lockSide(tx, id);
    if (!side || (access && side.page_scope !== access.scope)) {
      throw new RunRequestError(404, "Unknown side chat");
    }
    if (side.state === "closed") {
      return [];
    }
    if (side.state === "open") {
      await tx
        .update(sideChatsTable)
        .set({ state: "closing", epoch: side.epoch + 1 })
        .where(eq(sideChatsTable.id, id));
    }
    const runs = await tx
      .select({ id: chatRunsTable.id })
      .from(chatRunsTable)
      .where(eq(chatRunsTable.thread_id, id));
    return runs.map((run) => run.id);
  });
}

export async function purgeSideChat(id: string) {
  const db = await database();
  await db.transaction(async (tx) => {
    const side = await lockSide(tx, id);
    if (!side || side.state === "closed") {
      return;
    }
    if (side.state !== "closing") {
      throw new RunRequestError(409, "Side chat must be stopped before purge");
    }
    const runs = await tx
      .select({ id: chatRunsTable.id })
      .from(chatRunsTable)
      .where(eq(chatRunsTable.thread_id, id));
    const ids = runs.map((run) => run.id);
    if (ids.length) {
      await tx.delete(chatEventsTable).where(inArray(chatEventsTable.run_id, ids));
      await tx.delete(chatModelSlotsTable).where(inArray(chatModelSlotsTable.run_id, ids));
      await tx.delete(chatRunsTable).where(inArray(chatRunsTable.id, ids));
    }
    await tx.delete(threadsTable).where(eq(threadsTable.id, id));
    await tx
      .update(sideChatsTable)
      .set({ state: "closed", seed: null, draft: null })
      .where(eq(sideChatsTable.id, id));
  });
}

export async function listDiscardableSides(all = false) {
  const db = await database();
  return db
    .select({ id: sideChatsTable.id })
    .from(sideChatsTable)
    .where(
      all
        ? sql`${sideChatsTable.state} <> 'closed'`
        : sql`${sideChatsTable.state} = 'closing' or (${sideChatsTable.state} = 'open' and ${sideChatsTable.lease_until} <= now())`,
    );
}

const TERMINAL_RUN_EVENTS = new Set<StreamChunk["type"]>([
  EventType.RUN_FINISHED,
  EventType.RUN_ERROR,
]);

async function pollWhileOpen(signal: AbortSignal): Promise<void> {
  await delay(100, undefined, { signal }).catch((error) => {
    if (!signal.aborted) {
      throw error;
    }
  });
}

async function runExhausted(
  db: Awaited<ReturnType<typeof database>>,
  runId: string,
  cursor: number,
): Promise<boolean> {
  const [run] = await db.select().from(chatRunsTable).where(eq(chatRunsTable.id, runId));
  if (!run) {
    throw new Error("Observed run disappeared");
  }
  return run.state !== "pending" && cursor === run.next_sequence - 1;
}

export async function* observeRun(
  runId: string,
  cursor: number,
  signal: AbortSignal,
  access?: SideAccess,
): AsyncGenerator<{ sequence: number; event: StreamChunk }> {
  await checkCursor(runId, cursor, undefined, access);
  const db = await database();
  while (!signal.aborted) {
    const rows = await db
      .select({ sequence: chatEventsTable.sequence, payload: chatEventsTable.payload })
      .from(chatEventsTable)
      .where(and(eq(chatEventsTable.run_id, runId), gt(chatEventsTable.sequence, cursor)))
      .orderBy(chatEventsTable.sequence)
      .limit(100);
    for (const row of rows) {
      if (signal.aborted) {
        return;
      }
      cursor = row.sequence;
      yield { sequence: cursor, event: row.payload };
      if (TERMINAL_RUN_EVENTS.has(row.payload.type)) {
        return;
      }
    }
    if (rows.length) {
      continue;
    }
    if (await runExhausted(db, runId, cursor)) {
      return;
    }
    await pollWhileOpen(signal);
  }
}
