import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { z } from "zod";
import {
  browserOutputSchema,
  testingRequestSchema,
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
  readStartCancelDeliveries,
  hostTestingRuntime,
} from "../../../server/harness/testing-store";
import { digestOf } from "../../../server/harness/testing-domain";
import { createUseBrowserTool } from "../../../server/harness/tools/use-browser";
import {
  BUILD,
  MODEL,
  admitAttachedTesting,
  admitStandaloneTesting,
  acceptRoleCandidate,
  cancelPublishedTesting,
  cancelTesting,
  closeTesting,
  database,
  finishRun,
  guardActualIO,
  hydrateThread,
  listPendingRuns,
  persistRun,
  publishProjection,
  readPublishedTesting,
  readTestingExecution,
  reserveRoleTasks,
} from "../../../server/harness/run-store";

const enabled = process.env.TESTING_STORE_DATABASE_URL;
const source = { kind: "jira" as const, issueKey: "CHUM-42" };
const design = { fileKey: "CheckoutDemo", nodeId: "12:34" };
const goal = "Verify checkout";
const targetUrl = "https://preview.example.test/checkout";
const privateMarker = "private-observation-marker";
const rawMarker = "raw-source-secret";
let migrationFolder: string | undefined;

function hostFixture() {
  const runtime = hostTestingRuntime({ model: MODEL, build: BUILD });
  return {
    identity: runtime.fixture,
    adapterVersion: runtime.versions.adapter,
    outcomes: {
      "check-1": { state: "blocked" as const, reason: "Fixture target page is unavailable" },
    },
  };
}

