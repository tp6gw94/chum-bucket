import type { TestView } from "../../shared/testing";
import { mergeTestView } from "./testing-view";

export function mergeTestingView(
  views: readonly TestView[],
  incoming: TestView,
): readonly TestView[] {
  const index = views.findIndex((view) => view.runId === incoming.runId);

  if (index < 0) {
    return [...views, incoming];
  }

  const current = views[index]!;
  const merged = mergeTestView(current, incoming);

  if (merged === current) {
    return views;
  }

  const next = views.slice();
  next[index] = merged;

  return next;
}

export function mergeHydratedTestingView(
  views: readonly TestView[],
  published: TestView | null,
): readonly TestView[] {
  return published === null ? views : mergeTestingView(views, published);
}
