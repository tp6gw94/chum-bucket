import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { flushSync } from "react-dom";
import type { StreamChunk } from "@tanstack/ai";
import { fetchServerSentEvents, useChat } from "@tanstack/ai-react";
import {
  readCompactionEvent,
  type CompactionEvent,
  type CompactionTrigger,
} from "../../shared/compaction-event";
import { parseTestingProjectionEvent } from "../../shared/testing";
import { commandRunBody, parseComposerCommand } from "../composer-commands";
import { withPublishedTasks } from "../lib/testing-api";
import { mergeTestingView, mergeTestingViews, type TestingViews } from "../lib/testing-views";

const threadSchema = z.object({ id: z.uuid(), title: z.string() });
export type ThreadSummary = z.infer<typeof threadSchema>;
export type PageEntry =
  | { kind: "choose" }
  | { kind: "invalid" }
  | { kind: "thread"; threadId: string };
export type ThreadPhase = "loading" | "ready" | "busy" | "uncertain" | "load-error";
export type SendResult = "succeeded" | "failed" | "uncertain";

export function readPageEntry(): PageEntry {
  const id = new URL(window.location.href).searchParams.get("threadId");

  if (id === null) {
    return { kind: "choose" };
  }

  return z.uuid().safeParse(id).success ? { kind: "thread", threadId: id } : { kind: "invalid" };
}

export function threadUrl(id: string | null) {
  const url = new URL(window.location.href);

  if (id === null) {
    url.searchParams.delete("threadId");
  } else {
    url.searchParams.set("threadId", z.uuid().parse(id));
  }

  return url.href;
}

export async function createThread(): Promise<ThreadSummary> {
  const response = await fetch("/api/thread", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });

  if (!response.ok) {
    throw new Error(`建立對話失敗（HTTP ${response.status}）`);
  }

  return threadSchema.parse(await response.json());
}

export function useThreadList() {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/thread", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`載入對話失敗（HTTP ${response.status}）`);
        }

        const list = z.array(threadSchema).parse(await response.json());

        if (!controller.signal.aborted) {
          setThreads(list);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(cause));
        }
      });

    return () => controller.abort();
  }, []);

  return { threads, error };
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : "對話連線失敗";
}

const eventSchema = z.object({
  type: z.string(),
  runId: z.string().optional(),
  finishReason: z.string().optional(),
  metadata: z
    .object({
      tanstack: z
        .object({ runId: z.string().optional(), finishReason: z.string().optional() })
        .optional(),
    })
    .optional(),
});

export function terminalResult(event: unknown, runId: string | null): SendResult | null {
  const parsed = eventSchema.safeParse(event);

  if (!parsed.success || runId === null) {
    return null;
  }

  const chunk = parsed.data;

  if ((chunk.runId ?? chunk.metadata?.tanstack?.runId) !== runId) {
    return null;
  }

  if (chunk.type === "RUN_ERROR") {
    return "failed";
  }

  if (
    chunk.type === "RUN_FINISHED" &&
    chunk.finishReason !== "tool_calls" &&
    chunk.metadata?.tanstack?.finishReason !== "tool_calls"
  ) {
    return "succeeded";
  }

  return null;
}

const TRIGGER_LABEL: Record<CompactionTrigger, string> = {
  threshold: "接近上下文上限",
  overflow: "超出上下文上限",
  manual: "手動壓縮",
  "side-chat": "附屬對話",
};

