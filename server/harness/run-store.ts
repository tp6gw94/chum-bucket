import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { EventType, type StreamChunk, type UIMessage } from "@tanstack/ai";
import { z } from "zod";
import { chatEventsTable, chatRunsTable, threadsTable } from "../db/schema";
import { compactionEventName, type CompactionEvent } from "../../shared/compaction-event";
import type { SideChat } from "../../shared/side-chat";
import {
  conversationFromProjection,
  isSummaryMessage,
  projectConversation,
  type ConversationState,
  type RunProjection,
} from "./conversation";
import { MODEL, agentRegistry, type ConversationAgentId } from "./agents";
import { snapshot } from "./model-turn";

export const BUILD = "durable-chat-loop-v7";
export const runIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
export const revisionSchema = z.number().int().nonnegative().max(2_000_000_000);
export const compactInstructionsSchema = z.string().trim().min(1).max(2_000);
const messageRunSchema = z
  .object({
    threadId: z.uuid(),
    runId: runIdSchema,
    baseRevision: revisionSchema,
    message: z
      .object({ id: z.string().min(1).max(200), text: z.string().trim().min(1).max(32_000) })
      .strict(),
  })
  .strict();
const compactRunSchema = z
  .object({
    kind: z.literal("compact"),
    threadId: z.uuid(),
    runId: runIdSchema,
    baseRevision: revisionSchema,
    instructions: compactInstructionsSchema.optional(),
  })
  .strict();
export const runInputSchema = z.union([messageRunSchema, compactRunSchema]);
export type RunInput = z.infer<typeof runInputSchema>;
export type AcceptedRun = RunInput &
  RunProjection & {
    parentContext?: UIMessage[];
    agent: ConversationAgentId;
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

function threadProjection(thread: ThreadRow): RunProjection {
  return thread.context_anchor
    ? { messages: thread.messages, contextAnchor: thread.context_anchor }
    : { messages: thread.messages };
}

function threadTitle(messages: readonly UIMessage[], fallback: string): string {
  return (
    messages
      .find((message) => message.role === "user" && !isSummaryMessage(message))
      ?.parts.filter((part) => part.type === "text")
      .map((part) => part.content)
      .join("")
      .slice(0, 10) || fallback
  );
}

async function sideChatParentContext(
  tx: Transaction,
  thread: ThreadRow,
): Promise<UIMessage[] | undefined> {
  if (!thread.parent_thread_id || thread.messages.length) {
    return undefined;
  }

  const [parent] = await tx
    .select()
    .from(threadsTable)
    .where(eq(threadsTable.id, thread.parent_thread_id))
    .for("share");

  if (!parent) {
    throw new Error("Missing parent thread");
  }

  const { context } = conversationFromProjection(threadProjection(parent));

  return context.length ? context : undefined;
}

async function acceptedMessages(
  tx: Transaction,
  thread: ThreadRow,
  input: RunInput,
): Promise<Pick<AcceptedRun, "messages" | "parentContext">> {
  if ("kind" in input) {
    return { messages: thread.messages };
  }

  if (thread.messages.some((message) => message.id === input.message.id)) {
    throw new RunRequestError(409, "Message ID already exists");
  }

  const parentContext = await sideChatParentContext(tx, thread);

  return {
    messages: [
      ...thread.messages,
      {
        id: input.message.id,
        role: "user",
        parts: [{ type: "text", content: input.message.text }],
      },
    ],
    ...(parentContext ? { parentContext } : {}),
  };
}

export async function persistRun(value: RunInput) {
  const parsed = runInputSchema.safeParse(value);

  if (!parsed.success) {
    throw new RunRequestError(400, "Invalid run input");
  }

  const input = parsed.data;
  const db = await database();
  const accepted = await db.transaction(async (tx) => {
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

    if (thread.revision !== input.baseRevision || thread.active_run_id) {
      throw new RunRequestError(409, "Thread revision or claim conflict");
    }

    if (thread.closed_at) {
      throw new RunRequestError(409, "Thread is closed");
    }

    const projection = threadProjection(thread);
    const agent: ConversationAgentId = thread.parent_thread_id ? "side" : "main";
    const run: AcceptedRun = {
      ...input,
      ...projection,
      ...(await acceptedMessages(tx, thread, input)),
      agent,
      prompt: agentRegistry[agent].systemPrompt(),
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
        projection: projectConversation(conversationFromProjection(run)),
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
  });

  return accepted;
}

async function saveProjection(tx: Transaction, runId: string, conversation: ConversationState) {
  await tx
    .update(chatRunsTable)
    .set({ projection: projectConversation(conversation) })
    .where(eq(chatRunsTable.id, runId));
}

export async function emit(runId: string, event: StreamChunk, conversation?: ConversationState) {
  const db = await database();
  await db.transaction(async (tx) => {
    const { run } = await lockRun(tx, runId);
    await appendEvent(tx, run, randomUUID(), event);

    if (conversation) {
      await saveProjection(tx, runId, conversation);
    }
  });
}

export async function appendRunEvent(
  tx: Transaction,
  runId: string,
  key: string,
  event: StreamChunk,
): Promise<boolean> {
  const { run } = await lockRun(tx, runId);

  if (run.state !== "pending") {
    return false;
  }

  await appendEvent(tx, run, key, event);

  return true;
}

export async function recordCompaction(
  runId: string,
  event: CompactionEvent,
  conversation?: ConversationState,
) {
  const db = await database();
  await db.transaction(async (tx) => {
    const { run } = await lockRun(tx, runId);
    await appendEvent(tx, run, randomUUID(), {
      type: EventType.CUSTOM,
      name: compactionEventName,
      value: event,
      timestamp: Date.now(),
    });

    if (conversation) {
      await appendEvent(tx, run, randomUUID(), snapshot(conversation.display));
      await saveProjection(tx, runId, conversation);
    }
  });
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
      const { messages, contextAnchor } = projectConversation(conversation);
      await appendEvent(tx, run, "finished:snapshot", snapshot(messages));
      await tx
        .update(threadsTable)
        .set({
          messages,
          context_anchor: contextAnchor ?? null,
          title: threadTitle(messages, thread.title),
          revision: sql`${threadsTable.revision} + 1`,
          active_run_id: null,
          updated_at: sql`now()`,
        })
        .where(eq(threadsTable.id, thread.id));
    } else {
      await appendEvent(tx, run, "failed:snapshot", snapshot(run.projection.messages));
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

      messages = run.accepted.messages;
    }

    return {
      messages,
      revision: thread.revision,
      activeRun: thread.active_run_id ? { runId: thread.active_run_id } : null,
    };
  });
}

