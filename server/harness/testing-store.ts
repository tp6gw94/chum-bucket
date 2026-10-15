import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";
import type {
  Artifact,
  DelegationInput,
  RoleCompletion,
  RoleTask,
  Receipt,
} from "../../shared/testing";
import { agentRegistry } from "./agents";
import { digestOf, validateCandidate } from "./testing-domain";
import { and, eq, isNull } from "drizzle-orm";
import {
  testingOperationsTable,
  testingTasksTable,
  testingArtifactsTable,
  testingReceiptsTable,
} from "../db/schema";
import { database } from "./run-store";
import type { DelegationResult } from "./testing-run";

export const TESTING_WORKFLOW_VERSION = "testing-child-v1";
export type TestingInput = {
  operationId: string;
  childWorkflowId: string;
  parentRunId: string;
  threadId: string;
  requestKey: string;
  intent: DelegationInput;
  task: RoleTask;
  deadline: number;
  profile: string;
  model: typeof import("./agents").AGENT_MODEL;
  dependencies: string[];
};
export type TestingOutput = {
  inputDigest: string;
  completion: RoleCompletion;
  artifact: Artifact | null;
  receipts: Receipt[];
  task: RoleTask;
  proposalDigest?: string;
};

export function operationIdFor(parentRunId: string, callId: string): string {
  return `testing-${digestOf(`${parentRunId}\0${callId}`).slice(0, 32)}`;
}

export function workflowIdFor(operationId: string, role: DelegationInput["role"]): string {
  return `testing-${role}-${digestOf(`${TESTING_WORKFLOW_VERSION}\0${operationId}\0${role}`).slice(0, 24)}`;
}

export function artifactFor(input: TestingInput, payload: Artifact["payload"]): Artifact {
  const agent = agentRegistry[input.intent.role];
  const digest = digestOf(payload);

  return {
    ref: `art-${input.childWorkflowId}-${digest.slice(0, 40)}`,
    threadId: input.threadId,
    role: input.intent.role,
    kind: agent.artifact,
    digest,
    payload,
    metadata: {
      profile: input.profile,
      registration: agent.registration,
      dependencies: input.dependencies,
    },
  };
}

export async function withTestingClient<T>(work: (client: DBOSClient) => Promise<T>): Promise<T> {
  const client = await DBOSClient.create({
    systemDatabaseUrl: process.env.DATABASE_URL!,
    applicationName: "chum-bucket-chat",
  });

  try {
    return await work(client);
  } finally {
    await client.destroy();
  }
}

export async function loadArtifact(
  ref: string,
  threadId: string,
  kind: "requirements" | "plan",
): Promise<Artifact> {
  const db = await database();
  const [row] = await db
    .select()
    .from(testingArtifactsTable)
    .where(and(eq(testingArtifactsTable.ref, ref), eq(testingArtifactsTable.thread_id, threadId)));
  const artifact = row?.payload;
  const [owner] = row
    ? await db
        .select({
          outcome: testingOperationsTable.outcome,
          cancelled: testingOperationsTable.cancel_accepted_at,
        })
        .from(testingTasksTable)
        .innerJoin(
          testingOperationsTable,
          eq(testingTasksTable.operation_id, testingOperationsTable.id),
        )
        .where(eq(testingTasksTable.id, row.task_id))
    : [];

  if (owner?.outcome !== "succeeded" || owner.cancelled) {
    throw new Error("Artifact producer did not complete successfully");
  }

  if (
    !artifact ||
    artifact.kind !== kind ||
    artifact.digest !== digestOf(artifact.payload) ||
    artifact.metadata.profile !== agentRegistry[artifact.role].profile
  ) {
    throw new Error(
      "Artifact is missing, outside this thread, incompatible, or has the wrong kind",
    );
  }

  return artifact;
}

export async function assertChildIdentity(input: TestingInput) {
  if (DBOS.workflowID && DBOS.workflowID !== input.childWorkflowId) {
    throw new Error("Child workflow scope mismatch");
  }

  if (
    input.childWorkflowId !== workflowIdFor(input.operationId, input.intent.role) ||
    input.profile !== agentRegistry[input.intent.role].profile ||
    input.model !== agentRegistry[input.intent.role].model
  ) {
    throw new Error("Incompatible child workflow input");
  }

  if (Date.now() >= input.deadline) {
    throw new Error("deadline");
  }
}

type Transaction = Parameters<
  Parameters<Awaited<ReturnType<typeof database>>["transaction"]>[0]
>[0];

