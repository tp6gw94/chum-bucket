import { setTimeout as delay } from "node:timers/promises";
import { DBOS, DBOSClient, type WorkflowHandle } from "@dbos-inc/dbos-sdk";
import type { ModelCall } from "./model-turn";
import type { AcceptedRun } from "./run-store";
import {
  acceptRoleCompletion,
  admitAttachedTesting,
  database,
  closeTesting,
  publishProjection,
  readTestingExecution,
  recordRoleFailure,
  reserveRoleTask,
} from "./run-store";
import {
  abortTestingTransports,
  acknowledgeDrain,
  testingTransportState,
  type TestingChildInput,
  type TestingChildResult,
  type testingChildWorkflow,
} from "./testing-child";
import {
  TESTING_WORKFLOW_VERSION,
  ensureTestingCancelDeliveries,
  listPendingTestingOperations,
  readStartCancelDeliveries,
  type RoleFailureCode,
  type TestingExecution,
} from "./testing-store";
import { rootOutcome } from "./testing-policy";

type ChildSpec = TestingChildInput;
type ChildStartResult = TestingChildResult | Readonly<{ state: "unstarted" }>;

const DURABLE_RETRY = {
  retriesAllowed: true,
  maxAttempts: 3,
  intervalSeconds: 0.2,
  backoffRate: 2,
};

const FAILURE_CODES = new Map<string, RoleFailureCode>([
  ["cancel_requested", "cancelled"],
  ["cancelled", "cancelled"],
  ["deadline", "timed_out"],
  ["timed_out", "timed_out"],
  ["budget", "budget"],
  ["missing", "missing"],
  ["proposal_rejected", "proposal_rejected"],
  ["source_reads_incomplete", "source_reads_incomplete"],
  ["nonce", "denied"],
  ["scope", "denied"],
  ["terminal", "denied"],
  ["denied", "denied"],
]);

function failureCode(reason: string): RoleFailureCode {
  return FAILURE_CODES.get(reason) ?? "child_failed";
}

async function settleChild(
  ownerRunId: string,
  child: ChildSpec,
  result: TestingChildResult | null,
) {
  const execution = await readTestingExecution(ownerRunId, child.operationId);

  if (execution.cancelRequested) {
    await recordRoleFailure(ownerRunId, child.taskId, "cancelled").catch(() => undefined);

    return;
  }

  if (!result || result.state !== "ready") {
    await recordRoleFailure(
      ownerRunId,
      child.taskId,
      failureCode(result?.reason ?? "child_failed"),
      result?.state === "failed" ? result.issues : undefined,
    );

    return;
  }

  try {
    await acceptRoleCompletion(ownerRunId, child.taskId, result.completion);
  } catch {
    await recordRoleFailure(ownerRunId, child.taskId, "proposal_rejected");
  }
}

async function enqueueChild(
  client: DBOSClient,
  child: ChildSpec,
): Promise<WorkflowHandle<TestingChildResult> | null> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await client.enqueue<typeof testingChildWorkflow>(
        {
          queueName: "testing-delegation",
          workflowName: TESTING_WORKFLOW_VERSION,
          workflowID: child.childWorkflowId,
          appVersion: DBOS.applicationVersion,
        },
        child,
      );
    } catch {
      if (attempt < 2) {
        await delay(200);
        continue;
      }

      const handle = client.retrieveWorkflow<TestingChildResult>(child.childWorkflowId);

      return (await handle.getStatus()) ? handle : null;
    }
  }
}

async function joinChild(
  handle: WorkflowHandle<TestingChildResult>,
  child: ChildSpec,
): Promise<TestingChildResult> {
  try {
    return await handle.getResult();
  } catch (error) {
    const status = await handle.getStatus();

    if (status?.status !== "ERROR") {
      throw error;
    }

    await abortTestingTransports([child.childWorkflowId]);

    return { state: "failed", reason: "child_failed" };
  }
}

async function runChild(child: ChildSpec): Promise<ChildStartResult> {
  return DBOS.runStep(
    async () => {
      await DBOS.registerQueue("testing-delegation");
      const db = await database();
      const client = await DBOSClient.create({
        systemDatabaseUrl: process.env.DATABASE_URL!,
        systemDatabasePool: db.$client,
        applicationName: "chum-bucket-chat",
      });

      try {
        const handle = await enqueueChild(client, child);

        return handle ? await joinChild(handle, child) : { state: "unstarted" };
      } finally {
        await client.destroy();
      }
    },
    { name: `${child.taskId}:start-join`, ...DURABLE_RETRY },
  );
}