function testingRequest(threadId: string, revision: number, existingArtifacts?: readonly string[]) {
  return testingRequestSchema.parse({
    threadId,
    expectedRevision: revision,
    requestId: `req-${randomUUID()}`,
    goal,
    sources: [source],
    criteria: { kind: "all" as const },
    targetUrl,
    design,
    ...(existingArtifacts ? { existingArtifacts: [...existingArtifacts] } : {}),
  });
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
  if (migrationFolder) {
    await rm(migrationFolder, { recursive: true, force: true });
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

async function linkSourceCapture(task: { taskId: string; attemptNonce: number }) {
  const output = { summary: "AC-1" };
  const digest = digestOf(output);
  const capture = {
    reference: source,
    digest,
    anchors: ["AC-1"],
    capturedAt: "2026-10-09T00:00:00.000Z",
  };
  await appendTrustedReceipt({
    id: `jira-${task.taskId}`,
    taskId: task.taskId,
    attemptNonce: task.attemptNonce,
    slot: "capture",
    nativeName: "jira_get_issue",
    route: "direct",
    input: { issue_key: source.issueKey },
    output,
    bindings: {},
  });
  await appendTrustedReceipt({
    id: `cap-${task.taskId}`,
    taskId: task.taskId,
    attemptNonce: task.attemptNonce,
    slot: "capture",
    nativeName: "source_capture",
    route: "direct",
    input: { source },
    output: {
      reference: source,
      digest,
      anchors: ["AC-1"],
      capturedAt: "2026-10-09T00:00:00.000Z",
    },
    bindings: { nativeName: "jira_get_issue", nativeOutputDigest: digest },
  });
  return capture;
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
  "explicit bad refs reject before a standalone claim or testing rows",
  { skip: !enabled, timeout: 60_000 },
  async () => {
    await ensureDatabase();
    const thread = await createThread();
    const before = await countForThread(thread.id);
    await assert.rejects(
      () => admitStandaloneTesting(testingRequest(thread.id, 0, ["missing-a", "missing-b"])),
      (error: unknown) => {
        assert.ok(error instanceof TestingRequestError);
        assert.equal(error.decisions.length, 2);
        assert.deepEqual(
          error.decisions.map((decision) => decision.kind === "rejected" && decision.reason),
          ["not_accessible", "not_accessible"],
        );
        return true;
      },
    );
    assert.deepEqual(await countForThread(thread.id), before);
  },
);

test(
  "standalone admission pins closure, publishes fenced views, and does not renew deadline",
  { skip: !enabled, timeout: 120_000 },
  async () => {
    await ensureDatabase();
    const thread = await createThread();
    const admittedAt = new Date();
    const admission = await admitStandaloneTesting(testingRequest(thread.id, 0), admittedAt);
    const again = await admitStandaloneTesting(
      { ...testingRequest(thread.id, 4), requestId: admission.operationId },
      new Date("2026-10-11T00:00:00.000Z"),
    );
    assert.equal(again.operationId, admission.operationId);
    assert.equal(again.deadline, admission.deadline);
    assert.equal((await countForThread(thread.id)).runs, 1);
    const rootDb = await database();
    const [root] = await rootDb
      .select({ accepted: chatRunsTable.accepted })
      .from(chatRunsTable)
      .where(eq(chatRunsTable.id, admission.parentRunId));
    assert.ok(root);
    assert.equal(z.object({ build: z.string() }).parse(root.accepted).build, "testing-root-v1");
    assert.equal((await hydrateThread(thread.id)).activeRun?.runId, admission.parentRunId);
    const pending = await listPendingRuns();
    assert.equal(
      pending.some((run) => run.id === admission.parentRunId),
      false,
    );

    const frames = await reserveRoleTasks(admission.parentRunId, admission.operationId, [
      { role: "atlassian", input: { goal } },
    ]);
    assert.equal(frames.length, 1);
    const frame = frames[0]!;
    const same = await reserveRoleTasks(admission.parentRunId, admission.operationId, [
      { role: "atlassian", input: { goal } },
    ]);
    assert.equal(same[0]?.taskId, frame.taskId);
    await assert.rejects(
      () =>
        reserveRoleTasks(admission.parentRunId, admission.operationId, [
          { role: "atlassian", input: { goal: "other" } },
        ]),
      /collision/,
    );
    assert.deepEqual(
      await claimActualTask({
        taskId: frame.taskId,
        attemptNonce: frame.attemptNonce + 1,
        childWorkflowId: frame.childWorkflowId,
        parentRunId: admission.parentRunId,
      }),
      { state: "denied", reason: "nonce" },
    );
    assert.deepEqual(
      await claimActualTask({
        taskId: frame.taskId,
        attemptNonce: frame.attemptNonce,
        childWorkflowId: "other-child",
        parentRunId: admission.parentRunId,
      }),
      { state: "denied", reason: "scope" },
    );
    assert.deepEqual(
      await guardActualIO({
        taskId: frame.taskId,
        parentRunId: admission.parentRunId,
        attemptNonce: frame.attemptNonce,
        childWorkflowId: frame.childWorkflowId,
        kind: "model",
        step: "model-turn-1",
      }),
      { state: "allowed", slot: `${frame.taskId}-io-1` },
    );
    await claimActualTask({
      taskId: frame.taskId,
      attemptNonce: frame.attemptNonce,
      childWorkflowId: frame.childWorkflowId,
      parentRunId: admission.parentRunId,
    });
    assert.deepEqual(
      await guardActualIO({
        taskId: frame.taskId,
        parentRunId: admission.parentRunId,
        attemptNonce: frame.attemptNonce,
        childWorkflowId: frame.childWorkflowId,
        kind: "model",
        step: "model-turn-1",
      }),
      { state: "allowed", slot: `${frame.taskId}-io-2` },
    );

    await assert.rejects(
      () =>
        appendTrustedObservation({
          taskId: frame.taskId,
          attemptNonce: frame.attemptNonce,
          key: "minted-capture",
          body: {
            kind: "tool_started",
            toolName: "source_capture",
            route: "codemode",
            at: privateMarker,
          },
        }),
      /minted/,
    );
    await assert.rejects(
      () =>
        appendTrustedReceipt({
          id: `cap-${randomUUID()}`,
          taskId: frame.taskId,
          attemptNonce: frame.attemptNonce,
          slot: "raw",
          nativeName: "source_capture",
          route: "direct",
          input: { source },
          output: {
            reference: source,
            digest: "x",
            anchors: ["AC-1"],
            capturedAt: "2026-10-09T00:00:00.000Z",
            raw: rawMarker,
          },
          bindings: {},
        }),
      /private host receipt/,
    );
    const capture = await linkSourceCapture(frame);
    const requirements = await acceptRoleCandidate(admission.parentRunId, frame.taskId, {
      criteria: [{ key: "AC-1", statement: "Checkout succeeds", source, anchor: "AC-1" }],
      unresolved: ["price rule"],
    });
    const recovered = await acceptRoleCandidate(admission.parentRunId, frame.taskId, {
      criteria: [{ key: "AC-1", statement: "Checkout succeeds", source, anchor: "AC-1" }],
      unresolved: ["price rule"],
    });
    assert.deepEqual(recovered, requirements);

    const planner = await reserveRoleTasks(admission.parentRunId, admission.operationId, [
      { role: "planner", input: { goal } },
    ]);
    const plannerFrame = planner.find((task) => task.role === "planner")!;
    const planCase = {
      id: "case-1",
      title: "Checkout",
      preconditions: [] as string[],
      actions: [{ kind: "navigate" as const, path: "/checkout" }],
      checks: [
        {
          id: "check-1",
          criterionId: "crit:AC-1",
          kind: "functional" as const,
          expectedObservation: "Order confirmation is visible",
        },
        {
          id: "check-style",
          criterionId: "crit:AC-1",
          kind: "style" as const,
          design,
          property: "padding-left",
          tolerance: { kind: "exact" as const },
        },
      ],
    };
    const plan = await acceptRoleCandidate(admission.parentRunId, plannerFrame.taskId, {
      cases: [planCase],
    });
    const ac = await reserveRoleTasks(admission.parentRunId, admission.operationId, [
      { role: "ac", input: { plan: plan.ref } },
    ]);
    const acFrame = ac.find((task) => task.role === "ac")!;
    const fixture = hostFixture();
    const tool = createUseBrowserTool({
      role: "ac",
      cases: [planCase],
      checks: [planCase.checks[0]!],
      fixture,
      figmaProperties: null,
      designCapture: null,
    });
    const output = browserOutputSchema.parse(await tool.execute!({ checkId: "check-1" }));
    const drifted = { ...output, ignored: undefined };
    const receipt = await appendTrustedReceipt({
      id: `browser-${randomUUID()}`,
      taskId: acFrame.taskId,
      attemptNonce: acFrame.attemptNonce,
      slot: "browser",
      nativeName: "use_browser",
      route: "direct",
      input: { checkId: "check-1", unused: undefined },
      output: drifted,
      bindings: { fixture: fixture.identity, adapterVersion: fixture.adapterVersion },
    });
    const duplicate = await appendTrustedReceipt({
      id: `browser-${randomUUID()}`,
      taskId: acFrame.taskId,
      attemptNonce: acFrame.attemptNonce,
      slot: "browser-2",
      nativeName: "use_browser",
      route: "direct",
      input: { checkId: "check-1" },
      output,
      bindings: { fixture: fixture.identity, adapterVersion: fixture.adapterVersion },
    });
    assert.equal(receipt.outputDigest, digestOf(output));
    assert.equal(duplicate.outputDigest, receipt.outputDigest);
    assert.equal(duplicate.duplicate, false);
    await acceptRoleCandidate(admission.parentRunId, acFrame.taskId, {
      checks: [
        {
          caseId: output.evidence.caseId,
          checkId: output.checkId,
          judgment: "simulated_blocked",
          evidence: [{ receiptId: `browser-placeholder`, digest: receipt.outputDigest }],
        },
      ],
    }).catch(() => undefined);
    const storedReceiptId = await receiptIdFor(acFrame.taskId);
    const acResult = await acceptRoleCandidate(admission.parentRunId, acFrame.taskId, {
      checks: [
        {
          caseId: output.evidence.caseId,
          checkId: output.checkId,
          judgment: output.evidence.outcome === "blocked" ? "simulated_blocked" : "simulated_fail",
          evidence: [{ receiptId: storedReceiptId, digest: receipt.outputDigest }],
        },
      ],
    });
    const execution = await readTestingExecution(admission.parentRunId, admission.operationId);
    assert.equal(execution.intent.goal, goal);
    assert.equal(execution.mode, "standalone");
    assert.equal(execution.runtime.versions.model, MODEL);
    assert.deepEqual(
      execution.artifacts.map((artifact) => artifact.ref).sort(),
      [requirements.ref, plan.ref, acResult.ref].sort(),
    );
    assert.equal(
      execution.artifacts.find((artifact) => artifact.ref === plan.ref)?.provenance.producerTaskId,
      plannerFrame.taskId,
    );
    const executionAc = execution.tasks.find((task) => task.frame.taskId === acFrame.taskId);
    assert.deepEqual(executionAc?.receipts[0]?.output, output);
    assert.deepEqual(executionAc?.receipts[0]?.input, { checkId: "check-1" });
    const executionAtlassian = execution.tasks.find((task) => task.frame.taskId === frame.taskId);
    assert.deepEqual(
      executionAtlassian?.receipts.find((receipt) => receipt.nativeName === "source_capture")
        ?.output,
      capture,
    );
    await appendTrustedObservation({
      taskId: acFrame.taskId,
      attemptNonce: acFrame.attemptNonce,
      key: "private-note",
      body: { kind: "attempt_started", activity: "model", at: privateMarker },
    });
    const published = await publishProjection(admission.parentRunId, admission.operationId);
    assert.equal(JSON.stringify(published).includes(privateMarker), false);
    assert.equal(JSON.stringify(published).includes(rawMarker), false);
    const reread = await readPublishedTesting(thread.id, admission.parentRunId);
    assert.deepEqual(reread, published);
    const againPublished = await publishProjection(admission.parentRunId, admission.operationId);
    assert.deepEqual(againPublished, published);
    const db = await database();
    const events = await db
      .select({
        sequence: chatEventsTable.sequence,
        payload: chatEventsTable.payload,
        publicSequence: testingPublicationsTable.public_sequence,
      })
      .from(testingPublicationsTable)
      .innerJoin(
        testingOperationsTable,
        eq(testingPublicationsTable.operation_id, testingOperationsTable.id),
      )
      .innerJoin(
        chatEventsTable,
        sql`${chatEventsTable.run_id} = ${testingOperationsTable.parent_run_id} and ${chatEventsTable.sequence} = ${testingPublicationsTable.public_sequence}`,
      )
      .where(eq(testingPublicationsTable.operation_id, admission.operationId));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.sequence, events[0]?.publicSequence);
    assert.equal(events[0]?.payload.type, "CUSTOM");
    assert.equal(events[0]?.payload.name, "testing.projection");
    const closed = await closeTesting(admission.parentRunId, admission.operationId, "failed");
    assert.equal(closed.state, "finished");
    assert.ok(closed.report);
    assert.equal(closed.report.requirements?.unresolved[0], "price rule");
    assert.equal(closed.report.plan?.cases[0]?.id, "case-1");
    assert.equal(closed.report.results.ac[0]?.judgment, "simulated_blocked");
    assert.equal(closed.report.results.ac[0]?.evidence[0]?.caseId, output.evidence.caseId);
    assert.equal(closed.report.results.ui.length, 0);
    assert.equal(closed.report.acceptance.verdict, "blocked");
    assert.equal(closed.report.acceptance.reasons.includes("root_failed"), true);
    assert.equal(closed.report.acceptance.reasons.includes("ui_results_missing"), true);
    assert.equal(closed.availableArtifacts.includes(requirements.ref), true);
    assert.equal(closed.availableArtifacts.includes(plan.ref), true);
    assert.equal(closed.report.artifacts.includes(requirements.ref), true);
    assert.equal(
      closed.availableArtifacts.some((ref) => ref !== requirements.ref && ref !== plan.ref),
      false,
    );
    assert.equal(JSON.stringify(closed).includes(privateMarker), false);
    const hydrated = await hydrateThread(thread.id);
    assert.equal(hydrated.activeRun, null);
    assert.deepEqual(hydrated.publishedTesting, closed);
    assert.equal(hydrated.revision, 0);
    await assert.rejects(
      () =>
        appendTrustedObservation({
          taskId: frame.taskId,
          attemptNonce: frame.attemptNonce,
          key: "late",
          body: { kind: "attempt_settled", outcome: "completed", at: "late" },
        }),
      /terminal/,
    );

    const beforeReuse = await countForThread(thread.id);
    await assert.rejects(
      () => admitStandaloneTesting(testingRequest(thread.id, 0, [plan.ref])),
      (error: unknown) => {
        assert.ok(error instanceof TestingRequestError);
        assert.equal(
          error.decisions.some((decision) => decision.kind === "rejected"),
          true,
        );
        return true;
      },
    );
    assert.deepEqual(await countForThread(thread.id), beforeReuse);
  },
);

async function receiptIdFor(taskId: string) {
  const db = await database();
  const rows = await db.execute<{ id: string }>(sql`
    select id from testing_receipts where task_id = ${taskId} and native_name = 'use_browser' order by id
  `);
  const id = rows.rows[0]?.id;
  if (!id) {
    throw new Error("browser receipt was not stored");
  }
  return id;
}

test(
  "cancel freezes IO without renewing deadline and records delivery acks",
  { skip: !enabled, timeout: 60_000 },
  async () => {
    await ensureDatabase();
    const thread = await createThread();
    const admission = await admitStandaloneTesting(testingRequest(thread.id, 0));
    const db = await database();
    const [before] = await db
      .select({ deadline: testingOperationsTable.deadline })
      .from(testingOperationsTable)
      .where(eq(testingOperationsTable.id, admission.operationId));
    const frames = await reserveRoleTasks(admission.parentRunId, admission.operationId, [
      { role: "atlassian", input: { goal } },
    ]);
    const budgetBeforeCancel = await taskBudget(frames[0]!.taskId);
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
        taskId: frames[0]!.taskId,
        parentRunId: admission.parentRunId,
        attemptNonce: frames[0]!.attemptNonce,
        childWorkflowId: frames[0]!.childWorkflowId,
        kind: "tool",
      }),
      { state: "denied", reason: "cancel_requested" },
    );
    assert.deepEqual(await taskBudget(frames[0]!.taskId), budgetBeforeCancel);
    await assert.rejects(
      () => acceptRoleCandidate(admission.parentRunId, frames[0]!.taskId, { criteria: [] }),
      /fence/,
    );
  },
);

