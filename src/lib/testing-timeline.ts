import type { TestView } from "../../shared/testing";
import type { ChatMessage } from "../components/types";

type TimelineRow =
  | Readonly<{ kind: "message"; message: ChatMessage; key: string }>
  | Readonly<{ kind: "testing"; view: TestView; key: string }>;

function indexTaskOrigins(views: Iterable<TestView>) {
  const byMessage = new Map<string, Map<string, TestView[]>>();

  for (const view of views) {
    const origin = view.task?.origin;

    if (!origin) {
      continue;
    }

    const calls = byMessage.get(origin.parentMessageId) ?? new Map<string, TestView[]>();
    const tasks = calls.get(origin.requestKey) ?? [];
    tasks.push(view);
    calls.set(origin.requestKey, tasks);
    byMessage.set(origin.parentMessageId, calls);
  }

  return byMessage;
}

function appendMessageTasks(
  message: ChatMessage,
  calls: Map<string, TestView[]> | undefined,
  remaining: Map<string, TestView>,
  rows: TimelineRow[],
) {
  if (message.role !== "assistant") {
    return;
  }

  for (const part of message.parts) {
    if (part.type !== "tool-call" || part.name !== "delegate_task") {
      continue;
    }

    const located = (calls?.get(part.id) ?? []).filter((view) => remaining.has(view.runId));

    for (const view of located) {
      remaining.delete(view.runId);
      rows.push({ kind: "testing", view, key: `testing-${view.runId}` });
    }
  }
}

export function testingTimeline(
  messages: readonly ChatMessage[],
  views: readonly TestView[],
  isStreaming = false,
  activeRunId: string | null = null,
): readonly TimelineRow[] {
  const remaining = new Map(views.map((view) => [view.runId, view]));
  const byMessage = indexTaskOrigins(remaining.values());
  const rows: TimelineRow[] = [];
  const occurrences = new Map<string, number>();

  for (const message of messages) {
    const occurrence = occurrences.get(message.id) ?? 0;
    occurrences.set(message.id, occurrence + 1);
    rows.push({ kind: "message", message, key: `message-${message.id}-${occurrence}` });

    appendMessageTasks(message, byMessage.get(message.id), remaining, rows);
  }

  for (const view of remaining.values()) {
    if (
      isStreaming &&
      view.state !== "finished" &&
      view.task?.origin?.parentRunId === activeRunId
    ) {
      continue;
    }

    rows.push({ kind: "testing", view, key: `testing-${view.runId}` });
  }

  return rows;
}
