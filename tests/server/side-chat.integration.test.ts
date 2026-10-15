import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { UIMessage } from "@tanstack/ai";

const databaseUrl = process.env.TEST_DATABASE_URL;
const skip = databaseUrl ? false : "set TEST_DATABASE_URL to a disposable Postgres database";

if (databaseUrl) {
  process.env.DATABASE_URL = databaseUrl;
}

const user = (id: string, text: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", content: text }],
});
const assistant = (id: string, text: string): UIMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "text", content: text }],
});

async function modules() {
  const [schema, store, side, conversation, compaction, drizzle] = await Promise.all([
    import("../../server/db/schema"),
    import("../../server/harness/run-store"),
    import("../../server/harness/side-chat-store"),
    import("../../server/harness/conversation"),
    import("../../server/harness/compaction"),
    import("drizzle-orm"),
  ]);
  const db = await store.database();

  return { schema, store, side, conversation, compaction, drizzle, db };
}

type Modules = Awaited<ReturnType<typeof modules>>;
let m: Modules;

before(async () => {
  if (!databaseUrl) {
    return;
  }

  m = await modules();
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  await migrate(m.db, { migrationsFolder: "drizzle" });
});

after(async () => {
  if (databaseUrl) {
    await m.db.$client.end();
  }
});

async function createThread(messages: UIMessage[] = []) {
  const id = randomUUID();
  await m.db.insert(m.schema.threadsTable).values({ id, title: "t", messages });

  return id;
}

async function thread(id: string) {
  const [row] = await m.db
    .select()
    .from(m.schema.threadsTable)
    .where(m.drizzle.eq(m.schema.threadsTable.id, id));

  return row;
}

async function chat(threadId: string, text: string, admit = m.side.sideChatAdmission) {
  const current = await thread(threadId);

  return m.store.persistRun(
    {
      threadId,
      runId: randomUUID(),
      baseRevision: current!.revision,
      message: { id: randomUUID(), text },
    },
    admit,
  );
}

async function compactThread(threadId: string) {
  const current = await thread(threadId);
  const runId = randomUUID();
  const { run } = await m.store.persistRun({
    kind: "compact",
    threadId,
    runId,
    baseRevision: current!.revision,
  });
  const operationId = `${runId}/compact/0`;
  const summary = m.compaction.summaryMessage(operationId, "Earlier work summarized");
  const next = {
    display: [...run.conversation.display, summary],
    context: [summary, ...run.conversation.context.slice(-1)],
  };
  await m.store.checkpointCompaction(runId, operationId, next, "done", "manual");
  await m.store.finishRun(runId, next);

  return { runId, operationId, summary, next };
}

test("compaction checkpoints are idempotent per operation", { skip }, async () => {
  const threadId = await createThread([user("u1", "q1"), assistant("a1", "a1")]);
  const current = await thread(threadId);
  const runId = randomUUID();
  const { run } = await m.store.persistRun({
    kind: "compact",
    threadId,
    runId,
    baseRevision: current!.revision,
  });
  const operationId = `${runId}/compact/0`;
  await m.store.checkpointCompaction(runId, operationId, run.conversation, "skipped", "manual");
  await m.store.checkpointCompaction(runId, operationId, run.conversation, "skipped", "manual");
  const events = await m.db
    .select()
    .from(m.schema.chatEventsTable)
    .where(m.drizzle.eq(m.schema.chatEventsTable.event_key, `compact:${operationId}`));
  assert.equal(events.length, 1);
  await assert.rejects(
    m.store.checkpointCompaction(runId, operationId, run.conversation, "done", "manual"),
    /different result/,
  );
});

test("the next run reads its context from the compaction anchor", { skip }, async () => {
  const original = [
    user("u1", "q1"),
    assistant("a1", "a1"),
    user("u2", "q2"),
    assistant("a2", "a2"),
  ];
  const threadId = await createThread(original);
  const { summary } = await compactThread(threadId);
  const saved = await thread(threadId);
  assert.deepEqual(saved!.messages, [...original, summary]);

  const { run } = await chat(threadId, "follow up");
  assert.equal(run.conversation.context[0]!.id, summary.id);
  assert.deepEqual(run.conversation.context.map((message) => message.id).slice(1, 2), ["a2"]);
  assert.equal(run.conversation.display.length, original.length + 2);
});

test("a summary without a context anchor is refused", { skip }, async () => {
  const summary = m.compaction.summaryMessage("orphan", "orphan summary");
  const threadId = await createThread([user("u1", "q"), summary]);
  await assert.rejects(chat(threadId, "next"), /Missing context anchor/);
});