test(
  "attached finish closes unfinished testing before releasing the parent claim",
  { skip: !enabled, timeout: 60_000 },
  async () => {
    await ensureDatabase();
    const thread = await createThread();
    const persisted = await persistRun({
      kind: "chat",
      threadId: thread.id,
      runId: `run-${randomUUID()}`,
      baseRevision: 0,
      message: { id: `msg-${randomUUID()}`, text: "run tests" },
    });
    const before = await countForThread(thread.id);
    const admission = await admitAttachedTesting(persisted.run, "call-1", {
      goal,
      sources: [source],
      criteria: { kind: "all" },
      targetUrl,
      design,
    });
    assert.equal(admission.mode, "attached");
    assert.equal(admission.parentRunId, persisted.run.runId);
    assert.deepEqual(await countForThread(thread.id), {
      runs: before.runs,
      operations: before.operations + 1,
    });
    await finishRun(persisted.run.runId);
    const hydrated = await hydrateThread(thread.id);
    assert.equal(hydrated.activeRun, null);
    assert.equal(hydrated.publishedTesting?.state, "finished");
    assert.equal(hydrated.publishedTesting?.report?.acceptance.verdict, "blocked");
    assert.equal(
      hydrated.publishedTesting?.report?.acceptance.reasons.includes("root_failed"),
      true,
    );
    assert.equal(hydrated.publishedTesting?.report?.requirements, null);
    const db = await database();
    const [operation] = await db
      .select({ outcome: testingOperationsTable.terminal_outcome })
      .from(testingOperationsTable)
      .where(eq(testingOperationsTable.id, admission.operationId));
    assert.equal(operation?.outcome, "failed");
  },
);

