import type { RoleId, RootRunOutcome } from "../../shared/testing";

export type TestingPolicyState = Readonly<{
  intent: Readonly<{ task?: Readonly<{ input: Readonly<{ role: RoleId }> }> }>;
  cancelRequested: boolean;
  deadline: string;
  decisions: readonly Readonly<{ kind: string; role?: RoleId; execution?: string }>[];
}>;

export function rootOutcome(state: TestingPolicyState, nowMs: number): RootRunOutcome {
  if (state.cancelRequested) {
    return "cancelled";
  }

  if (Date.parse(state.deadline) <= nowMs) {
    return "timed_out";
  }

  const role = state.intent.task?.input.role;

  if (!role) {
    throw new Error("Legacy testing operations require maintenance");
  }

  const decision = state.decisions.find(
    (item) => item.kind === "task_result" && item.role === role,
  );

  if (decision?.execution === "timed_out") {
    return "timed_out";
  }

  return decision?.execution === "completed" ? "completed" : "failed";
}
