import { setTimeout as delay } from "node:timers/promises";
import { DBOS } from "@dbos-inc/dbos-sdk";
import type { RoleId } from "../../shared/testing";
import type { ModelCall } from "./model-turn";
import type { AcceptedRun } from "./run-store";
import {
  TESTING_ROOT_BUILD,
  acceptRoleCandidate,
  admitAttachedTesting,
  closeTesting,
  publishProjection,
  readTestingExecution,
  recordRoleFailure,
  reserveRoleTasks,
} from "./run-store";
import {
  testingChildWorkflow,
  type TestingChildInput,
  type TestingChildResult,
} from "./testing-child";
import { abortTestingTransports, testingTransportState } from "./testing-child";
import {
  ensureTestingCancelDeliveries,
  listPendingTestingOperations,
  readStartCancelDeliveries,
  type RoleFailureCode,
  type TestingAdmission,
  type TestingExecution,
} from "./testing-store";
import { phaseEligible, rootOutcome } from "./testing-policy";

type TestingRootInput = Readonly<{
  parentRunId: string;
  operationId: string;
}>;

type ChildSpec = TestingChildInput;

type DispatchFrame =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "start"; child: ChildSpec }>
  | Readonly<{ kind: "results"; ac: ChildSpec | null; ui: ChildSpec | null }>;

function taskInput(execution: TestingExecution, role: RoleId): unknown {
  return {
    role,
    operationId: execution.operationId,
    intentDigest: execution.intent.goal,
  };
}

function spec(execution: TestingExecution, role: RoleId): ChildSpec | null {
  const task = execution.tasks.find((item) => item.frame.role === role);

  if (!task) {
    return null;
  }

  return {
    taskId: task.frame.taskId,
    attemptNonce: task.frame.attemptNonce,
    childWorkflowId: task.frame.childWorkflowId,
    parentRunId: execution.parentRunId,
    operationId: execution.operationId,
    role,
  };
}

function sequentialRole(role: RoleId | undefined): role is "atlassian" | "planner" {
  return role === "atlassian" || role === "planner";
}

async function startFrame(
  execution: TestingExecution,
  role: "atlassian" | "planner",
): Promise<DispatchFrame> {
  await reserveRoleTasks(execution.parentRunId, execution.operationId, [
    { role, input: taskInput(execution, role) },
  ]);
  const latest = await readTestingExecution(execution.parentRunId, execution.operationId);
  const child = spec(latest, role);

  return child ? { kind: "start", child } : { kind: "idle" };
}

async function resultsFrame(
  execution: TestingExecution,
  roles: readonly RoleId[],
): Promise<DispatchFrame> {
  await reserveRoleTasks(
    execution.parentRunId,
    execution.operationId,
    roles.map((role) => ({ role, input: taskInput(execution, role) })),
  );
  const latest = await readTestingExecution(execution.parentRunId, execution.operationId);

  return {
    kind: "results",
    ac: roles.includes("ac") ? spec(latest, "ac") : null,
    ui: roles.includes("ui") ? spec(latest, "ui") : null,
  };
}

async function frameFor(
  execution: TestingExecution,
  roles: readonly RoleId[],
): Promise<DispatchFrame> {
  if (execution.cancelRequested || execution.finished || roles.length === 0) {
    return { kind: "idle" };
  }

  const [role] = roles;

  if (roles.length === 1 && sequentialRole(role)) {
    return startFrame(execution, role);
  }

  return resultsFrame(execution, roles);
}

