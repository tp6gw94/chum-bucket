import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { EventType } from "@tanstack/ai";
import {
  testingArtifactsTable,
  testingDecisionsTable,
  testingDeliveriesTable,
  testingOperationsTable,
  testingPinsTable,
  testingPublicationsTable,
  testingReceiptsTable,
  testingTasksTable,
} from "../db/schema";
import {
  artifactKinds,
  delegationInputSchema,
  planArtifactSchema,
  requirementsSchema,
  testingProjectionEventName,
  type DelegationInput,
  type OperationOutcome,
  type Role,
  type RoleFailureCode,
  type TaskStatus,
  type TestView,
} from "../../shared/testing";
import { roleDefinition, type RoleLimits } from "./agents";
import { appendRunEvent, database, RunRequestError, type Transaction } from "./run-store";
import {
  artifactRefFor,
  childWorkflowIdFor,
  clipIssues,
  digestOf,
  evaluateRole,
  failureCodeFor,
  MAX_FAILURE_ISSUE_CHARS,
  MAX_FAILURE_ISSUES,
  operationIdFor,
  taskIdFor,
  TESTING_WORKFLOW_VERSION,
  type Receipt,
  type RoleContext,
} from "./testing-domain";

const DEADLINE_MINUTES = 15;
const MAX_STEP_ATTEMPTS = 3;

export type OperationRuntime = Readonly<{
  profile: string;
  registration: string;
  limits: RoleLimits;
  workflowVersion: string;
}>;
export type TaskActivity = Readonly<{ kind: "model" | "tool"; name: string | null }>;
export type DeniedReason = "cancel_requested" | "terminal" | "deadline" | "budget" | "nonce";
export type IoKind = "model" | "tool" | "nested";

export type TestingChildInput = Readonly<{
  taskId: string;
  attemptNonce: number;
  childWorkflowId: string;
  parentRunId: string;
  operationId: string;
  role: Role;
}>;

export type ClaimedTask = Readonly<{
  intent: DelegationInput;
  runtime: OperationRuntime;
  deadline: string;
  taskInput: unknown;
  context: RoleContext;
}>;

export type ArtifactView = Readonly<{ ref: string; kind: string; payload: unknown }>;

type Executor = Transaction | Awaited<ReturnType<typeof database>>;
type OperationRow = typeof testingOperationsTable.$inferSelect;
type TaskRow = typeof testingTasksTable.$inferSelect;
type TaskResult =
  | { state: "ready"; ref: string }
  | { state: "failed"; reasonCode: RoleFailureCode; issues: string[] }
  | { state: "cancelled" };

type Dependency = Readonly<{ ref: string; kind: "requirements" | "plan"; role: Role }>;

function dependencyOf(intent: DelegationInput): Dependency | undefined {
  switch (intent.role) {
    case "atlassian":
      return undefined;
    case "planner":
      return { ref: intent.requirementsRef, kind: "requirements", role: "atlassian" };
    default:
      return { ref: intent.planRef, kind: "plan", role: "planner" };
  }
}

async function appendDecision(
  tx: Transaction,
  operationId: string,
  key: string,
  kind: string,
  payload: unknown,
): Promise<void> {
  const [existing] = await tx
    .select({ key: testingDecisionsTable.decision_key })
    .from(testingDecisionsTable)
    .where(
      and(
        eq(testingDecisionsTable.operation_id, operationId),
        eq(testingDecisionsTable.decision_key, key),
      ),
    );

  if (existing) {
    return;
  }

  const [{ next }] = (await tx
    .select({ next: sql<number>`coalesce(max(${testingDecisionsTable.decision_index}) + 1, 0)` })
    .from(testingDecisionsTable)
    .where(eq(testingDecisionsTable.operation_id, operationId))) as [{ next: number }];
  await tx.insert(testingDecisionsTable).values({
    operation_id: operationId,
    decision_index: Number(next),
    decision_key: key,
    kind,
    payload,
  });
}

async function decisionPayload<T>(
  db: Executor,
  operationId: string,
  key: string,
): Promise<T | undefined> {
  const [row] = await db
    .select({ payload: testingDecisionsTable.payload })
    .from(testingDecisionsTable)
    .where(
      and(
        eq(testingDecisionsTable.operation_id, operationId),
        eq(testingDecisionsTable.decision_key, key),
      ),
    );

  return row?.payload as T | undefined;
}

