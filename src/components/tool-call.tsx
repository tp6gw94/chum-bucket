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

type CodeBlock = { key: string; value: string };

function parseJson(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isMultiline(value: unknown): value is string {
  return typeof value === "string" && value.includes("\n");
}

function splitArguments(text: string): { json: string; blocks: CodeBlock[] } {
  const parsed = parseJson(text);

  if (!parsed || !isRecord(parsed.value)) {
    return { json: parsed ? JSON.stringify(parsed.value, null, 2) : text, blocks: [] };
  }

  const entries = Object.entries(parsed.value);
  const blocks = entries.flatMap(([key, value]) => (isMultiline(value) ? [{ key, value }] : []));
  const rest = entries.filter(([, value]) => !isMultiline(value));

  return {
    json: blocks.length && !rest.length ? "" : JSON.stringify(Object.fromEntries(rest), null, 2),
    blocks,
  };
}

export function ToolCall({ part }: { part: ToolCallPart }) {
  const { json, blocks } = splitArguments(part.arguments);

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
        {blocks.map((block) => (
          <div key={block.key} className="flex min-w-0 flex-col gap-1">
            <p className="font-mono text-xs text-muted-foreground">{block.key}</p>
            <pre className="max-h-96 overflow-auto rounded-md bg-muted p-2 text-xs">
              <code>{block.value}</code>
            </pre>
          </div>
        ))}
      </div>
    </details>
  );
}
