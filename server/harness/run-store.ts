import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq, gt, sql } from "drizzle-orm";
import { EventType, type StreamChunk, type UIMessage } from "@tanstack/ai";
import { z } from "zod";
import {
  compactionEvent,
  parseCompactionEvent,
  type CompactionReason,
  type CompactionState,
} from "../../shared/compaction-event";
import { chatEventsTable, chatRunsTable, threadsTable } from "../db/schema";
import {
  isSummaryMessage,
  readProjection,
  toProjection,
  type ConversationState,
} from "./conversation";
import { openuiInstructions } from "./prompts";
import { snapshot } from "./model-turn";

export const BUILD = "durable-chat-loop-v6";
export const MODEL = "deepseek-ai/DeepSeek-V4.1-Flash";
export const runIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
export const baseRevisionSchema = z.number().int().nonnegative().max(2_000_000_000);
export const chatInputSchema = z
  .object({
    threadId: z.uuid(),
    runId: runIdSchema,
    baseRevision: baseRevisionSchema,
    message: z
      .object({
        id: z.string().min(1).max(200),
        text: z.string().trim().min(1).max(32_000),
        sideChatTransfer: z.literal(true).optional(),
      })
      .strict(),
  })
  .strict();
export const compactInputSchema = z
  .object({
    kind: z.literal("compact"),
    threadId: z.uuid(),
    runId: runIdSchema,
    baseRevision: baseRevisionSchema,
  })
  .strict();
const runInputSchema = z.union([chatInputSchema, compactInputSchema]);
export type RunInput = z.infer<typeof runInputSchema>;
export type AcceptedRun = RunInput & {
  conversation: ConversationState;
  sideChat: boolean;
  prompt: string;
  model: typeof MODEL;
  build: typeof BUILD;
};
type RunRow = typeof chatRunsTable.$inferSelect;
type ThreadRow = typeof threadsTable.$inferSelect;
export type Transaction = Parameters<Parameters<typeof import("../db").db.transaction>[0]>[0];
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

  const [thread] = await tx
    .select()
    .from(threadsTable)
    .where(eq(threadsTable.id, found.thread_id))
    .for("update");
  const [run] = await tx.select().from(chatRunsTable).where(eq(chatRunsTable.id, id)).for("update");

  return { run: run!, thread: thread! };
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

export type ContextSource = (tx: Transaction, thread: ThreadRow) => Promise<UIMessage[] | null>;

async function anchoredContext(tx: Transaction, thread: ThreadRow): Promise<UIMessage[] | null> {
  const anchors = await tx
    .select({ projection: chatRunsTable.projection })
    .from(chatRunsTable)
    .where(
      and(
        eq(chatRunsTable.thread_id, thread.id),
        sql`(${chatRunsTable.projection} ->> 'committedRevision')::integer = ${thread.revision}`,
      ),
    );

  if (anchors.length > 1) {
    throw new RunRequestError(409, "Multiple context anchors");
  }

  if (anchors.length === 0) {
    return null;
  }

  const projection = readProjection(anchors[0]!.projection);

  if (!isDeepStrictEqual(projection.display, thread.messages)) {
    throw new RunRequestError(409, "Context anchor does not match the thread");
  }

  return projection.context;
}

export async function threadContext(
  tx: Transaction,
  thread: ThreadRow,
  fallback?: ContextSource,
): Promise<UIMessage[]> {
  const anchored = await anchoredContext(tx, thread);

  if (anchored) {
    return anchored;
  }

  const seeded = await fallback?.(tx, thread);

  if (seeded) {
    return seeded;
  }

  if (thread.messages.some(isSummaryMessage)) {
    throw new RunRequestError(409, "Missing context anchor");
  }

  return thread.messages;
}

function initialConversation(input: RunInput, thread: ThreadRow, context: UIMessage[]) {
  if ("kind" in input) {
    return { display: thread.messages, context };
  }

  if (thread.messages.some((message) => message.id === input.message.id)) {
    throw new RunRequestError(409, "Message ID already exists");
  }

  const message: UIMessage = {
    id: input.message.id,
    role: "user",
    parts: [{ type: "text", content: input.message.text }],
    ...(input.message.sideChatTransfer ? { metadata: { sideChatTransfer: true } } : {}),
  };

  return { display: [...thread.messages, message], context: [...context, message] };
}

export type RunAdmission = Readonly<{
  sideChat: boolean;
  context?: ContextSource;
}>;

export type PersistedRun = Readonly<{ run: AcceptedRun; pending: boolean }>;

