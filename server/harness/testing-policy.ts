import type { ArtifactKind, RoleId, RootRunOutcome } from "../../shared/testing";

export type TestingPolicyState = Readonly<{
  finished: boolean;
  cancelRequested: boolean;
  decisions: readonly Readonly<{ kind: string; role?: RoleId }>[];
  artifacts: readonly Readonly<{ kind: ArtifactKind; payload: unknown }>[];
}>;

export function isSatisfied(state: TestingPolicyState, role: RoleId): boolean {
  return state.decisions.some(
    (decision) => decision.kind === "satisfied" && decision.role === role,
  );
}

export function isNotRequired(state: TestingPolicyState): boolean {
  return state.decisions.some(
    (decision) => decision.kind === "not_required" && decision.role === "ui",
  );
}

export function isStyleRequired(state: TestingPolicyState): boolean {
  const plan = state.artifacts.find((artifact) => artifact.kind === "plan");
  const assignments = (plan?.payload as { assignments?: { ui?: readonly unknown[] } } | undefined)
    ?.assignments;

  return (assignments?.ui?.length ?? 0) > 0;
}

export function isDecided(state: TestingPolicyState, role: RoleId): boolean {
  return state.decisions.some(
    (decision) => decision.kind === "task_result" && decision.role === role,
  );
}

export function deriveFrontier(state: TestingPolicyState): readonly RoleId[] {
  if (state.finished || state.cancelRequested) {
    return [];
  }

  if (!isSatisfied(state, "atlassian")) {
    return ["atlassian"];
  }

  if (!isSatisfied(state, "planner")) {
    return ["planner"];
  }

  const plan = state.artifacts.find((artifact) => artifact.kind === "plan");
  const uiRequired =
    plan !== undefined &&
    Array.isArray((plan.payload as { assignments?: { ui?: unknown } }).assignments?.ui) &&
    ((plan.payload as { assignments: { ui: readonly unknown[] } }).assignments.ui.length ?? 0) >
      0 &&
    !isNotRequired(state);

  return [
    ...(isSatisfied(state, "ac") ? [] : ["ac" as const]),
    ...(uiRequired && !isSatisfied(state, "ui") ? ["ui" as const] : []),
  ];
}

export function phaseEligible(state: TestingPolicyState, role: RoleId): boolean {
  if (
    state.cancelRequested ||
    state.finished ||
    isSatisfied(state, role) ||
    isDecided(state, role)
  ) {
    return false;
  }

  if (role === "atlassian") {
    return true;
  }

  if (role === "planner") {
    return isSatisfied(state, "atlassian");
  }

  if (role === "ac") {
    return isSatisfied(state, "planner");
  }

  if (role === "ui") {
    return isSatisfied(state, "planner") && !isNotRequired(state) && isStyleRequired(state);
  }

  return false;
}

export function rootOutcome(
  state: TestingPolicyState & Readonly<{ deadline: string }>,
  nowMs: number,
): RootRunOutcome {
  if (state.cancelRequested) {
    return "cancelled";
  }

  if (Date.parse(state.deadline) <= nowMs) {
    return "timed_out";
  }

  const required: RoleId[] = ["atlassian", "planner", "ac"];

  if (!isNotRequired(state)) {
    const plan = state.artifacts.find((artifact) => artifact.kind === "plan");
    const ui =
      plan &&
      ((plan.payload as { assignments?: { ui?: readonly string[] } }).assignments?.ui?.length ??
        0) > 0;

    if (ui) {
      required.push("ui");
    }
  }

  return required.every((role) => isSatisfied(state, role)) ? "completed" : "failed";
}
