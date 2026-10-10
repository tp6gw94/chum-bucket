import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mock, test, before, after } from "node:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { EventType } from "@tanstack/ai";
import { chatRunsTable, testingOperationsTable } from "../../../server/db/schema";
import threadApp from "../../../server/thread";
import testingApp from "../../../server/testing";
import { database, persistRun, hydrateThread } from "../../../server/harness/run-store";
import { readStartCancelDeliveries } from "../../../server/harness/testing-store";
import { launchChatRuntime, shutdownChatRuntime, ensureStarted } from "../../../server/harness/run";
import { withMcpEnvironment } from "../../fixtures/mcp-fixture";
import { roleRegistry } from "../../../server/harness/agents";
import { ROLE_IDS } from "../../../shared/testing";

const require = createRequire(import.meta.url);
const { scriptedEvents } = require("../../fixtures/testing-runtime-external-fixture.mjs") as {
  scriptedEvents: (
    options: { systemPrompts?: string[]; messages?: unknown[] },
    control: { intent?: Record<string, unknown>; failUi?: boolean },
  ) => Array<Record<string, unknown>>;
};
const enabled = process.env.TESTING_RUNTIME_DATABASE_URL;
const providerCalls: string[] = [];
type ProviderRequest = { systemPrompts?: string[]; messages?: unknown[] };
const providerRequests: ProviderRequest[] = [];

function userTaskText(options: ProviderRequest): string {
  const messages = options.messages as Array<{ role: string; content: unknown }> | undefined;
  const user = messages?.find((message) => message.role === "user");

  if (typeof user?.content === "string") {
    return user.content;
  }

  return Array.isArray(user?.content)
    ? user.content.map((part: { text?: string }) => part.text ?? "").join("")
    : "";
}
const control: { intent?: Record<string, unknown>; failUi?: boolean } = {};
let migrationFolder: string | undefined;
let restoreFetch: (() => void) | undefined;
let chatStream: { mock: { restore: () => void } } | undefined;

async function migrationsFolder() {
  if (migrationFolder) {
    return migrationFolder;
  }

  const source = path.resolve("drizzle");
  const journal = JSON.parse(await readFile(path.join(source, "meta/_journal.json"), "utf8")) as {
    version: string;
    dialect: string;
    entries: readonly {
      idx: number;
      version: string;
      when: number;
      tag: string;
      breakpoints: boolean;
    }[];
  };
  const entries = journal.entries
    .filter((entry) => entry.tag !== "0000_durable_chat")
    .map((entry, idx) => ({ ...entry, idx }));
  migrationFolder = await mkdtemp(path.join(tmpdir(), "chum-testing-runtime-migrations-"));
  await mkdir(path.join(migrationFolder, "meta"));

  for (const entry of entries) {
    await copyFile(
      path.join(source, `${entry.tag}.sql`),
      path.join(migrationFolder, `${entry.tag}.sql`),
    );
  }

  await writeFile(
    path.join(migrationFolder, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );

  return migrationFolder;
}

async function migrateDatabase() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    await migrate(drizzle(pool), { migrationsFolder: await migrationsFolder() });
  } finally {
    await pool.end();
  }
}

