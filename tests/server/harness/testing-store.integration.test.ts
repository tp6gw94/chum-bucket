import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, mock, test } from "node:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import {
  browserOutputSchema,
  delegationInputSchema,
  TestingRequestError,
} from "../../../shared/testing";
import {
  chatEventsTable,
  chatRunsTable,
  testingArtifactsTable,
  testingOperationsTable,
  testingPinsTable,
  testingPublicationsTable,
  testingReceiptsTable,
  testingTasksTable,
  threadsTable,
} from "../../../server/db/schema";
import {
  ackDelivery,
  appendTrustedObservation,
  appendTrustedReceipt,
  claimActualTask,
  listPendingTestingOperations,
  readStartCancelDeliveries,
  hostTestingRuntime,
} from "../../../server/harness/testing-store";
import { digestOf } from "../../../server/harness/testing-domain";
import { assertDelegationCutover } from "../../../server/harness/testing-run";
import { createUseBrowserTool } from "../../../server/harness/tools/use-browser";
import { MODEL } from "../../../server/harness/agents";
import {
  BUILD,
  admitAttachedTesting,
  acceptRoleCompletion,
  cancelPublishedTesting,
  cancelTesting,
  closeTesting,
  database,
  finishRun,
  guardActualIO,
  hydrateThread,
  persistRun,
  emit,
  publishProjection,
  readPublishedTesting,
  readTestingExecution,
  reserveRoleTask,
} from "../../../server/harness/run-store";

const enabled = process.env.TESTING_STORE_DATABASE_URL;
const originalDatabaseUrl = process.env.DATABASE_URL;
const source = { kind: "jira" as const, issueKey: "CHUM-42" };
const design = { fileKey: "CheckoutDemo", nodeId: "12:34" };
const goal = "Verify checkout";
const targetUrl = "https://preview.example.test/checkout";
const privateMarker = "private-observation-marker";
const rawMarker = "raw-source-secret";
let migrationFolder: string | undefined;

function syntheticBlockedBrowserFixture() {
  return {
    identity: { id: "playwright-chromium", version: "v1" },
    adapterVersion: "playwright-jev-v1",
    run: async () => ({
      state: "blocked" as const,
      reason: "Synthetic browser evidence for persistence only; no browser was launched",
      browser: { selections: [] },
    }),
  };
}

const sourceInput = {
  role: "atlassian",
  summary: "Read checkout requirements",
  goal,
  sources: [source],
} as const;

async function parentRun(threadId: string) {
  const persisted = await persistRun({
    threadId,
    runId: `run-${randomUUID()}`,
    baseRevision: 0,
    message: { id: `msg-${randomUUID()}`, text: "Delegate checkout requirements" },
  });
  return persisted.run;
}

async function admitSource(threadId: string, now = new Date()) {
  return admitAttachedTesting(await parentRun(threadId), "source", sourceInput, now);
}