const FAILURE_CODES = new Map<string, RoleFailureCode>([
  ["cancel_requested", "cancelled"],
  ["cancelled", "cancelled"],
  ["deadline", "timed_out"],
  ["timed_out", "timed_out"],
  ["budget", "budget"],
  ["missing", "missing"],
  ["proposal_rejected", "proposal_rejected"],
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

  if (!result || result.state !== "proposed") {
    await recordRoleFailure(
      ownerRunId,
      child.taskId,
      failureCode(result?.reason ?? "child_failed"),
    );

    return;
  }

  try {
    await acceptRoleCandidate(ownerRunId, child.taskId, result.proposal);
  } catch {
    await recordRoleFailure(ownerRunId, child.taskId, "proposal_rejected");
  }
}

async function runChild(child: ChildSpec): Promise<TestingChildResult | null> {
  const handle = await DBOS.startWorkflow(testingChildWorkflow, {
    workflowID: child.childWorkflowId,
  })(child);

  try {
    return await handle.getResult();
  } catch {
    return { state: "failed", reason: "child_failed" };
  }
}

async function phaseFrame(
  ownerRunId: string,
  operationId: string,
  role: RoleId,
): Promise<DispatchFrame> {
  const execution = await readTestingExecution(ownerRunId, operationId);

  if (!phaseEligible(execution, role)) {
    return { kind: "idle" };
  }

  return frameFor(execution, [role]);
}

function markersQuiet(
  execution: TestingExecution,
  deliveries: readonly { taskId: string; kind: string; acknowledgement: string | null }[],
): boolean {
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

async function proveQuiet(execution: TestingExecution): Promise<boolean> {
  if (
    execution.tasks.some((task) => testingTransportState(task.frame.childWorkflowId) === "live")
  ) {
    return false;
  }

  const deliveries = await readStartCancelDeliveries(execution.operationId);

  return markersQuiet(execution, deliveries);
}

async function runSerialProducer(
  admission: TestingAdmission,
  role: "atlassian" | "planner",
): Promise<void> {
  const prefix = admission.operationId;
  const frame = await DBOS.runStep(
    async () => phaseFrame(admission.parentRunId, admission.operationId, role),
    { name: `${prefix}:frame:${role}` },
  );

  if (frame.kind === "start") {
    const result = await runChild(frame.child);
    await DBOS.runStep(() => settleChild(admission.parentRunId, frame.child, result), {
      name: `${prefix}:settle:${role}`,
    });
  }
}

async function runTestingBody(
  admission: TestingAdmission,
): Promise<import("../../shared/testing").TestView> {
  const prefix = admission.operationId;
  await DBOS.runStep(() => publishProjection(admission.parentRunId, admission.operationId), {
    name: `${prefix}:publish:admit`,
  });
  await runSerialProducer(admission, "atlassian");
  await runSerialProducer(admission, "planner");
  const results = await DBOS.runStep(
    async () => {
      const execution = await readTestingExecution(admission.parentRunId, admission.operationId);
      const roles = (["ac", "ui"] as const).filter((role) => phaseEligible(execution, role));
      const frame = roles.length > 0 ? await frameFor(execution, roles) : { kind: "idle" as const };

      return frame.kind === "results" ? frame : { kind: "results" as const, ac: null, ui: null };
    },
    { name: `${prefix}:frame:results` },
  );

  if (results.ac && results.ui) {
    const acHandle = await DBOS.startWorkflow(testingChildWorkflow, {
      workflowID: results.ac.childWorkflowId,
    })(results.ac);
    const uiHandle = await DBOS.startWorkflow(testingChildWorkflow, {
      workflowID: results.ui.childWorkflowId,
    })(results.ui);
    const acResult = await acHandle
      .getResult()
      .catch(() => ({ state: "failed" as const, reason: "child_failed" }));
    const uiResult = await uiHandle
      .getResult()
      .catch(() => ({ state: "failed" as const, reason: "child_failed" }));
    await DBOS.runStep(
      async () => {
        await settleChild(admission.parentRunId, results.ac!, acResult);
        await settleChild(admission.parentRunId, results.ui!, uiResult);
      },
      { name: `${prefix}:settle:results` },
    );
  } else if (results.ac) {
    const result = await runChild(results.ac);
    await DBOS.runStep(() => settleChild(admission.parentRunId, results.ac!, result), {
      name: `${prefix}:settle:ac`,
    });
  } else if (results.ui) {
    const result = await runChild(results.ui);
    await DBOS.runStep(() => settleChild(admission.parentRunId, results.ui!, result), {
      name: `${prefix}:settle:ui`,
    });
  }

  await DBOS.runStep(
    async () => {
      for (;;) {
        const execution = await readTestingExecution(admission.parentRunId, admission.operationId);

        if (execution.finished || (await proveQuiet(execution))) {
          return;
        }

        if (execution.cancelRequested) {
          await abortTestingTransports(execution.tasks.map((task) => task.frame.childWorkflowId));
        }

        await publishProjection(admission.parentRunId, admission.operationId).catch(
          () => undefined,
        );
        await delay(200);
      }
    },
    { name: `${prefix}:quiet` },
  );

  return DBOS.runStep(
    async () => {
      const execution = await readTestingExecution(admission.parentRunId, admission.operationId);

      return closeTesting(
        admission.parentRunId,
        admission.operationId,
        rootOutcome(execution, Date.now()),
      );
    },
    { name: `${prefix}:close` },
  );
}

export async function orchestrateAttachedTesting(
  run: AcceptedRun,
  call: ModelCall,
): Promise<import("../../shared/testing").TestView> {
  if (run.side) {
    throw new Error("Side chat cannot delegate testing");
  }

  const admission = await DBOS.runStep(() => admitAttachedTesting(run, call.id, call.input), {
    name: `testing-admit:${call.id}`,
  });

  return runTestingBody(admission);
}

async function executeTestingRoot(input: TestingRootInput) {
  const admission = await DBOS.runStep(
    () => readTestingExecution(input.parentRunId, input.operationId).then(() => input),
    { name: "testing-root-open" },
  );
  const loaded = await DBOS.runStep(
    async () => {
      const execution = await readTestingExecution(admission.parentRunId, admission.operationId);

      return {
        operationId: execution.operationId,
        parentRunId: execution.parentRunId,
        threadId: execution.threadId,
        requestKey: execution.operationId,
        deadline: execution.deadline,
        mode: execution.mode,
        decisions: execution.decisions.flatMap((decision) =>
          decision.kind === "reuse" ? [decision.decision] : [],
        ),
        pinnedRefs: execution.artifacts.map((artifact) => artifact.ref),
      } satisfies TestingAdmission;
    },
    { name: "testing-root-admission" },
  );

  return runTestingBody(loaded);
}

const testingRootWorkflow = DBOS.registerWorkflow(executeTestingRoot, {
  name: TESTING_ROOT_BUILD,
});

export async function ensureTestingRoot(parentRunId: string, operationId: string): Promise<void> {
  const status = await DBOS.getWorkflowStatus(parentRunId);

  if (!status) {
    await DBOS.startWorkflow(testingRootWorkflow, { workflowID: parentRunId })({
      parentRunId,
      operationId,
    });
  }
}

type PendingOperation = Awaited<ReturnType<typeof listPendingTestingOperations>>[number];

const ROOT_ENDED_STATUSES: ReadonlySet<string> = new Set([
  "SUCCESS",
  "ERROR",
  "CANCELLED",
  "MAX_RECOVERY_ATTEMPTS_EXCEEDED",
]);

async function standaloneRootStatus(operation: PendingOperation) {
  if (operation.mode !== "standalone") {
    return null;
  }

  const status = await DBOS.getWorkflowStatus(operation.parentRunId).catch(() => null);

  if (!status) {
    await ensureTestingRoot(operation.parentRunId, operation.operationId);
  }

  return status;
}

async function reconcileOperation(operation: PendingOperation): Promise<void> {
  if (operation.cancelRequested) {
    await ensureTestingCancelDeliveries(operation.operationId).catch(() => undefined);
  }

  const status = await standaloneRootStatus(operation);
  const execution = await readTestingExecution(operation.parentRunId, operation.operationId).catch(
    () => null,
  );
  const quiet = execution !== null && (await proveQuiet(execution));

  if (execution && quiet && status !== null && ROOT_ENDED_STATUSES.has(status.status)) {
    await closeTesting(
      operation.parentRunId,
      operation.operationId,
      rootOutcome(execution, Date.now()),
    ).catch(() => undefined);

    return;
  }

  await publishProjection(operation.parentRunId, operation.operationId).catch(() => undefined);
}

export async function reconcileTestingOperations(): Promise<void> {
  const pending = await listPendingTestingOperations();

  for (const operation of pending) {
    await reconcileOperation(operation);
  }
}