export async function persistRunIn(
  tx: Transaction,
  input: RunInput,
  admit: (tx: Transaction, thread: ThreadRow) => Promise<RunAdmission> = async () => ({
    sideChat: false,
  }),
): Promise<PersistedRun> {
  const [thread] = await tx
    .select()
    .from(threadsTable)
    .where(eq(threadsTable.id, input.threadId))
    .for("update");

  if (!thread) {
    throw new RunRequestError(404, "Unknown thread");
  }

  const [existing] = await tx.select().from(chatRunsTable).where(eq(chatRunsTable.id, input.runId));

  if (existing) {
    if (!isDeepStrictEqual(existing.request, input)) {
      throw new RunRequestError(409, "Run input collision");
    }

    return { run: existing.accepted, pending: existing.state === "pending" };
  }

  if (thread.revision !== input.baseRevision || thread.active_run_id) {
    throw new RunRequestError(409, "Thread revision or claim conflict");
  }

  const admission = await admit(tx, thread);
  const context = await threadContext(tx, thread, admission.context);
  const run: AcceptedRun = {
    ...input,
    conversation: initialConversation(input, thread, context),
    sideChat: admission.sideChat,
    prompt: openuiInstructions(),
    model: MODEL,
    build: BUILD,
  };
  const [inserted] = await tx
    .insert(chatRunsTable)
    .values({
      id: run.runId,
      thread_id: run.threadId,
      request: input,
      accepted: run,
      projection: toProjection(run.conversation),
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

export async function persistRun(
  value: RunInput,
  admit?: (tx: Transaction, thread: ThreadRow) => Promise<RunAdmission>,
): Promise<PersistedRun> {
  const parsed = runInputSchema.safeParse(value);

  if (!parsed.success) {
    throw new RunRequestError(400, "Invalid run input");
  }

  const db = await database();

  return db.transaction((tx) => persistRunIn(tx, parsed.data, admit));
}

export async function emit(runId: string, event: StreamChunk, conversation?: ConversationState) {
  const db = await database();
  await db.transaction(async (tx) => {
    const { run } = await lockRun(tx, runId);
    await appendEvent(tx, run, randomUUID(), event);

    if (conversation) {
      await tx
        .update(chatRunsTable)
        .set({ projection: toProjection(conversation) })
        .where(eq(chatRunsTable.id, runId));
    }
  });
}

export async function checkpointCompaction(
  runId: string,
  operationId: string,
  conversation: ConversationState,
  state: CompactionState,
  reason: CompactionReason,
) {
  const db = await database();
  const key = `compact:${operationId}`;
  await db.transaction(async (tx) => {
    const { run } = await lockRun(tx, runId);
    const [saved] = await tx
      .select({ payload: chatEventsTable.payload })
      .from(chatEventsTable)
      .where(and(eq(chatEventsTable.run_id, runId), eq(chatEventsTable.event_key, key)));

    if (saved) {
      if (parseCompactionEvent(saved.payload)?.state !== state) {
        throw new Error("Compaction was already saved with a different result");
      }

      return;
    }

    if (state === "done") {
      await tx
        .update(chatRunsTable)
        .set({ projection: toProjection(conversation) })
        .where(eq(chatRunsTable.id, runId));
      await appendEvent(tx, run, `${key}:snapshot`, snapshot(conversation.display));
    }

    await appendEvent(
      tx,
      run,
      key,
      compactionEvent({ runId, operationId, state, reason }) as StreamChunk,
    );
  });
}

function threadTitle(messages: UIMessage[]) {
  return (
    messages
      .find((message) => message.role === "user" && !isSummaryMessage(message))
      ?.parts.filter((part) => part.type === "text")
      .map((part) => part.content)
      .join("")
      .slice(0, 10) || "新對話"
  );
}

function transferredMessage(run: RunRow): UIMessage | undefined {
  const last = run.accepted.conversation.display.at(-1);

  return (last?.metadata as { sideChatTransfer?: unknown } | undefined)?.sideChatTransfer === true
    ? last
    : undefined;
}

async function commitThread(
  tx: Transaction,
  run: RunRow,
  thread: ThreadRow,
  conversation: ConversationState,
) {
  await tx
    .update(chatRunsTable)
    .set({ projection: toProjection(conversation, thread.revision + 1) })
    .where(eq(chatRunsTable.id, run.id));
  await tx
    .update(threadsTable)
    .set({
      messages: conversation.display,
      title: thread.parent_thread_id ? thread.title : threadTitle(conversation.display),
      revision: sql`${threadsTable.revision} + 1`,
      active_run_id: null,
      updated_at: sql`now()`,
    })
    .where(eq(threadsTable.id, thread.id));
}

async function releaseFailedRun(tx: Transaction, run: RunRow, thread: ThreadRow) {
  await appendEvent(tx, run, "failed:snapshot", snapshot(readProjection(run.projection).display));
  const transferred = transferredMessage(run);

  if (transferred) {
    await commitThread(tx, run, thread, {
      display: [...thread.messages, transferred],
      context: run.accepted.conversation.context,
    });

    return;
  }

  await tx.update(threadsTable).set({ active_run_id: null }).where(eq(threadsTable.id, thread.id));
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

    if (thread.active_run_id !== runId || thread.revision !== run.request.baseRevision) {
      throw new Error("Thread claim changed");
    }

    if (conversation) {
      await appendEvent(tx, run, "finished:snapshot", snapshot(conversation.display));
      await commitThread(tx, run, thread, conversation);
    } else {
      await releaseFailedRun(tx, run, thread);
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
    .where(eq(chatRunsTable.state, "pending"))
    .orderBy(chatRunsTable.created_at);
}

export async function hydrateThread(threadId: string) {
  if (!z.uuid().safeParse(threadId).success) {
    throw new RunRequestError(400, "Invalid thread ID");
  }

  const db = await database();

  return db.transaction(async (tx) => {
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

      messages = run.accepted.conversation.display;
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
