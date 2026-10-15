import { DBOS } from "@dbos-inc/dbos-sdk";
import { delegationFailure } from "./testing-error";
import type { Artifact, DelegationInput, Plan, Requirements, RoleTask } from "../../shared/testing";
import { delegationInputSchema } from "../../shared/testing";
import { agentRegistry, allowsTool } from "./agents";
import type { AcceptedRun } from "./run-store";
import type { ModelCall } from "./model-turn";
import type { AgentOrchestration } from "./agent-loop";
import { assembleToolResults, digestOf } from "./testing-domain";
import {
  TESTING_WORKFLOW_VERSION,
  admitOperation,
  reserveTask,
  operationIdFor,
  workflowIdFor,
  loadArtifact,
  withTestingClient,
  acceptCompletion,
  closeOperation,
  type TestingInput,
  type TestingOutput,
} from "./testing-store";
import type { executeTestingChild } from "./testing-child";
import "./testing-child";

export type DelegationResult = {
  runId: string;
  state: "finished";
  task: {
    version: 2 | 3;
    role: TestingInput["intent"]["role"];
    summary: string;
    result: Artifact | null;
    findings?: string | null;
    missingChecks?: string[];
    conflictingChecks?: string[];
  };
  progress: { state: "completed" | "failed"; reasonCode?: string; issues?: string[] };
};

async function prepareTask(
  intent: DelegationInput,
  threadId: string,
): Promise<{ task: RoleTask; dependencies: string[] }> {
  const task: RoleTask = {
    summary: intent.summary,
    goal: "",
    sources: [],
    requirements: null,
    plan: null,
    design: null,
    targetUrl: null,
    checks: [],
  };

  if (intent.role === "atlassian") {
    return { task: { ...task, goal: intent.goal, sources: intent.sources }, dependencies: [] };
  }

  if (intent.role === "planner") {
    const artifact = await loadArtifact(intent.requirementsRef, threadId, "requirements");
    const requirements = artifact.payload as Requirements;

    return {
      task: { ...task, goal: requirements.goal, requirements, design: intent.design ?? null },
      dependencies: [artifact.ref],
    };
  }

  const artifact = await loadArtifact(intent.planRef, threadId, "plan");
  const plan = artifact.payload as Plan;

  if (intent.role === "ui" && !plan.design) {
    throw new Error("UI verification requires a plan with an explicit design node");
  }

  return {
    task: {
      ...task,
      goal: plan.goal,
      plan,
      design: intent.role === "ui" ? plan.design : null,
      targetUrl: intent.targetUrl,
      checks: plan.assignments[intent.role],
    },
    dependencies: [artifact.ref],
  };
}

async function admit(run: AcceptedRun, call: ModelCall): Promise<TestingInput> {
  if (run.delegationAllowed === false) {
    throw new Error("Side conversations cannot delegate");
  }

  const intent = delegationInputSchema.parse(call.input);
  const { task, dependencies } = await prepareTask(intent, run.threadId);

  const operationId = operationIdFor(run.runId, call.id);
  const agent = agentRegistry[intent.role];

  return admitOperation({
    operationId,
    childWorkflowId: workflowIdFor(operationId, intent.role),
    parentRunId: run.runId,
    threadId: run.threadId,
    requestKey: call.id,
    intent,
    task,
    deadline: Date.now() + 15 * 60_000,
    profile: agent.profile,
    model: agent.model,
    dependencies,
  });
}

async function startJoin(input: TestingInput): Promise<TestingOutput> {
  return withTestingClient(async (client) => {
    const handle = await client.enqueue<typeof executeTestingChild>(
      {
        queueName: "testing-delegation",
        workflowName: TESTING_WORKFLOW_VERSION,
        workflowID: input.childWorkflowId,
      },
      input,
    );

    try {
      return await handle.getResult();
    } catch (error) {
      const status = await handle.getStatus();

      if (
        !status ||
        !["ERROR", "CANCELLED", "MAX_RECOVERY_ATTEMPTS_EXCEEDED"].includes(status.status)
      ) {
        throw error;
      }

      return {
        inputDigest: digestOf(input),
        task: input.task,
        completion: { state: "failed", candidate: null, findings: null, reason: "child_failed" },
        artifact: null,
        receipts: [],
      };
    }
  });
}

function projection(input: TestingInput, output: TestingOutput): DelegationResult {
  const qa = input.intent.role === "ac" || input.intent.role === "ui";
  const observations = qa
    ? assembleToolResults(input.intent.role as "ac" | "ui", input.task, output.receipts)
    : null;

  return {
    runId: input.operationId,
    state: "finished",
    task: {
      version: qa ? 3 : 2,
      role: input.intent.role,
      summary: input.intent.summary,
      result: output.artifact,
      ...(observations
        ? {
            findings: output.completion.findings,
            missingChecks: observations.missingChecks,
            conflictingChecks: observations.conflictingChecks,
          }
        : {}),
    },
    progress: {
      state: output.completion.state === "ready" ? "completed" : "failed",
      ...(output.completion.reason ? { reasonCode: output.completion.reason } : {}),
      ...(output.completion.issues ? { issues: output.completion.issues } : {}),
    },
  };
}

export async function delegateTask(run: AcceptedRun, call: ModelCall): Promise<DelegationResult> {
  const input = await DBOS.runStep(() => admit(run, call), {
    name: `delegate-v1:admit:${call.id}`,
  });
  await DBOS.runStep(() => reserveTask(input), { name: `${input.operationId}:reserve` });
  const output = await DBOS.runStep(() => startJoin(input), {
    name: `${input.childWorkflowId}:start-join`,
    retriesAllowed: true,
    maxAttempts: 3,
    intervalSeconds: 1,
  });
  await DBOS.runStep(
    async () => {
      await withTestingClient(async (client) => {
        const status = await client.retrieveWorkflow(input.childWorkflowId).getStatus();

        if (
          status &&
          !["SUCCESS", "ERROR", "CANCELLED", "MAX_RECOVERY_ATTEMPTS_EXCEEDED"].includes(
            status.status,
          )
        ) {
          throw new Error("Child workflow is still running");
        }
      });
    },
    { name: `${input.operationId}:drain` },
  );
  const settled = await DBOS.runStep(() => acceptCompletion(input, output), {
    name: `${input.operationId}:settle`,
  });
  const result = await DBOS.runStep(async () => projection(input, settled), {
    name: `${input.operationId}:quiet`,
  });

  return DBOS.runStep(() => closeOperation(input, result), { name: `${input.operationId}:close` });
}

export function testingOrchestration(run: AcceptedRun): AgentOrchestration {
  return async (call) => {
    if (call.name !== "delegate_task") {
      return { state: "unhandled" };
    }

    try {
      if (!allowsTool("main", call.name, "direct") || run.delegationAllowed === false) {
        throw new Error("Delegation is unavailable");
      }

      return { state: "handled", output: await delegateTask(run, call) };
    } catch (error) {
      return {
        state: "handled",
        error: true,
        output: delegationFailure(error),
      };
    }
  };
}