async function loadArtifact(db: Executor, threadId: string, ref: string) {
  const [artifact] = await db
    .select()
    .from(testingArtifactsTable)
    .where(and(eq(testingArtifactsTable.ref, ref), eq(testingArtifactsTable.thread_id, threadId)));

  return artifact;
}

async function dependencyPayload(db: Executor, threadId: string, dependency: Dependency) {
  const artifact = await loadArtifact(db, threadId, dependency.ref);

  return artifact?.kind === dependency.kind ? artifact.payload : undefined;
}

async function roleContextFor(db: Executor, operation: OperationRow): Promise<RoleContext> {
  const intent = operation.intent;
  const dependency = dependencyOf(intent);
  const payload = dependency
    ? await dependencyPayload(db, operation.thread_id, dependency)
    : undefined;

  switch (intent.role) {
    case "atlassian":
      return { role: "atlassian", intent };
    case "planner":
      return {
        role: "planner",
        requirementsRef: intent.requirementsRef,
        requirements: requirementsSchema.parse(payload),
        design: intent.design ?? null,
      };
    default:
      return {
        role: intent.role,
        planRef: intent.planRef,
        plan: planArtifactSchema.parse(payload),
        targetUrl: intent.targetUrl,
      };
  }
}

function roleTaskInput(intent: DelegationInput, context: RoleContext) {
  const base = {
    summary: intent.summary,
    goal: null as string | null,
    sources: [] as unknown[],
    requirements: null as unknown,
    targetUrl: null as string | null,
    design: null as unknown,
    plan: null as unknown,
    checks: [] as string[],
  };

  switch (context.role) {
    case "atlassian":
      return { ...base, goal: context.intent.goal, sources: context.intent.sources };
    case "planner":
      return {
        ...base,
        goal: context.requirements.goal,
        sources: context.requirements.sources.map((source) => source.reference),
        requirements: context.requirements,
        design: context.design,
      };
    default:
      return {
        ...base,
        goal: context.plan.goal,
        targetUrl: context.targetUrl,
        design: context.plan.design,
        plan: context.plan,
        checks: context.plan.assignments[context.role],
      };
  }
}

export type AdmitResult =
  | { state: "admitted"; operationId: string }
  | { state: "rejected"; message: string; decisions?: unknown[] };

async function missingDependency(
  tx: Transaction,
  threadId: string,
  intent: DelegationInput,
): Promise<AdmitResult | undefined> {
  const dependency = dependencyOf(intent);

  if (!dependency) {
    return undefined;
  }

  const payload = await dependencyPayload(tx, threadId, dependency);

  if (payload === undefined) {
    return {
      state: "rejected",
      message: `Artifact ${dependency.ref} is not a ${dependency.kind} artifact of this thread; delegate ${dependency.role} first and use the ref it returns`,
      decisions: [{ kind: "missing_dependency", ref: dependency.ref, expected: dependency.kind }],
    };
  }

  if (intent.role === "ac" || intent.role === "ui") {
    const plan = planArtifactSchema.safeParse(payload);

    if (!plan.success || plan.data.assignments[intent.role].length === 0) {
      return {
        state: "rejected",
        message: `Plan ${dependency.ref} has no checks assigned to ${intent.role}`,
        decisions: [{ kind: "empty_assignment", ref: dependency.ref, role: intent.role }],
      };
    }
  }

  return undefined;
}

