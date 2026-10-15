import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { db } from "../../server/db";
import app from "../../server/thread";

test("thread API rejects invalid creation and lookup requests", async () => {
  const create = await app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [] }),
  });
  assert.equal(create.status, 400);

  const blankMessage = await app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ id: "m1", role: "user", parts: [{ type: "text", content: "   " }] }],
    }),
  });
  assert.equal(blankMessage.status, 400);

  const lookup = await app.request("/not-a-uuid");
  assert.equal(lookup.status, 400);
});

test("thread creation accepts only an empty object and stores an empty revision", async () => {
  let stored: unknown;
  const id = "d08035f1-07df-49f3-b2d0-5cf5cb2b1e74";
  const insert = mock.method(
    db,
    "insert",
    () =>
      ({
        values(value: { title: string; messages: unknown[] }) {
          stored = value;
          return {
            returning: async () => [{ id, ...value, revision: 0, updated_at: new Date(0) }],
          };
        },
      }) as unknown as ReturnType<typeof db.insert>,
  );
  try {
    const response = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(stored, { title: "新對話", messages: [] });
    assert.deepEqual(await response.json(), {
      id,
      title: "新對話",
      messages: [],
      revision: 0,
      updatedAt: new Date(0).toISOString(),
    });
  } finally {
    insert.mock.restore();
  }
});

function deletionTransaction(row: { activeRunId: string | null } | undefined) {
  const writes: string[] = [];
  const where = () => ({ for: async () => (row ? [row] : []) });
  const tx = {
    select: () => ({ from: () => ({ where }) }),
    delete: (table: unknown) => ({
      where: async () => {
        writes.push(
          `delete:${String((table as Record<symbol, string>)[Symbol.for("drizzle:Name")])}`,
        );
      },
    }),
    update: () => ({
      set: () => ({
        where: async () => {
          writes.push("detach-children");
        },
      }),
    }),
  };
  const transaction = mock.method(db, "transaction", (async (
    run: (value: typeof tx) => Promise<unknown>,
  ) => run(tx)) as unknown as typeof db.transaction);

  return { writes, restore: () => transaction.mock.restore() };
}

test("thread deletion validates the id and refuses missing or running threads", async () => {
  assert.equal((await app.request("/not-a-uuid", { method: "DELETE" })).status, 400);

  const missing = deletionTransaction(undefined);
  try {
    const response = await app.request("/d08035f1-07df-49f3-b2d0-5cf5cb2b1e74", {
      method: "DELETE",
    });
    assert.equal(response.status, 404);
    assert.deepEqual(missing.writes, []);
  } finally {
    missing.restore();
  }

  const busy = deletionTransaction({ activeRunId: "run-1" });
  try {
    const response = await app.request("/d08035f1-07df-49f3-b2d0-5cf5cb2b1e74", {
      method: "DELETE",
    });
    assert.equal(response.status, 409);
    assert.deepEqual(busy.writes, []);
  } finally {
    busy.restore();
  }
});

test("thread deletion removes events, runs, and the thread", async () => {
  const idle = deletionTransaction({ activeRunId: null });
  try {
    const response = await app.request("/d08035f1-07df-49f3-b2d0-5cf5cb2b1e74", {
      method: "DELETE",
    });
    assert.equal(response.status, 204);
    assert.deepEqual(idle.writes, [
      "delete:chat_events",
      "delete:chat_runs",
      "detach-children",
      "delete:threads",
    ]);
  } finally {
    idle.restore();
  }
});