test(
  "cross-run results and conflicting requirements do not open a claim",
  { skip: !enabled, timeout: 60_000 },
  async () => {
    await ensureDatabase();
    const thread = await createThread();
    const first = await admitStandaloneTesting(testingRequest(thread.id, 0));
    const frame = (
      await reserveRoleTasks(first.parentRunId, first.operationId, [
        { role: "atlassian", input: { goal } },
      ])
    )[0]!;
    await linkSourceCapture(frame);
    const requirements = await acceptRoleCandidate(first.parentRunId, frame.taskId, {
      criteria: [{ key: "AC-1", statement: "Checkout succeeds", source, anchor: "AC-1" }],
      unresolved: [],
    });
    await closeTesting(first.parentRunId, first.operationId, "failed");
    const second = await admitStandaloneTesting(testingRequest(thread.id, 0));
    const secondFrame = (
      await reserveRoleTasks(second.parentRunId, second.operationId, [
        { role: "atlassian", input: { goal } },
      ])
    )[0]!;
    await linkSourceCapture(secondFrame);
    const other = await acceptRoleCandidate(second.parentRunId, secondFrame.taskId, {
      criteria: [{ key: "AC-1", statement: "Checkout succeeds", source, anchor: "AC-1" }],
      unresolved: [],
    });
    await closeTesting(second.parentRunId, second.operationId, "failed");
    const before = await countForThread(thread.id);
    await assert.rejects(
      () => admitStandaloneTesting(testingRequest(thread.id, 0, [requirements.ref, other.ref])),
      (error: unknown) => {
        assert.ok(error instanceof TestingRequestError);
        assert.equal(
          error.decisions.some(
            (decision) =>
              decision.kind === "rejected" && decision.reason === "conflicting_reference",
          ),
          true,
        );
        return true;
      },
    );
    assert.deepEqual(await countForThread(thread.id), before);
  },
);