async function locked(tx: Transaction, input: TestingInput) {
  const [operation] = await tx
    .select()
    .from(testingOperationsTable)
    .where(eq(testingOperationsTable.id, input.operationId))
    .for("update");
  const [task] = await tx
    .select()
    .from(testingTasksTable)
    .where(eq(testingTasksTable.id, input.childWorkflowId))
    .for("update");

  if (
    !operation ||
    !task ||
    operation.input_digest !== digestOf(input) ||
    task.input_digest !== digestOf(input)
  ) {
    throw new Error("scope");
  }

  return { operation, task };
}

function live(operation: typeof testingOperationsTable.$inferSelect) {
  if (operation.finished_at) {
    throw new Error("terminal");
  }

  if (operation.cancel_accepted_at) {
    throw new Error("cancel_requested");
  }

  if (operation.deadline.getTime() <= Date.now()) {
    throw new Error("deadline");
  }
}

export async function admitOperation(input: TestingInput): Promise<TestingInput> {
  const db = await database();
  const digest = digestOf(input);
  await db
    .insert(testingOperationsTable)
    .values({
      id: input.operationId,
      parent_run_id: input.parentRunId,
      thread_id: input.threadId,
      request_key: input.requestKey,
      input,
      input_digest: digest,
      deadline: new Date(input.deadline),
    })
    .onConflictDoNothing();
  const [row] = await db
    .select()
    .from(testingOperationsTable)
    .where(eq(testingOperationsTable.id, input.operationId));

  if (!row || digestOf({ ...row.input, deadline: input.deadline }) !== digest) {
    throw new Error("Delegation input conflict");
  }

  return row.input;
}

export async function reserveTask(input: TestingInput) {
  const db = await database();
  await db
    .insert(testingTasksTable)
    .values({
      id: input.childWorkflowId,
      child_workflow_id: input.childWorkflowId,
      operation_id: input.operationId,
      input_digest: digestOf(input),
    })
    .onConflictDoNothing();
  const [task] = await db
    .select()
    .from(testingTasksTable)
    .where(eq(testingTasksTable.id, input.childWorkflowId));

  if (!task || task.input_digest !== digestOf(input)) {
    throw new Error("Task input conflict");
  }
}

function nextModelAttempts(
  input: TestingInput,
  task: typeof testingTasksTable.$inferSelect,
  step: string,
) {
  const attempts = { ...task.model_attempts };
  const previous = attempts[step] ?? 0;

  if (
    previous >= 3 ||
    (previous === 0 && Object.keys(attempts).length >= agentRegistry[input.intent.role].maxTurns)
  ) {
    throw new Error("budget");
  }

  attempts[step] = previous + 1;

  return { model_attempts: attempts };
}

function nextToolCount(
  input: TestingInput,
  task: typeof testingTasksTable.$inferSelect,
  kind: "tool" | "nested",
) {
  const nested = kind === "nested";
  const count = nested ? task.nested_calls : task.native_calls;
  const max = nested ? 8 : input.intent.role === "ac" || input.intent.role === "ui" ? 60 : 24;

  if (count >= max) {
    throw new Error("budget");
  }

  return nested ? { nested_calls: count + 1 } : { native_calls: count + 1 };
}

export async function guardActualIO(
  input: TestingInput,
  kind: "model" | "tool" | "nested",
  step: string,
) {
  const db = await database();
  await db.transaction(async (tx) => {
    const { operation, task } = await locked(tx, input);
    live(operation);

    if (task.settled) {
      throw new Error("Testing receipt fence is closed");
    }

    const update =
      kind === "model" ? nextModelAttempts(input, task, step) : nextToolCount(input, task, kind);
    await tx.update(testingTasksTable).set(update).where(eq(testingTasksTable.id, task.id));
  });
}

export async function readReceipts(taskId: string): Promise<Receipt[]> {
  const db = await database();
  const rows = await db
    .select()
    .from(testingReceiptsTable)
    .where(eq(testingReceiptsTable.task_id, taskId));

  return rows
    .map((row) => row.payload)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.id.localeCompare(b.id));
}

export async function appendReceipt(input: TestingInput, receipt: Receipt) {
  const db = await database();
  await db.transaction(async (tx) => {
    const { operation, task } = await locked(tx, input);
    live(operation);

    if (task.settled) {
      throw new Error("Testing receipt fence is closed");
    }

    if (receipt.taskId !== task.id || receipt.outputDigest !== digestOf(receipt.output)) {
      throw new Error("Invalid receipt binding or digest");
    }

    const [previous] = await tx
      .select()
      .from(testingReceiptsTable)
      .where(eq(testingReceiptsTable.id, receipt.id));

    if (previous) {
      if (
        digestOf(previous.payload.input) !== digestOf(receipt.input) ||
        previous.payload.outputDigest !== receipt.outputDigest ||
        previous.payload.name !== receipt.name
      ) {
        throw new Error("Receipt conflict");
      }

      return;
    }

    await tx
      .insert(testingReceiptsTable)
      .values({ id: receipt.id, task_id: task.id, payload: receipt });
  });
}

