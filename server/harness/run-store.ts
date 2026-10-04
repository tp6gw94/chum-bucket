import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq, gt, sql } from "drizzle-orm";
import { EventType, type StreamChunk, type UIMessage } from "@tanstack/ai";
import { z } from "zod";
import { chatEventsTable, chatRunsTable, threadsTable } from "../db/schema";
import { openuiInstructions } from "./prompts";
import { snapshot } from "./model-turn";

export const BUILD = "durable-chat-loop-v5";
export const MODEL = "deepseek-ai/DeepSeek-V4.1-Flash";
const runIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
export const runInputSchema = z
  .object({
    threadId: z.uuid(),
    runId: runIdSchema,
    baseRevision: z.number().int().nonnegative().max(2_000_000_000),
    message: z
      .object({ id: z.string().min(1).max(200), text: z.string().trim().min(1).max(32_000) })
      .strict(),
  })
  .strict();
export type RunInput = z.infer<typeof runInputSchema>;
export type AcceptedRun = RunInput & {
  messages: UIMessage[];
  prompt: string;
  model: typeof MODEL;
  build: typeof BUILD;
};
type RunRow = typeof chatRunsTable.$inferSelect;
type ThreadRow = typeof threadsTable.$inferSelect;
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
    if (thread.messages.some((message) => message.id === input.message.id)) {
      throw new RunRequestError(409, "Message ID already exists");
    }
    const run: AcceptedRun = {
      ...input,
      messages: [
        ...thread.messages,
        {
          id: input.message.id,
          role: "user",
          parts: [{ type: "text", content: input.message.text }],
        },
      ],
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
        projection: run.messages,
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

export async function emit(runId: string, event: StreamChunk, messages?: UIMessage[]) {
  const db = await database();
  await db.transaction(async (tx) => {
    const { run } = await lockRun(tx, runId);
    await appendEvent(tx, run, randomUUID(), event);
    if (messages) {
      await tx
        .update(chatRunsTable)
        .set({ projection: messages })
        .where(eq(chatRunsTable.id, runId));
    }
  });
}

export async function finishRun(runId: string, messages?: UIMessage[], code = "execution_failed") {
  const db = await database();
  await db.transaction(async (tx) => {
    const { run, thread } = await lockRun(tx, runId);
    if (run.state !== "pending") {
      return;
    }
    if (thread.active_run_id !== runId || thread.revision !== run.request.baseRevision) {
      throw new Error("Thread claim changed");
    }
    if (messages) {
      const title =
        messages
          .find((message) => message.role === "user")
          ?.parts.filter((part) => part.type === "text")
          .map((part) => part.content)
          .join("")
          .slice(0, 10) || "新對話";
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
      await appendEvent(tx, run, "failed:snapshot", snapshot(run.projection));
      await tx
        .update(threadsTable)
        .set({ active_run_id: null })
        .where(eq(threadsTable.id, thread.id));
    }
    await appendEvent(
      tx,
      run,
      "terminal",
      messages
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
      .set({ state: messages ? "succeeded" : "failed" })
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