async function proveQuiet(execution: TestingExecution): Promise<boolean> {
  const deliveries = await readStartCancelDeliveries(execution.operationId);

  return execution.tasks.every((task) => {
    if (testingTransportState(task.frame.childWorkflowId) === "live") {
      return false;
    }

    const start = deliveries.find(
      (delivery) => delivery.taskId === task.frame.taskId && delivery.kind === "start",
    );
    const cancel = deliveries.find(
      (delivery) => delivery.taskId === task.frame.taskId && delivery.kind === "cancel",
    );

    return start?.acknowledgement === "quiet" && (!cancel || cancel.acknowledgement === "stopped");
  });
}

export async function delegateTask(run: AcceptedRun, call: ModelCall) {
  if (run.side) {
    throw new Error("Side chat cannot delegate tasks");
  }

  const admission = await DBOS.runStep(() => admitAttachedTesting(run, call.id, call.input), {
    name: `delegate-v2:admit:${call.id}`,
  });
  const prefix = admission.operationId;
  const child = await DBOS.runStep(
    async () => {
      const execution = await readTestingExecution(run.runId, prefix);
      const task = execution.intent.task;

      if (!task) {
        throw new Error("Legacy testing operation requires maintenance");
      }

      if (execution.finished) {
        await publishProjection(run.runId, prefix);

        return null;
      }

      const frame = await reserveRoleTask(run.runId, prefix, task.input.role, task.input);
      await publishProjection(run.runId, prefix);

      return frame
        ? {
            taskId: frame.taskId,
            attemptNonce: frame.attemptNonce,
            childWorkflowId: frame.childWorkflowId,
            parentRunId: run.runId,
            operationId: prefix,
            role: task.input.role,
          }
        : null;
    },
    { name: `${prefix}:reserve`, ...DURABLE_RETRY },
  );

  if (child) {
    const result = await runChild(child);

    await DBOS.runStep(() => acknowledgeDrain(child), {
      name: `${prefix}:drain`,
      ...DURABLE_RETRY,
    });
    await DBOS.runStep(
      () => settleChild(run.runId, child, result.state === "unstarted" ? null : result),
      { name: `${prefix}:settle`, ...DURABLE_RETRY },
    );
  }

  await DBOS.runStep(
    async () => {
      for (;;) {
        const execution = await readTestingExecution(run.runId, prefix);

        if (execution.finished || (await proveQuiet(execution))) {
          return;
        }

        if (child) {
          await acknowledgeDrain(child);
        }

        if (execution.cancelRequested) {
          await abortTestingTransports(execution.tasks.map((task) => task.frame.childWorkflowId));
        }

        await publishProjection(run.runId, prefix);
        await delay(200);
      }
    },
    { name: `${prefix}:quiet`, ...DURABLE_RETRY },
  );

  return DBOS.runStep(
    async () => {
      const execution = await readTestingExecution(run.runId, prefix);

      const view = await closeTesting(run.runId, prefix, rootOutcome(execution, Date.now()));

      return {
        runId: view.runId,
        state: view.state,
        task: view.task,
        progress: view.task ? view.progress.rows[view.task.role] : null,
      };
    },
    { name: `${prefix}:close`, ...DURABLE_RETRY },
  );
}

export async function assertDelegationCutover(): Promise<void> {
  const pending = await listPendingTestingOperations();

  if (pending.some((operation) => !operation.delegated)) {
    throw new Error(
      "Legacy testing operations are active. Maintenance is required before delegation cutover; no records were changed.",
    );
  }
}

export async function reconcileTestingOperations(): Promise<void> {
  const pending = await listPendingTestingOperations();

  for (const operation of pending) {
    if (!operation.delegated) {
      continue;
    }

    if (operation.cancelRequested) {
      await ensureTestingCancelDeliveries(operation.operationId);
    }

    await publishProjection(operation.parentRunId, operation.operationId).catch(() => undefined);
  }
}
