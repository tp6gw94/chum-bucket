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

type ArgumentDisplay = Readonly<{
  args: string;
  multiline: readonly (readonly [string, string])[];
}>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMultilineString(value: unknown): value is string {
  return typeof value === "string" && /[\r\n]/.test(value);
}

function partitionArguments(parsed: Record<string, unknown>): {
  multiline: Array<[string, string]>;
  remaining: Array<[string, unknown]>;
} {
  const multiline: Array<[string, string]> = [];
  const remaining: Array<[string, unknown]> = [];

  for (const [name, value] of Object.entries(parsed)) {
    if (isMultilineString(value)) {
      multiline.push([name, value]);
    } else {
      remaining.push([name, value]);
    }
  }

  return { multiline, remaining };
}

function remainingArgsText(multilineCount: number, remaining: Array<[string, unknown]>): string {
  if (multilineCount > 0 && remaining.length === 0) {
    return "";
  }

  return JSON.stringify(Object.fromEntries(remaining), null, 2);
}

function displayArguments(text: string): ArgumentDisplay {
  try {
    const parsed: unknown = JSON.parse(text);

    if (!isPlainObject(parsed)) {
      return { args: JSON.stringify(parsed, null, 2), multiline: [] };
    }

    const { multiline, remaining } = partitionArguments(parsed);

    return { args: remainingArgsText(multiline.length, remaining), multiline };
  } catch {
    return { args: text, multiline: [] };
  }
}

export function ToolCall({ part }: { part: ToolCallPart }) {
  const { args, multiline } = displayArguments(part.arguments);

  return (
    <details open className="min-w-0 rounded-lg border border-border bg-muted/30 p-3">
      <summary className="cursor-pointer break-all text-sm">
        <span className="font-mono">{part.name}</span>
        {" · "}
        <span role="status" className="text-muted-foreground">
          {labels[part.state]}
        </span>
      </summary>
      <div className="mt-2 flex min-w-0 flex-col gap-2">
        <p className="text-xs text-muted-foreground">傳入參數</p>
        {args !== "" || multiline.length === 0 ? (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
            {args || "等待參數…"}
          </pre>
        ) : null}
        {multiline.map(([name, value]) => (
          <div key={name} className="flex min-w-0 flex-col gap-1">
            <p className="break-all font-mono text-xs text-muted-foreground">{name}</p>
            <pre className="max-h-80 max-w-full overflow-auto whitespace-pre rounded-md border border-border bg-background p-3 font-mono text-xs leading-relaxed">
              <code>{value}</code>
            </pre>
          </div>
        ))}
      </div>
    </details>
  );
}