test(
  "side chats refuse nesting and busy parents and never touch the main thread",
  { skip },
  async () => {
    const parentId = await createThread([
      user("u1", "main question"),
      assistant("a1", "main answer"),
    ]);
    const { id } = await m.side.openSideChat(parentId);
    await assert.rejects(m.side.openSideChat(id), /nested/);

    const busy = await chat(parentId, "keep working");
    await assert.rejects(m.side.openSideChat(parentId), /running/);
    await m.store.finishRun(busy.run.runId, busy.run.conversation);

    const before = await thread(parentId);
    const sideRun = await chat(id, "side question");
    assert.equal(sideRun.run.sideChat, true);
    await m.store.finishRun(sideRun.run.runId, {
      display: [...sideRun.run.conversation.display, assistant("side-a", "side answer")],
      context: [...sideRun.run.conversation.context, assistant("side-a", "side answer")],
    });
    const afterSide = await thread(parentId);
    assert.deepEqual(afterSide!.messages, before!.messages);
    assert.equal(afterSide!.revision, before!.revision);

    const additions = await m.side.sideChatAdditions(id);
    assert.deepEqual(
      additions.map((message) => message.role),
      ["user", "assistant"],
    );
    assert.ok(
      additions.every((message) => !before!.messages.some((seed) => seed.id === message.id)),
    );
  },
);

test("a compacted parent seeds the side chat from its summary", { skip }, async () => {
  const parentId = await createThread([
    user("u1", "q1"),
    assistant("a1", "a1"),
    user("u2", "q2"),
    assistant("a2", "a2"),
  ]);
  const { summary } = await compactThread(parentId);
  const { id } = await m.side.openSideChat(parentId);
  const { run } = await chat(id, "side question");
  assert.equal(run.conversation.context[0]!.id, summary.id);
});

test("transfers are idempotent by text and survive side chat deletion", { skip }, async () => {
  const parentId = await createThread([user("u1", "main"), assistant("a1", "answer")]);
  const { id } = await m.side.openSideChat(parentId);
  const sideRun = await chat(id, "side question");
  await m.store.finishRun(sideRun.run.runId, sideRun.run.conversation);

  const first = await m.side.transferSideChat(id, "  edited summary  ");
  assert.equal(first.run.runId, `side-${id}`);
  await assert.rejects(m.side.assertSideChatOpen(id), /closed/);
  const second = await m.side.transferSideChat(id, "edited summary");
  assert.equal(second.run.runId, first.run.runId);
  await assert.rejects(m.side.transferSideChat(id, "different"), /different summary/);

  await m.side.deleteSideChat(id);
  assert.equal(await thread(id), undefined);
  const third = await m.side.transferSideChat(id, "edited summary");
  assert.equal(third.run.runId, first.run.runId);

  const parentRuns = await m.db
    .select()
    .from(m.schema.chatRunsTable)
    .where(m.drizzle.eq(m.schema.chatRunsTable.thread_id, parentId));
  assert.equal(parentRuns.filter((run) => run.id === first.run.runId).length, 1);

  await m.store.finishRun(first.run.runId, undefined, "test_failure");
  const parent = await thread(parentId);
  const last = parent!.messages.at(-1)!;
  assert.equal(last.id, first.run.runId);
  assert.deepEqual(last.metadata, { sideChatTransfer: true });
  const next = await chat(parentId, "after failure");
  assert.equal(next.run.conversation.context.at(-2)!.id, first.run.runId);
});

test("closing a side chat stops admission and deletion removes every row", { skip }, async () => {
  const parentId = await createThread([user("u1", "main")]);
  const { id } = await m.side.openSideChat(parentId);
  const sideRun = await chat(id, "side question");
  await m.side.markSideChatClosing(id);
  await assert.rejects(m.side.assertSideChatOpen(id), /closed/);
  await m.store.finishRun(sideRun.run.runId, undefined, "cancelled");
  await assert.rejects(chat(id, "after close"), /closed/);
  await m.side.deleteSideChat(id);

  assert.equal(await thread(id), undefined);
  const runs = await m.db
    .select()
    .from(m.schema.chatRunsTable)
    .where(m.drizzle.eq(m.schema.chatRunsTable.thread_id, id));
  assert.deepEqual(runs, []);
  const sides = await m.db
    .select()
    .from(m.schema.sideChatsTable)
    .where(m.drizzle.eq(m.schema.sideChatsTable.id, id));
  assert.deepEqual(sides, []);
});
