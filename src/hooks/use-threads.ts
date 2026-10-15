import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { flushSync } from "react-dom";
import type { StreamChunk, UIMessage } from "@tanstack/ai";
import { fetchServerSentEvents, useChat } from "@tanstack/ai-react";
import { parseCompactionEvent, type CompactionState } from "../../shared/compaction-event";
import { parseComposerCommand } from "../composer-commands";

const threadSchema = z.object({ id: z.uuid(), title: z.string() });
export type ThreadSummary = z.infer<typeof threadSchema>;
export type PageEntry =
  | { kind: "choose" }
  | { kind: "invalid" }
  | { kind: "thread"; threadId: string };
export type ThreadPhase = "loading" | "ready" | "busy" | "compacting" | "uncertain" | "load-error";
export type SendResult = "succeeded" | "failed" | "uncertain";
export type ThreadNotice = { state: Exclude<CompactionState, "started">; message: string };

const PHASE_STATUS: Partial<Record<ThreadPhase, "running" | "compacting">> = {
  busy: "running",
  compacting: "compacting",
};

export function threadStatus(phase: ThreadPhase): "running" | "compacting" | "idle" {
  return PHASE_STATUS[phase] ?? "idle";
}

const COMPACTION_NOTICES: Record<ThreadNotice["state"], string> = {
  done: "上下文已整理，完整摘要與原文已保留。",
  skipped: "目前沒有足夠的可整理歷史，原文與上下文未變更。",
  failed: "整理上下文失敗，原文與上下文已保留。",
};

export function compactionNotice(event: unknown): ThreadNotice | "started" | null {
  const value = parseCompactionEvent(event);

  if (!value) {
    return null;
  }

  return value.state === "started"
    ? "started"
    : { state: value.state, message: COMPACTION_NOTICES[value.state] };
}

export async function readServerSentEvents(
  response: Response,
  onEvent: (event: unknown) => void,
): Promise<void> {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();

    if (done) {
      return;
    }

    buffer += value;
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");

      if (data) {
        onEvent(JSON.parse(data));
      }
    }
  }
}

async function threadRevision(threadId: string) {
  const response = await fetch(`/api/thread/${encodeURIComponent(threadId)}`);

  if (!response.ok) {
    throw new Error(`載入對話失敗（HTTP ${response.status}）`);
  }

  return z.object({ revision: z.number().int().nonnegative() }).parse(await response.json())
    .revision;
}

async function savedMessages(threadId: string): Promise<UIMessage[]> {
  const response = await fetch(`/api/chat?threadId=${encodeURIComponent(threadId)}`);

  if (!response.ok) {
    throw new Error(`載入對話失敗（HTTP ${response.status}）`);
  }

  return ((await response.json()) as { messages: UIMessage[] }).messages;
}

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

export function useThread(threadId: string) {
  const [phase, setPhase] = useState<ThreadPhase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ThreadNotice | null>(null);
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

  function noteCompaction(chunk: unknown) {
    const compaction = compactionNotice(chunk);

    if (compaction === "started") {
      publish("compacting");
    } else if (compaction) {
      setNotice(compaction);

      if (owner.phase === "compacting") {
        publish("busy");
      }
    }
  }

  const connection = useMemo(() => {
    const base = fetchServerSentEvents("/api/chat");
    let hydration: ReturnType<NonNullable<typeof base.hydrate>> | undefined;

    const observe = async function* (stream: AsyncIterable<StreamChunk>) {
      try {
        for await (const chunk of stream) {
          const terminal = terminalResult(chunk, owner.runId);
          noteCompaction(chunk);

          if (terminal) {
            owner.terminal = terminal;
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

  async function compact(): Promise<SendResult> {
    flushSync(() => publish("compacting"));
    setError(null);
    setNotice(null);
    const runId = crypto.randomUUID();
    let terminal: SendResult | null = null;

    try {
      const response = await fetch("/api/compact", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Run-Id": runId },
        body: JSON.stringify({
          kind: "compact",
          threadId,
          runId,
          baseRevision: await threadRevision(threadId),
        }),
      });

      if (!response.ok) {
        throw new Error(`整理上下文失敗（HTTP ${response.status}）`);
      }

      await readServerSentEvents(response, (event) => {
        terminal = terminalResult(event, runId) ?? terminal;
        const compaction = compactionNotice(event);

        if (compaction && compaction !== "started") {
          setNotice(compaction);
        }
      });
      chat.setMessages(await savedMessages(threadId));
    } finally {
      publish("ready");
    }

    return terminal ?? "uncertain";
  }

  async function send(text: string): Promise<SendResult> {
    if (owner.phase !== "ready" || !text.trim()) {
      throw new Error("目前無法送出訊息");
    }

    if (parseComposerCommand(text) === "compact") {
      return compact();
    }

    flushSync(() => publish("busy"));
    owner.submitting = true;
    owner.terminal = null;
    setError(null);
    setNotice(null);
    let submitted = false;

    try {
      const revision = await threadRevision(threadId);

      if (!owner.mounted) {
        throw new Error("頁面已離開");
      }

      submitted = true;
      await chat.sendMessage(text, { body: { baseRevision: revision } });
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

  return { messages: chat.messages, phase, error, notice, send, navigate };
}
