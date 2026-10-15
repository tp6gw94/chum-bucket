import type { ToolCallPart } from "@tanstack/ai";

const labels: Record<ToolCallPart["state"], string> = {
  "awaiting-input": "等待參數",
  "input-streaming": "接收參數中",
  "input-complete": "等待執行結果",
  "approval-requested": "等待核准",
  "approval-responded": "已回覆核准請求",
  complete: "已完成",
  error: "執行失敗",
};

type Rendered = { blocks: [string, string][]; rest: string };

function isBlock([, value]: [string, unknown]): boolean {
  return typeof value === "string" && value.includes("\n");
}

function renderArguments(raw: string): Rendered {
  try {
    const parsed: unknown = JSON.parse(raw);

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { blocks: [], rest: JSON.stringify(parsed, null, 2) };
    }

    const entries = Object.entries(parsed);
    const blocks = entries.filter(isBlock) as [string, string][];
    const rest = entries.filter((entry) => !isBlock(entry));

    return {
      blocks,
      rest:
        blocks.length > 0 && rest.length === 0
          ? ""
          : JSON.stringify(Object.fromEntries(rest), null, 2),
    };
  } catch {
    return { blocks: [], rest: raw };
  }
}

export function ToolCall({ part }: { part: ToolCallPart }) {
  const { blocks, rest } = renderArguments(part.arguments);

  return (
    <details open className="min-w-0 rounded-lg border border-border bg-muted/30 p-3">
      <summary className="cursor-pointer break-all text-sm">
        <span className="font-mono">{part.name}</span>
        {" · "}
        <span role="status" className="text-muted-foreground">
          {labels[part.state]}
        </span>
      </summary>
      <div className="mt-2 flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">傳入參數</p>
        {rest || blocks.length === 0 ? (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
            {rest || "等待參數…"}
          </pre>
        ) : null}
        {blocks.map(([key, value]) => (
          <div key={key} className="flex flex-col gap-1">
            <p className="font-mono text-xs text-muted-foreground">{key}</p>
            <pre className="max-h-96 overflow-auto rounded bg-muted p-2 text-xs">
              <code>{value}</code>
            </pre>
          </div>
        ))}
      </div>
    </details>
  );
}
