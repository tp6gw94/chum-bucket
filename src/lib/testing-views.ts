import type { Role, TestView } from "../../shared/testing";

export type TestingViews = Readonly<Record<string, TestView>>;

export const roleLabels: Record<Role, string> = {
  atlassian: "需求讀取（atlassian）",
  planner: "測試計畫（planner）",
  ac: "功能驗證（ac）",
  ui: "樣式驗證（ui）",
};

const taskStatusLabels = {
  queued: "排隊中",
  running: "執行中",
  ready: "已完成",
  failed: "失敗",
  cancelled: "已取消",
} as const;

const outcomeLabels = {
  satisfied: "已完成",
  failed: "失敗",
  cancelled: "已取消",
  deadline: "逾時",
} as const;

export function mergeTestingView(views: TestingViews, view: TestView): TestingViews {
  const current = views[view.requestKey];

  return current && current.version >= view.version ? views : { ...views, [view.requestKey]: view };
}

export function mergeTestingViews(views: TestingViews, list: readonly TestView[]): TestingViews {
  return list.reduce(mergeTestingView, views);
}

export function testingStatus(view: TestView): string {
  if (view.outcome) {
    return outcomeLabels[view.outcome];
  }

  if (view.cancelRequested) {
    return "取消中";
  }

  return view.task ? taskStatusLabels[view.task.status] : "排隊中";
}

export function testingActivity(view: TestView): string | null {
  const activity = view.state === "running" ? view.task?.activity : null;

  if (!activity) {
    return null;
  }

  return activity.kind === "model" ? "模型思考中" : `執行工具 ${activity.name ?? ""}`.trim();
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function countBy(values: readonly string[]): string {
  const counts = new Map<string, number>();

  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts].map(([key, count]) => `${key} ${count}`).join("、");
}

export function artifactLines(view: TestView): string[] {
  const payload = record(view.artifact?.payload);

  if (!view.artifact || !payload) {
    return [];
  }

  switch (view.artifact.kind) {
    case "requirements":
      return [`讀取 ${list(payload.sources).length} 個來源`];
    case "plan":
      return [
        `${list(payload.criteria).length} 條驗收條件、${list(payload.cases).length} 個測試案例`,
        `未執行案例 ${list(payload.deferredCases).length} 個、待釐清 ${list(payload.unresolved).length} 項`,
      ];

    default: {
      const outcomes = list(payload.checks).map((check) =>
        String(record(check)?.outcome ?? "unknown"),
      );

      return [`${outcomes.length} 項檢查：${countBy(outcomes) || "無"}`];
    }
  }
}
