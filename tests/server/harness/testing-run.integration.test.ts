import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { delegateTask } from "../../../server/harness/testing-run";
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
import {
  database,
  persistRun,
  openSideChat,
  hydrateThread,
  admitAttachedTesting,
  reserveRoleTask,
  cancelPublishedTesting,
  finishRun,
} from "../../../server/harness/run-store";
import { readStartCancelDeliveries } from "../../../server/harness/testing-store";
import {
  launchChatRuntime,
  shutdownChatRuntime,
  ensureStarted,
  executeRun,
} from "../../../server/harness/run";
import {
  mcpFixture,
  sourceReadPages,
  sourceReadRule,
  withMcpEnvironment,
} from "../../fixtures/mcp-fixture";
import { digestOf } from "../../../server/harness/testing-domain";
import { agentRegistry, roleRegistry } from "../../../server/harness/agents";
import { ROLE_IDS } from "../../../shared/testing";

const require = createRequire(import.meta.url);
const { scriptedEvents } = require("../../fixtures/testing-runtime-external-fixture.mjs") as {
  scriptedEvents: (
    options: { systemPrompts?: string[]; messages?: unknown[] },
    control: {
      intent?: Record<string, unknown>;
      failUi?: boolean;
      planningMixed?: boolean;
      plannerScenario?: string;
    },
  ) => Array<Record<string, unknown>>;
};
const enabled = process.env.TESTING_RUNTIME_DATABASE_URL;
const originalEnvironment = {
  DATABASE_URL: process.env.DATABASE_URL,
  MODEL_API_KEY: process.env.MODEL_API_KEY,
  FIGMA_API_KEY: process.env.FIGMA_API_KEY,
  JEV_API_KEY: process.env.JEV_API_KEY,
};
const providerCalls: string[] = [];
type ProviderRequest = {
  model: string;
  adapterModel: string;
  systemPrompts?: string[];
  messages?: unknown[];
};
const providerRequests: ProviderRequest[] = [];

function userTaskText(options: Pick<ProviderRequest, "messages">): string {
  const messages = options.messages as Array<{ role: string; content: unknown }> | undefined;
  const user = messages?.find((message) => message.role === "user");

  if (typeof user?.content === "string") {
    return user.content;
  }

  return Array.isArray(user?.content)
    ? user.content.map((part: { text?: string }) => part.text ?? "").join("")
    : "";
}
const control: {
  intent?: Record<string, unknown>;
  failUi?: boolean;
  planningMixed?: boolean;
  plannerScenario?: string;
} = {};
const checkoutIssue = {
  key: "CHUM-42",
  summary: "Checkout",
  description: "## 驗收條件\n1. AC-1 Checkout succeeds",
  customfield_10009: "考核說明：private grading note",
};

