import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { EventType, type StreamChunk, type UIMessage } from "@tanstack/ai";
import { z } from "zod";
import { chatEventsTable, chatRunsTable, sideChatsTable, threadsTable } from "../db/schema";
import { compactionEvent, parseCompactionEvent } from "../../shared/compaction-event";
import { sideTranscript, sideTransferRunId, type SideChatSeed } from "../../shared/side-chat";
import { openuiInstructions } from "./prompts";
import { snapshot } from "./model-turn";
import { projectConversation, readProjection, type ConversationState } from "./conversation";

export const BUILD = "durable-chat-loop-v6";
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
  build: typeof BUILD;
  side?: boolean;
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

  if (side) {
    assertSideOpen(side);
  }

  const [thread] = await tx
    .select()
    .from(threadsTable)
    .where(eq(threadsTable.id, found.thread_id))
    .for("update");
  const [run] = await tx.select().from(chatRunsTable).where(eq(chatRunsTable.id, id)).for("update");

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

  await tx.insert(chatEventsTable).values({
    run_id: run.id,
    sequence: run.next_sequence,
    event_key: key,
    payload: event,
  });
  await tx
    .update(chatRunsTable)
    .set({ next_sequence: sql`${chatRunsTable.next_sequence} + 1` })
    .where(eq(chatRunsTable.id, run.id));
  run.next_sequence++;
}

async function sideSeedContext(tx: Transaction, thread: ThreadRow): Promise<UIMessage[]> {
  const [side] = await tx.select().from(sideChatsTable).where(eq(sideChatsTable.id, thread.id));

  if (!side) {
    throw new RunRequestError(409, "Side chat is closed");
  }

  return side.seed.context;
}

async function contextAnchors(tx: Transaction, thread: ThreadRow): Promise<RunRow[]> {
  return tx
    .select()
    .from(chatRunsTable)
    .where(
      and(
        eq(chatRunsTable.thread_id, thread.id),
        sql`${chatRunsTable.projection}->>'committedRevision' = ${String(thread.revision)}`,
      ),
    );
}

async function committedModelContext(tx: Transaction, thread: ThreadRow): Promise<UIMessage[]> {
  if (thread.revision === 0 && thread.parent_thread_id) {
    return sideSeedContext(tx, thread);
  }

  const anchors = await contextAnchors(tx, thread);

  if (anchors.length > 1) {
    throw new RunRequestError(409, "Ambiguous conversation context anchor");
  }

  const [anchor] = anchors;

  if (!anchor) {
    if (thread.messages.some((message) => message.metadata?.fromSummary === true)) {
      throw new RunRequestError(409, "Archived summaries require a conversation context anchor");
    }

    return thread.messages;
  }

  const prior = readProjection(anchor.projection);

  if (!isDeepStrictEqual(prior.display, thread.messages)) {
    throw new RunRequestError(409, "Conversation context anchor does not match saved history");
  }

  return prior.context;
}

function chatAdditions(
  input: z.output<typeof runInputSchema>,
  metadata?: Record<string, unknown>,
): UIMessage[] {
  if (input.kind !== "chat") {
    return [];
  }

  return [
    {
      id: input.message.id,
      role: "user",
      parts: [{ type: "text", content: input.message.text }],
      ...(metadata ? { metadata } : {}),
    },
  ];
}

