import { setTimeout as delay } from "node:timers/promises";
import { DBOS } from "@dbos-inc/dbos-sdk";
import type { ModelCall } from "./model-turn";
import type { AcceptedRun } from "./run-store";
import { TESTING_QUEUE, testingChildWorkflow, type ChildResult } from "./testing-child";
import {
  acceptRoleCompletion,
  admitOperation,
  closeOperation,
  markTaskStopped,
  operationResult,
  publishOperation,
  recordTaskFailure,
  reserveTask,
  settleDeliveries,
  type TestingChildInput,
} from "./testing-store";

const QUIET_POLL_MS = 200;

export class DelegationRejected extends Error {
  constructor(
    message: string,
    readonly decisions?: unknown[],
  ) {
    super(message);
  }
}

async function startJoin(child: TestingChildInput): Promise<ChildResult> {
  const handle = await DBOS.startWorkflow(testingChildWorkflow, {
    workflowID: child.childWorkflowId,
    queueName: TESTING_QUEUE,
  })(child);

  try {
    return await handle.getResult();
  } catch (error) {
    return {
      state: "failed",
      reason: "child_failed",
      issues: [error instanceof Error ? error.message.slice(0, 240) : "Child workflow failed"],
    };
  }
}

async function settle(child: TestingChildInput, result: ChildResult): Promise<void> {
  if (result.state === "ready") {
    await acceptRoleCompletion({
      operationId: child.operationId,
      taskId: child.taskId,
      finalText: result.finalText,
    });

    return;
  }

  await recordTaskFailure({
    operationId: child.operationId,
    taskId: child.taskId,
    reasonCode:
      result.state === "failed"
        ? result.reason
        : result.reason === "cancel_requested"
          ? "cancelled"
          : "denied",
    issues: result.state === "failed" ? result.issues : [],
  });
}

async function quiet(child: TestingChildInput): Promise<void> {
  for (;;) {
    await markTaskStopped(child.taskId);

    if (await settleDeliveries(child.operationId)) {
      return;
    }

    await publishOperation(child.operationId);
    await delay(QUIET_POLL_MS);
  }
}

export async function delegateTask(run: AcceptedRun, call: ModelCall) {
  const admitted = await DBOS.runStep(
    () =>
      admitOperation({
        parentRunId: run.runId,
        threadId: run.threadId,
        requestKey: call.id,
        raw: call.input,
      }),
    { name: `delegate-v2:admit:${call.id}` },
  );

  if (admitted.state === "rejected") {
    throw new DelegationRejected(admitted.message, admitted.decisions);
  }

  const operationId = admitted.operationId;
  const child = await DBOS.runStep(() => reserveTask(operationId), {
    name: `${operationId}:reserve`,
  });
  await DBOS.runStep(() => publishOperation(operationId).then(() => undefined), {
    name: `${operationId}:publish`,
  });
  const result = await startJoin(child);
  await DBOS.runStep(() => markTaskStopped(child.taskId), { name: `${operationId}:drain` });
  await DBOS.runStep(() => settle(child, result), { name: `${operationId}:settle` });
  await DBOS.runStep(() => quiet(child), { name: `${operationId}:quiet` });
  await DBOS.runStep(() => closeOperation(operationId), { name: `${operationId}:close` });

  return DBOS.runStep(
    async () => {
      await publishOperation(operationId);

      return operationResult(operationId);
    },
    { name: `${operationId}:result` },
  );
}
