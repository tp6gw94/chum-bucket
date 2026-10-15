import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { UIMessage } from "@tanstack/ai";
import { chatEventsTable, chatRunsTable, sideChatsTable, threadsTable } from "../db/schema";
import { isSummaryMessage } from "./conversation";
import {
  RunRequestError,
  chatInputSchema,
  database,
  persistRunIn,
  threadContext,
  type PersistedRun,
  type RunAdmission,
  type Transaction,
} from "./run-store";

type ThreadRow = typeof threadsTable.$inferSelect;

const sideChatTitle = "附屬對話";

export async function sideChatAdmission(tx: Transaction, thread: ThreadRow): Promise<RunAdmission> {
  if (!thread.parent_thread_id) {
    return { sideChat: false };
  }

  const [side] = await tx
    .select()
    .from(sideChatsTable)
    .where(eq(sideChatsTable.id, thread.id))
    .for("update");

  if (side?.state !== "open") {
    throw new RunRequestError(409, "Side chat is closed");
  }

  return {
    sideChat: true,
    context: async (_tx, current) => (current.revision === 0 ? side.seed.context : null),
  };
}

export async function assertSideChatOpen(threadId: string) {
  const db = await database();
  const [side] = await db
    .select({ state: sideChatsTable.state })
    .from(sideChatsTable)
    .where(eq(sideChatsTable.id, threadId));

  if (side?.state !== "open") {
    throw new Error("Side chat is closed");
  }
}

export async function openSideChat(parentId: string): Promise<{ id: string }> {
  const db = await database();

  return db.transaction(async (tx) => {
    const [parent] = await tx
      .select()
      .from(threadsTable)
      .where(eq(threadsTable.id, parentId))
      .for("update");

    if (!parent) {
      throw new RunRequestError(404, "Unknown thread");
    }

    if (parent.parent_thread_id) {
      throw new RunRequestError(409, "Side chats cannot be nested");
    }

    if (parent.active_run_id) {
      throw new RunRequestError(409, "The main thread is running");
    }

    const seed = { display: parent.messages, context: await threadContext(tx, parent) };
    const id = randomUUID();
    await tx.insert(threadsTable).values({
      id,
      title: sideChatTitle,
      messages: seed.display,
      parent_thread_id: parent.id,
    });
    await tx.insert(sideChatsTable).values({ id, parent_thread_id: parent.id, seed });

    return { id };
  });
}

async function openSide(tx: Transaction, id: string) {
  const [side] = await tx
    .select()
    .from(sideChatsTable)
    .where(eq(sideChatsTable.id, id))
    .for("update");

  if (!side) {
    throw new RunRequestError(404, "Unknown side chat");
  }

  if (side.state !== "open") {
    throw new RunRequestError(409, "Side chat is closed");
  }

  const [thread] = await tx.select().from(threadsTable).where(eq(threadsTable.id, id));

  if (thread!.active_run_id) {
    throw new RunRequestError(409, "Side chat is running");
  }

  return { side, thread: thread! };
}

export async function sideChatAdditions(id: string): Promise<UIMessage[]> {
  const db = await database();

  return db.transaction(async (tx) => {
    const { side, thread } = await openSide(tx, id);
    const seeded = new Set(side.seed.display.map((message) => message.id));
    const added = thread.messages.filter(
      (message) => !seeded.has(message.id) && !isSummaryMessage(message),
    );

    if (added.length === 0) {
      throw new RunRequestError(409, "The side chat has no new messages");
    }

    return added;
  });
}

const summaries = new Map<string, AbortController>();

export function trackSideChatSummary(id: string): AbortController {
  summaries.get(id)?.abort();
  const controller = new AbortController();
  summaries.set(id, controller);

  return controller;
}

export function releaseSideChatSummary(id: string, controller: AbortController) {
  if (summaries.get(id) === controller) {
    summaries.delete(id);
  }
}

export function cancelSideChatSummary(id: string) {
  summaries.get(id)?.abort();
  summaries.delete(id);
}

function transferRunId(id: string) {
  return `side-${id}`;
}

async function existingTransfer(tx: Transaction, runId: string, text: string) {
  const [existing] = await tx.select().from(chatRunsTable).where(eq(chatRunsTable.id, runId));

  if (!existing) {
    return undefined;
  }

  if (!("message" in existing.request) || existing.request.message.text !== text) {
    throw new RunRequestError(409, "A different summary was already transferred");
  }

  return { run: existing.accepted, pending: existing.state === "pending" };
}

export async function transferSideChat(id: string, value: string): Promise<PersistedRun> {
  const runId = transferRunId(id);
  const text = value.trim();
  const db = await database();

  return db.transaction(async (tx) => {
    const existing = await existingTransfer(tx, runId, text);

    if (existing) {
      return existing;
    }

    const { side } = await openSide(tx, id);
    const [parent] = await tx
      .select({ revision: threadsTable.revision })
      .from(threadsTable)
      .where(eq(threadsTable.id, side.parent_thread_id));
    const input = chatInputSchema.safeParse({
      threadId: side.parent_thread_id,
      runId,
      baseRevision: parent!.revision,
      message: { id: runId, text, sideChatTransfer: true },
    });

    if (!input.success) {
      throw new RunRequestError(400, "Invalid summary text");
    }

    const accepted = await persistRunIn(tx, input.data);
    await tx.update(sideChatsTable).set({ state: "closing" }).where(eq(sideChatsTable.id, id));

    return accepted;
  });
}

export async function markSideChatClosing(id: string) {
  const db = await database();
  await db.update(sideChatsTable).set({ state: "closing" }).where(eq(sideChatsTable.id, id));
}

export async function sideChatRunIds(ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) {
    return [];
  }

  const db = await database();
  const rows = await db
    .select({ id: chatRunsTable.id })
    .from(chatRunsTable)
    .where(inArray(chatRunsTable.thread_id, [...ids]));

  return rows.map((row) => row.id);
}

export async function listSideChatIds(): Promise<string[]> {
  const db = await database();
  const rows = await db.select({ id: sideChatsTable.id }).from(sideChatsTable);

  return rows.map((row) => row.id);
}

export async function markAllSideChatsClosing(): Promise<string[]> {
  const db = await database();
  const rows = await db
    .update(sideChatsTable)
    .set({ state: "closing" })
    .returning({ id: sideChatsTable.id });

  return rows.map((row) => row.id);
}

export async function deleteSideChat(id: string) {
  const db = await database();
  await db.transaction(async (tx) => {
    const runs = await tx
      .select({ id: chatRunsTable.id })
      .from(chatRunsTable)
      .where(eq(chatRunsTable.thread_id, id));
    const runIds = runs.map((run) => run.id);

    if (runIds.length > 0) {
      await tx.delete(chatEventsTable).where(inArray(chatEventsTable.run_id, runIds));
      await tx.delete(chatRunsTable).where(inArray(chatRunsTable.id, runIds));
    }

    await tx.delete(sideChatsTable).where(eq(sideChatsTable.id, id));
    await tx.delete(threadsTable).where(eq(threadsTable.id, id));
  });
}