function formatTokens(tokens: number) {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

export function compactionProgress(event: CompactionEvent): string {
  const label = TRIGGER_LABEL[event.trigger];

  switch (event.phase) {
    case "started":
      return event.trigger === "side-chat"
        ? `正在摘要主對話（約 ${formatTokens(event.tokensBefore)} tokens）…`
        : `${label}：正在壓縮對話脈絡（約 ${formatTokens(event.tokensBefore)} tokens）…`;
    case "done":
      return event.trigger === "side-chat"
        ? `已帶入主對話摘要（約 ${formatTokens(event.tokensAfter)} tokens）`
        : `${label}：已壓縮 ${event.compactedMessages} 則訊息，約 ${formatTokens(event.tokensBefore)} → ${formatTokens(event.tokensAfter)} tokens`;
    case "skipped":
      return `${label}：目前沒有可壓縮的訊息`;
    case "failed":
      return `${label}：壓縮失敗（${event.error}）`;
  }
}

export function compactionLines(event: CompactionEvent | null): string[] {
  return event && event.phase !== "done" ? [compactionProgress(event)] : [];
}

export function useThread(threadId: string) {
  const [phase, setPhase] = useState<ThreadPhase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [compaction, setCompaction] = useState<CompactionEvent | null>(null);
  const [testing, setTesting] = useState<TestingViews>({});
  const owner = useRef({
    phase: "loading" as ThreadPhase,
    mounted: true,
    hydrating: true,
    submitting: false,
    runId: null as string | null,
    terminal: null as SendResult | null,
    hydrationTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    terminalTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  }).current;

  function publish(next: ThreadPhase) {
    owner.phase = next;

    if (owner.mounted) {
      setPhase(next);
    }
  }

  function settle() {
    if (!owner.mounted || owner.hydrating || owner.submitting) {
      return;
    }

    if (owner.terminal) {
      publish("ready");
      setError(owner.terminal === "failed" ? "執行失敗，已保留原文。" : null);
    } else {
      publish("uncertain");
      setError("執行結果尚未確認，請重新載入此對話。原文已保留，請勿重複送出。");
    }
  }

  const connection = useMemo(() => {
    const base = fetchServerSentEvents("/api/chat", {
      fetchClient: withPublishedTasks((views) => {
        if (owner.mounted) {
          setTesting((current) => mergeTestingViews(current, views));
        }
      }),
    });
    let hydration: ReturnType<NonNullable<typeof base.hydrate>> | undefined;

    const observe = async function* (stream: AsyncIterable<StreamChunk>) {
      try {
        for await (const chunk of stream) {
          const terminal = terminalResult(chunk, owner.runId);
          const compacted = readCompactionEvent(chunk);
          const view = parseTestingProjectionEvent(chunk);

          if (terminal) {
            owner.terminal = terminal;
          }

          if (compacted && owner.mounted) {
            setCompaction(compacted);
          }

          if (view && owner.mounted) {
            setTesting((current) => mergeTestingView(current, view));
          }

          yield chunk;
        }
      } finally {
        if (owner.mounted) {
          owner.terminalTimer = setTimeout(settle, 0);
        }
      }
    };

    return {
      ...base,
      async *connect(...args: Parameters<typeof base.connect>) {
        owner.runId = args[3]?.runId ?? null;

        for await (const chunk of observe(base.connect(...args))) {
          yield chunk;
        }
      },
      async *joinRun(...args: Parameters<NonNullable<typeof base.joinRun>>) {
        for await (const chunk of observe(base.joinRun!(...args))) {
          yield chunk;
        }
      },
      hydrate(...args: Parameters<NonNullable<typeof base.hydrate>>) {
        return (hydration ??= base.hydrate!(...args)
          .then((result) => {
            if (owner.mounted) {
              owner.runId = result.activeRun?.runId ?? null;

              if (owner.runId) {
                publish("busy");
              }

              owner.hydrationTimer = setTimeout(() => {
                owner.hydrating = false;

                if (!owner.mounted) {
                  return;
                }

                if (owner.terminal) {
                  settle();
                } else if (!owner.runId && owner.phase === "loading") {
                  publish("ready");
                }
              }, 0);
            }

            return result;
          })
          .catch((cause: unknown) => {
            if (owner.mounted) {
              publish("load-error");
              setError(`載入對話失敗：${errorMessage(cause)}`);
            }

            throw cause;
          }));
      },
    };
  }, [threadId]);
  const chat = useChat({ connection, threadId, persistence: true });
  useEffect(() => {
    owner.mounted = true;

    return () => {
      owner.mounted = false;
      clearTimeout(owner.hydrationTimer);
      clearTimeout(owner.terminalTimer);
    };
  }, [owner]);

  async function send(text: string): Promise<SendResult> {
    if (owner.phase !== "ready" || !text.trim()) {
      throw new Error("目前無法送出訊息");
    }

    flushSync(() => publish("busy"));
    owner.submitting = true;
    owner.terminal = null;
    setError(null);
    setCompaction(null);
    const command = parseComposerCommand(text);
    let submitted = false;

    try {
      const response = await fetch(`/api/thread/${encodeURIComponent(threadId)}`);

      if (!response.ok) {
        throw new Error(`載入對話失敗（HTTP ${response.status}）`);
      }

      const { revision } = z
        .object({ revision: z.number().int().nonnegative() })
        .parse(await response.json());

      if (!owner.mounted) {
        throw new Error("頁面已離開");
      }

      submitted = true;
      await chat.sendMessage(text.trim(), { body: commandRunBody(command, revision) });
    } catch (cause) {
      if (!submitted) {
        publish("ready");
        throw cause;
      }
    } finally {
      if (submitted) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }

      owner.submitting = false;
    }

    settle();

    return owner.terminal ?? "uncertain";
  }

  function navigate(id: string | null) {
    if (owner.phase !== "ready" || id === threadId) {
      return false;
    }

    const url = threadUrl(id);
    flushSync(() => publish("busy"));
    window.location.assign(url);

    return true;
  }

  return {
    messages: chat.messages,
    phase,
    error,
    progress: compactionLines(compaction),
    testing,
    updateTesting: (view: Parameters<typeof mergeTestingView>[1]) =>
      setTesting((current) => mergeTestingView(current, view)),
    send,
    navigate,
  };
}