function sideChatOf(thread: ThreadRow): SideChat {
  return {
    id: thread.id,
    parentThreadId: thread.parent_thread_id!,
    title: thread.title,
    revision: thread.revision,
  };
}

export async function createSideChat(parentThreadId: string): Promise<SideChat> {
  const db = await database();

  return db.transaction(async (tx) => {
    const [parent] = await tx
      .select()
      .from(threadsTable)
      .where(eq(threadsTable.id, parentThreadId))
      .for("share");

    if (!parent || parent.closed_at) {
      throw new RunRequestError(404, "Unknown thread");
    }

    if (parent.parent_thread_id) {
      throw new RunRequestError(409, "Side chats cannot be nested");
    }

    const [created] = await tx
      .insert(threadsTable)
      .values({ title: "附屬對話", agent: "side-chat", parent_thread_id: parentThreadId })
      .returning();

    return sideChatOf(created!);
  });
}

export async function listSideChats(parentThreadId: string): Promise<SideChat[]> {
  const db = await database();
  const rows = await db
    .select()
    .from(threadsTable)
    .where(and(eq(threadsTable.parent_thread_id, parentThreadId), isNull(threadsTable.closed_at)))
    .orderBy(asc(threadsTable.created_at), asc(threadsTable.id));

  return rows.map(sideChatOf);
}

export async function closeSideChat(id: string): Promise<void> {
  const db = await database();
  await db.transaction(async (tx) => {
    const [thread] = await tx
      .select()
      .from(threadsTable)
      .where(eq(threadsTable.id, id))
      .for("update");

    if (!thread?.parent_thread_id) {
      throw new RunRequestError(404, "Unknown side chat");
    }

    if (thread.active_run_id) {
      throw new RunRequestError(409, "Side chat is still running");
    }

    if (!thread.closed_at) {
      await tx
        .update(threadsTable)
        .set({ closed_at: sql`now()` })
        .where(eq(threadsTable.id, id));
    }
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