export async function admitOperation(input: {
  parentRunId: string;
  threadId: string;
  requestKey: string;
  raw: unknown;
}): Promise<AdmitResult> {
  const parsed = delegationInputSchema.safeParse(input.raw);

  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "input"}: ${issue.message}`,
    );

    return {
      state: "rejected",
      message: `Invalid delegate_task input: ${issues.slice(0, 8).join("; ")}`,
    };
  }

  const intent = parsed.data;
  const operationId = operationIdFor(input.parentRunId, input.requestKey);
  const definition = roleDefinition(intent.role);
  const db = await database();

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(testingOperationsTable)
      .where(eq(testingOperationsTable.id, operationId));

    if (existing) {
      return digestOf(existing.intent) === digestOf(intent)
        ? { state: "admitted", operationId }
        : { state: "rejected", message: "Operation input collision" };
    }

    const rejected = await missingDependency(tx, input.threadId, intent);

    if (rejected) {
      return rejected;
    }

    await tx.insert(testingOperationsTable).values({
      id: operationId,
      parent_run_id: input.parentRunId,
      thread_id: input.threadId,
      request_key: input.requestKey,
      role: intent.role,
      intent,
      runtime: {
        profile: definition.profile,
        registration: definition.registration,
        limits: definition.limits,
        workflowVersion: TESTING_WORKFLOW_VERSION,
      },
      deadline: sql`now() + make_interval(mins => ${DEADLINE_MINUTES})`,
    });
    const dependency = dependencyOf(intent);

    if (dependency) {
      await tx
        .insert(testingPinsTable)
        .values({ operation_id: operationId, ref: dependency.ref })
        .onConflictDoNothing();
    }

    await appendDecision(tx, operationId, "admit", "admit", {
      role: intent.role,
      dependency: dependency?.ref ?? null,
    });

    return { state: "admitted", operationId };
  });
}

async function operationRow(db: Executor, operationId: string): Promise<OperationRow> {
  const [operation] = await db
    .select()
    .from(testingOperationsTable)
    .where(eq(testingOperationsTable.id, operationId));

  if (!operation) {
    throw new Error(`Unknown testing operation ${operationId}`);
  }

  return operation;
}

export async function loadOperation(operationId: string): Promise<OperationRow> {
  return operationRow(await database(), operationId);
}

export async function reserveTask(operationId: string): Promise<TestingChildInput> {
  const db = await database();

  return db.transaction(async (tx) => {
    const [operation] = await tx
      .select()
      .from(testingOperationsTable)
      .where(eq(testingOperationsTable.id, operationId))
      .for("update");

    if (!operation) {
      throw new Error(`Unknown testing operation ${operationId}`);
    }

    const role = operation.role;
    const taskId = taskIdFor(operationId, role);
    const context = await roleContextFor(tx, operation);
    const input = roleTaskInput(operation.intent, context);
    const inputDigest = digestOf(input);
    const [existing] = await tx
      .select()
      .from(testingTasksTable)
      .where(eq(testingTasksTable.id, taskId));

    if (existing && existing.input_digest !== inputDigest) {
      throw new Error("Testing task input changed");
    }

    if (!existing) {
      await tx.insert(testingTasksTable).values({
        id: taskId,
        operation_id: operationId,
        role,
        child_workflow_id: childWorkflowIdFor(operationId, role),
        attempt_nonce: 1,
        input_digest: inputDigest,
        input,
      });
      await tx.insert(testingDeliveriesTable).values({
        delivery_key: `start:${taskId}`,
        operation_id: operationId,
        task_id: taskId,
        kind: "start",
        acknowledgement: "pending",
      });
      await appendDecision(tx, operationId, `dispatch:${role}`, "dispatch", { taskId, role });
    }

    return {
      taskId,
      attemptNonce: existing?.attempt_nonce ?? 1,
      childWorkflowId: existing?.child_workflow_id ?? childWorkflowIdFor(operationId, role),
      parentRunId: operation.parent_run_id,
      operationId,
      role,
    };
  });
}

async function lockTask(tx: Transaction, taskId: string) {
  const [task] = await tx
    .select()
    .from(testingTasksTable)
    .where(eq(testingTasksTable.id, taskId))
    .for("update");

  if (!task) {
    return undefined;
  }

  const [operation] = await tx
    .select({
      row: testingOperationsTable,
      expired: sql<boolean>`${testingOperationsTable.deadline} <= now()`,
    })
    .from(testingOperationsTable)
    .where(eq(testingOperationsTable.id, task.operation_id));

  return { task, operation: operation!.row, expired: operation!.expired };
}

type Locked = NonNullable<Awaited<ReturnType<typeof lockTask>>>;

function denial(
  locked: Locked | undefined,
  identity: Pick<TestingChildInput, "attemptNonce" | "childWorkflowId">,
): DeniedReason | undefined {
  if (
    !locked ||
    locked.task.attempt_nonce !== identity.attemptNonce ||
    locked.task.child_workflow_id !== identity.childWorkflowId
  ) {
    return "nonce";
  }

  if (locked.operation.finished_at) {
    return "terminal";
  }

  if (locked.operation.cancel_accepted_at) {
    return "cancel_requested";
  }

  return locked.expired ? "deadline" : undefined;
}

export async function claimTask(
  input: TestingChildInput,
): Promise<{ state: "claimed"; task: ClaimedTask } | { state: "denied"; reason: DeniedReason }> {
  const db = await database();

  return db.transaction(async (tx) => {
    const locked = await lockTask(tx, input.taskId);
    const reason = denial(locked, input);

    if (reason || !locked) {
      return { state: "denied", reason: reason ?? "nonce" };
    }

    await tx
      .update(testingDeliveriesTable)
      .set({ acknowledgement: "running", updated_at: sql`now()` })
      .where(
        and(
          eq(testingDeliveriesTable.delivery_key, `start:${input.taskId}`),
          eq(testingDeliveriesTable.acknowledgement, "pending"),
        ),
      );

    return {
      state: "claimed",
      task: {
        intent: locked.operation.intent,
        runtime: locked.operation.runtime,
        deadline: locked.operation.deadline.toISOString(),
        taskInput: locked.task.input,
        context: await roleContextFor(tx, locked.operation),
      },
    };
  });
}

function modelBudget(task: TaskRow, limits: RoleLimits, step: string) {
  const attempts = task.step_attempts[step] ?? 0;

  if ((attempts === 0 && task.model_steps >= limits.maxTurns) || attempts >= MAX_STEP_ATTEMPTS) {
    return undefined;
  }

  return {
    step_attempts: { ...task.step_attempts, [step]: attempts + 1 },
    model_steps: task.model_steps + (attempts === 0 ? 1 : 0),
  };
}

const callCounters = {
  tool: { column: "native_calls", limit: "maxToolCalls" },
  nested: { column: "nested_calls", limit: "maxNestedCalls" },
} as const;

function budgetUpdate(task: TaskRow, limits: RoleLimits, kind: IoKind, step: string) {
  if (kind === "model") {
    return modelBudget(task, limits, step);
  }

  const { column, limit } = callCounters[kind];

  return task[column] < limits[limit]
    ? ({ [column]: task[column] + 1 } as Partial<Pick<TaskRow, typeof column>>)
    : undefined;
}

export async function guardActualIO(input: {
  taskId: string;
  attemptNonce: number;
  childWorkflowId: string;
  kind: IoKind;
  step: string;
  name?: string;
}): Promise<{ state: "allowed" } | { state: "denied"; reason: DeniedReason }> {
  const db = await database();

  return db.transaction(async (tx) => {
    const locked = await lockTask(tx, input.taskId);
    const reason = denial(locked, input);

    if (reason || !locked) {
      return { state: "denied", reason: reason ?? "nonce" };
    }

    const update = budgetUpdate(
      locked.task,
      locked.operation.runtime.limits,
      input.kind,
      input.step,
    );

    if (!update) {
      return { state: "denied", reason: "budget" };
    }

    const activity: TaskActivity =
      input.kind === "model"
        ? { kind: "model", name: null }
        : { kind: "tool", name: input.name ?? null };
    await tx
      .update(testingTasksTable)
      .set({ ...update, activity })
      .where(eq(testingTasksTable.id, input.taskId));

    return { state: "allowed" };
  });
}

function receiptIdFor(taskId: string, attempt: number, slot: string, nativeName: string) {
  return `rcpt-${createHash("sha256").update(`${taskId}\0${attempt}\0${slot}\0${nativeName}`).digest("hex").slice(0, 32)}`;
}

export async function recordReceipt(input: {
  taskId: string;
  attempt: number;
  slot: string;
  nativeName: string;
  route: string;
  input: unknown;
  output: unknown;
  bindings: Record<string, string>;
}): Promise<{ receiptId: string; outputDigest: string; duplicate: boolean }> {
  const id = receiptIdFor(input.taskId, input.attempt, input.slot, input.nativeName);
  const inputDigest = digestOf(input.input);
  const outputDigest = digestOf(input.output);
  const db = await database();
  const [inserted] = await db
    .insert(testingReceiptsTable)
    .values({
      id,
      task_id: input.taskId,
      attempt: input.attempt,
      slot: input.slot,
      native_name: input.nativeName,
      route: input.route,
      input: input.input ?? null,
      output: input.output ?? null,
      input_digest: inputDigest,
      output_digest: outputDigest,
      bindings: input.bindings,
    })
    .onConflictDoNothing()
    .returning({ id: testingReceiptsTable.id });

  if (inserted) {
    return { receiptId: id, outputDigest, duplicate: false };
  }

  const [existing] = await db
    .select()
    .from(testingReceiptsTable)
    .where(eq(testingReceiptsTable.id, id));

  if (existing?.input_digest !== inputDigest || existing.output_digest !== outputDigest) {
    throw new Error("Receipt slot already holds different content");
  }

  return { receiptId: id, outputDigest, duplicate: true };
}

async function listReceipts(db: Executor, taskId: string): Promise<Receipt[]> {
  const rows = await db
    .select()
    .from(testingReceiptsTable)
    .where(eq(testingReceiptsTable.task_id, taskId))
    .orderBy(asc(testingReceiptsTable.created_at), asc(testingReceiptsTable.id));

  return rows.map((row) => ({
    id: row.id,
    slot: row.slot,
    nativeName: row.native_name,
    route: row.route,
    input: row.input,
    output: row.output,
    inputDigest: row.input_digest,
    outputDigest: row.output_digest,
    bindings: row.bindings,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function taskReceipts(taskId: string): Promise<Receipt[]> {
  return listReceipts(await database(), taskId);
}

export async function cancellationRequested(taskId: string): Promise<boolean> {
  const db = await database();

  return db.transaction(async (tx) => {
    const [delivery] = await tx
      .update(testingDeliveriesTable)
      .set({ acknowledgement: "cancel_requested", updated_at: sql`now()` })
      .where(
        and(
          eq(testingDeliveriesTable.delivery_key, `cancel:${taskId}`),
          eq(testingDeliveriesTable.acknowledgement, "pending"),
        ),
      )
      .returning({ key: testingDeliveriesTable.delivery_key });

    if (delivery) {
      return true;
    }

    const [existing] = await tx
      .select({ key: testingDeliveriesTable.delivery_key })
      .from(testingDeliveriesTable)
      .where(eq(testingDeliveriesTable.delivery_key, `cancel:${taskId}`));

    return !!existing;
  });
}

export async function markTaskStopped(taskId: string): Promise<void> {
  const db = await database();
  await db.transaction(async (tx) => {
    await tx
      .update(testingDeliveriesTable)
      .set({ acknowledgement: "stopped", updated_at: sql`now()` })
      .where(
        and(
          eq(testingDeliveriesTable.task_id, taskId),
          inArray(testingDeliveriesTable.acknowledgement, [
            "pending",
            "running",
            "cancel_requested",
          ]),
        ),
      );
    await tx
      .update(testingTasksTable)
      .set({ activity: null })
      .where(eq(testingTasksTable.id, taskId));
  });
}

async function lockOperation(tx: Transaction, operationId: string) {
  const [operation] = await tx
    .select()
    .from(testingOperationsTable)
    .where(eq(testingOperationsTable.id, operationId))
    .for("update");

  if (!operation) {
    throw new Error(`Unknown testing operation ${operationId}`);
  }

  return operation;
}

async function artifactView(db: Executor, threadId: string, ref: string): Promise<ArtifactView> {
  const artifact = await loadArtifact(db, threadId, ref);

  if (!artifact) {
    throw new Error(`Missing artifact ${ref}`);
  }

  return { ref: artifact.ref, kind: artifact.kind, payload: artifact.payload };
}

export type Acceptance =
  | { state: "accepted"; artifact: ArtifactView }
  | { state: "rejected"; reasonCode: RoleFailureCode; issues: string[] }
  | { state: "cancelled" };

async function existingAcceptance(
  tx: Transaction,
  operation: OperationRow,
  taskId: string,
): Promise<Acceptance | undefined> {
  const prior = await decisionPayload<TaskResult>(tx, operation.id, `task_result:${taskId}`);

  if (!prior) {
    return undefined;
  }

  if (prior.state === "ready") {
    return { state: "accepted", artifact: await artifactView(tx, operation.thread_id, prior.ref) };
  }

  return prior.state === "failed"
    ? { state: "rejected", reasonCode: prior.reasonCode, issues: prior.issues }
    : { state: "cancelled" };
}

export async function acceptRoleCompletion(input: {
  operationId: string;
  taskId: string;
  finalText: string | null;
}): Promise<Acceptance> {
  const db = await database();

  return db.transaction(async (tx) => {
    const operation = await lockOperation(tx, input.operationId);
    const prior = await existingAcceptance(tx, operation, input.taskId);

    if (prior) {
      return prior;
    }

    if (operation.cancel_accepted_at) {
      await appendDecision(tx, operation.id, `task_result:${input.taskId}`, "task_result", {
        state: "cancelled",
      } satisfies TaskResult);

      return { state: "cancelled" };
    }

    if (operation.finished_at) {
      throw new Error("Testing operation is already finished");
    }

    const context = await roleContextFor(tx, operation);
    const evaluation = evaluateRole(context, {
      finalText: input.finalText,
      receipts: await listReceipts(tx, input.taskId),
    });

    if (!evaluation.ok) {
      const result: TaskResult = {
        state: "failed",
        reasonCode: failureCodeFor(operation.role),
        issues: clipIssues(evaluation.issues, MAX_FAILURE_ISSUES, MAX_FAILURE_ISSUE_CHARS),
      };
      await appendDecision(tx, operation.id, `task_result:${input.taskId}`, "task_result", result);

      return { state: "rejected", reasonCode: result.reasonCode, issues: result.issues };
    }

    const payloadDigest = digestOf(evaluation.value);
    const ref = artifactRefFor(operation.id, operation.role, payloadDigest);
    const dependency = dependencyOf(operation.intent);
    await tx
      .insert(testingArtifactsTable)
      .values({
        ref,
        thread_id: operation.thread_id,
        operation_id: operation.id,
        role: operation.role,
        kind: artifactKinds[operation.role],
        scope_digest: digestOf({ threadId: operation.thread_id, intent: operation.intent }),
        payload_digest: payloadDigest,
        metadata: {
          dependsOn: dependency?.ref ?? null,
          profile: operation.runtime.profile,
          registration: operation.runtime.registration,
        },
        payload: evaluation.value,
      })
      .onConflictDoNothing();
    await tx
      .insert(testingPinsTable)
      .values({ operation_id: operation.id, ref })
      .onConflictDoNothing();
    await appendDecision(tx, operation.id, `task_result:${input.taskId}`, "task_result", {
      state: "ready",
      ref,
    } satisfies TaskResult);
    await appendDecision(tx, operation.id, `satisfied:${operation.role}`, "satisfied", { ref });

    return {
      state: "accepted",
      artifact: { ref, kind: artifactKinds[operation.role], payload: evaluation.value },
    };
  });
}

export async function recordTaskFailure(input: {
  operationId: string;
  taskId: string;
  reasonCode: RoleFailureCode;
  issues: readonly string[];
}): Promise<void> {
  const db = await database();
  await db.transaction(async (tx) => {
    const operation = await lockOperation(tx, input.operationId);
    const result: TaskResult = operation.cancel_accepted_at
      ? { state: "cancelled" }
      : {
          state: "failed",
          reasonCode: input.reasonCode,
          issues: clipIssues(input.issues, MAX_FAILURE_ISSUES, MAX_FAILURE_ISSUE_CHARS),
        };
    await appendDecision(tx, operation.id, `task_result:${input.taskId}`, "task_result", result);
  });
}

async function closingOutcome(tx: Transaction, operation: OperationRow): Promise<OperationOutcome> {
  if (operation.cancel_accepted_at) {
    return "cancelled";
  }

  const result = await decisionPayload<TaskResult>(
    tx,
    operation.id,
    `task_result:${taskIdFor(operation.id, operation.role)}`,
  );

  if (result?.state === "ready") {
    return "satisfied";
  }

  const [{ expired }] = (await tx
    .select({ expired: sql<boolean>`${testingOperationsTable.deadline} <= now()` })
    .from(testingOperationsTable)
    .where(eq(testingOperationsTable.id, operation.id))) as [{ expired: boolean }];

  return expired ? "deadline" : "failed";
}

export async function closeOperation(operationId: string): Promise<OperationOutcome> {
  const db = await database();

  return db.transaction(async (tx) => {
    const operation = await lockOperation(tx, operationId);

    if (operation.finished_at && operation.terminal_outcome) {
      return operation.terminal_outcome;
    }

    const outcome = await closingOutcome(tx, operation);
    await tx
      .update(testingOperationsTable)
      .set({ finished_at: sql`now()`, terminal_outcome: outcome })
      .where(eq(testingOperationsTable.id, operationId));
    await appendDecision(tx, operationId, "terminal", "terminal", { outcome });

    return outcome;
  });
}

async function addCancelDeliveries(tx: Transaction, operationId: string): Promise<void> {
  const starts = await tx
    .select()
    .from(testingDeliveriesTable)
    .where(
      and(
        eq(testingDeliveriesTable.operation_id, operationId),
        eq(testingDeliveriesTable.kind, "start"),
      ),
    );

  for (const start of starts) {
    if (start.acknowledgement === "stopped" || start.acknowledgement === "quiet") {
      continue;
    }

    await tx
      .insert(testingDeliveriesTable)
      .values({
        delivery_key: `cancel:${start.task_id}`,
        operation_id: operationId,
        task_id: start.task_id,
        kind: "cancel",
        acknowledgement: "pending",
      })
      .onConflictDoNothing();
  }
}

export async function requestCancel(
  operationId: string,
  threadId: string,
): Promise<{ state: "cancel_requested" | "finished" }> {
  const db = await database();

  return db.transaction(async (tx) => {
    const [operation] = await tx
      .select()
      .from(testingOperationsTable)
      .where(
        and(
          eq(testingOperationsTable.id, operationId),
          eq(testingOperationsTable.thread_id, threadId),
        ),
      )
      .for("update");

    if (!operation) {
      throw new RunRequestError(404, "Unknown testing run");
    }

    if (operation.finished_at) {
      return { state: "finished" };
    }

    if (!operation.cancel_accepted_at) {
      await tx
        .update(testingOperationsTable)
        .set({ cancel_accepted_at: sql`now()` })
        .where(eq(testingOperationsTable.id, operationId));
    }

    await appendDecision(tx, operationId, "cancel", "cancel", {});
    await addCancelDeliveries(tx, operationId);

    return { state: "cancel_requested" };
  });
}

export async function ensureCancelDeliveries(operationId: string): Promise<void> {
  const db = await database();
  await db.transaction((tx) => addCancelDeliveries(tx, operationId));
}

export async function settleDeliveries(operationId: string): Promise<boolean> {
  const db = await database();

  return db.transaction(async (tx) => {
    const deliveries = await tx
      .select()
      .from(testingDeliveriesTable)
      .where(eq(testingDeliveriesTable.operation_id, operationId))
      .for("update");

    if (deliveries.some((d) => d.acknowledgement !== "stopped" && d.acknowledgement !== "quiet")) {
      return false;
    }

    await tx
      .update(testingDeliveriesTable)
      .set({ acknowledgement: "quiet", updated_at: sql`now()` })
      .where(
        and(
          eq(testingDeliveriesTable.operation_id, operationId),
          eq(testingDeliveriesTable.acknowledgement, "stopped"),
        ),
      );

    return true;
  });
}

async function startDelivery(db: Executor, taskId: string) {
  const [delivery] = await db
    .select()
    .from(testingDeliveriesTable)
    .where(eq(testingDeliveriesTable.delivery_key, `start:${taskId}`));

  return delivery;
}

function taskStatus(
  result: TaskResult | undefined,
  acknowledgement: string | undefined,
): TaskStatus {
  if (result) {
    return result.state;
  }

  return acknowledgement === "pending" ? "queued" : "running";
}

function failureOf(result: TaskResult | undefined) {
  return result?.state === "failed"
    ? { reasonCode: result.reasonCode, issues: result.issues }
    : { reasonCode: null, issues: [] };
}

function activityOf(task: TaskRow, result: TaskResult | undefined, finished: boolean) {
  return result || finished ? null : (task.activity ?? null);
}

function taskView(
  task: TaskRow,
  result: TaskResult | undefined,
  acknowledgement: string | undefined,
  finished: boolean,
): NonNullable<TestView["task"]> {
  return {
    status: taskStatus(result, acknowledgement),
    ...failureOf(result),
    activity: activityOf(task, result, finished),
    modelSteps: task.model_steps,
    toolCalls: task.native_calls + task.nested_calls,
  };
}

async function buildView(
  db: Executor,
  operation: OperationRow,
): Promise<Omit<TestView, "version">> {
  const taskId = taskIdFor(operation.id, operation.role);
  const [task] = await db.select().from(testingTasksTable).where(eq(testingTasksTable.id, taskId));
  const result = await decisionPayload<TaskResult>(db, operation.id, `task_result:${taskId}`);
  const delivery = await startDelivery(db, taskId);
  const finished = operation.finished_at !== null;

  return {
    operationId: operation.id,
    threadId: operation.thread_id,
    requestKey: operation.request_key,
    role: operation.role,
    summary: operation.intent.summary,
    state: finished ? "finished" : "running",
    cancelRequested: operation.cancel_accepted_at !== null,
    outcome: operation.terminal_outcome,
    task: task ? taskView(task, result, delivery?.acknowledgement, finished) : null,
    artifact:
      result?.state === "ready" ? await artifactView(db, operation.thread_id, result.ref) : null,
  };
}

export async function publishOperation(operationId: string): Promise<TestView> {
  const db = await database();

  return db.transaction(async (tx) => {
    const operation = await lockOperation(tx, operationId);
    const view = await buildView(tx, operation);
    const digest = digestOf(view);
    const [last] = await tx
      .select()
      .from(testingPublicationsTable)
      .where(eq(testingPublicationsTable.operation_id, operationId))
      .orderBy(desc(testingPublicationsTable.version))
      .limit(1);

    if (last?.digest === digest) {
      return last.view;
    }

    const published: TestView = { ...view, version: (last?.version ?? 0) + 1 };
    await tx.insert(testingPublicationsTable).values({
      operation_id: operationId,
      version: published.version,
      digest,
      view: published,
    });
    await appendRunEvent(
      tx,
      operation.parent_run_id,
      `testing:${operationId}:v${published.version}`,
      {
        type: EventType.CUSTOM,
        name: testingProjectionEventName,
        value: published,
        timestamp: Date.now(),
      },
    );

    return published;
  });
}

export async function operationView(operationId: string, threadId: string): Promise<TestView> {
  const db = await database();
  const [operation] = await db
    .select({ id: testingOperationsTable.id })
    .from(testingOperationsTable)
    .where(
      and(
        eq(testingOperationsTable.id, operationId),
        eq(testingOperationsTable.thread_id, threadId),
      ),
    );

  if (!operation) {
    throw new RunRequestError(404, "Unknown testing run");
  }

  return publishOperation(operationId);
}

export async function publishedTasks(threadId: string): Promise<TestView[]> {
  const db = await database();
  const rows = await db
    .selectDistinctOn([testingPublicationsTable.operation_id], {
      view: testingPublicationsTable.view,
      createdAt: testingOperationsTable.created_at,
    })
    .from(testingPublicationsTable)
    .innerJoin(
      testingOperationsTable,
      eq(testingOperationsTable.id, testingPublicationsTable.operation_id),
    )
    .where(eq(testingOperationsTable.thread_id, threadId))
    .orderBy(testingPublicationsTable.operation_id, desc(testingPublicationsTable.version));

  return rows
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
    .map((row) => row.view);
}

export async function operationResult(operationId: string) {
  const db = await database();
  const operation = await operationRow(db, operationId);
  const view = await buildView(db, operation);

  return {
    runId: operationId,
    state: "finished" as const,
    outcome: operation.terminal_outcome,
    task: {
      role: operation.role,
      summary: operation.intent.summary,
      origin: { parentRunId: operation.parent_run_id, requestKey: operation.request_key },
      result: view.artifact,
    },
    progress: view.task
      ? {
          status: view.task.status,
          ...(view.task.reasonCode ? { reasonCode: view.task.reasonCode } : {}),
          ...(view.task.issues.length ? { issues: view.task.issues } : {}),
        }
      : { status: "failed" as const, reasonCode: "child_failed" },
  };
}

export async function openOperations() {
  const db = await database();

  return db
    .select({
      id: testingOperationsTable.id,
      cancelled: isNotNull(testingOperationsTable.cancel_accepted_at),
    })
    .from(testingOperationsTable)
    .where(isNull(testingOperationsTable.finished_at))
    .orderBy(asc(testingOperationsTable.created_at));
}
