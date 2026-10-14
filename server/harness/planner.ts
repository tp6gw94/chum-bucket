import type { AgentCheckpoint, AgentSession } from "./agent-loop";
import { roleRegistry, roleSystemPrompt } from "./agents";
import type { RoleTaskInput } from "./prompts";
import { reviewPlanner, runRole, type PlannerResult } from "./role-run";
import { plannerRoleTools } from "./role-tools";
import { TESTING_LIMITS, type Requirements } from "./testing-domain";

export type PlannerInput = Readonly<{
  task: RoleTaskInput & { requirements: Requirements };
  session: Omit<AgentSession, "tools">;
  signal: AbortSignal;
}>;

const sleep = (seconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

const directCheckpoint: AgentCheckpoint = async ({ retry, shouldRetry, work }) => {
  if (!retry?.retriesAllowed) {
    return work();
  }

  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= retry.maxAttempts || !(shouldRetry?.() ?? true)) {
        throw error;
      }

      await sleep(retry.intervalSeconds * retry.backoffRate ** (attempt - 1));
    }
  }
};

export async function runPlanner(input: PlannerInput): Promise<PlannerResult> {
  const run = plannerRoleTools(input.signal);

  try {
    return await runRole({
      role: "planner",
      task: input.task,
      turns: TESTING_LIMITS.turns,
      systemPrompt: roleSystemPrompt("planner", roleRegistry.planner.profile),
      session: { ...input.session, tools: run.tools },
      checkpoint: directCheckpoint,
      signal: input.signal,
      review: (conversation) => Promise.resolve(reviewPlanner(input.task, conversation)),
    });
  } finally {
    await run.quiet();
  }
}
