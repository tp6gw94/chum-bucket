import { setTimeout as delay } from "node:timers/promises";
import { DBOS } from "@dbos-inc/dbos-sdk";
import type { RoleCompletion } from "../../shared/testing";
import { runAgentLoop, type AgentCheckpoint } from "./agent-loop";
import { roleSystemPrompt } from "./agents";
import { roleFinalTurnPrompt } from "./role-prompts";
import { runRolePasses } from "./testing-role";
import { withRoleTools, type RoleToolState } from "./testing-tools";
import { digestOf, validateCandidate } from "./testing-domain";
import {
  assertChildIdentity,
  TESTING_WORKFLOW_VERSION,
  type TestingInput,
  type TestingOutput,
  guardActualIO,
  appendReceipt,
  readReceipts,
  cancellationRequested,
} from "./testing-store";

async function roleLoops(
  input: TestingInput,
  state: RoleToolState,
  signal: AbortSignal,
): Promise<RoleCompletion> {
  const role = input.intent.role;
  const prompt = roleSystemPrompt(role, input.profile);
  let activeStep = "";

  const checkpoint =
    (prefix: string): AgentCheckpoint =>
    async ({ name, retry, work }) => {
      activeStep = `${prefix}:${name}`;
      const saved = await DBOS.runStep(
        async () => {
          signal.throwIfAborted();
          state.receipts = await readReceipts(input.childWorkflowId);
          const value = await work();

          return { value, receipts: structuredClone(state.receipts) };
        },
        { name: activeStep, ...retry },
      );
      state.receipts = saved.receipts;

      return saved.value;
    };

  return withRoleTools(
    {
      role,
      taskId: input.childWorkflowId,
      task: input.task,
      state,
      guard: (kind, step) => guardActualIO(input, kind, step),
      append: (receipt) => appendReceipt(input, receipt),
    },
    async (tools) =>
      runRolePasses({
        role,
        taskId: input.childWorkflowId,
        task: input.task,
        pass: (conversation, maxTurns, prefix) =>
          runAgentLoop({
            session: {
              runId: input.childWorkflowId,
              emit: async () => undefined,
              tools,
              chatStream: async (options) => {
                signal.throwIfAborted();
                await guardActualIO(input, "model", activeStep);
                const { deepinfra } = await import("./provider");

                return deepinfra(input.model).chatStream(options);
              },
            },
            conversation,
            model: input.model,
            prompt,
            checkpoint: checkpoint(prefix),
            compact: async ({ conversation }) => ({ state: "skipped", conversation }),
            maxTurns,
            finalTurnPrompt: roleFinalTurnPrompt(role),
            signal,
            toolTimeoutMs: 100_000,
          }),
        validate: (candidate, name) =>
          DBOS.runStep(
            async () => {
              if (role === "planner" && candidate === undefined) {
                return { valid: false as const, issues: ["Role output is not valid JSON"] };
              }

              const receipts = await readReceipts(input.childWorkflowId);

              return validateCandidate(role, candidate, input.intent, input.task, receipts);
            },
            { name },
          ),
      }),
  );
}

async function watchCancellation(
  input: TestingInput,
  stop: AbortSignal,
  controller: AbortController,
) {
  try {
    while (!stop.aborted) {
      if (await cancellationRequested(input.operationId)) {
        controller.abort(new Error("cancel_requested"));
        break;
      }

      await delay(200, undefined, { signal: stop }).catch(() => undefined);
    }
  } catch {
    controller.abort(new Error("Cancellation polling failed"));
  }
}

export async function executeTestingChild(input: TestingInput): Promise<TestingOutput> {
  const state: RoleToolState = { receipts: [] };
  let completion: RoleCompletion;
  const stop = new AbortController();
  const controller = new AbortController();
  let polling: Promise<void> | undefined;

  try {
    await DBOS.runStep(() => assertChildIdentity(input), { name: "claim" });
    polling = watchCancellation(input, stop.signal, controller);
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(Math.max(1, input.deadline - Date.now())),
    ]);
    completion = await roleLoops(input, state, signal);
  } catch (error) {
    completion = {
      state: "failed",
      candidate: null,
      findings: null,
      reason: "child_failed",
      issues: [error instanceof Error ? error.message.slice(0, 240) : "Child execution failed"],
    };
  } finally {
    stop.abort();
    await polling;
  }

  return DBOS.runStep(
    async () => ({
      inputDigest: digestOf(input),
      completion,
      artifact: null,
      receipts: await readReceipts(input.childWorkflowId),
      task: input.task,
    }),
    { name: "completion" },
  );
}

DBOS.registerWorkflow(executeTestingChild, { name: TESTING_WORKFLOW_VERSION });
