import { parsePublishedTasks, testingPath, type TestView } from "../../shared/testing";

export async function cancelTesting(
  operationId: string,
  threadId: string,
): Promise<TestView | null> {
  const response = await fetch(`${testingPath}/${encodeURIComponent(operationId)}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadId }),
  });

  if (!response.ok) {
    throw new Error(`取消失敗（HTTP ${response.status}）`);
  }

  const data = (await response.json().catch(() => null)) as { view?: unknown } | null;

  return parsePublishedTasks([data?.view])[0] ?? null;
}

export function withPublishedTasks(onTasks: (views: TestView[]) => void): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    const method = init?.method ?? "GET";

    if (method === "GET" && response.ok && response.headers.get("content-type")?.includes("json")) {
      void response
        .clone()
        .json()
        .then((data: unknown) => {
          const tasks = parsePublishedTasks(
            (data as { publishedTasks?: unknown } | null)?.publishedTasks,
          );

          if (tasks.length) {
            onTasks(tasks);
          }
        })
        .catch(() => undefined);
    }

    return response;
  };
}