async function integrationMigrationsFolder() {
  if (migrationFolder) {
    return migrationFolder;
  }

  const source = path.resolve("drizzle");
  const journal = JSON.parse(await readFile(path.join(source, "meta/_journal.json"), "utf8")) as {
    version: string;
    dialect: string;
    entries: readonly Readonly<{
      idx: number;
      version: string;
      when: number;
      tag: string;
      breakpoints: boolean;
    }>[];
  };
  const entries = journal.entries
    .filter((entry) => entry.tag !== "0000_durable_chat")
    .map((entry, idx) => ({ ...entry, idx }));
  migrationFolder = await mkdtemp(path.join(tmpdir(), "chum-testing-store-migrations-"));
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

after(async () => {
  try {
    if (migrationFolder) {
      await rm(migrationFolder, { recursive: true, force: true });
    }
  } finally {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

async function ensureDatabase() {
  if (!enabled) {
    throw new Error("missing testing database");
  }

  process.env.DATABASE_URL = enabled;
  const pool = new pg.Pool({ connectionString: enabled });

  try {
    await migrate(drizzle(pool), { migrationsFolder: await integrationMigrationsFolder() });
  } catch (error) {
    const message =
      error instanceof Error ? error.message.replaceAll(enabled, "[redacted]") : "migration failed";
    throw new Error(message);
  } finally {
    await pool.end();
  }
}

async function createThread() {
  const db = await database();
  const [thread] = await db
    .insert(threadsTable)
    .values({ title: "新對話", messages: [] })
    .returning();

  if (!thread) {
    throw new Error("thread was not created");
  }

  return thread;
}

const checkoutIssue = {
  key: "CHUM-42",
  summary: "Checkout",
  description: "## 驗收條件\n1. AC-1 Checkout succeeds",
  customfield_10009: rawMarker,
};
const checkoutText = "CHUM-42 Checkout\n\n## 驗收條件\n1. AC-1 Checkout succeeds";

async function readJira(
  task: { taskId: string; attemptNonce: number },
  slot = "io-1",
  issue: Record<string, unknown> = checkoutIssue,
) {
  const output = { result: JSON.stringify(issue) };
  await appendTrustedReceipt({
    id: `jira-${task.taskId}-${task.attemptNonce}-${slot}`,
    taskId: task.taskId,
    attemptNonce: task.attemptNonce,
    slot,
    nativeName: "jira_get_issue",
    route: "direct",
    input: { issue_key: source.issueKey, include: "remote_links" },
    output,
    bindings: {},
  });

  return output;
}

function planProposal(cases: readonly unknown[], unresolved: readonly string[] = []) {
  return { criteria: [{ id: "AC-1", statement: "Checkout succeeds" }], unresolved, cases };
}

async function taskBudget(taskId: string) {
  const db = await database();
  const [task] = await db
    .select({
      model_steps: testingTasksTable.model_steps,
      native_calls: testingTasksTable.native_calls,
      nested_calls: testingTasksTable.nested_calls,
      io_sequence: testingTasksTable.io_sequence,
    })
    .from(testingTasksTable)
    .where(eq(testingTasksTable.id, taskId));

  if (!task) {
    throw new Error("testing task was not stored");
  }

  return task;
}

async function countForThread(threadId: string) {
  const db = await database();
  const [runs] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(chatRunsTable)
    .where(eq(chatRunsTable.thread_id, threadId));
  const [operations] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(testingOperationsTable)
    .where(eq(testingOperationsTable.thread_id, threadId));

  return { runs: runs?.count ?? 0, operations: operations?.count ?? 0 };
}

test(
  "baseline and supervised testing migrations apply the comment-free schema",
  { skip: !enabled, timeout: 60_000 },
  async () => {
    await ensureDatabase();
    const db = await database();
    const rows = await db.execute<{ table_name: string }>(sql`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_name like 'testing_%'
    order by table_name
  `);
    assert.deepEqual(
      rows.rows.map((row) => row.table_name),
      [
        "testing_artifacts",
        "testing_decisions",
        "testing_deliveries",
        "testing_observations",
        "testing_operations",
        "testing_pins",
        "testing_publications",
        "testing_receipts",
        "testing_tasks",
      ],
    );
  },
);

test(
  "seventeen direct tool calls fit the native allowance without consuming nested calls",
  { skip: !enabled, timeout: 60_000 },
  async () => {
    await ensureDatabase();
    const thread = await createThread();
    const admission = await admitSource(thread.id);
    const frame = (await reserveRoleTask(
      admission.parentRunId,
      admission.operationId,
      "atlassian",
      { goal },
    ))!;
    const input = {
      taskId: frame.taskId,
      parentRunId: admission.parentRunId,
      attemptNonce: frame.attemptNonce,
      childWorkflowId: frame.childWorkflowId,
    };
    const direct = await Promise.all(
      Array.from({ length: 17 }, () => guardActualIO({ ...input, kind: "tool" })),
    );
    assert.equal(
      direct.every((result) => result.state === "allowed"),
      true,
    );
    assert.deepEqual(await taskBudget(frame.taskId), {
      model_steps: {},
      native_calls: 17,
      nested_calls: 0,
      io_sequence: 17,
    });
  },
);

test(
  "cancel freezes IO without renewing deadline and records delivery acks",
  { skip: !enabled, timeout: 60_000 },
  async () => {
    await ensureDatabase();
    const thread = await createThread();
    const admission = await admitSource(thread.id);
    const db = await database();
    const [before] = await db
      .select({ deadline: testingOperationsTable.deadline })
      .from(testingOperationsTable)
      .where(eq(testingOperationsTable.id, admission.operationId));
    const frame = (await reserveRoleTask(
      admission.parentRunId,
      admission.operationId,
      "atlassian",
      { goal },
    ))!;
    const budgetBeforeCancel = await taskBudget(frame.taskId);
    const view = await cancelTesting(admission.parentRunId, admission.operationId);
    assert.equal(view.state, "cancelling");
    const [after] = await db
      .select({ deadline: testingOperationsTable.deadline })
      .from(testingOperationsTable)
      .where(eq(testingOperationsTable.id, admission.operationId));
    assert.equal(after?.deadline.toISOString(), before?.deadline.toISOString());
    const deliveries = await readStartCancelDeliveries(admission.operationId);
    const cancel = deliveries.find((delivery) => delivery.kind === "cancel");
    assert.ok(cancel);
    assert.equal(cancel.acknowledgement, null);
    const requested = await ackDelivery(cancel.key, "cancel_requested");
    assert.equal(requested.acknowledgement, "cancel_requested");
    const stopped = await ackDelivery(cancel.key, "stopped");
    assert.equal(stopped.acknowledgement, "stopped");
    assert.deepEqual(await ackDelivery(cancel.key, "stopped"), stopped);
    await assert.rejects(() => ackDelivery(cancel.key, "quiet"), /not allowed/);
    assert.deepEqual(
      await guardActualIO({
        taskId: frame.taskId,
        parentRunId: admission.parentRunId,
        attemptNonce: frame.attemptNonce,
        childWorkflowId: frame.childWorkflowId,
        kind: "tool",
      }),
      { state: "denied", reason: "cancel_requested" },
    );
    assert.deepEqual(await taskBudget(frame.taskId), budgetBeforeCancel);
    await assert.rejects(
      () => acceptRoleCompletion(admission.parentRunId, frame.taskId, { role: "atlassian" }),
      /fence/,
    );
  },
);

test(
  "past admission deadline denies IO and is not extended by guard",
  { skip: !enabled, timeout: 60_000 },
  async () => {
    await ensureDatabase();
    const thread = await createThread();
    const admission = await admitSource(thread.id, new Date("2000-01-01T00:00:00.000Z"));
    const frame = (await reserveRoleTask(
      admission.parentRunId,
      admission.operationId,
      "atlassian",
      { goal },
    ))!;
    const budgetBeforeDeadline = await taskBudget(frame.taskId);
    assert.deepEqual(
      await guardActualIO({
        taskId: frame.taskId,
        parentRunId: admission.parentRunId,
        attemptNonce: frame.attemptNonce,
        childWorkflowId: frame.childWorkflowId,
        kind: "model",
        step: "expired-turn",
      }),
      { state: "denied", reason: "deadline" },
    );
    assert.deepEqual(await taskBudget(frame.taskId), budgetBeforeDeadline);
  },
);

test(
  "actual I/O reservations are atomic and model retries are scoped to steps",
  { skip: !enabled, timeout: 60_000 },
  async () => {
    await ensureDatabase();
    const thread = await createThread();
    const admission = await admitSource(thread.id);
    const frame = (await reserveRoleTask(
      admission.parentRunId,
      admission.operationId,
      "atlassian",
      { goal },
    ))!;
    const db = await database();
    const receiptsBefore = await db
      .select({ id: testingReceiptsTable.id })
      .from(testingReceiptsTable)
      .where(eq(testingReceiptsTable.task_id, frame.taskId));
    assert.deepEqual(receiptsBefore, []);
    const input = {
      taskId: frame.taskId,
      parentRunId: admission.parentRunId,
      attemptNonce: frame.attemptNonce,
      childWorkflowId: frame.childWorkflowId,
    };
    const nested = await Promise.all(
      Array.from({ length: 9 }, () => guardActualIO({ ...input, kind: "nested" })),
    );
    const allowedNested = nested.filter((result) => result.state === "allowed");
    assert.equal(allowedNested.length, 8);
    assert.equal(
      nested.filter((result) => result.state === "denied" && result.reason === "budget").length,
      1,
    );
    assert.equal(
      new Set(allowedNested.flatMap((result) => (result.state === "allowed" ? [result.slot] : [])))
        .size,
      8,
    );
    assert.deepEqual(
      await db
        .select({ id: testingReceiptsTable.id })
        .from(testingReceiptsTable)
        .where(eq(testingReceiptsTable.task_id, frame.taskId)),
      [],
    );
    assert.deepEqual(await taskBudget(frame.taskId), {
      model_steps: {},
      native_calls: 8,
      nested_calls: 8,
      io_sequence: 8,
    });
    const modelAttempts = await Promise.all([
      guardActualIO({ ...input, kind: "model", step: "turn-1" }),
      guardActualIO({ ...input, kind: "model", step: "turn-1" }),
      guardActualIO({ ...input, kind: "model", step: "turn-1" }),
      guardActualIO({ ...input, kind: "model", step: "turn-2" }),
      guardActualIO({ ...input, kind: "model", step: "turn-3" }),
      guardActualIO({ ...input, kind: "model", step: "turn-4" }),
      guardActualIO({ ...input, kind: "model", step: "turn-5" }),
      guardActualIO({ ...input, kind: "model", step: "turn-6" }),
      guardActualIO({ ...input, kind: "model", step: "turn-7" }),
      guardActualIO({ ...input, kind: "model", step: "turn-8" }),
    ]);
    assert.equal(
      modelAttempts.every((result) => result.state === "allowed"),
      true,
    );
    const modelSlots = modelAttempts.flatMap((result) =>
      result.state === "allowed" ? [result.slot] : [],
    );
    assert.equal(modelSlots.length, 10);
    assert.equal(new Set(modelSlots).size, 10);
    assert.deepEqual(await guardActualIO({ ...input, kind: "model", step: "turn-1" }), {
      state: "denied",
      reason: "budget",
    });
    assert.deepEqual(await guardActualIO({ ...input, kind: "model", step: "turn-9" }), {
      state: "denied",
      reason: "budget",
    });
    const native = await Promise.all(
      Array.from({ length: 16 }, () => guardActualIO({ ...input, kind: "tool" })),
    );
    const nativeSlots = native.flatMap((result) =>
      result.state === "allowed" ? [result.slot] : [],
    );
    assert.equal(nativeSlots.length, 16);
    assert.equal(new Set(nativeSlots).size, 16);
    assert.deepEqual(await guardActualIO({ ...input, kind: "tool" }), {
      state: "denied",
      reason: "budget",
    });
    const budget = await taskBudget(frame.taskId);
    assert.deepEqual(budget.model_steps, {
      "turn-1": 3,
      "turn-2": 1,
      "turn-3": 1,
      "turn-4": 1,
      "turn-5": 1,
      "turn-6": 1,
      "turn-7": 1,
      "turn-8": 1,
    });
    assert.equal(budget.native_calls, 24);
    assert.equal(budget.nested_calls, 8);
    assert.equal(budget.io_sequence, 34);
    const observation = {
      kind: "attempt_started" as const,
      activity: "model" as const,
      at: "replayed-observation",
    };
    assert.equal(
      (
        await appendTrustedObservation({
          taskId: frame.taskId,
          attemptNonce: frame.attemptNonce,
          key: "same-publication-key",
          body: observation,
        })
      ).duplicate,
      false,
    );
    assert.equal(
      (
        await appendTrustedObservation({
          taskId: frame.taskId,
          attemptNonce: frame.attemptNonce,
          key: "same-publication-key",
          body: observation,
        })
      ).duplicate,
      true,
    );
    assert.deepEqual(await taskBudget(frame.taskId), budget);
  },
);

const browserPlanCase = {
  id: "case-1",
  title: "Checkout",
  preconditions: [],
  actions: [{ kind: "navigate" as const, path: "/checkout" }],
  checks: [
    {
      id: "check-1",
      criterionId: "AC-1",
      kind: "functional" as const,
      expectedObservation: "Order confirmation is visible",
    },
  ],
};

async function plannerWithExecution() {
  await ensureDatabase();
  const thread = await createThread();
  const parent = await parentRun(thread.id);
  const sourceAdmission = await admitAttachedTesting(parent, "source", sourceInput);
  const sourceTask = (await reserveRoleTask(
    parent.runId,
    sourceAdmission.operationId,
    "atlassian",
    sourceInput,
  ))!;
  await readJira(sourceTask);
  const requirements = await acceptRoleCompletion(parent.runId, sourceTask.taskId, {
    role: "atlassian",
  });
  await ackDelivery(`start:${sourceTask.taskId}`, "quiet");
  await closeTesting(parent.runId, sourceAdmission.operationId, "completed");
  const plannerInput = delegationInputSchema.parse({
    role: "planner",
    summary: "Plan checkout",
    requirementsRef: requirements.ref,
  });
  const planning = await admitAttachedTesting(parent, "plan", plannerInput);
  const planner = (await reserveRoleTask(
    parent.runId,
    planning.operationId,
    "planner",
    plannerInput,
  ))!;

  const startAc = async () => {
    const plan = await acceptRoleCompletion(parent.runId, planner.taskId, {
      role: "planner",
      proposal: planProposal([browserPlanCase]),
    });
    await ackDelivery(`start:${planner.taskId}`, "quiet");
    await closeTesting(parent.runId, planning.operationId, "completed");
    const acInput = delegationInputSchema.parse({
      role: "ac",
      summary: "Check checkout",
      planRef: plan.ref,
      targetUrl,
    });
    const checking = await admitAttachedTesting(parent, "ac", acInput);

    return (await reserveRoleTask(parent.runId, checking.operationId, "ac", acInput))!;
  };
  const io = (frame: { taskId: string; attemptNonce: number; childWorkflowId: string }) => ({
    taskId: frame.taskId,
    parentRunId: parent.runId,
    attemptNonce: frame.attemptNonce,
    childWorkflowId: frame.childWorkflowId,
  });

  return { parent, planner, startAc, io };
}

test(
  "AC tasks allow 60 tools and 20 turns while the planner still stops at tool 25 and turn 9",
  { skip: !enabled, timeout: 120_000 },
  async () => {
    const { planner, startAc, io } = await plannerWithExecution();
    const turns = (frame: Parameters<typeof io>[0], count: number) =>
      Promise.all(
        Array.from({ length: count }, (_, index) =>
          guardActualIO({ ...io(frame), kind: "model", step: `turn-${index + 1}` }),
        ),
      );
    const tools = (frame: Parameters<typeof io>[0], count: number) =>
      Promise.all(
        Array.from({ length: count }, () => guardActualIO({ ...io(frame), kind: "tool" })),
      );
    const states = (results: readonly { state: string }[]) =>
      new Set(results.map((result) => result.state));
    const denied = { state: "denied", reason: "budget" };

    assert.deepEqual(states(await turns(planner, 8)), new Set(["allowed"]));
    assert.deepEqual(
      await guardActualIO({ ...io(planner), kind: "model", step: "turn-9" }),
      denied,
    );
    assert.deepEqual(states(await tools(planner, 24)), new Set(["allowed"]));
    assert.deepEqual(await guardActualIO({ ...io(planner), kind: "tool" }), denied);
    const ac = await startAc();

    assert.deepEqual(states(await turns(ac, 20)), new Set(["allowed"]));
    assert.deepEqual(await guardActualIO({ ...io(ac), kind: "model", step: "turn-21" }), denied);
    assert.deepEqual(states(await tools(ac, 60)), new Set(["allowed"]));
    assert.deepEqual(await guardActualIO({ ...io(ac), kind: "tool" }), denied);
    const budget = await taskBudget(ac.taskId);
    assert.deepEqual(
      {
        turns: Object.keys(budget.model_steps as object).length,
        native: budget.native_calls,
        io: budget.io_sequence,
      },
      { turns: 20, native: 60, io: 80 },
    );
  },
);

test(
  "AC observation capacity admits 240 schema-maximal entries of 192 bytes while the planner keeps 64",
  { skip: !enabled, timeout: 180_000 },
  async () => {
    const { planner, startAc } = await plannerWithExecution();
    const append = (frame: { taskId: string; attemptNonce: number }, index: number) =>
      appendTrustedObservation({
        taskId: frame.taskId,
        attemptNonce: frame.attemptNonce,
        key: `capacity-${index}`,
        body: {
          kind: "tool_started",
          toolName: "t".repeat(64),
          route: "codemode",
          at: String(index).padStart(64, "0"),
        },
      });

    for (let index = 0; index < 64; index++) {
      await append(planner, index);
    }

    await assert.rejects(() => append(planner, 64), /Observation bound exceeded/);
    const ac = await startAc();

    for (let index = 0; index < 240; index++) {
      await append(ac, index);
    }

    await assert.rejects(() => append(ac, 240), /Observation bound exceeded/);
  },
);

test(
  "a selection_required handoff is refused as a browser receipt while terminal evidence is stored",
  { skip: !enabled, timeout: 120_000 },
  async () => {
    const { startAc } = await plannerWithExecution();
    const ac = await startAc();
    const bindings = {
      checkId: "check-1",
      fixture: { id: "playwright-chromium", version: "v1" },
      adapterVersion: "playwright-jev-v1",
    };
    const receipt = (slot: string, output: unknown) =>
      appendTrustedReceipt({
        id: `${slot}-${randomUUID()}`,
        taskId: ac.taskId,
        attemptNonce: ac.attemptNonce,
        slot,
        nativeName: "verify_ac",
        route: "direct",
        input: { checkId: "check-1" },
        output,
        bindings,
      });
    await assert.rejects(
      () =>
        receipt("handoff", {
          state: "selection_required",
          checkId: "check-1",
          handoff: {
            kind: "selection",
            id: "h1",
            caseId: "case-1",
            ordinal: 1,
            laterHandoffsAllowed: 2,
            expiresAt: "2026-10-13T00:03:00.000Z",
            url: "https://preview.example.test/checkout",
            target: {
              intent: "Order confirmation",
              operation: "observe",
              at: { kind: "check", checkId: "check-1" },
            },
            candidates: [{ id: "c0", description: "Order confirmation" }],
            links: [],
            diagnostics: {
              code: "uncertain_or_invalid_selection",
              choice: "none",
              confidence: 0.9,
              probability: 0.9,
              gap: 0.8,
              probabilityTotal: 1,
              candidateCount: 2,
              probabilityCount: 2,
            },
            image: {
              path: "00000000-0000-4000-8000-000000000000.png",
              digest: "d".repeat(64),
            },
          },
        }),
      /Browser receipt is outside the host scope/,
    );
    const tool = createUseBrowserTool({
      role: "ac",
      cases: [browserPlanCase],
      checks: browserPlanCase.checks,
      fixture: syntheticBlockedBrowserFixture(),
      figmaProperties: null,
      designCapture: null,
    });
    await receipt("terminal", await tool.execute!({ checkId: "check-1" }));
    const db = await database();

    assert.deepEqual(
      (
        await db
          .select({ slot: testingReceiptsTable.slot })
          .from(testingReceiptsTable)
          .where(eq(testingReceiptsTable.task_id, ac.taskId))
      ).map((row) => row.slot),
      ["terminal"],
    );
  },
);

test(
  "scope, nonce, root-claim, and terminal denials do not allocate budget",
  { skip: !enabled, timeout: 60_000 },
  async () => {
    await ensureDatabase();
    const thread = await createThread();
    const admission = await admitSource(thread.id);
    const frame = (await reserveRoleTask(
      admission.parentRunId,
      admission.operationId,
      "atlassian",
      { goal },
    ))!;
    const input = {
      taskId: frame.taskId,
      parentRunId: admission.parentRunId,
      attemptNonce: frame.attemptNonce,
      childWorkflowId: frame.childWorkflowId,
      kind: "tool" as const,
    };
    const initial = await taskBudget(frame.taskId);
    assert.deepEqual(await guardActualIO({ ...input, attemptNonce: frame.attemptNonce + 1 }), {
      state: "denied",
      reason: "nonce",
    });
    assert.deepEqual(await guardActualIO({ ...input, childWorkflowId: "other-child" }), {
      state: "denied",
      reason: "scope",
    });
    assert.deepEqual(await guardActualIO({ ...input, parentRunId: "missing-parent" }), {
      state: "denied",
      reason: "scope",
    });
    const db = await database();
    await db
      .update(threadsTable)
      .set({ active_run_id: null })
      .where(eq(threadsTable.id, thread.id));
    assert.deepEqual(await guardActualIO(input), { state: "denied", reason: "scope" });
    assert.deepEqual(await taskBudget(frame.taskId), initial);
    await db
      .update(threadsTable)
      .set({ active_run_id: admission.parentRunId })
      .where(eq(threadsTable.id, thread.id));
    await closeTesting(admission.parentRunId, admission.operationId, "missing");
    assert.deepEqual(await guardActualIO(input), { state: "denied", reason: "terminal" });
    assert.deepEqual(await taskBudget(frame.taskId), initial);
  },
);

test(
  "published cancellation requires operation identity and keeps foreign threads isolated",
  { skip: !enabled, timeout: 60_000 },
  async () => {
    await ensureDatabase();
    const thread = await createThread();
    const admission = await admitSource(thread.id);
    const published = await publishProjection(admission.parentRunId, admission.operationId);
    const missing = { status: 404, message: "Testing run was not found" };

    await assert.rejects(() => cancelPublishedTesting(thread.id, ""), missing);
    await assert.rejects(() => cancelPublishedTesting(thread.id, "unknown-run"), missing);
    const otherThread = await createThread();
    await assert.rejects(
      () => cancelPublishedTesting(otherThread.id, admission.operationId),
      missing,
    );
    await assert.rejects(() => cancelPublishedTesting("not-a-uuid", admission.operationId), {
      status: 400,
      message: "Invalid thread ID",
    });
    assert.deepEqual(await readPublishedTesting(thread.id, ""), published);
    assert.equal((await countForThread(thread.id)).operations, 1);
    const db = await database();
    const [untouched] = await db
      .select({ accepted: testingOperationsTable.cancel_accepted_at })
      .from(testingOperationsTable)
      .where(eq(testingOperationsTable.id, admission.operationId));
    assert.equal(untouched?.accepted, null);

    const cancelled = await cancelPublishedTesting(thread.id, admission.operationId);
    assert.equal(cancelled.state, "cancelling");
    const [accepted] = await db
      .select({ accepted: testingOperationsTable.cancel_accepted_at })
      .from(testingOperationsTable)
      .where(eq(testingOperationsTable.id, admission.operationId));
    assert.notEqual(accepted?.accepted, null);
  },
);

test(
  "explicit dependencies fail before admission and do not launch helpers",
  { skip: !enabled },
  async () => {
    await ensureDatabase();
    const thread = await createThread();
    const parent = await parentRun(thread.id);
    const before = await countForThread(thread.id);
    for (const input of [
      { role: "planner", summary: "Plan", requirementsRef: "foreign-ref" },
      { role: "ac", summary: "Execute", planRef: "missing-ref", targetUrl },
      { role: "ui", summary: "Style", planRef: "missing-ref", targetUrl },
      { role: "planner", summary: "Plan", requirements: {} },
    ]) {
      await assert.rejects(
        () => admitAttachedTesting(parent, randomUUID(), input),
        /reference|intent/,
      );
    }
    assert.deepEqual(await countForThread(thread.id), before);
    const source = await admitAttachedTesting(parent, "source", sourceInput);
    assert.equal(source.mode, "attached");
    assert.equal((await countForThread(thread.id)).operations, 1);
  },
);

test(
  "native source reads are stamped with host time once and keep it on duplicate append",
  { skip: !enabled },
  async () => {
    await ensureDatabase();
    const thread = await createThread();
    const admission = await admitSource(thread.id);
    const task = (await reserveRoleTask(
      admission.parentRunId,
      admission.operationId,
      "atlassian",
      sourceInput,
    ))!;
    const read = {
      id: `jira-${task.taskId}`,
      taskId: task.taskId,
      attemptNonce: task.attemptNonce,
      slot: "io-1",
      nativeName: "jira_get_issue",
      route: "direct" as const,
      input: { issue_key: source.issueKey },
      output: { result: JSON.stringify({ key: "CHUM-42", summary: "Checkout" }) },
      bindings: {},
    };
    const discovery = {
      ...read,
      id: `discovery-${task.taskId}`,
      slot: "io-2",
      nativeName: "discover_atlassian_tools",
      input: { toolNames: ["jira_get_issue"] },
      output: { tools: [] },
    };
    const before = Date.now();
    assert.equal((await appendTrustedReceipt(read)).duplicate, false);
    const after = Date.now();
    await appendTrustedReceipt(discovery);
    const db = await database();
    const stored = async () =>
      db
        .select({ id: testingReceiptsTable.id, bindings: testingReceiptsTable.bindings })
        .from(testingReceiptsTable)
        .where(eq(testingReceiptsTable.task_id, task.taskId))
        .orderBy(testingReceiptsTable.slot);
    const [first, other] = await stored();
    const capturedAt = (first?.bindings as { capturedAt: string }).capturedAt;
    assert.match(capturedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(Date.parse(capturedAt) >= before && Date.parse(capturedAt) <= after);
    assert.deepEqual(other, { id: discovery.id, bindings: {} });
    assert.equal((await appendTrustedReceipt(read)).duplicate, true);
    assert.deepEqual(await stored(), [
      { id: read.id, bindings: { capturedAt } },
      { id: discovery.id, bindings: {} },
    ]);
    const execution = await readTestingExecution(admission.parentRunId, admission.operationId);
    assert.deepEqual(
      execution.tasks[0]?.receipts.map((receipt) => receipt.bindings),
      [{ capturedAt }, {}],
    );
  },
);

test(
  "store assembly selects the first current-attempt native read in lexical slot order and replays the same ref",
  { skip: !enabled },
  async () => {
    await ensureDatabase();
    for (const historicalAttempt of [false, true]) {
      const thread = await createThread();
      const parent = await parentRun(thread.id);
      const admission = await admitAttachedTesting(parent, "read-order", sourceInput);
      const first = await reserveRoleTask(
        parent.runId,
        admission.operationId,
        "atlassian",
        sourceInput,
      );
      assert.ok(first);
      const db = await database();
      if (historicalAttempt) {
        await readJira(first, "io-0", { ...checkoutIssue, summary: "Previous attempt" });
        await db
          .update(testingTasksTable)
          .set({ attempt_nonce: 2 })
          .where(eq(testingTasksTable.id, first.taskId));
      }
      const task = { ...first, attemptNonce: historicalAttempt ? 2 : 1 };
      await readJira(task, "io-2", { ...checkoutIssue, summary: "Later slot" });
      const selected = await readJira(task, "io-10", { ...checkoutIssue, summary: "Selected" });
      await readJira(task, "io-10", { ...checkoutIssue, summary: "Selected" });
      const accepted = await acceptRoleCompletion(parent.runId, task.taskId, { role: "atlassian" });
      const [receipt] = await db
        .select({ bindings: testingReceiptsTable.bindings })
        .from(testingReceiptsTable)
        .where(eq(testingReceiptsTable.id, `jira-${task.taskId}-${task.attemptNonce}-io-10`));
      const [original] = await db
        .select()
        .from(testingArtifactsTable)
        .where(eq(testingArtifactsTable.ref, accepted.ref));
      assert.ok(original);
      assert.deepEqual(original.payload, {
        goal,
        sources: [
          {
            reference: source,
            text: "CHUM-42 Selected\n\n## 驗收條件\n1. AC-1 Checkout succeeds",
            links: [],
            digest: digestOf(selected),
            capturedAt: (receipt?.bindings as { capturedAt: string }).capturedAt,
          },
        ],
      });
      await readJira(task, "io-1", { ...checkoutIssue, summary: "Earlier slot after acceptance" });
      assert.deepEqual(
        await acceptRoleCompletion(parent.runId, task.taskId, { role: "atlassian" }),
        accepted,
      );
      const [replayed] = await db
        .select()
        .from(testingArtifactsTable)
        .where(eq(testingArtifactsTable.ref, accepted.ref));
      assert.deepEqual(replayed, original);
      assert.equal(
        (
          await db
            .select({ id: testingReceiptsTable.id })
            .from(testingReceiptsTable)
            .where(eq(testingReceiptsTable.task_id, task.taskId))
        ).length,
        historicalAttempt ? 4 : 3,
      );
      for (const payload of [
        { ...(original.payload as Record<string, unknown>), goal: "Forged goal" },
        { goal, criteria: [], unresolved: [], captures: [] },
      ]) {
        await db
          .update(testingArtifactsTable)
          .set({ payload, payload_digest: digestOf(payload) })
          .where(eq(testingArtifactsTable.ref, accepted.ref));
        await assert.rejects(
          () => acceptRoleCompletion(parent.runId, task.taskId, { role: "atlassian" }),
          /version mismatch/,
        );
      }
      const metadata = original.metadata as { versions: Record<string, string> };
      await db
        .update(testingArtifactsTable)
        .set({
          payload: original.payload,
          payload_digest: original.payload_digest,
          metadata: { ...metadata, versions: { ...metadata.versions, model: "forged-model" } },
        })
        .where(eq(testingArtifactsTable.ref, accepted.ref));
      await assert.rejects(
        () => acceptRoleCompletion(parent.runId, task.taskId, { role: "atlassian" }),
        /version mismatch/,
      );
      await db
        .update(testingArtifactsTable)
        .set({ metadata: original.metadata })
        .where(eq(testingArtifactsTable.ref, accepted.ref));
      assert.deepEqual(
        await acceptRoleCompletion(parent.runId, task.taskId, { role: "atlassian" }),
        accepted,
      );
    }
  },
);

test(
  "single-role admissions preserve retries, sealed dependencies, receipts and all history",
  { skip: !enabled, timeout: 120_000 },
  async () => {
    await ensureDatabase();
    const thread = await createThread();
    const parent = await parentRun(thread.id);
    const sourceAdmission = await admitAttachedTesting(parent, "source", sourceInput);
    const again = await admitAttachedTesting(parent, "source", sourceInput, new Date("2030-01-01"));
    assert.deepEqual(again, sourceAdmission);
    await assert.rejects(
      () => admitAttachedTesting(parent, "source", { ...sourceInput, summary: "Changed" }),
      /collision/,
    );
    const sourceTask = await reserveRoleTask(
      parent.runId,
      sourceAdmission.operationId,
      "atlassian",
      sourceInput,
    );
    assert.ok(sourceTask);
    await assert.rejects(
      () => reserveRoleTask(parent.runId, sourceAdmission.operationId, "planner", {}),
      /explicitly delegated/,
    );
    await assert.rejects(
      () =>
        reserveRoleTask(parent.runId, sourceAdmission.operationId, "atlassian", { altered: true }),
      /collision/,
    );
    await assert.rejects(
      () => acceptRoleCompletion(parent.runId, sourceTask.taskId, { role: "atlassian" }),
      /task\.sources\[0\]: jira:CHUM-42 has no successful read/,
    );
    await assert.rejects(
      () =>
        acceptRoleCompletion(parent.runId, sourceTask.taskId, { role: "planner", proposal: {} }),
      /Completion role does not match its task/,
    );
    const db = await database();
    assert.deepEqual(
      await db
        .select({ ref: testingArtifactsTable.ref })
        .from(testingArtifactsTable)
        .where(eq(testingArtifactsTable.thread_id, thread.id)),
      [],
    );
    await readJira(sourceTask);
    const requirements = await acceptRoleCompletion(parent.runId, sourceTask.taskId, {
      role: "atlassian",
    });
    assert.deepEqual(
      await acceptRoleCompletion(parent.runId, sourceTask.taskId, { role: "atlassian" }),
      requirements,
    );
    await ackDelivery(`start:${sourceTask.taskId}`, "quiet");
    const firstView = await closeTesting(parent.runId, sourceAdmission.operationId, "completed");
    assert.equal(firstView.runId, sourceAdmission.operationId);
    assert.equal(firstView.progress.rows.atlassian.status, "terminal");
    assert.equal(firstView.task?.result?.kind, "requirements");
    assert.equal(
      firstView.task?.result?.kind === "requirements" &&
        firstView.task.result.payload.sources[0]?.text,
      checkoutText,
    );
    assert.equal(JSON.stringify(firstView).includes(rawMarker), false);
    assert.equal(firstView.report, null);

    const plannerInput = delegationInputSchema.parse({
      role: "planner",
      summary: "Plan checkout",
      requirementsRef: requirements.ref,
      design,
    });
    const planning = await admitAttachedTesting(parent, "plan", plannerInput);
    const planner = await reserveRoleTask(
      parent.runId,
      planning.operationId,
      "planner",
      plannerInput,
    );
    assert.ok(planner);
    const planCase = {
      id: "case-1",
      title: "Checkout",
      preconditions: [],
      actions: [{ kind: "navigate" as const, path: "/checkout" }],
      checks: [
        {
          id: "check-1",
          criterionId: "AC-1",
          kind: "functional" as const,
          expectedObservation: "Order confirmation is visible",
        },
      ],
    };
    const plan = await acceptRoleCompletion(parent.runId, planner.taskId, {
      role: "planner",
      proposal: planProposal([planCase]),
    });
    const execution = await readTestingExecution(parent.runId, planning.operationId);
    assert.equal(execution.intent.targetUrl, null);
    assert.equal(execution.tasks.length, 1);
    assert.equal(execution.tasks[0]?.frame.role, "planner");
    assert.equal(
      (execution.artifacts.find((item) => item.ref === plan.ref)?.payload as { targetUrl: unknown })
        .targetUrl,
      null,
    );
    await ackDelivery(`start:${planner.taskId}`, "quiet");
    await closeTesting(parent.runId, planning.operationId, "completed");

    await assert.rejects(
      () =>
        admitAttachedTesting(parent, "wrong-role", {
          role: "planner",
          summary: "Wrong",
          requirementsRef: plan.ref,
        }),
      /wrong_kind/,
    );
    await assert.rejects(
      () =>
        admitAttachedTesting(parent, "no-style", {
          role: "ui",
          summary: "Style",
          planRef: plan.ref,
          targetUrl,
        }),
      /no automated checks for the delegated role/,
    );
    const foreignThread = await createThread();
    const foreignParent = await parentRun(foreignThread.id);
    await assert.rejects(
      () => admitAttachedTesting(foreignParent, "foreign", plannerInput),
      /not_accessible/,
    );

    const acInput = delegationInputSchema.parse({
      role: "ac",
      summary: "Check checkout",
      planRef: plan.ref,
      targetUrl,
    });
    const checking = await admitAttachedTesting(parent, "ac", acInput);
    const ac = await reserveRoleTask(parent.runId, checking.operationId, "ac", acInput);
    assert.ok(ac);
    const fixture = syntheticBlockedBrowserFixture();
    const tool = createUseBrowserTool({
      role: "ac",
      cases: [planCase],
      checks: planCase.checks,
      fixture,
      figmaProperties: null,
      designCapture: null,
    });
    const output = browserOutputSchema.parse(await tool.execute!({ checkId: "check-1" }));
    const legacyOutput = browserOutputSchema.parse({
      ...output,
      evidence: {
        ...output.evidence,
        origin: "mock",
        browser: undefined,
        fixture: { id: "legacy-mock", version: "v1" },
        adapterVersion: "mock-browser-v1",
      },
    });
    await assert.rejects(
      () =>
        appendTrustedReceipt({
          id: `legacy-browser-${randomUUID()}`,
          taskId: ac.taskId,
          attemptNonce: 1,
          slot: "browser",
          nativeName: "use_browser",
          route: "direct",
          input: { checkId: "check-1" },
          output: legacyOutput,
          bindings: {
            checkId: "check-1",
            fixture: legacyOutput.evidence.fixture,
            adapterVersion: legacyOutput.evidence.adapterVersion,
          },
        }),
      /Browser receipt is outside the host scope/,
    );
    const receiptId = `browser-${randomUUID()}`;
    const receipt = await appendTrustedReceipt({
      id: receiptId,
      taskId: ac.taskId,
      attemptNonce: 1,
      slot: "browser",
      nativeName: "verify_ac",
      route: "direct",
      input: { checkId: "check-1" },
      output,
      bindings: {
        checkId: "check-1",
        fixture: fixture.identity,
        adapterVersion: fixture.adapterVersion,
      },
    });
    assert.equal(receipt.outputDigest, digestOf(output));
    const completion = {
      role: "ac" as const,
      findings: "The tool was blocked. This is unassessed prose, not a pass.",
    };
    const result = await acceptRoleCompletion(parent.runId, ac.taskId, completion);
    assert.deepEqual(await acceptRoleCompletion(parent.runId, ac.taskId, completion), result);
    await assert.rejects(
      acceptRoleCompletion(parent.runId, ac.taskId, {
        ...completion,
        findings: "Changed findings",
      }),
      /Task result version mismatch/,
    );
    const completed = await publishProjection(parent.runId, checking.operationId);
    assert.equal(completed.task?.version, 3);
    assert.equal(completed.task?.version === 3 && completed.task.findings, completion.findings);
    assert.deepEqual(completed.task?.version === 3 && completed.task.missingChecks, []);
    await ackDelivery(`start:${ac.taskId}`, "quiet");
    const lastView = await closeTesting(parent.runId, checking.operationId, "completed");
    assert.equal(
      lastView.task?.result?.kind === "ac-result" && lastView.task.result.payload[0]?.judgment,
      "blocked",
    );
    assert.deepEqual(
      lastView.task?.result?.kind === "ac-result" && lastView.task.result.payload[0]?.evidence,
      [output.evidence],
    );
    const storedAc = await readTestingExecution(parent.runId, checking.operationId);
    assert.deepEqual(
      storedAc.tasks[0]?.receipts
        .filter((item) => item.slot === "browser")
        .map((item) => ({
          nativeName: item.nativeName,
          output: item.output,
        })),
      [{ nativeName: "verify_ac", output }],
    );
    assert.equal(lastView.task?.result?.ref, result.ref);
    assert.equal(lastView.report, null);
    assert.equal(JSON.stringify(lastView).includes(rawMarker), false);
    assert.equal(JSON.stringify(lastView).includes(privateMarker), false);
    assert.deepEqual(await readPublishedTesting(thread.id, checking.operationId), lastView);
    assert.deepEqual(await publishProjection(parent.runId, checking.operationId), lastView);
    const hydrated = await hydrateThread(thread.id);
    assert.deepEqual(
      hydrated.publishedTasks.map((view) => view.task?.role),
      ["atlassian", "planner", "ac"],
    );
    assert.equal(new Set(hydrated.publishedTasks.map((view) => view.runId)).size, 3);
    const storedSource = await readTestingExecution(parent.runId, sourceAdmission.operationId);
    assert.deepEqual(
      storedSource.tasks[0]?.receipts.map((item) => item.nativeName),
      ["jira_get_issue"],
    );
    assert.equal(JSON.stringify(hydrated.publishedTasks).includes(rawMarker), false);
    const pins = await db
      .select({ metadata: testingArtifactsTable.metadata })
      .from(testingPinsTable)
      .innerJoin(testingArtifactsTable, eq(testingPinsTable.ref, testingArtifactsTable.ref))
      .where(eq(testingPinsTable.operation_id, checking.operationId));
    assert.equal(pins.length, 3);
    for (const pin of pins) {
      assert.equal((pin.metadata as { versions: { model: string } }).versions.model, MODEL);
    }
    for (const scenario of ["missing", "status-only", "cancelled"] as const) {
      const admitted = await admitAttachedTesting(parent, scenario, acInput);
      const task = await reserveRoleTask(parent.runId, admitted.operationId, "ac", acInput);
      assert.ok(task);
      if (scenario === "cancelled") {
        await appendTrustedReceipt({
          id: `partial-${randomUUID()}`,
          taskId: task.taskId,
          attemptNonce: 1,
          slot: "browser",
          nativeName: "verify_ac",
          route: "direct",
          input: { checkId: "check-1" },
          output,
          bindings: {
            checkId: "check-1",
            fixture: fixture.identity,
            adapterVersion: fixture.adapterVersion,
          },
        });
        await cancelTesting(parent.runId, admitted.operationId);
        await ackDelivery(`cancel:${task.taskId}`, "cancel_requested");
        await ackDelivery(`cancel:${task.taskId}`, "stopped");
      } else {
        await acceptRoleCompletion(parent.runId, task.taskId, {
          role: "ac",
          findings: scenario === "missing" ? null : "Assembling the corrected final output.",
        });
      }
      await ackDelivery(`start:${task.taskId}`, "quiet");
      const view = await closeTesting(
        parent.runId,
        admitted.operationId,
        scenario === "cancelled" ? "cancelled" : "completed",
      );
      assert.equal(view.task?.version, 3);
      if (view.task?.version !== 3) throw new Error("Expected QA v3");
      assert.deepEqual(view.task.missingChecks, scenario === "cancelled" ? [] : ["check-1"]);
      assert.deepEqual(view.task.conflictingChecks, []);
      assert.equal(
        view.task.findings,
        scenario === "status-only" ? "Assembling the corrected final output." : null,
      );
      assert.equal(view.task.result?.payload.length, scenario === "cancelled" ? 1 : 0);
      assert.deepEqual(await readPublishedTesting(thread.id, admitted.operationId), view);
      assert.equal(view.progress.rows.ac.status, "terminal");
      assert.ok(!JSON.stringify(view).includes(privateMarker));
    }
    await finishRun(parent.runId);
    assert.equal((await hydrateThread(thread.id)).activeRun, null);
  },
);

test(
  "cancel isolates a task, preserves live activity, and fences late proposals",
  { skip: !enabled },
  async () => {
    await ensureDatabase();
    const thread = await createThread();
    const parent = await parentRun(thread.id);
    const first = await admitAttachedTesting(parent, "first", sourceInput);
    const second = await admitAttachedTesting(parent, "second", sourceInput);
    const task = await reserveRoleTask(parent.runId, first.operationId, "atlassian", sourceInput);
    assert.ok(task);
    await appendTrustedObservation({
      taskId: task.taskId,
      attemptNonce: 1,
      key: "tool",
      body: {
        kind: "tool_started",
        toolName: "jira_get_issue",
        route: "direct",
        at: "2026-01-01T00:00:00Z",
      },
    });
    const cancelled = await cancelPublishedTesting(thread.id, first.operationId);
    assert.deepEqual(cancelled.progress.rows.atlassian, {
      status: "cancelling",
      active: [{ toolName: "jira_get_issue", route: "direct", startedAt: "2026-01-01T00:00:00Z" }],
    });
    assert.equal(
      (await readTestingExecution(parent.runId, second.operationId)).cancelRequested,
      false,
    );
    assert.equal((await hydrateThread(thread.id)).activeRun?.runId, parent.runId);
    await assert.rejects(
      () => acceptRoleCompletion(parent.runId, task.taskId, { role: "atlassian" }),
      /fence/,
    );
    await assert.rejects(() => cancelPublishedTesting(thread.id, parent.runId), /not found/);
  },
);

test(
  "malformed dependency payloads are rejected before admitting work",
  { skip: !enabled },
  async () => {
    await ensureDatabase();
    const thread = await createThread();
    const parent = await parentRun(thread.id);
    const admission = await admitAttachedTesting(parent, "source", sourceInput);
    const task = await reserveRoleTask(
      parent.runId,
      admission.operationId,
      "atlassian",
      sourceInput,
    );
    assert.ok(task);
    await readJira(task);
    const requirements = await acceptRoleCompletion(parent.runId, task.taskId, {
      role: "atlassian",
    });
    const db = await database();
    const [storedRequirements] = await db
      .select()
      .from(testingArtifactsTable)
      .where(eq(testingArtifactsTable.ref, requirements.ref));
    assert.ok(storedRequirements);
    for (const payload of [
      null,
      {},
      { ...(storedRequirements.payload as object), goal: "Tampered goal" },
      { goal, criteria: [], unresolved: [], captures: [] },
    ]) {
      await db
        .update(testingArtifactsTable)
        .set({ payload: sql`${JSON.stringify(payload)}::jsonb` })
        .where(eq(testingArtifactsTable.ref, requirements.ref));
      await assert.rejects(
        () =>
          admitAttachedTesting(parent, `bad-requirements-${randomUUID()}`, {
            role: "planner",
            summary: "Plan",
            requirementsRef: requirements.ref,
          }),
        TestingRequestError,
      );
      assert.equal((await countForThread(thread.id)).operations, 1);
    }
    await db
      .update(testingArtifactsTable)
      .set({ payload: storedRequirements.payload })
      .where(eq(testingArtifactsTable.ref, requirements.ref));
    const plannerInput = {
      role: "planner",
      summary: "Plan",
      requirementsRef: requirements.ref,
    } as const;
    const planning = await admitAttachedTesting(parent, "plan", plannerInput);
    const planner = await reserveRoleTask(
      parent.runId,
      planning.operationId,
      "planner",
      plannerInput,
    );
    assert.ok(planner);
    const plan = await acceptRoleCompletion(parent.runId, planner.taskId, {
      role: "planner",
      proposal: planProposal([
        {
          id: "case-1",
          title: "Checkout",
          preconditions: [],
          actions: [{ kind: "navigate", path: "/checkout" }],
          checks: [
            {
              id: "check-1",
              criterionId: "AC-1",
              kind: "functional",
              expectedObservation: "Checkout succeeds",
            },
          ],
        },
      ]),
    });
    const [storedPlan] = await db
      .select()
      .from(testingArtifactsTable)
      .where(eq(testingArtifactsTable.ref, plan.ref));
    assert.ok(storedPlan);
    const {
      criteria: _criteria,
      unresolved: _unresolved,
      ...legacyPlan
    } = storedPlan.payload as Record<string, unknown>;
    for (const payload of [null, {}, { targetUrl, assignments: null }, legacyPlan]) {
      await db
        .update(testingArtifactsTable)
        .set({ payload: sql`${JSON.stringify(payload)}::jsonb` })
        .where(eq(testingArtifactsTable.ref, plan.ref));
      await assert.rejects(
        () =>
          admitAttachedTesting(parent, `bad-plan-${randomUUID()}`, {
            role: "ac",
            summary: "Check",
            planRef: plan.ref,
            targetUrl,
          }),
        TestingRequestError,
      );
      assert.equal((await countForThread(thread.id)).operations, 2);
    }
    await db
      .update(testingArtifactsTable)
      .set({ payload: storedPlan.payload })
      .where(eq(testingArtifactsTable.ref, plan.ref));
    for (const [ref, role, profile] of [
      [requirements.ref, "atlassian", "requirements-v3"],
      [plan.ref, "planner", "planning-v2"],
    ] as const) {
      const [row] = await db
        .select({ metadata: testingArtifactsTable.metadata })
        .from(testingArtifactsTable)
        .where(eq(testingArtifactsTable.ref, ref));
      const metadata = row!.metadata as { profiles: Record<string, string> };
      await db
        .update(testingArtifactsTable)
        .set({ metadata: { ...metadata, profiles: { ...metadata.profiles, [role]: profile } } })
        .where(eq(testingArtifactsTable.ref, ref));
      await assert.rejects(
        () =>
          admitAttachedTesting(parent, `old-${profile}`, {
            role: "ac",
            summary: "Check",
            planRef: plan.ref,
            targetUrl,
          }),
        (error: unknown) =>
          error instanceof TestingRequestError &&
          error.decisions.some(
            (decision) =>
              decision.kind === "rejected" &&
              decision.ref === ref &&
              decision.reason === "incompatible_snapshot",
          ),
      );
      await db
        .update(testingArtifactsTable)
        .set({ metadata })
        .where(eq(testingArtifactsTable.ref, ref));
    }
  },
);

test(
  "run-scoped origins survive old finished publication reads without rewriting rows",
  { skip: !enabled },
  async () => {
    await ensureDatabase();
    const thread = await createThread();
    const db = await database();
    for (const messageId of ["origin-first", "origin-second"]) {
      const parent = await parentRun(thread.id);
      const callId = "reused-call";
      const assistant = {
        id: messageId,
        role: "assistant" as const,
        parts: [
          {
            type: "tool-call" as const,
            id: callId,
            name: "delegate_task",
            arguments: "{}",
            state: "input-complete" as const,
          },
        ],
      };
      const display = [...parent.messages, assistant];
      await emit(
        parent.runId,
        {
          type: "TOOL_CALL_START",
          timestamp: 1,
          toolCallId: callId,
          toolCallName: "delegate_task",
          ...(messageId === "origin-first" ? { parentMessageId: messageId } : {}),
        },
        { display, context: display },
      );
      const admission = await admitAttachedTesting(parent, callId, sourceInput);
      const active = await publishProjection(parent.runId, admission.operationId);
      const origin = { parentRunId: parent.runId, requestKey: callId, parentMessageId: messageId };
      assert.deepEqual(active.task?.origin, origin);
      assert.deepEqual(
        (await cancelPublishedTesting(thread.id, admission.operationId)).task?.origin,
        origin,
      );
      const terminal = await closeTesting(parent.runId, admission.operationId, "missing");
      assert.deepEqual(terminal.task?.origin, origin);
      assert.ok(terminal.task);
      const { origin: _origin, ...task } = terminal.task;
      await db
        .update(testingPublicationsTable)
        .set({ view: { ...terminal, task } })
        .where(eq(testingPublicationsTable.operation_id, admission.operationId));
      const before = await db
        .select()
        .from(testingPublicationsTable)
        .where(eq(testingPublicationsTable.operation_id, admission.operationId));
      assert.deepEqual(
        (await publishProjection(parent.runId, admission.operationId)).task?.origin,
        origin,
      );
      assert.deepEqual(
        (await readPublishedTesting(thread.id, admission.operationId))?.task?.origin,
        origin,
      );
      assert.deepEqual(
        (await hydrateThread(thread.id)).publishedTasks.find(
          (view) => view.runId === admission.operationId,
        )?.task?.origin,
        origin,
      );
      assert.deepEqual(
        await db
          .select()
          .from(testingPublicationsTable)
          .where(eq(testingPublicationsTable.operation_id, admission.operationId)),
        before,
      );
      await finishRun(parent.runId, { display, context: display });
      await db.update(threadsTable).set({ revision: 0 }).where(eq(threadsTable.id, thread.id));
    }
    const hydrated = await hydrateThread(thread.id);
    assert.deepEqual(
      new Set(hydrated.publishedTasks.map((view) => view.task?.origin?.parentMessageId)),
      new Set(["origin-first", "origin-second"]),
    );
  },
);

test(
  "origin fallback requires a unique new run owner and never overrides conflicting events",
  { skip: !enabled },
  async () => {
    await ensureDatabase();
    const thread = await createThread();
    const db = await database();
    for (const [label, parents, owners, expected] of [
      ["missing-parent", [null], ["survivor"], "survivor"],
      ["ambiguous", [null], ["one", "two"], null],
      ["conflicting", ["abandoned", "survivor"], ["survivor"], null],
      ["abandoned", [null, null], ["survivor"], "survivor"],
      ["wrong-owner", ["abandoned"], ["survivor"], null],
      ["no-event", [], ["survivor"], null],
    ] as const) {
      const parent = await parentRun(thread.id);
      const display = [
        ...parent.messages,
        ...owners.map((id) => ({
          id: `${label}-${id}`,
          role: "assistant" as const,
          parts: [
            {
              type: "tool-call" as const,
              id: label,
              name: "delegate_task",
              arguments: "{}",
              state: "input-complete" as const,
            },
          ],
        })),
      ];
      await db
        .update(chatRunsTable)
        .set({ projection: { version: 1, display, context: display } })
        .where(eq(chatRunsTable.id, parent.runId));
      for (const [sequence, parentMessageId] of parents.entries()) {
        await db.insert(chatEventsTable).values({
          run_id: parent.runId,
          sequence: sequence + 100,
          event_key: `${label}-${sequence}`,
          payload: {
            type: "TOOL_CALL_START",
            timestamp: 1,
            toolCallId: label,
            toolCallName: "delegate_task",
            ...(parentMessageId === null ? {} : { parentMessageId: `${label}-${parentMessageId}` }),
          },
        });
      }
      const admission = await admitAttachedTesting(parent, label, sourceInput);
      const view = await publishProjection(parent.runId, admission.operationId);
      assert.deepEqual(
        view.task?.origin ?? null,
        expected === null
          ? null
          : {
              parentRunId: parent.runId,
              requestKey: label,
              parentMessageId: `${label}-${expected}`,
            },
        label,
      );
      await closeTesting(parent.runId, admission.operationId, "missing");
      await finishRun(parent.runId, { display, context: display });
      await db.update(threadsTable).set({ revision: 0 }).where(eq(threadsTable.id, thread.id));
    }
  },
);

test(
  "planner records unresolved notes in the plan without a URL and assigned execution stays allowed",
  { skip: !enabled },
  async () => {
    await ensureDatabase();
    const thread = await createThread();
    const parent = await parentRun(thread.id);
    const admission = await admitAttachedTesting(parent, "source", sourceInput);
    const task = await reserveRoleTask(
      parent.runId,
      admission.operationId,
      "atlassian",
      sourceInput,
    );
    assert.ok(task);
    await readJira(task);
    const requirements = await acceptRoleCompletion(parent.runId, task.taskId, {
      role: "atlassian",
    });
    const plannerInput = {
      role: "planner",
      summary: "Plan",
      requirementsRef: requirements.ref,
    } as const;
    const planning = await admitAttachedTesting(parent, "planner", plannerInput);
    const planner = await reserveRoleTask(
      parent.runId,
      planning.operationId,
      "planner",
      plannerInput,
    );
    assert.ok(planner);
    const plan = await acceptRoleCompletion(parent.runId, planner.taskId, {
      role: "planner",
      proposal: planProposal(
        [
          {
            id: "case-1",
            title: "Checkout",
            preconditions: [],
            actions: [{ kind: "navigate", path: "/checkout" }],
            checks: [
              {
                id: "check-1",
                criterionId: "AC-1",
                kind: "functional",
                expectedObservation: "Checkout succeeds",
              },
            ],
          },
        ],
        ["price rule"],
      ),
    });
    const execution = await readTestingExecution(parent.runId, planning.operationId);
    assert.equal(execution.intent.targetUrl, null);
    assert.deepEqual(
      execution.tasks.map((entry) => entry.frame.role),
      ["planner"],
    );
    const storedPlan = execution.artifacts.find((artifact) => artifact.ref === plan.ref);
    assert.deepEqual(storedPlan?.payload, {
      requirementsDigest: execution.artifacts.find((artifact) => artifact.kind === "requirements")
        ?.payloadDigest,
      goal,
      targetUrl: null,
      design: null,
      criteria: [{ id: "AC-1", statement: "Checkout succeeds" }],
      unresolved: ["price rule"],
      cases: [
        {
          id: "case-1",
          title: "Checkout",
          preconditions: [],
          actions: [{ kind: "navigate", path: "/checkout" }],
          checks: [
            {
              id: "check-1",
              criterionId: "AC-1",
              kind: "functional",
              expectedObservation: "Checkout succeeds",
            },
          ],
        },
      ],
      assignments: { ac: ["check-1"], ui: [] },
    });
    const execute = await admitAttachedTesting(parent, "execute", {
      role: "ac",
      summary: "Execute",
      planRef: plan.ref,
      targetUrl,
    });
    assert.deepEqual(
      execute.decisions.map((decision) => [decision.ref, decision.kind]),
      [
        [plan.ref, "accepted"],
        [requirements.ref, "accepted"],
      ],
    );
    assert.equal((await countForThread(thread.id)).operations, 3);
  },
);

test(
  "an invalid newest publication omits finished work without reviving its older active card",
  { skip: !enabled, timeout: 60_000 },
  async () => {
    await ensureDatabase();
    const thread = await createThread();
    const parent = await parentRun(thread.id);
    const invalid = await admitAttachedTesting(parent, "invalid-latest", sourceInput);
    const older = await publishProjection(parent.runId, invalid.operationId);
    const newest = await closeTesting(parent.runId, invalid.operationId, "missing");
    const healthy = await admitAttachedTesting(parent, "healthy", sourceInput);
    const healthyView = await closeTesting(parent.runId, healthy.operationId, "missing");
    const db = await database();
    const publications = await db
      .select({ version: testingPublicationsTable.version, view: testingPublicationsTable.view })
      .from(testingPublicationsTable)
      .where(eq(testingPublicationsTable.operation_id, invalid.operationId))
      .orderBy(testingPublicationsTable.version);
    assert.deepEqual(publications, [
      { version: older.progress.version, view: older },
      { version: newest.progress.version, view: newest },
    ]);
    assert.equal(older.state, "active");
    assert.equal(newest.state, "finished");
    assert.equal((await readTestingExecution(parent.runId, invalid.operationId)).finished, true);
    await finishRun(parent.runId, { display: parent.messages, context: parent.context });
    const before = await hydrateThread(thread.id);
    assert.ok(before.messages.length > 0);
    assert.equal(before.activeRun, null);
    await db.update(testingPublicationsTable).set({ view: { raw: privateMarker } }).where(sql`
        ${testingPublicationsTable.operation_id} = ${invalid.operationId}
        and ${testingPublicationsTable.version} = ${newest.progress.version}
      `);
    const diagnostic = mock.method(console, "warn", () => undefined);
    try {
      const hydrated = await hydrateThread(thread.id);
      assert.deepEqual(hydrated.messages, before.messages);
      assert.equal(hydrated.activeRun, null);
      assert.deepEqual(
        diagnostic.mock.calls.map((call) => call.arguments),
        [
          [
            "Invalid testing publication",
            {
              operationId: invalid.operationId,
              threadId: thread.id,
              version: newest.progress.version,
            },
          ],
        ],
      );
      assert.equal(JSON.stringify(diagnostic.mock.calls).includes(privateMarker), false);
      assert.deepEqual(hydrated.publishedTasks, [healthyView]);
      assert.deepEqual(hydrated.publishedTesting, healthyView);
    } finally {
      diagnostic.mock.restore();
    }
  },
);

test(
  "legacy cards with one parent hydrate as distinct operations and cutover fails without mutations",
  { skip: !enabled },
  async () => {
    await ensureDatabase();
    const thread = await createThread();
    const parent = await parentRun(thread.id);
    const ids = [];
    const db = await database();
    for (const callId of ["old-one", "old-two"]) {
      const admission = await admitAttachedTesting(parent, callId, sourceInput);
      const view = await publishProjection(parent.runId, admission.operationId);
      const { task: _task, ...legacy } = view;
      await db
        .update(testingPublicationsTable)
        .set({ view: { ...legacy, runId: parent.runId } })
        .where(eq(testingPublicationsTable.operation_id, admission.operationId));
      await db
        .update(testingOperationsTable)
        .set({ intent: { goal, sources: [source], targetUrl } })
        .where(eq(testingOperationsTable.id, admission.operationId));
      ids.push(admission.operationId);
    }
    const before = await db
      .select()
      .from(testingOperationsTable)
      .where(eq(testingOperationsTable.thread_id, thread.id));
    await assert.rejects(() => assertDelegationCutover(), /Maintenance.*no records were changed/);
    assert.deepEqual(
      await db
        .select()
        .from(testingOperationsTable)
        .where(eq(testingOperationsTable.thread_id, thread.id)),
      before,
    );
    const messages = (await hydrateThread(thread.id)).messages;
    const invalidIds = [];
    for (const view of [null, 3, { raw: privateMarker }]) {
      const admission = await admitAttachedTesting(
        parent,
        `invalid-${invalidIds.length}`,
        sourceInput,
      );
      await publishProjection(parent.runId, admission.operationId);
      await db
        .update(testingPublicationsTable)
        .set({ view: sql`${JSON.stringify(view)}::jsonb` })
        .where(eq(testingPublicationsTable.operation_id, admission.operationId));
      invalidIds.push(admission.operationId);
    }
    const diagnostic = mock.method(console, "warn", () => undefined);
    let hydrated;
    try {
      hydrated = await hydrateThread(thread.id);
      assert.equal(diagnostic.mock.calls.length, 3);
      assert.deepEqual(
        diagnostic.mock.calls.map((call) => call.arguments[1].operationId).sort(),
        [...invalidIds].sort(),
      );
      assert.equal(JSON.stringify(diagnostic.mock.calls).includes(privateMarker), false);
    } finally {
      diagnostic.mock.restore();
    }
    assert.deepEqual(hydrated.messages, messages);
    const views = hydrated.publishedTasks;
    assert.deepEqual(
      views.map((view) => view.runId),
      ids,
    );
    assert.equal(
      views.every((view) => view.state === "active" && !view.task),
      true,
    );
  },
);

test(
  "frozen workflow versions keep prose QA history as view 3, structured history as view 2, and report the frozen workflow to the cutover check",
  { skip: !enabled },
  async () => {
    const { parent, startAc } = await plannerWithExecution();
    const ac = await startAc();
    const findings = "Unassessed prose from the first completed reply.";
    await acceptRoleCompletion(parent.runId, ac.taskId, { role: "ac", findings });
    const db = await database();
    const workflowOf = async () =>
      (await listPendingTestingOperations()).find((item) => item.operationId === ac.operationId)
        ?.workflow;
    const freeze = (workflow: string) =>
      db
        .update(testingOperationsTable)
        .set({
          runtime: sql`jsonb_set(${testingOperationsTable.runtime}, '{versions,workflow}', to_jsonb(${workflow}::text))`,
        })
        .where(eq(testingOperationsTable.id, ac.operationId));
    assert.equal(await workflowOf(), "testing-child-v3");
    const current = await publishProjection(parent.runId, ac.operationId);
    assert.equal(current.task?.version === 3 && current.task.findings, findings);

    await freeze("testing-child-v2");
    assert.equal(await workflowOf(), "testing-child-v2");
    const prose = await publishProjection(parent.runId, ac.operationId);
    assert.equal(prose.task?.version === 3 && prose.task.findings, findings);

    await freeze("testing-child-v1");
    const structured = await publishProjection(parent.runId, ac.operationId);
    assert.equal(structured.task?.version, 2);
    assert.equal(structured.task?.version === 2 && "findings" in structured.task, false);
  },
);
