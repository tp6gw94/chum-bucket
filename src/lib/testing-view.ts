import type { ProgressCard, ProgressRow, RoleId, TestRunId, TestView } from "../../shared/testing";

export const ROLE_ORDER: readonly RoleId[] = ["atlassian", "planner", "ac", "ui"];

export function orderedRows(card: ProgressCard): readonly (readonly [RoleId, ProgressRow])[] {
  return ROLE_ORDER.map((role) => [role, card.rows[role]] as const);
}

export function mergeTestView(current: TestView | null, incoming: TestView): TestView {
  if (!current || current.runId !== incoming.runId) {
    return incoming;
  }

  const newer = incoming.progress.version > current.progress.version;
  const selected = current.state !== "finished" && newer ? incoming : current;
  const origin =
    current.task?.origin ??
    (incoming.progress.version >= current.progress.version ? incoming.task?.origin : null);

  return selected.task && origin && selected.task.origin !== origin
    ? { ...selected, task: { ...selected.task, origin } }
    : selected;
}

export type CancelRequest =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "requesting" }>
  | Readonly<{ status: "accepted" }>
  | Readonly<{ status: "failed"; message: string }>;

export type CancelTracker = Readonly<{
  runId: TestRunId;
  generation: number;
  request: CancelRequest;
}>;

export function beginCancelRequest(
  tracker: CancelTracker | null,
  runId: TestRunId,
  generation: number,
): CancelTracker {
  if (tracker && tracker.generation >= generation) {
    return tracker;
  }

  return { runId, generation, request: { status: "requesting" } };
}

export function settleCancelRequest(
  tracker: CancelTracker | null,
  runId: TestRunId,
  generation: number,
  request: Extract<CancelRequest, { status: "accepted" | "failed" }>,
): CancelTracker | null {
  if (!tracker || tracker.runId !== runId || tracker.generation !== generation) {
    return tracker;
  }

  return { ...tracker, request };
}

export function cancelRequestMessage(request: CancelRequest): string | null {
  switch (request.status) {
    case "idle":
      return null;
    case "requesting":
      return "取消要求已送出，等待伺服器回應。";
    case "accepted":
      return "伺服器已接受取消要求，尚未確認停止。";
    case "failed":
      return `取消失敗：${request.message}`;
  }
}

export function cancelRequestFor(tracker: CancelTracker | null, runId: TestRunId): CancelRequest {
  return tracker && tracker.runId === runId ? tracker.request : { status: "idle" };
}

export function cancelButtonDisabled(view: TestView, request: CancelRequest): boolean {
  return (
    view.state !== "active" || request.status === "requesting" || request.status === "accepted"
  );
}