async function acceptInTransaction(
  tx: Transaction,
  thread: ThreadRow,
  input: z.output<typeof runInputSchema>,
  metadata?: Record<string, unknown>,
) {
  if (thread.revision !== input.baseRevision || thread.active_run_id) {
    throw new RunRequestError(409, "Thread revision or claim conflict");
  }

  const priorContext = await committedModelContext(tx, thread);
  const additions = chatAdditions(input, metadata);
  const known = new Set([...thread.messages, ...priorContext].map((message) => message.id));

  if (additions.some((message) => known.has(message.id))) {
    throw new RunRequestError(409, "Message ID already exists");
  }

  const run: AcceptedRun = {
    ...input,
    messages: [...thread.messages, ...additions],
    context: [...priorContext, ...additions],
    prompt: openuiInstructions(),
    model: MODEL,
    build: BUILD,
    ...(thread.parent_thread_id ? { side: true } : {}),
  };
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

export async function persistRun(value: RunInput) {
  const parsed = runInputSchema.safeParse(value);

  if (!parsed.success) {
    throw new RunRequestError(400, "Invalid run input");
  }

  const input = parsed.data;
  const db = await database();

  return db.transaction(async (tx) => {
    const side = await lockSide(tx, input.threadId);

    if (side) {
      assertSideOpen(side);
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
      if (!isDeepStrictEqual(existing.request, input)) {
        throw new RunRequestError(409, "Run input collision");
      }

      return { run: existing.accepted, pending: existing.state === "pending" };
    }

    return acceptInTransaction(tx, thread, input);
  });
}

export async function emit(runId: string, event: StreamChunk, conversation?: ConversationState) {
  const db = await database();
  await db.transaction(async (tx) => {
    const { run } = await lockRun(tx, runId);
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

function transferConversation(run: RunRow): ConversationState | undefined {
  return run.accepted.messages.at(-1)?.metadata?.sideChatTransfer
    ? { display: run.accepted.messages, context: run.accepted.context }
    : undefined;
}

function threadTitle(messages: readonly UIMessage[]) {
  return (
    messages
      .find((message) => message.role === "user")
      ?.parts.filter((part) => part.type === "text")
      .map((part) => part.content)
      .join("")
      .slice(0, 10) || "新對話"
  );
}

export async function finishRun(
  runId: string,
  conversation?: ConversationState,
  code = "execution_failed",
) {
  const db = await database();
  await db.transaction(async (tx) => {
    const { run, thread } = await lockRun(tx, runId);

    if (run.state !== "pending") {
      return;
    }

    assertThreadClaim(run, thread);
    const committed = conversation ?? transferConversation(run);

    if (committed) {
      await appendEvent(tx, run, "finished:snapshot", snapshot(committed.display));
      await tx
        .update(threadsTable)
        .set({
          messages: committed.display,
          title: threadTitle(committed.display),
          revision: sql`${threadsTable.revision} + 1`,
          active_run_id: null,
          updated_at: sql`now()`,
        })
        .where(eq(threadsTable.id, thread.id));
      await tx
        .update(chatRunsTable)
        .set({
          projection: { ...projectConversation(committed), committedRevision: thread.revision + 1 },
        })
        .where(eq(chatRunsTable.id, runId));
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
      conversation
        ? { type: EventType.RUN_FINISHED, threadId: thread.id, runId }
        : {
            type: EventType.RUN_ERROR,
            message: "Run failed; reconnect to view saved output",
            code,
            metadata: { tanstack: { runId, threadId: thread.id } },
          },
    );
    await tx
      .update(chatRunsTable)
      .set({ state: conversation ? "succeeded" : "failed" })
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
        sql`not exists (select 1 from ${sideChatsTable} where ${sideChatsTable.id} = ${chatRunsTable.thread_id} and ${sideChatsTable.state} <> 'open')`,
      ),
    )
    .orderBy(chatRunsTable.created_at);
}

export async function hydrateThread(threadId: string) {
  if (!z.uuid().safeParse(threadId).success) {
    throw new RunRequestError(400, "Invalid thread ID");
  }

  const db = await database();

  return db.transaction(async (tx) => {
    const side = await lockSide(tx, threadId);

    if (side) {
      assertSideOpen(side);
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

export async function checkCursor(runId: string, cursor: number, threadId?: string) {
  if (!runIdSchema.safeParse(runId).success || !Number.isSafeInteger(cursor) || cursor < -1) {
    throw new RunRequestError(400, "Invalid run cursor");
  }

  const db = await database();
  const [run] = await db.select().from(chatRunsTable).where(eq(chatRunsTable.id, runId));

  if (!run) {
    throw new RunRequestError(404, "Unknown run");
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

function assertSideOpen(side: SideRow) {
  if (side.state !== "open") {
    throw new RunRequestError(409, "Side chat is closed");
  }
}

export async function assertExecution(run: AcceptedRun) {
  if (!run.side) {
    return;
  }

  const db = await database();
  const [side] = await db.select().from(sideChatsTable).where(eq(sideChatsTable.id, run.threadId));

  if (!side) {
    throw new RunRequestError(409, "Side chat is closed");
  }

  assertSideOpen(side);
}

export async function openSideChat(parentThreadId: string) {
  const db = await database();

  return db.transaction(async (tx) => {
    const [parent] = await tx
      .select()
      .from(threadsTable)
      .where(eq(threadsTable.id, parentThreadId))
      .for("update");

    if (!parent) {
      throw new RunRequestError(404, "Unknown parent thread");
    }

    if (parent.parent_thread_id) {
      throw new RunRequestError(409, "Nested side chats are not supported");
    }

    if (parent.active_run_id) {
      throw new RunRequestError(409, "Parent thread must be ready");
    }

    const seed: SideChatSeed = {
      display: parent.messages,
      context: await committedModelContext(tx, parent),
    };
    const id = randomUUID();
    await tx.insert(sideChatsTable).values({ id, parent_thread_id: parentThreadId, seed });
    await tx.insert(threadsTable).values({
      id,
      parent_thread_id: parentThreadId,
      title: "附屬對話",
      agent: parent.agent,
      messages: seed.display,
    });

    return { id };
  });
}

async function lockIdleSide(tx: Transaction, id: string) {
  const side = await lockSide(tx, id);

  if (!side) {
    throw new RunRequestError(404, "Unknown side chat");
  }

  assertSideOpen(side);
  const [thread] = await tx
    .select()
    .from(threadsTable)
    .where(eq(threadsTable.id, id))
    .for("update");

  if (!thread || thread.active_run_id) {
    throw new RunRequestError(409, "Side chat must be idle");
  }

  return { side, thread };
}

export async function readSideTranscript(id: string) {
  const db = await database();

  return db.transaction(async (tx) => {
    const { side, thread } = await lockIdleSide(tx, id);
    const transcript = sideTranscript(thread.messages, side.seed);

    if (!transcript.length) {
      throw new RunRequestError(409, "Side chat has no new discussion");
    }

    return transcript;
  });
}

async function lockIdleParent(tx: Transaction, parentId: string): Promise<ThreadRow> {
  const [parent] = await tx
    .select()
    .from(threadsTable)
    .where(eq(threadsTable.id, parentId))
    .for("update");

  if (!parent || parent.active_run_id) {
    throw new RunRequestError(409, "Main thread is busy");
  }

  return parent;
}

export async function transferSideSummary(id: string, text: string) {
  const runId = sideTransferRunId(id);
  const db = await database();

  return db.transaction(async (tx) => {
    const locked = await lockSide(tx, id);
    const [prior] = await tx.select().from(chatRunsTable).where(eq(chatRunsTable.id, runId));

    if (prior) {
      if (prior.request.kind !== "chat" || prior.request.message.text !== text) {
        throw new RunRequestError(409, "Side chat summary was already transferred");
      }

      return { run: prior.accepted, pending: prior.state === "pending" };
    }

    if (!locked) {
      throw new RunRequestError(404, "Unknown side chat");
    }

    const { side } = await lockIdleSide(tx, id);
    const parent = await lockIdleParent(tx, side.parent_thread_id);
    const accepted = await acceptInTransaction(
      tx,
      parent,
      {
        kind: "chat",
        threadId: parent.id,
        runId,
        baseRevision: parent.revision,
        message: { id: runId, text },
      },
      { sideChatTransfer: { sideChatId: id } },
    );
    await tx.update(sideChatsTable).set({ state: "closing" }).where(eq(sideChatsTable.id, id));

    return accepted;
  });
}

export async function beginSideDiscard(id: string) {
  const db = await database();

  return db.transaction(async (tx) => {
    const side = await lockSide(tx, id);

    if (!side) {
      return [];
    }

    if (side.state === "open") {
      await tx.update(sideChatsTable).set({ state: "closing" }).where(eq(sideChatsTable.id, id));
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

    if (!side) {
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
      await tx.delete(chatRunsTable).where(inArray(chatRunsTable.id, ids));
    }

    await tx.delete(threadsTable).where(eq(threadsTable.id, id));
    await tx.delete(sideChatsTable).where(eq(sideChatsTable.id, id));
  });
}

export async function listSideChats(state?: "closing") {
  const db = await database();

  return db
    .select({ id: sideChatsTable.id })
    .from(sideChatsTable)
    .where(state ? eq(sideChatsTable.state, state) : undefined);
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
): AsyncGenerator<{ sequence: number; event: StreamChunk }> {
  await checkCursor(runId, cursor);
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