function completionState(
  completion: RoleCompletion,
  operation: typeof testingOperationsTable.$inferSelect,
): RoleCompletion {
  if (operation.cancel_accepted_at) {
    return { ...completion, state: "failed", reason: "cancelled", findings: null };
  }

  if (Date.now() >= operation.deadline.getTime()) {
    return { ...completion, state: "failed", reason: "deadline", findings: null };
  }

  return completion;
}

function acceptedOutput(
  input: TestingInput,
  output: TestingOutput,
  receipts: Receipt[],
  operation: typeof testingOperationsTable.$inferSelect,
): TestingOutput {
  const validated = validateCandidate(
    input.intent.role,
    output.completion.candidate,
    input.intent,
    input.task,
    receipts,
  );
  let completion = completionState(output.completion, operation);

  if (!validated.valid && completion.state === "ready") {
    completion = {
      ...completion,
      state: "failed",
      reason: "proposal_rejected",
      issues: validated.issues.slice(0, 8),
    };
  }

  const qa = input.intent.role === "ac" || input.intent.role === "ui";
  const artifact =
    validated.valid && (completion.state === "ready" || qa)
      ? artifactFor(input, validated.payload)
      : null;

  return { ...output, completion, artifact, receipts, proposalDigest: digestOf(output.completion) };
}

export async function acceptCompletion(
  input: TestingInput,
  output: TestingOutput,
): Promise<TestingOutput> {
  const db = await database();

  return db.transaction(async (tx) => {
    const { operation, task } = await locked(tx, input);

    if (output.inputDigest !== digestOf(input)) {
      throw new Error("Child result scope mismatch");
    }

    if (task.settled) {
      if (task.settled.proposalDigest !== digestOf(output.completion)) {
        throw new Error("Completion conflict");
      }

      return task.settled;
    }

    const rows = await tx
      .select()
      .from(testingReceiptsTable)
      .where(eq(testingReceiptsTable.task_id, task.id));
    const receipts = rows.map((row) => row.payload);
    const accepted = acceptedOutput(input, output, receipts, operation);
    const artifact = accepted.artifact;

    if (artifact) {
      await tx.insert(testingArtifactsTable).values({
        ref: artifact.ref,
        thread_id: input.threadId,
        task_id: task.id,
        payload: artifact,
      });
    }

    await tx
      .update(testingTasksTable)
      .set({ settled: accepted })
      .where(eq(testingTasksTable.id, task.id));

    return accepted;
  });
}

export async function cancellationRequested(operationId: string): Promise<boolean> {
  const db = await database();
  const [row] = await db
    .select({ cancelled: testingOperationsTable.cancel_accepted_at })
    .from(testingOperationsTable)
    .where(eq(testingOperationsTable.id, operationId));

  return !!row?.cancelled;
}

export async function closeOperation(
  input: TestingInput,
  result: DelegationResult,
): Promise<DelegationResult> {
  const db = await database();

  return db.transaction(async (tx) => {
    const { operation } = await locked(tx, input);

    if (operation.result) {
      return operation.result;
    }

    if (operation.cancel_accepted_at || Date.now() >= input.deadline) {
      result = {
        ...result,
        progress: {
          state: "failed",
          reasonCode: operation.cancel_accepted_at ? "cancelled" : "deadline",
        },
        task: {
          ...result.task,
          result: null,
          ...(result.task.version === 3 ? { findings: null } : {}),
        },
      };
    }

    await tx
      .update(testingOperationsTable)
      .set({
        finished_at: new Date(),
        outcome: operation.cancel_accepted_at
          ? "cancelled"
          : result.progress.state === "completed"
            ? "succeeded"
            : "failed",
        result,
      })
      .where(eq(testingOperationsTable.id, input.operationId));

    return result;
  });
}

export async function cancelOperation(operationId: string, threadId: string) {
  const db = await database();
  const rows = await db
    .update(testingOperationsTable)
    .set({ cancel_accepted_at: new Date() })
    .where(
      and(
        eq(testingOperationsTable.id, operationId),
        eq(testingOperationsTable.thread_id, threadId),
        isNull(testingOperationsTable.finished_at),
        isNull(testingOperationsTable.cancel_accepted_at),
      ),
    )
    .returning({ id: testingOperationsTable.id });

  return rows.length > 0;
}