function installFigmaBoundary() {
  const original = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const url = String(input);

    if (url.includes("api.figma.com")) {
      return new Response(
        JSON.stringify({
          nodes: {
            "12:34": {
              document: {
                id: "12:34",
                name: "Checkout",
                type: "FRAME",
                visible: true,
                absoluteBoundingBox: { x: 0, y: 0, width: 320, height: 48 },
              },
            },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }

    return original(input, init);
  };

  restoreFetch = () => {
    globalThis.fetch = original;
  };
}

async function installProviderBoundary() {
  const { deepinfra } = await import("../../../server/harness/provider");
  const { MODEL } = await import("../../../server/harness/run-store");
  const adapter = deepinfra(MODEL);
  chatStream = mock.method(
    Object.getPrototypeOf(adapter),
    "chatStream",
    async function* (options: { systemPrompts?: string[]; messages?: unknown[] }) {
      const role = userTaskText(options).match(/testing-role:([a-z]+)/)?.[1] ?? "main";
      providerCalls.push(role);
      providerRequests.push(
        structuredClone({
          systemPrompts: options.systemPrompts,
          messages: options.messages,
        }),
      );
      const events = scriptedEvents(options, control);

      for (const event of events) {
        yield event.type === "RUN_STARTED" ? { ...event, type: EventType.RUN_STARTED } : event;
      }
    },
  );
}

async function createThread() {
  const response = await threadApp.request("/", {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json" },
  });
  assert.equal(response.status, 200);

  return (await response.json()) as { id: string; revision: number };
}

function requestBody(threadId: string, revision: number, extra: Record<string, unknown> = {}) {
  return {
    threadId,
    expectedRevision: revision,
    requestId: `req-${randomUUID().slice(0, 8)}`,
    goal: "Verify checkout",
    sources: [{ kind: "jira", issueKey: "CHUM-42" }],
    criteria: { kind: "all" },
    targetUrl: "https://preview.example.test/checkout",
    ...extra,
  };
}

async function readView(threadId: string, runId: string) {
  const response = await testingApp.request(`/${encodeURIComponent(runId)}?threadId=${threadId}`);

  return { status: response.status, body: await response.json() };
}

async function waitFinished(threadId: string, runId: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const view = await readView(threadId, runId);

    if (view.status === 200 && view.body.state === "finished") {
      return view.body;
    }

    await delay(250);
  }

  const last = await readView(threadId, runId);
  throw new Error(`testing run did not finish: ${JSON.stringify(last.body).slice(0, 800)}`);
}

before(async () => {
  if (!enabled) {
    return;
  }

  process.env.DATABASE_URL = enabled;
  process.env.MODEL_API_KEY = "offline";
  process.env.FIGMA_API_KEY = "offline-figma";
  await migrateDatabase();
  installFigmaBoundary();
  await installProviderBoundary();
  await launchChatRuntime();
});

after(async () => {
  if (!enabled) {
    return;
  }

  chatStream?.mock.restore();
  restoreFetch?.();
  await shutdownChatRuntime().catch(() => undefined);

  if (migrationFolder) {
    await rm(migrationFolder, { recursive: true, force: true });
  }
});

test(
  "invalid artifact references reject before a standalone claim",
  { skip: !enabled, timeout: 60_000 },
  async () => {
    const thread = await createThread();
    const beforeRuns = await countRuns(thread.id);
    const response = await testingApp.request("/", {
      method: "POST",
      body: JSON.stringify(
        requestBody(thread.id, thread.revision, { existingArtifacts: ["missing-artifact-ref"] }),
      ),
      headers: { "content-type": "application/json" },
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(
      body.decisions.some((decision: { kind: string }) => decision.kind === "rejected"),
      true,
    );
    assert.equal(await countRuns(thread.id), beforeRuns);
  },
);

test(
  "public request runs real children and publishes a non-passing report",
  { skip: !enabled, timeout: 120_000 },
  async () => {
    await withMcpEnvironment(async () => {
      const beforeCalls = providerCalls.length;
      const thread = await createThread();
      const response = await testingApp.request("/", {
        method: "POST",
        body: JSON.stringify(requestBody(thread.id, thread.revision)),
        headers: { "content-type": "application/json" },
      });
      assert.equal(response.status, 200);
      const started = await response.json();
      assert.equal(started.state, "active");
      assert.equal(started.report, null);
      const finished = await waitFinished(thread.id, started.runId);
      assert.equal(finished.state, "finished");
      assert.notEqual(finished.report.acceptance.verdict, "passed");
      assert.equal(finished.progress.rows.ui.status, "not_required");
      assert.equal(finished.report.results.ac.length > 0, true);
      assert.equal(providerCalls.slice(beforeCalls).includes("atlassian"), true);
      assert.equal(providerCalls.slice(beforeCalls).includes("planner"), true);
      assert.equal(providerCalls.slice(beforeCalls).includes("ac"), true);
      const evidence = finished.report.results.ac[0].evidence[0];

      if (evidence.outcome !== "blocked") {
        assert.notEqual(evidence.observed, evidence.expected);
        assert.notEqual(evidence.observed, "UNIQUE-EXPECTED");
      }

      const deliveries = await readStartCancelDeliveries(started.runId);
      assert.equal(deliveries.filter((delivery) => delivery.kind === "start").length, 3);
      assert.equal(
        deliveries.every(
          (delivery) => delivery.kind === "start" && delivery.acknowledgement === "quiet",
        ),
        true,
      );
    });
  },
);

test(
  "attached main orchestration returns the public view without a side room",
  { skip: !enabled, timeout: 120_000 },
  async () => {
    await withMcpEnvironment(async () => {
      const thread = await createThread();
      control.intent = {
        goal: "Verify checkout",
        sources: [{ kind: "jira", issueKey: "CHUM-42" }],
        criteria: { kind: "all" },
        targetUrl: "https://preview.example.test/checkout",
      };
      const accepted = await persistRun({
        threadId: thread.id,
        runId: `chat-${randomUUID().slice(0, 8)}`,
        baseRevision: thread.revision,
        message: { id: "user-1", text: "請測試結帳" },
      });
      await ensureStarted(accepted.run);
      let done = await hydrateThread(thread.id);

      for (let attempt = 0; attempt < 80 && done.activeRun; attempt += 1) {
        await delay(250);
        done = await hydrateThread(thread.id);
      }

      assert.equal(done.activeRun, null);
      assert.equal(done.publishedTesting?.state, "finished");
      const db = await database();
      const operations = await db
        .select({ id: testingOperationsTable.id })
        .from(testingOperationsTable)
        .where(eq(testingOperationsTable.parent_run_id, accepted.run.runId));
      assert.equal(operations.length, 1);
      const deliveries = await readStartCancelDeliveries(operations[0]!.id);
      assert.equal(deliveries.filter((delivery) => delivery.kind === "start").length, 3);
      assert.equal(
        deliveries.every(
          (delivery) => delivery.kind === "start" && delivery.acknowledgement === "quiet",
        ),
        true,
      );
    });
  },
);

test(
  "all four child roles send distinct system instructions and task data only as user messages",
  { skip: !enabled, timeout: 120_000 },
  async () => {
    await withMcpEnvironment(async () => {
      const start = providerRequests.length;
      const thread = await createThread();
      const response = await testingApp.request("/", {
        method: "POST",
        body: JSON.stringify(
          requestBody(thread.id, thread.revision, {
            design: { fileKey: "FILE", nodeId: "12:34" },
          }),
        ),
        headers: { "content-type": "application/json" },
      });
      assert.equal(response.status, 200);
      const started = await response.json();
      const finished = await waitFinished(thread.id, started.runId);
      assert.equal(finished.report.results.ac.length > 0, true);
      assert.equal(finished.report.results.ui.length > 0, true);
      assert.notEqual(finished.report.acceptance.verdict, "passed");
      const requests = providerRequests.slice(start);

      for (const role of ROLE_IDS) {
        const calls = requests.filter((request) =>
          userTaskText(request).startsWith(`testing-role:${role}\n`),
        );
        assert.ok(calls.length > 0, `${role} must reach the provider`);

        for (const call of calls) {
          assert.equal(call.systemPrompts?.[0], roleRegistry[role].systemPrompt);
          assert.ok((call.systemPrompts?.length ?? 0) > 1, "tool instructions remain separate");
          assert.equal(
            call.systemPrompts?.some((prompt) => prompt.includes("testing-task:")),
            false,
          );
          const taskText = userTaskText(call);
          assert.equal(taskText.includes(roleRegistry[role].systemPrompt), false);
          const task = JSON.parse(taskText.split("testing-task:\n")[1]!);
          assert.equal(task.goal, "Verify checkout");
          assert.deepEqual(task.bounds, { maxCases: 20, maxChecks: 80, maxChecksPerCase: 12 });

          if (role === "ac" || role === "ui") {
            assert.ok(task.plan.assignments[role].length > 0);
            assert.ok(task.plan.cases[0].actions.length > 0);
          }
        }
      }
    });
  },
);

async function countRuns(threadId: string) {
  const db = await database();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(chatRunsTable)
    .where(eq(chatRunsTable.thread_id, threadId));

  return row?.count ?? 0;
}
