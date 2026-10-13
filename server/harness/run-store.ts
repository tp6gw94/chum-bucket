import { randomUUID } from "node:crypto";
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
  testingOperationsTable,
  threadsTable,
} from "../db/schema";
import { sideTranscript, sideTransferRunId, type SideChatSeed } from "../../shared/side-chat";
import { agentRegistry, type AgentModel } from "./agents";
import { snapshot } from "./model-turn";
import { projectConversation, readProjection, type ConversationState } from "./conversation";
import { compactionEvent, parseCompactionEvent } from "../../shared/compaction-event";
import {
  type ArtifactKind,
  type ArtifactRef,
  type RoleId,
  type RootRunOutcome,
  type TestView,
} from "../../shared/testing";
import {
  admitAttachedInTransaction,
  acceptRoleCompletionInTransaction,
  cancelTestingInTransaction,
  closeTestingInTransaction,
  closeUnfinishedTesting,
  guardActualIOInTransaction,
  hostTestingRuntime,
  publishProjectionInTransaction,
  readTestingExecutionInTransaction,
  readPublishedTestingRow,
  readPublishedThreadViewsRow,
  readPublishedThreadViewsInTransaction,
  selectTestingCancellation,
  recordRoleFailureInTransaction,
  reserveRoleTaskInTransaction,
  testingFinishOutcome,
  TestingPersistenceError,
  type ActualIoGuard,
  type ActualIoInput,
  type AppendTestingEvent,
  type RoleCompletion,
  type RoleFrame,
  type TestingAdmission,
  type TestingExecution,
} from "./testing-store";