test(
  "a plan without style checks marks UI not required and pins profile versions",
  { skip: !enabled, timeout: 60_000 },
  async () => {
    await ensureDatabase();
    const thread = await createThread();
    const admission = await admitStandaloneTesting(testingRequest(thread.id, 0));
    const frame = (
      await reserveRoleTasks(admission.parentRunId, admission.operationId, [
        { role: "atlassian", input: { goal } },
      ])
    )[0]!;
    await linkSourceCapture(frame);
    await acceptRoleCandidate(admission.parentRunId, frame.taskId, {
      criteria: [{ key: "AC-1", statement: "Checkout succeeds", source, anchor: "AC-1" }],
      unresolved: [],
    });
    const planner = (
      await reserveRoleTasks(admission.parentRunId, admission.operationId, [
        { role: "planner", input: { goal } },
      ])
    ).find((task) => task.role === "planner")!;
    await acceptRoleCandidate(admission.parentRunId, planner.taskId, {
      cases: [
        {
          id: "case-1",
          title: "Checkout",
          preconditions: [],
          actions: [{ kind: "navigate", path: "/checkout" }],
          checks: [
            {
              id: "check-1",
              criterionId: "crit:AC-1",
              kind: "functional",
              expectedObservation: "Order confirmation is visible",
            },
          ],
        },
      ],
    });
    await assert.rejects(
      () =>
        reserveRoleTasks(admission.parentRunId, admission.operationId, [
          { role: "ui", input: { goal } },
        ]),
      /not required/,
    );
    const view = await publishProjection(admission.parentRunId, admission.operationId);
    assert.equal(view.progress.rows.ui.status, "not_required");
    const db = await database();
    const pins = await db
      .select({ metadata: testingArtifactsTable.metadata })
      .from(testingPinsTable)
      .innerJoin(testingArtifactsTable, eq(testingPinsTable.ref, testingArtifactsTable.ref))
      .where(eq(testingPinsTable.operation_id, admission.operationId));
    assert.equal(pins.length >= 2, true);
    for (const pin of pins) {
      const metadata = pin.metadata as {
        profiles?: { atlassian?: string };
        registration?: { atlassian?: string };
        versions?: { model?: string };
      };
      assert.equal(metadata.profiles?.atlassian, "requirements-v1");
      assert.equal(typeof metadata.registration?.atlassian, "string");
      assert.equal(metadata.versions?.model, MODEL);
    }
    await closeTesting(admission.parentRunId, admission.operationId, "missing");
  },
);

