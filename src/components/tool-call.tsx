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

type DisplayArguments = { json: string; blocks: [string, string][] };

function parseArguments(raw: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(raw) as unknown };
  } catch {
    return undefined;
  }
}

function isMultiline(value: unknown): value is string {
  return typeof value === "string" && value.includes("\n");
}

function displayArguments(raw: string): DisplayArguments {
  const parsed = parseArguments(raw);

  if (!parsed) {
    return { json: raw, blocks: [] };
  }

  const { value } = parsed;

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { json: JSON.stringify(value, null, 2), blocks: [] };
  }

  const entries = Object.entries(value);
  const blocks = entries.filter((entry): entry is [string, string] => isMultiline(entry[1]));
  const rest = Object.fromEntries(entries.filter(([, field]) => !isMultiline(field)));
  const onlyBlocks = blocks.length > 0 && Object.keys(rest).length === 0;

  return { json: onlyBlocks ? "" : JSON.stringify(rest, null, 2), blocks };
}

export function ToolCall({ part }: { part: ToolCallPart }) {
  const { json, blocks } = displayArguments(part.arguments);

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
        {json || !blocks.length ? (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
            {json || "等待參數…"}
          </pre>
        ) : null}
        {blocks.map(([key, value]) => (
          <div key={key} className="flex flex-col gap-1">
            <p className="font-mono text-xs text-muted-foreground">{key}</p>
            <pre className="max-h-96 overflow-auto rounded-md bg-muted p-2 text-xs">
              <code>{value}</code>
            </pre>
          </div>
        ))}
      </div>
    </details>
  );
}