export const PREVIOUS_BUILD = "durable-chat-loop-v9";
export const BUILD = "durable-chat-loop-v11";
const TESTING_ROOT_BUILD = "testing-root-v1";
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
  model: AgentModel;
  build: typeof BUILD | typeof PREVIOUS_BUILD | typeof TESTING_ROOT_BUILD;
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
  const [thread] = await tx
    .select()
    .from(threadsTable)
    .where(eq(threadsTable.id, found.thread_id))
    .for("update");
  const [run] = await tx.select().from(chatRunsTable).where(eq(chatRunsTable.id, id)).for("update");

  if (side) {
    assertSideOpen(side);
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

async function sideSeedContext(tx: Transaction, thread: ThreadRow): Promise<UIMessage[]> {
  const [side] = await tx.select().from(sideChatsTable).where(eq(sideChatsTable.id, thread.id));

  if (!side?.seed || !isDeepStrictEqual(side.seed.display, thread.messages)) {
    throw new RunRequestError(409, "Invalid side chat seed anchor");
  }

  return side.seed.context;
}

async function contextAnchors(tx: Transaction, thread: ThreadRow): Promise<RunRow[]> {
  const marked = await tx
    .select()
    .from(chatRunsTable)
    .where(
      and(
        eq(chatRunsTable.thread_id, thread.id),
        sql`${chatRunsTable.projection}->>'committedRevision' = ${String(thread.revision)}`,
      ),
    );

  if (marked.length) {
    return marked;
  }

  return tx
    .select()
    .from(chatRunsTable)
    .where(
      and(
        eq(chatRunsTable.thread_id, thread.id),
        eq(chatRunsTable.state, "succeeded"),
        sql`${chatRunsTable.request}->>'baseRevision' = ${String(thread.revision - 1)}`,
      ),
    );
}

function unanchoredContext(thread: ThreadRow): UIMessage[] {
  if (thread.messages.some((message) => message.metadata?.fromSummary === true)) {
    throw new RunRequestError(409, "Archived summaries require a conversation context anchor");
  }

  return thread.messages;
}

function anchoredContext(anchor: RunRow, thread: ThreadRow): UIMessage[] {
  if (anchor.state === "pending" || anchor.request.baseRevision !== thread.revision - 1) {
    throw new RunRequestError(409, "Invalid conversation context anchor");
  }

  const prior = readProjection(anchor.projection);

  if (!isDeepStrictEqual(prior.display, thread.messages)) {
    throw new RunRequestError(409, "Conversation context anchor does not match saved history");
  }

  return prior.context;
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

  return !anchor || Array.isArray(anchor.projection)
    ? unanchoredContext(thread)
    : anchoredContext(anchor, thread);
}

export async function persistRun(value: RunInput) {
  const parsed = runInputSchema.safeParse(value);

  if (!parsed.success) {
    throw new RunRequestError(400, "Invalid run input");
  }

  const input = parsed.data;
  const db = await database();
  const accepted = await db.transaction(async (tx) => {
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
      if (!isDeepStrictEqual(runInputSchema.parse(existing.request), input)) {
        throw new RunRequestError(409, "Run input collision");
      }

      return { run: existing.accepted, pending: existing.state === "pending" };
    }

    return acceptInTransaction(tx, thread, input, side);
  });

  return accepted;
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

async function insertAcceptedRun(
  tx: Transaction,
  run: AcceptedRun,
  input: z.output<typeof runInputSchema>,
): Promise<void> {
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
  const additions = chatAdditions(input, metadata);
  const known = new Set([...thread.messages, ...priorContext].map((entry) => entry.id));

  if (additions.some((message) => known.has(message.id))) {
    throw new RunRequestError(409, "Message ID already exists in history or context");
  }

  const agent = agentRegistry.main;
  const run: AcceptedRun = {
    ...input,
    messages: [...thread.messages, ...additions],
    context: [...priorContext, ...additions],
    prompt: agent.systemPrompt(),
    model: agent.model,
    build: BUILD,
    ...(side ? { side: true } : {}),
  };
  await insertAcceptedRun(tx, run, input);

  return { run, pending: true };
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

function testingEventAppend(tx: Transaction, run: RunRow): AppendTestingEvent {
  return async (key, event) => {
    const sequence = run.next_sequence;
    await appendEvent(tx, run, key, event);

    return sequence;
  };
}

function transferConversation(run: RunRow): ConversationState | undefined {
  return run.accepted.messages.at(-1)?.metadata?.sideChatTransfer
    ? { display: run.accepted.messages, context: run.accepted.context }
    : undefined;
}

async function committedConversation(
  tx: Transaction,
  run: RunRow,
  conversation: ConversationState | undefined,
): Promise<ConversationState | undefined> {
  return conversation ?? (await failedConversation(tx, run)) ?? transferConversation(run);
}

async function commitThreadSnapshot(
  tx: Transaction,
  run: RunRow,
  thread: ThreadRow,
  messages: UIMessage[],
): Promise<void> {
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
}

async function releaseFailedThread(tx: Transaction, run: RunRow, thread: ThreadRow) {
  await appendEvent(tx, run, "failed:snapshot", snapshot(readProjection(run.projection).display));
  await tx.update(threadsTable).set({ active_run_id: null }).where(eq(threadsTable.id, thread.id));
}

function terminalEvent(
  succeeded: boolean,
  threadId: string,
  runId: string,
  code: string,
): StreamChunk {
  return succeeded
    ? { type: EventType.RUN_FINISHED, threadId, runId }
    : {
        type: EventType.RUN_ERROR,
        message: "執行失敗，請重新連線查看已儲存的內容。",
        code,
        metadata: { tanstack: { runId, threadId } },
      };
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
    await closeUnfinishedTesting(
      tx,
      run.id,
      testingFinishOutcome(code, succeeded),
      testingEventAppend(tx, run),
    );
    const committed = await committedConversation(tx, run, conversation);

    if (committed) {
      await commitThreadSnapshot(tx, run, thread, committed.display);
    } else {
      await releaseFailedThread(tx, run, thread);
    }

    await appendEvent(tx, run, "terminal", terminalEvent(succeeded, thread.id, runId, code));

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
        sql`not exists (select 1 from ${sideChatsTable} where ${sideChatsTable.id} = ${chatRunsTable.thread_id} and ${sideChatsTable.state} <> 'open')`,
        sql`not exists (select 1 from ${testingOperationsTable} where ${testingOperationsTable.id} = ${chatRunsTable.id} and ${testingOperationsTable.parent_run_id} = ${chatRunsTable.id})`,
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

    const published = await readPublishedThreadViewsInTransaction(tx, threadId);

    return {
      messages,
      revision: thread.revision,
      activeRun: thread.active_run_id ? { runId: thread.active_run_id } : null,
      publishedTesting: published[0] ?? null,
      publishedTasks: published.toReversed(),
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
      undefined,
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
      await tx.delete(chatModelSlotsTable).where(inArray(chatModelSlotsTable.run_id, ids));
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

async function withTestingRoot<T>(
  ownerRunId: string,
  work: (tx: Transaction, run: RunRow, thread: ThreadRow, append: AppendTestingEvent) => Promise<T>,
): Promise<T> {
  const db = await database();

  return db.transaction(async (tx) => {
    const locked = await lockRun(tx, ownerRunId);

    if (locked.run.state !== "pending") {
      throw new TestingPersistenceError(409, "Run is terminal");
    }

    assertThreadClaim(locked.run, locked.thread);

    return work(tx, locked.run, locked.thread, testingEventAppend(tx, locked.run));
  });
}

async function releaseStandaloneClaim(
  tx: Transaction,
  run: RunRow,
  thread: ThreadRow,
  outcome: RootRunOutcome,
) {
  if (thread.active_run_id === run.id) {
    await tx
      .update(threadsTable)
      .set({ active_run_id: null })
      .where(eq(threadsTable.id, thread.id));
  }

  if (run.state === "pending") {
    const state = outcome === "completed" ? "succeeded" : "failed";
    await tx.update(chatRunsTable).set({ state }).where(eq(chatRunsTable.id, run.id));
    run.state = state;
  }
}

export async function admitAttachedTesting(
  parent: AcceptedRun,
  callId: string,
  intent: unknown,
  now = new Date(),
): Promise<TestingAdmission> {
  const runtime = hostTestingRuntime({ model: parent.model, build: parent.build }, now);
  const db = await database();

  return db.transaction(async (tx) => {
    const locked = await lockRun(tx, parent.runId);

    if (locked.run.thread_id !== parent.threadId || locked.run.state !== "pending") {
      throw new TestingPersistenceError(409, "Attached testing requires the active parent run");
    }

    assertThreadClaim(locked.run, locked.thread);

    return admitAttachedInTransaction(tx, parent.runId, parent.threadId, callId, intent, runtime);
  });
}

export async function reserveRoleTask(
  ownerRunId: string,
  operationId: string,
  role: RoleId,
  input: unknown,
): Promise<RoleFrame | null> {
  return withTestingRoot(ownerRunId, (tx) =>
    reserveRoleTaskInTransaction(tx, operationId, ownerRunId, role, input),
  );
}

export async function guardActualIO(input: ActualIoInput): Promise<ActualIoGuard> {
  const db = await database();

  return db.transaction(async (tx) => {
    let owner: { run: RunRow; thread: ThreadRow };

    try {
      owner = await lockRun(tx, input.parentRunId);
    } catch (error) {
      if (error instanceof RunRequestError) {
        return { state: "denied", reason: "scope" };
      }

      throw error;
    }

    if (owner.run.state !== "pending") {
      return { state: "denied", reason: "terminal" };
    }

    if (
      owner.thread.active_run_id !== owner.run.id ||
      owner.thread.revision !== owner.run.request.baseRevision
    ) {
      return { state: "denied", reason: "scope" };
    }

    return guardActualIOInTransaction(tx, input, owner.thread.id);
  });
}

export async function acceptRoleCompletion(
  ownerRunId: string,
  taskId: string,
  completion: RoleCompletion,
): Promise<{ ref: ArtifactRef; kind: ArtifactKind }> {
  return withTestingRoot(ownerRunId, (tx) =>
    acceptRoleCompletionInTransaction(tx, ownerRunId, taskId, completion),
  );
}

export async function readTestingExecution(
  ownerRunId: string,
  operationId: string,
): Promise<TestingExecution> {
  return withTestingRoot(ownerRunId, (tx, run, thread) =>
    readTestingExecutionInTransaction(tx, run.id, thread.id, operationId),
  );
}

export async function publishProjection(
  ownerRunId: string,
  operationId: string,
): Promise<TestView> {
  return withTestingRoot(ownerRunId, (tx, _run, _thread, append) =>
    publishProjectionInTransaction(tx, ownerRunId, operationId, append),
  );
}

export async function cancelTesting(ownerRunId: string, operationId: string): Promise<TestView> {
  return withTestingRoot(ownerRunId, (tx, _run, _thread, append) =>
    cancelTestingInTransaction(tx, ownerRunId, operationId, append),
  );
}

export async function closeTesting(
  ownerRunId: string,
  operationId: string,
  rootOutcome: RootRunOutcome,
): Promise<TestView> {
  return withTestingRoot(ownerRunId, async (tx, run, thread, append) => {
    const view = await closeTestingInTransaction(tx, ownerRunId, operationId, rootOutcome, append);
    const [operation] = await tx
      .select({
        runtime: testingOperationsTable.runtime,
        terminal_outcome: testingOperationsTable.terminal_outcome,
      })
      .from(testingOperationsTable)
      .where(eq(testingOperationsTable.id, operationId));
    const runtime = operation?.runtime as { mode?: string } | undefined;

    if (runtime?.mode === "standalone" && operation?.terminal_outcome) {
      await releaseStandaloneClaim(tx, run, thread, operation.terminal_outcome as RootRunOutcome);
    }

    return view;
  });
}

function requireThreadId(threadId: string): void {
  if (!z.uuid().safeParse(threadId).success) {
    throw new RunRequestError(400, "Invalid thread ID");
  }
}

export async function readPublishedTesting(
  threadId: string,
  runId: string,
): Promise<TestView | null> {
  requireThreadId(threadId);

  return readPublishedTestingRow(threadId, runId);
}

export async function readPublishedThreadViews(threadId: string): Promise<readonly TestView[]> {
  requireThreadId(threadId);

  return readPublishedThreadViewsRow(threadId);
}

export async function recordRoleFailure(
  ownerRunId: string,
  taskId: string,
  reasonCode: string,
  issues?: readonly string[],
): Promise<{ duplicate: boolean }> {
  return withTestingRoot(ownerRunId, (tx) =>
    recordRoleFailureInTransaction(tx, ownerRunId, taskId, reasonCode, issues),
  );
}

export async function cancelPublishedTesting(threadId: string, runId: string): Promise<TestView> {
  requireThreadId(threadId);
  const selection = await selectTestingCancellation(threadId, runId);

  if (selection.kind === "live") {
    return cancelTesting(selection.parentRunId, selection.operationId);
  }

  const view =
    selection.kind === "terminal" ? await readPublishedTestingRow(threadId, runId) : null;

  if (!view) {
    throw new RunRequestError(404, "Testing run was not found");
  }

  return view;
}