function sourceFixture(
  rules = [sourceReadRule("jira_get_issue", { issue_key: "CHUM-42" }, checkoutIssue)],
) {
  return mcpFixture({ pages: sourceReadPages, rules });
}
const cancelledDelegation = DBOS.registerWorkflow(
  async () => {
    const payload = await DBOS.recv<{
      run: Parameters<typeof delegateTask>[0];
      input: Record<string, unknown>;
    }>("cancelled-reservation");

    if (!payload) throw new Error("Cancelled reservation was not delivered");

    const result = await delegateTask(payload.run, {
      id: "reserved",
      name: "delegate_task",
      arguments: JSON.stringify(payload.input),
      input: payload.input,
    });
    await DBOS.runStep(() => finishRun(payload.run.runId), { name: "finish" });

    return result;
  },
  { name: "delegation-cancel-proof-v2" },
);
let migrationFolder: string | undefined;
let runtimeLaunched = false;
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
  const { MODEL } = await import("../../../server/harness/agents");
  const adapter = deepinfra(MODEL);
  chatStream = mock.method(
    Object.getPrototypeOf(adapter),
    "chatStream",
    async function* (
      this: { model: string },
      options: { model: string; systemPrompts?: string[]; messages?: unknown[] },
    ) {
      const role = userTaskText(options).match(/testing-role:([a-z]+)/)?.[1] ?? "main";
      providerCalls.push(role);
      providerRequests.push(
        structuredClone({
          model: options.model,
          adapterModel: this.model,
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

const intent = {
  goal: "Verify checkout",
  sources: [{ kind: "jira", issueKey: "CHUM-42" }],
  targetUrl: "https://preview.example.test/checkout",
};

async function chat(thread: { id: string; revision: number }, input: Record<string, unknown>) {
  control.intent = input;
  const accepted = await persistRun({
    threadId: thread.id,
    runId: `chat-${randomUUID().slice(0, 8)}`,
    baseRevision: thread.revision,
    message: { id: `user-${randomUUID()}`, text: "Please delegate the requested checkout task" },
  });
  await ensureStarted(accepted.run);
  return accepted.run;
}

async function waitChat(threadId: string) {
  let done = await hydrateThread(threadId);
  for (let attempt = 0; attempt < 160 && done.activeRun; attempt += 1) {
    await delay(125);
    done = await hydrateThread(threadId);
  }
  assert.equal(done.activeRun, null, "main run must converge");
  return done;
}

before(async () => {
  if (!enabled) {
    return;
  }

  process.env.DATABASE_URL = enabled;
  process.env.MODEL_API_KEY = "offline";
  process.env.FIGMA_API_KEY = "offline-figma";
  process.env.JEV_API_KEY = "";
  await migrateDatabase();
  installFigmaBoundary();
  await installProviderBoundary();
  await launchChatRuntime();
  runtimeLaunched = true;
});

after(async () => {
  if (!enabled) {
    return;
  }

  try {
    chatStream?.mock.restore();
    restoreFetch?.();
    if (runtimeLaunched) await shutdownChatRuntime();

    if (migrationFolder) {
      await rm(migrationFolder, { recursive: true, force: true });
    }
  } finally {
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test(
  "main and side admission retain their registry prompt snapshots through execution and replay",
  { skip: !enabled, timeout: 30_000 },
  async () => {
    await withMcpEnvironment(async () => {
      const { deepinfra } = await import("../../../server/harness/provider");
      const requests: ProviderRequest[] = [];
      const provider = mock.method(
        Object.getPrototypeOf(deepinfra(agentRegistry.main.model)),
        "chatStream",
        async function* (this: { model: string }, options: Omit<ProviderRequest, "adapterModel">) {
          requests.push(
            structuredClone({
              model: options.model,
              adapterModel: this.model,
              systemPrompts: options.systemPrompts,
              messages: options.messages,
            }),
          );
          yield {
            type: EventType.TEXT_MESSAGE_START,
            messageId: "registry-answer",
            role: "assistant",
          };
          yield {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: "registry-answer",
            delta: "Registry reply",
          };
          yield { type: EventType.TEXT_MESSAGE_END, messageId: "registry-answer" };
          yield {
            type: EventType.RUN_FINISHED,
            threadId: "provider",
            runId: "provider",
            finishReason: "stop",
          };
        },
      );
      try {
        for (const scope of ["main", "side"] as const) {
          const parent = await createThread();
          const thread = scope === "side" ? await openSideChat(parent.id) : parent;
          const input = {
            threadId: thread.id,
            runId: `registry-${randomUUID()}`,
            baseRevision: 0,
            message: { id: `registry-user-${randomUUID()}`, text: "Reply once" },
          };
          const expectedPrompt = `${scope} registry snapshot`;
          const prompt = mock.method(agentRegistry.main, "systemPrompt", () => expectedPrompt);
          let admitted: Awaited<ReturnType<typeof persistRun>>;
          try {
            admitted = await persistRun(input);
          } finally {
            prompt.mock.restore();
          }
          assert.equal(admitted.run.prompt, expectedPrompt);
          assert.equal(admitted.run.model, "deepseek-ai/DeepSeek-V4.1-Flash");
          const selectedModel = agentRegistry.main.model;
          Object.defineProperty(agentRegistry.main, "model", {
            value: "snapshot-model-mismatch",
          });
          try {
            await assert.rejects(ensureStarted(admitted.run), /Incompatible run build/);
            await assert.rejects(executeRun(admitted.run), /Incompatible run build/);
          } finally {
            Object.defineProperty(agentRegistry.main, "model", { value: selectedModel });
          }
          await ensureStarted(admitted.run);
          let state = await hydrateThread(thread.id);
          for (let attempt = 0; attempt < 200 && state.activeRun; attempt += 1) {
            await delay(20);
            state = await hydrateThread(thread.id);
          }
          assert.equal(state.activeRun, null);
          assert.equal(JSON.stringify(state.messages).includes("Registry reply"), true);
          assert.equal(requests.at(-1)?.systemPrompts?.[0], expectedPrompt);
          assert.equal(requests.at(-1)?.model, "deepseek-ai/DeepSeek-V4.1-Flash");
          assert.equal(requests.at(-1)?.adapterModel, "deepseek-ai/DeepSeek-V4.1-Flash");
          const replay = await persistRun(input);
          assert.equal(replay.run.prompt, expectedPrompt);
          assert.equal(replay.pending, false);
          const db = await database();
          const [stored] = await db
            .select()
            .from(chatRunsTable)
            .where(eq(chatRunsTable.id, input.runId));
          assert.equal(stored?.accepted.prompt, expectedPrompt);
          assert.equal(stored?.accepted.model, "deepseek-ai/DeepSeek-V4.1-Flash");
        }
      } finally {
        provider.mock.restore();
      }
    });
  },
);

test(
  "the retired whole-pipeline HTTP admission never creates work",
  { skip: !enabled },
  async () => {
    const thread = await createThread();
    const response = await testingApp.request("/", {
      method: "POST",
      body: JSON.stringify({ ...intent, threadId: thread.id }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(response.status, 410);
    assert.equal(await countRuns(thread.id), 0);
  },
);

test(
  "plan-only conversation creates exactly two durable tasks and reloads both",
  { skip: !enabled, timeout: 120_000 },
  async () => {
    await withMcpEnvironment(
      async () => {
        const thread = await createThread();
        const start = providerCalls.length;
        const parent = await chat(thread, intent);
        const done = await waitChat(thread.id);
        assert.deepEqual(
          done.publishedTasks.map((view) => view.task?.role),
          ["atlassian", "planner"],
        );
        assert.equal(
          done.publishedTasks.every((view) => view.state === "finished"),
          true,
        );
        assert.equal(new Set(done.publishedTasks.map((view) => view.runId)).size, 2);
        const plan = done.publishedTasks.find((view) => view.task?.role === "planner")?.task
          ?.result;
        assert.equal(plan?.kind === "plan" && plan.payload.cases[0]?.id, "case-1");
        assert.equal(
          done.publishedTasks.every((view) => view.report === null),
          true,
        );
        assert.equal(providerCalls.slice(start).includes("ac"), false);
        assert.equal(providerCalls.slice(start).includes("ui"), false);
        const db = await database();
        const operations = await db
          .select()
          .from(testingOperationsTable)
          .where(eq(testingOperationsTable.parent_run_id, parent.runId));
        assert.equal(operations.length, 2);
        for (const operation of operations) {
          const deliveries = await readStartCancelDeliveries(operation.id);
          assert.equal(deliveries.length, 1);
          assert.equal(deliveries[0]?.kind, "start");
          assert.equal(deliveries[0]?.acknowledgement, "quiet");
        }
        assert.deepEqual((await hydrateThread(thread.id)).publishedTasks, done.publishedTasks);
      },
      true,
      sourceFixture(),
    );
  },
);

test(
  "unresolved functional-only planning persists mixed final replies without UI or execution children",
  { skip: !enabled, timeout: 120_000 },
  async () => {
    await withMcpEnvironment(
      async () => {
        const thread = await createThread();
        const start = providerCalls.length;
        control.planningMixed = true;
        try {
          await chat(thread, {
            goal: intent.goal,
            sources: intent.sources,
          });
          const done = await waitChat(thread.id);
          assert.deepEqual(
            done.publishedTasks.map((view) => view.task?.role),
            ["atlassian", "planner"],
          );
          const requirements = done.publishedTasks.find((view) => view.task?.role === "atlassian")
            ?.task?.result;
          assert.equal(requirements?.kind, "requirements");
          assert.equal(
            requirements?.kind === "requirements" && "unresolved" in requirements.payload,
            false,
          );
          const plan = done.publishedTasks.find((view) => view.task?.role === "planner")?.task
            ?.result;
          assert.equal(plan?.kind, "plan");
          if (plan?.kind === "plan") {
            assert.deepEqual(plan.payload.unresolved, [
              "Price rule is not specified",
              "Execution URL is not supplied",
              "UI validation is not required",
            ]);
            assert.deepEqual(plan.payload.assignments, { ac: ["check-1"], ui: [] });
          }
          assert.deepEqual([...new Set(providerCalls.slice(start))].sort(), [
            "atlassian",
            "main",
            "planner",
          ]);
          const reply = done.messages
            .filter((message) => message.role === "assistant")
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "text")
            .map((part) => part.content)
            .join("");
          assert.match(reply, /Here's the functional-only plan/);
          assert.match(reply, /Middle prose/);
          assert.match(reply, /Trailing prose/);
          assert.equal((reply.match(/root = Stack/g) ?? []).length, 2);
          const reloaded = await hydrateThread(thread.id);
          assert.deepEqual(reloaded.messages, done.messages);
          assert.deepEqual(reloaded.publishedTasks, done.publishedTasks);
        } finally {
          control.planningMixed = false;
        }
      },
      true,
      sourceFixture(),
    );
  },
);

test(
  "source reads retry unread sources once, ignore invented JSON and persist failures privately",
  { skip: !enabled, timeout: 120_000 },
  async () => {
    const page = {
      metadata: {
        id: "PAGE-7",
        title: "結帳規格",
        content: { value: "## 運費\n- 滿 NT$500 免運", format: "markdown" },
      },
    };
    const fixture = sourceFixture([
      sourceReadRule("jira_get_issue", { issue_key: "CHUM-42" }, checkoutIssue),
      sourceReadRule("confluence_get_page", { page_id: "PAGE-7" }, page),
    ]);
    const issueText = "CHUM-42 Checkout\n\n## 驗收條件\n1. AC-1 Checkout succeeds";
    await withMcpEnvironment(
      async () => {
        for (const scenario of [
          "source-all",
          "source-retry",
          "source-invented",
          "source-missing",
        ]) {
          const thread = await createThread();
          const start = providerRequests.length;
          await chat(thread, {
            role: "atlassian",
            summary: scenario,
            goal: "Read checkout sources",
            sources: [
              { kind: "jira", issueKey: "CHUM-42" },
              { kind: "confluence", pageId: "PAGE-7" },
            ],
          });
          const done = await waitChat(thread.id);
          const view = done.publishedTasks[0]!;
          const result = view.task?.result;
          const feedback = providerRequests
            .slice(start)
            .flatMap((request) => (request.messages ?? []) as Array<{ content?: unknown }>)
            .map((message) => (typeof message.content === "string" ? message.content : ""))
            .filter((text) => text.startsWith("Private validation failed:"));
          const pool = new pg.Pool({ connectionString: enabled });
          try {
            const receipts = await pool.query(
              "select r.native_name, r.output_digest, r.bindings from testing_receipts r join testing_tasks t on t.id = r.task_id join testing_operations o on o.id = t.operation_id where o.thread_id = $1 and r.native_name in ('jira_get_issue', 'confluence_get_page') order by r.slot",
              [thread.id],
            );
            const checkpoints = await pool.query(
              "select f.function_name from dbos.operation_outputs f join testing_tasks t on t.child_workflow_id = f.workflow_uuid join testing_operations o on o.id = t.operation_id where o.thread_id = $1 and f.function_name in ('proposal', 'proposal-2') order by f.function_id",
              [thread.id],
            );
            const artifacts = await pool.query(
              "select payload from testing_artifacts where thread_id = $1",
              [thread.id],
            );
            assert.deepEqual(
              checkpoints.rows.map((row) => row.function_name),
              scenario === "source-retry" || scenario === "source-missing"
                ? ["proposal", "proposal-2"]
                : ["proposal"],
              scenario,
            );
            assert.deepEqual(
              [...new Set(feedback)],
              scenario === "source-retry" || scenario === "source-missing"
                ? [
                    "Private validation failed: task.sources[1]: confluence:PAGE-7 has no successful read",
                  ]
                : [],
              scenario,
            );
            if (scenario === "source-missing") {
              assert.equal(result, null);
              assert.deepEqual(view.progress.rows.atlassian, {
                status: "terminal",
                outcome: "failed",
                reasonCode: "source_reads_incomplete",
                issues: ["task.sources[1]: confluence:PAGE-7 has no successful read"],
              });
              assert.equal(artifacts.rows.length, 0);
              continue;
            }
            const [jira, confluence] = receipts.rows;
            assert.equal(result?.kind, "requirements", scenario);
            assert.deepEqual(result?.kind === "requirements" ? result.payload : null, {
              goal: "Read checkout sources",
              sources: [
                {
                  reference: { kind: "jira", issueKey: "CHUM-42" },
                  text: issueText,
                  links: [],
                  digest: jira.output_digest,
                  capturedAt: jira.bindings.capturedAt,
                },
                {
                  reference: { kind: "confluence", pageId: "PAGE-7" },
                  text: "結帳規格\n\n## 運費\n- 滿 NT$500 免運",
                  links: [],
                  digest: confluence.output_digest,
                  capturedAt: confluence.bindings.capturedAt,
                },
              ],
            });
            assert.deepEqual(
              artifacts.rows[0]?.payload,
              result?.kind === "requirements" ? result.payload : null,
            );
            assert.equal(JSON.stringify(view).includes("Invented"), false);
            assert.equal(JSON.stringify(view).includes("private grading note"), false);
          } finally {
            await pool.end();
          }
          assert.deepEqual((await hydrateThread(thread.id)).publishedTasks, done.publishedTasks);
        }
      },
      true,
      fixture,
    );
  },
);

test(
  "Jira result wrappers produce requirements bound to the original native receipt",
  { skip: !enabled, timeout: 120_000 },
  async () => {
    const description = ["## 使用者故事", "身為顧客，我想把司康加入購物車。", "", "## 驗收條件"]
      .concat(
        Array.from({ length: 40 }, (_, index) => `${index + 1}. 第 ${index + 1} 項驗收條件。`),
      )
      .join("\n");
    const issue = { key: "FETM-78", summary: "司康小舖：商品與購物車", description };
    const output = { result: JSON.stringify(issue) };
    const fixture = sourceFixture([
      sourceReadRule("jira_get_issue", { issue_key: "FETM-78" }, issue),
    ]);
    await withMcpEnvironment(
      async () => {
        const thread = await createThread();
        const before = new Date().toISOString();
        await chat(thread, {
          role: "atlassian",
          summary: "Capture Jira requirements",
          goal: "Plan checkout",
          sources: [{ kind: "jira", issueKey: "FETM-78" }],
        });
        const done = await waitChat(thread.id);
        const result = done.publishedTasks[0]?.task?.result;
        const pool = new pg.Pool({ connectionString: enabled });
        try {
          const receipts = await pool.query(
            "select r.native_name, r.input, r.output, r.output_digest, r.bindings from testing_receipts r join testing_tasks t on t.id = r.task_id join testing_operations o on o.id = t.operation_id where o.thread_id = $1 order by r.slot",
            [thread.id],
          );
          assert.deepEqual(
            receipts.rows.map((row) => row.native_name),
            ["discover_atlassian_tools", "jira_get_issue"],
          );
          const native = receipts.rows[1]!;
          assert.deepEqual(native.input, {
            issue_key: "FETM-78",
            fields: "summary,description",
            include: "remote_links",
          });
          assert.deepEqual(native.output, output);
          assert.equal(native.output_digest, digestOf(output));
          assert.ok(native.bindings.capturedAt >= before);
          assert.equal(result?.kind, "requirements");
          assert.deepEqual(result?.kind === "requirements" ? result.payload : null, {
            goal: "Plan checkout",
            sources: [
              {
                reference: { kind: "jira", issueKey: "FETM-78" },
                text: `FETM-78 司康小舖：商品與購物車\n\n${description}`,
                links: [],
                digest: digestOf(output),
                capturedAt: native.bindings.capturedAt,
              },
            ],
          });
        } finally {
          await pool.end();
        }
      },
      true,
      fixture,
    );
  },
);

test(
  "planner receives raw source text and a subset summary and persists its own criteria",
  { skip: !enabled, timeout: 120_000 },
  async () => {
    const issue = {
      key: "CHUM-42",
      summary: "Checkout",
      description:
        "## 驗收條件\n1. AC-1 Cart starts empty\n2. AC-2 Checkout succeeds\n3. AC-3 Receipt appears",
    };
    await withMcpEnvironment(
      async () => {
        const thread = await createThread();
        const start = providerRequests.length;
        await chat(thread, { ...intent, plannerSummary: "Plan only AC-2 from CHUM-42" });
        const done = await waitChat(thread.id);
        const planner = providerRequests
          .slice(start)
          .find((request) => userTaskText(request).startsWith("testing-role:planner\n"));
        const task = JSON.parse(userTaskText(planner!).split("testing-task:\n")[1]!);
        assert.equal(task.summary, "Plan only AC-2 from CHUM-42");
        assert.deepEqual(
          task.requirements.sources.map((source: { text: string }) => source.text),
          [`CHUM-42 Checkout\n\n${issue.description}`],
        );
        assert.equal("criteria" in task.requirements, false);
        const plan = done.publishedTasks.find((view) => view.task?.role === "planner")?.task
          ?.result;
        assert.equal(plan?.kind, "plan");
        assert.deepEqual(plan?.kind === "plan" ? plan.payload.criteria : null, [
          { id: "AC-2", statement: "Checkout succeeds" },
        ]);
        assert.deepEqual(plan?.kind === "plan" ? plan.payload.unresolved : null, []);
        assert.deepEqual(
          plan?.kind === "plan"
            ? plan.payload.cases[0]?.checks.map((check) => check.criterionId)
            : null,
          ["AC-2"],
        );
      },
      true,
      sourceFixture([sourceReadRule("jira_get_issue", { issue_key: "CHUM-42" }, issue)]),
    );
  },
);

test(
  "planner structural feedback repairs duplicate criterion ids and unknown references once",
  { skip: !enabled, timeout: 120_000 },
  async () => {
    await withMcpEnvironment(
      async () => {
        const thread = await createThread();
        const start = providerRequests.length;
        control.plannerScenario = "planner-repair";
        try {
          await chat(thread, intent);
          const done = await waitChat(thread.id);
          const feedback = providerRequests
            .slice(start)
            .filter((request) => userTaskText(request).startsWith("testing-role:planner\n"))
            .flatMap((request) => (request.messages ?? []) as Array<{ content?: unknown }>)
            .map((message) => (typeof message.content === "string" ? message.content : ""))
            .filter((text) => text.startsWith("Private validation failed:"));
          assert.deepEqual(
            [...new Set(feedback)],
            [
              "Private validation failed: criteria[1].id: duplicate criterion id AC-1; check check-unknown references an unknown criterion",
            ],
          );
          const plan = done.publishedTasks.find((view) => view.task?.role === "planner")?.task
            ?.result;
          assert.deepEqual(plan?.kind === "plan" ? plan.payload.criteria : null, [
            { id: "AC-1", statement: "Checkout succeeds" },
          ]);
          const pool = new pg.Pool({ connectionString: enabled });
          try {
            const checkpoints = await pool.query(
              "select f.function_name from dbos.operation_outputs f join testing_tasks t on t.child_workflow_id = f.workflow_uuid join testing_operations o on o.id = t.operation_id where o.thread_id = $1 and t.role = 'planner' and f.function_name in ('proposal', 'proposal-2') order by f.function_id",
              [thread.id],
            );
            assert.deepEqual(
              checkpoints.rows.map((row) => row.function_name),
              ["proposal", "proposal-2"],
            );
          } finally {
            await pool.end();
          }
        } finally {
          delete control.plannerScenario;
        }
      },
      true,
      sourceFixture(),
    );
  },
);

test(
  "explicit AC/UI calls persist live-adapter blocked evidence without Jev or browser execution",
  { skip: !enabled, timeout: 120_000 },
  async () => {
    await withMcpEnvironment(
      async () => {
        const thread = await createThread();
        const start = providerRequests.length;
        const parent = await chat(thread, {
          ...intent,
          design: { fileKey: "FILE", nodeId: "12:34" },
          executionRoles: ["ac", "ui"],
        });
        const done = await waitChat(thread.id);
        const db = await database();
        const operations = await db
          .select()
          .from(testingOperationsTable)
          .where(eq(testingOperationsTable.parent_run_id, parent.runId));
        assert.equal(operations.length, 4);
        for (const operation of operations) {
          const runtime = operation.runtime as { model: string; versions: { model: string } };
          assert.equal(runtime.model, "deepseek-ai/DeepSeek-V4.1-Flash");
          assert.equal(runtime.versions.model, "deepseek-ai/DeepSeek-V4.1-Flash");
        }
        assert.deepEqual(
          done.publishedTasks.map((view) => view.task?.role),
          ["atlassian", "planner", "ac", "ui"],
        );
        for (const role of ["ac", "ui"] as const) {
          const view = done.publishedTasks.find((item) => item.task?.role === role);
          assert.equal(view?.state, "finished");
          const result = view?.task?.result;
          assert.ok(result && (result.kind === "ac-result" || result.kind === "ui-result"));
          assert.equal(result.payload.length, 1);
          assert.equal(result.payload[0]?.judgment, "blocked");
          const evidence = result.payload[0]?.evidence[0];
          assert.equal(evidence?.origin, "browser");
          assert.equal(evidence?.outcome, "blocked");
          assert.deepEqual(evidence?.fixture, { id: "playwright-chromium", version: "v1" });
          assert.equal(evidence?.adapterVersion, "playwright-jev-v1");
          assert.deepEqual(evidence?.browser, { selections: [] });
          assert.equal(
            evidence?.outcome === "blocked" && evidence.reason,
            JSON.stringify({
              stage: "scope",
              code: "JEV_API_KEY is required",
              replay: "forbidden",
            }),
          );
        }
        const pool = new pg.Pool({ connectionString: enabled });
        try {
          const receipts = await pool.query(
            "select t.role, r.native_name, r.output, r.output_digest, r.bindings from testing_receipts r join testing_tasks t on t.id = r.task_id join testing_operations o on o.id = t.operation_id where o.parent_run_id = $1 and r.native_name in ('verify_ac', 'verify_ui') order by t.role",
            [parent.runId],
          );
          assert.deepEqual(
            receipts.rows.map((row) => ({ role: row.role, nativeName: row.native_name })),
            [
              { role: "ac", nativeName: "verify_ac" },
              { role: "ui", nativeName: "verify_ui" },
            ],
          );
          for (const row of receipts.rows) {
            const evidence = done.publishedTasks.find((view) => view.task?.role === row.role)?.task
              ?.result;
            assert.ok(evidence && (evidence.kind === "ac-result" || evidence.kind === "ui-result"));
            assert.deepEqual(row.output.evidence, evidence.payload[0]?.evidence[0]);
            assert.equal(row.output_digest, digestOf(row.output));
            assert.equal(row.bindings.checkId, row.output.checkId);
            assert.deepEqual(row.bindings.fixture, { id: "playwright-chromium", version: "v1" });
            assert.equal(row.bindings.adapterVersion, "playwright-jev-v1");
          }
        } finally {
          await pool.end();
        }
        for (const role of ROLE_IDS) {
          const calls = providerRequests
            .slice(start)
            .filter((request) => userTaskText(request).startsWith(`testing-role:${role}\n`));
          assert.ok(calls.length > 0, `${role} must reach the provider`);
          for (const call of calls) {
            assert.equal(call.model, "deepseek-ai/DeepSeek-V4.1-Flash");
            assert.equal(call.adapterModel, "deepseek-ai/DeepSeek-V4.1-Flash");
            assert.equal(call.systemPrompts?.[0], roleRegistry[role].systemPrompt);
            assert.equal(
              call.systemPrompts?.some((prompt) => prompt.includes("testing-task:")),
              false,
            );
            const task = JSON.parse(userTaskText(call).split("testing-task:\n")[1]!);
            assert.equal(task.goal, "Verify checkout");
            assert.equal("bounds" in task, false);
            if (role === "planner") assert.equal(task.targetUrl, null);
            if (role === "ac" || role === "ui") assert.equal(task.targetUrl, intent.targetUrl);
          }
        }
      },
      true,
      sourceFixture(),
    );
  },
);

test(
  "invalid explicit dependency returns an ordinary tool error without producer work",
  { skip: !enabled, timeout: 120_000 },
  async () => {
    const thread = await createThread();
    const start = providerCalls.length;
    await chat(thread, {
      role: "planner",
      summary: "Plan with missing requirements",
      requirementsRef: "missing-ref",
    });
    const done = await waitChat(thread.id);
    assert.deepEqual(done.publishedTasks, []);
    assert.deepEqual([...new Set(providerCalls.slice(start))], ["main"]);
    const transcript = JSON.stringify(done.messages);
    assert.equal(transcript.includes("reference"), true);
    assert.equal(transcript.includes("not_accessible"), true);
    assert.equal(transcript.includes("decisions"), true);
    assert.equal(transcript.includes("missing-ref"), true);
  },
);

test(
  "a failed UI task preserves completed AC and source tasks",
  { skip: !enabled, timeout: 120_000 },
  async () => {
    await withMcpEnvironment(
      async () => {
        const thread = await createThread();
        control.failUi = true;
        try {
          await chat(thread, {
            ...intent,
            design: { fileKey: "FILE", nodeId: "12:34" },
            executionRoles: ["ac", "ui"],
          });
          const done = await waitChat(thread.id);
          const ui = done.publishedTasks.find((view) => view.task?.role === "ui");
          const ac = done.publishedTasks.find((view) => view.task?.role === "ac");
          assert.equal(ui?.progress.rows.ui.status, "terminal");
          assert.equal(
            ui?.progress.rows.ui.status === "terminal" && ui.progress.rows.ui.outcome,
            "failed",
          );
          assert.equal(ac?.task?.result?.kind === "ac-result" && ac.task.result.payload.length, 1);
          assert.equal(done.publishedTasks.length, 4);
        } finally {
          control.failUi = false;
        }
      },
      true,
      sourceFixture(),
    );
  },
);

test(
  "cancelling a never-started reservation drains without provider IO or a quiet hang",
  { skip: !enabled, timeout: 30_000 },
  async () => {
    const thread = await createThread();
    const runId = `cancel-${randomUUID()}`;
    const handle = await DBOS.startWorkflow(cancelledDelegation, { workflowID: runId })();
    const parent = await persistRun({
      threadId: thread.id,
      runId,
      baseRevision: 0,
      message: { id: "cancel-proof", text: "Cancel a delegated source task" },
    });
    const input = {
      role: "atlassian",
      summary: "Read checkout",
      goal: intent.goal,
      sources: intent.sources,
    };
    const admission = await admitAttachedTesting(parent.run, "reserved", input);
    await reserveRoleTask(parent.run.runId, admission.operationId, "atlassian", input);
    await cancelPublishedTesting(thread.id, admission.operationId);
    const calls = providerCalls.length;
    await DBOS.send(runId, { run: parent.run, input }, "cancelled-reservation", "cancel-proof");
    const result = await handle.getResult();
    assert.equal(result.state, "finished");
    assert.equal(result.task?.result, null);
    assert.equal(result.comment, null);
    assert.equal(providerCalls.length, calls);
    const view = (await hydrateThread(thread.id)).publishedTasks[0]!;
    assert.deepEqual(view.progress.rows.atlassian, {
      status: "terminal",
      outcome: "cancelled",
      reasonCode: "cancelled",
    });
    const deliveries = await readStartCancelDeliveries(admission.operationId);
    assert.deepEqual(
      deliveries.map((delivery) => [delivery.kind, delivery.acknowledgement]).sort(),
      [
        ["cancel", "stopped"],
        ["start", "quiet"],
      ],
    );
    await finishRun(parent.run.runId);
  },
);

test(
  "completed durable task history survives a runtime restart without replaying producers",
  { skip: !enabled, timeout: 120_000 },
  async () => {
    const thread = await createThread();
    await withMcpEnvironment(
      async () => {
        await chat(thread, intent);
        const before = await waitChat(thread.id);
        const calls = providerCalls.length;
        await shutdownChatRuntime();
        runtimeLaunched = false;
        const restart = spawnSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            `
      const { launchChatRuntime, shutdownChatRuntime } = await import("./server/harness/run.ts");
      const { hydrateThread } = await import("./server/harness/run-store.ts");
      await launchChatRuntime();
      console.log("RELOADED " + JSON.stringify((await hydrateThread("${thread.id}")).publishedTasks));
      await shutdownChatRuntime();
    `,
          ],
          { encoding: "utf8", env: process.env, timeout: 30_000 },
        );
        assert.equal(restart.status, 0, restart.stderr);
        const reloaded = restart.stdout.split("\n").find((line) => line.startsWith("RELOADED "));
        assert.deepEqual(JSON.parse(reloaded!.slice(9)), before.publishedTasks);
        assert.equal(providerCalls.length, calls);
      },
      true,
      sourceFixture(),
    );
  },
);

test(
  "a killed planner resumes mid-flight without replaying accepted source work or renewing deadlines",
  { skip: !enabled, timeout: 120_000 },
  async () => {
    const args = [
      "--import",
      "tsx",
      "--import",
      require.resolve("../../fixtures/delegation-runtime-preload.mjs"),
      require.resolve("../../fixtures/delegation-recovery-worker.mjs"),
    ];
    const worker = spawn(process.execPath, args, {
      env: {
        ...process.env,
        DELEGATION_FIXTURE_DELAY_ROLE: "planner",
        DELEGATION_FIXTURE_DELAY_MS: "30000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    worker.stdout.on("data", (chunk) => {
      output += chunk;
    });
    worker.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    try {
      for (let attempt = 0; attempt < 300 && !output.includes('"role":"planner"'); attempt += 1) {
        if (worker.exitCode !== null) throw new Error(errors + output);
        await delay(100);
      }
      assert.equal(output.includes('"role":"planner"'), true, output + errors);
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) {
        const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
        worker.kill("SIGKILL");
        await exited;
      }
    }
    const threadId = output
      .split("\n")
      .find((line) => line.startsWith("RECOVERY_THREAD "))!
      .slice(16);
    const pool = new pg.Pool({ connectionString: enabled });
    try {
      const before = await pool.query(
        "select id, deadline from testing_operations where thread_id = $1 order by id",
        [threadId],
      );
      const accepted = await pool.query(
        "select ref, payload_digest from testing_artifacts where thread_id = $1",
        [threadId],
      );
      assert.equal(before.rows.length, 2);
      assert.equal(accepted.rows.length, 1);
      const resumed = spawnSync(process.execPath, args, {
        encoding: "utf8",
        env: {
          ...process.env,
          DELEGATION_RECOVERY_THREAD: threadId,
          DELEGATION_FIXTURE_DELAY_ROLE: "",
        },
        timeout: 60_000,
      });
      assert.equal(resumed.status, 0, resumed.stderr + resumed.stdout);
      assert.equal(
        resumed.stdout
          .split("\n")
          .filter((line) => line.startsWith("FIXTURE "))
          .some((line) => line.includes('"boundary":"model","role":"atlassian"')),
        false,
      );
      const recovered = JSON.parse(
        resumed.stdout
          .split("\n")
          .find((line) => line.startsWith("RECOVERED "))!
          .slice(10),
      ) as Array<{ task: { role: string; result: unknown }; state: string }>;
      assert.deepEqual(
        recovered.map((view) => view.task.role),
        ["atlassian", "planner"],
      );
      assert.equal(
        recovered.every((view) => view.state === "finished" && view.task.result),
        true,
      );
      assert.deepEqual(
        (
          await pool.query(
            "select id, deadline from testing_operations where thread_id = $1 order by id",
            [threadId],
          )
        ).rows,
        before.rows,
      );
      assert.deepEqual(
        (
          await pool.query("select ref, payload_digest from testing_artifacts where ref = $1", [
            accepted.rows[0].ref,
          ])
        ).rows,
        accepted.rows,
      );
    } finally {
      await pool.end();
    }
  },
);

for (const fault of ["no-status", "status-created", "after-enqueue", "no-status-exhausted"]) {
  test(
    `SDK ${fault} start failure and crash replay converge without duplicate source IO`,
    { skip: !enabled, timeout: 120_000 },
    async () => {
      if (runtimeLaunched) {
        await shutdownChatRuntime();
        runtimeLaunched = false;
      }
      const args = [
        "--import",
        "tsx",
        "--import",
        require.resolve("../../fixtures/delegation-runtime-preload.mjs"),
        "--import",
        require.resolve("../../fixtures/delegation-sdk-fault-preload.mjs"),
        require.resolve("../../fixtures/delegation-recovery-worker.mjs"),
      ];
      const worker = spawn(process.execPath, args, {
        env: { ...process.env, DELEGATION_SDK_FAULT: fault },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      worker.stdout.on("data", (chunk) => {
        output += chunk;
      });
      worker.stderr.on("data", (chunk) => {
        output += chunk;
      });
      try {
        for (
          let attempt = 0;
          attempt < 100 && !output.includes("FAULT_CRASH_READY");
          attempt += 1
        ) {
          if (worker.exitCode !== null) break;
          await delay(100);
        }
        assert.equal(output.includes("FAULT_CRASH_READY"), true, output);
      } finally {
        if (worker.exitCode === null && worker.signalCode === null) {
          const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
          worker.kill("SIGKILL");
          await exited;
        }
      }
      if (process.env.DELEGATION_EVIDENCE)
        await writeFile(path.join(process.env.DELEGATION_EVIDENCE, `${fault}-before.log`), output);
      const threadId = output
        .split("\n")
        .find((line) => line.startsWith("RECOVERY_THREAD "))!
        .slice(16);
      const pool = new pg.Pool({ connectionString: enabled });
      try {
        const before = await pool.query(
          "select id, deadline from testing_operations where thread_id = $1 order by id",
          [threadId],
        );
        const resumed = spawnSync(process.execPath, args, {
          encoding: "utf8",
          env: { ...process.env, DELEGATION_SDK_FAULT: "", DELEGATION_RECOVERY_THREAD: threadId },
          timeout: 60_000,
        });
        if (process.env.DELEGATION_EVIDENCE)
          await writeFile(
            path.join(process.env.DELEGATION_EVIDENCE, `${fault}-after.log`),
            resumed.stdout + resumed.stderr,
          );
        assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
        const recovered = JSON.parse(
          resumed.stdout
            .split("\n")
            .find((line) => line.startsWith("RECOVERED "))!
            .slice(10),
        ) as Array<{ task: { role: string; result: unknown }; state: string }>;
        assert.deepEqual(
          recovered.map((view) => view.task.role),
          fault === "no-status-exhausted" ? ["atlassian"] : ["atlassian", "planner"],
        );
        assert.equal(
          recovered.every((view) => view.state === "finished"),
          true,
        );
        if (fault === "no-status-exhausted") {
          assert.equal(recovered[0]?.task.result, null);
          assert.equal(
            (output + resumed.stdout).includes('"boundary":"model","role":"atlassian"'),
            false,
          );
        } else {
          assert.equal(
            recovered.every((view) => view.task.result),
            true,
          );
          if (fault !== "after-enqueue")
            assert.equal(
              resumed.stdout
                .split("\n")
                .filter(
                  (line) =>
                    line.startsWith("FIXTURE ") &&
                    line.includes('"boundary":"model","role":"atlassian"'),
                ).length,
              0,
            );
        }
        const after = await pool.query(
          "select id, deadline from testing_operations where thread_id = $1 order by id",
          [threadId],
        );
        for (const prior of before.rows)
          assert.deepEqual(
            after.rows.find((row) => row.id === prior.id),
            prior,
          );
        assert.equal(
          (
            await pool.query(
              "select count(*)::int as count from testing_artifacts where thread_id = $1 and kind = 'requirements'",
              [threadId],
            )
          ).rows[0].count,
          fault === "no-status-exhausted" ? 0 : 1,
        );
      } finally {
        await pool.end();
      }
    },
  );
}

for (const fault of ["projection", "parent-drain"]) {
  test(
    `transient ${fault} failure preserves the main reply and closes delegated work`,
    { skip: !enabled, timeout: 30_000 },
    async () => {
      if (runtimeLaunched) {
        await shutdownChatRuntime();
        runtimeLaunched = false;
      }
      const args = [
        "--import",
        "tsx",
        "--import",
        require.resolve("../../fixtures/delegation-runtime-preload.mjs"),
        "--import",
        require.resolve("../../fixtures/delegation-sdk-fault-preload.mjs"),
        require.resolve("../../fixtures/delegation-recovery-worker.mjs"),
      ];
      const worker = spawnSync(process.execPath, args, {
        encoding: "utf8",
        env: {
          ...process.env,
          DELEGATION_SDK_FAULT: fault,
          DELEGATION_RECOVERY_ATTEMPTS: "100",
        },
        timeout: 25_000,
      });
      if (process.env.DELEGATION_EVIDENCE)
        await writeFile(
          path.join(process.env.DELEGATION_EVIDENCE, `${fault}-worker.log`),
          worker.stdout + worker.stderr,
        );
      assert.equal(worker.stdout.includes(`FAULT_INJECTED ${fault}`), true);
      assert.equal(worker.status, 0, worker.stdout + worker.stderr);
      const recovered = JSON.parse(
        worker.stdout
          .split("\n")
          .find((line) => line.startsWith("RECOVERED "))!
          .slice(10),
      ) as Array<{ task: { role: string; result: unknown }; state: string }>;
      assert.deepEqual(
        recovered.map((view) => view.task.role),
        ["atlassian", "planner"],
      );
      assert.equal(
        recovered.every((view) => view.state === "finished" && view.task.result),
        true,
      );
      const messages = JSON.parse(
        worker.stdout
          .split("\n")
          .find((line) => line.startsWith("RECOVERED_MESSAGES "))!
          .slice(19),
      ) as Array<{ role: string }>;
      assert.equal(
        messages.some((message) => message.role === "assistant"),
        true,
      );
    },
  );
}

test(
  "SDK child ERROR after physical drain preserves the main reply and settles deliveries",
  { skip: !enabled, timeout: 30_000 },
  async () => {
    if (runtimeLaunched) {
      await shutdownChatRuntime();
      runtimeLaunched = false;
    }
    const args = [
      "--import",
      "tsx",
      "--import",
      require.resolve("../../fixtures/delegation-runtime-preload.mjs"),
      "--import",
      require.resolve("../../fixtures/delegation-sdk-fault-preload.mjs"),
      require.resolve("../../fixtures/delegation-recovery-worker.mjs"),
    ];
    const worker = spawnSync(process.execPath, args, {
      encoding: "utf8",
      env: {
        ...process.env,
        DELEGATION_SDK_FAULT: "child-drain",
        DELEGATION_RECOVERY_ATTEMPTS: "100",
      },
      timeout: 25_000,
    });
    if (process.env.DELEGATION_EVIDENCE)
      await writeFile(
        path.join(process.env.DELEGATION_EVIDENCE, "child-drain-worker.log"),
        worker.stdout + worker.stderr,
      );
    assert.equal(worker.stdout.includes("FAULT_INJECTED child-drain"), true);
    assert.equal(worker.status, 0, worker.stdout + worker.stderr);
    const recovered = JSON.parse(
      worker.stdout
        .split("\n")
        .find((line) => line.startsWith("RECOVERED "))!
        .slice(10),
    ) as Array<{ runId: string; task: { result: unknown }; state: string }>;
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.state, "finished");
    assert.equal(recovered[0]?.task.result, null);
    const messages = JSON.parse(
      worker.stdout
        .split("\n")
        .find((line) => line.startsWith("RECOVERED_MESSAGES "))!
        .slice(19),
    ) as Array<{ role: string }>;
    assert.equal(
      messages.some((message) => message.role === "assistant"),
      true,
    );
    const pool = new pg.Pool({ connectionString: enabled });
    try {
      const deliveries = await pool.query(
        "select acknowledgement from testing_deliveries where operation_id = $1",
        [recovered[0]?.runId],
      );
      assert.deepEqual(deliveries.rows, [{ acknowledgement: "quiet" }]);
    } finally {
      await pool.end();
    }
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