test(
  "past admission deadline denies IO and is not extended by guard",
  { skip: !enabled, timeout: 60_000 },
  async () => {
    await ensureDatabase();
    const thread = await createThread();
    const admission = await admitStandaloneTesting(
      testingRequest(thread.id, 0),
      new Date("2000-01-01T00:00:00.000Z"),
    );
    const frame = (
      await reserveRoleTasks(admission.parentRunId, admission.operationId, [
        { role: "atlassian", input: { goal } },
      ])
    )[0]!;
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
    const admission = await admitStandaloneTesting(testingRequest(thread.id, 0));
    const frame = (
      await reserveRoleTasks(admission.parentRunId, admission.operationId, [
        { role: "atlassian", input: { goal } },
      ])
    )[0]!;
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

test(
  "scope, nonce, root-claim, and terminal denials do not allocate budget",
  { skip: !enabled, timeout: 60_000 },
  async () => {
    await ensureDatabase();
    const thread = await createThread();
    const admission = await admitStandaloneTesting(testingRequest(thread.id, 0));
    const frame = (
      await reserveRoleTasks(admission.parentRunId, admission.operationId, [
        { role: "atlassian", input: { goal } },
      ])
    )[0]!;
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
  "published cancellation matches operation or parent ids only while empty reads stay thread-wide",
  { skip: !enabled, timeout: 60_000 },
  async () => {
    await ensureDatabase();
    const thread = await createThread();
    const admission = await admitStandaloneTesting(testingRequest(thread.id, 0));
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
