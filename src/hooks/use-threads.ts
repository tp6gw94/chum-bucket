import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { flushSync } from "react-dom";
import type { StreamChunk } from "@tanstack/ai";
import { fetchServerSentEvents, useChat, type UIMessage } from "@tanstack/ai-react";
import { parseCompactionEvent, type CompactionState } from "../../shared/compaction-event";
import {
  applyToolApprovalEvent,
  parseToolApprovalEvent,
  toolApprovalListSchema,
  type ToolApproval,
} from "../../shared/tool-approval";
import type { ComposerCommand } from "../composer-commands";

const threadSchema = z.object({ id: z.uuid(), title: z.string() });
export type ThreadSummary = z.infer<typeof threadSchema>;
export type PageEntry =
  | { kind: "choose" }
  | { kind: "invalid" }
  | { kind: "thread"; threadId: string };
export type ThreadPhase = "loading" | "ready" | "busy" | "compacting" | "uncertain" | "load-error";
export type SendResult = "succeeded" | "failed" | "uncertain";
export type CompactionNotice = {
  state: Exclude<CompactionState, "started">;
  text: string;
};

const COMPACTION_NOTICES: Record<CompactionNotice["state"], string> = {
  done: "上下文已整理，完整摘要與原文已保留。",
  skipped: "目前沒有足夠的可整理歷史，原文與上下文未變更。",
  failed: "整理上下文失敗，原文與上下文已保留。",
};

export function compactionNotice(state: CompactionNotice["state"]): CompactionNotice {
  return { state, text: COMPACTION_NOTICES[state] };
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

export async function deleteThread(id: string) {
  const response = await fetch(`/api/thread/${encodeURIComponent(z.uuid().parse(id))}`, {
    method: "DELETE",
  });

  if (response.status === 409) {
    throw new Error("對話仍在執行中，無法刪除");
  }

  if (!response.ok && response.status !== 404) {
    throw new Error(`刪除對話失敗（HTTP ${response.status}）`);
  }
}

export function useThreadList(currentId: string | null = null) {
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

  async function remove({ id }: ThreadSummary) {
    setError(null);

    try {
      await deleteThread(id);
    } catch (cause) {
      setError(errorMessage(cause));

      return;
    }

    if (id === currentId) {
      window.location.assign(threadUrl(null));
    } else {
      setThreads((list) => list.filter((thread) => thread.id !== id));
    }
  }

  return { threads, error, remove };
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

export async function* serverSentData(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      return;
    }

    buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
    let boundary = buffer.indexOf("\n\n");

    while (boundary >= 0) {
      const data = buffer
        .slice(0, boundary)
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");

      if (data) {
        yield JSON.parse(data);
      }
    }
  }
}

const customEventSchema = z.object({
  type: z.literal("CUSTOM"),
  name: z.string(),
  value: z.unknown(),
});

async function readThread(threadId: string) {
  const response = await fetch(`/api/thread/${encodeURIComponent(threadId)}`);

  if (!response.ok) {
    throw new Error(`載入對話失敗（HTTP ${response.status}）`);
  }

  return z
    .object({ revision: z.number().int().nonnegative(), messages: z.array(z.unknown()) })
    .parse(await response.json());
}

async function readApprovals(threadId: string): Promise<ToolApproval[]> {
  const response = await fetch(`/api/chat?threadId=${encodeURIComponent(threadId)}`);

  if (!response.ok) {
    throw new Error(`載入批准失敗（HTTP ${response.status}）`);
  }

  return z.object({ approvals: toolApprovalListSchema }).parse(await response.json()).approvals;
}

async function sendApprovalDecision(approval: ToolApproval, approved: boolean) {
  const response = await fetch(
    `/api/chat/approvals/${encodeURIComponent(approval.approvalId)}/decision`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Tool-Approval": "1" },
      body: JSON.stringify({
        threadId: approval.threadId,
        digest: approval.digest,
        tool: approval.tool,
        approved,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`決策未確認（HTTP ${response.status}）`);
  }
}

class RunRejectedError extends Error {}

function compactRejection(status: number) {
  return status === 409 ? "對話正在執行，請稍後再整理上下文" : `整理上下文失敗（HTTP ${status}）`;
}

async function openCompactRun(threadId: string, runId: string) {
  const { revision } = await readThread(threadId).catch((cause: unknown) => {
    throw new RunRejectedError(errorMessage(cause));
  });
  const response = await fetch("/api/compact", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Run-Id": runId },
    body: JSON.stringify({ kind: "compact", threadId, runId, baseRevision: revision }),
  });

  if (!response.ok || !response.body) {
    throw new RunRejectedError(compactRejection(response.status));
  }

  return response.body;
}

export function useThread(threadId: string) {
  const [phase, setPhase] = useState<ThreadPhase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<CompactionNotice | null>(null);
  const [approvals, setApprovals] = useState<ToolApproval[]>([]);
  const owner = useRef({
    phase: "loading" as ThreadPhase,
    compactingFrom: null as ThreadPhase | null,
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
    const base = fetchServerSentEvents("/api/chat");
    let hydration: ReturnType<NonNullable<typeof base.hydrate>> | undefined;

    const observe = async function* (stream: AsyncIterable<StreamChunk>) {
      try {
        for await (const chunk of stream) {
          const terminal = terminalResult(chunk, owner.runId);

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
            void readApprovals(threadId)
              .then((loaded) => {
                if (owner.mounted) {
                  setApprovals(loaded);
                }
              })
              .catch(() => undefined);

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

  function observeCompaction(name: string, value: unknown) {
    const event = parseCompactionEvent(name, value);

    if (!event || (owner.runId !== null && event.runId !== owner.runId)) {
      return;
    }

    if (event.state === "started") {
      if (owner.phase !== "compacting") {
        owner.compactingFrom = owner.phase;
        publish("compacting");
      }

      return;
    }

    if (owner.mounted) {
      setNotice(compactionNotice(event.state));
    }

    if (owner.compactingFrom && owner.phase === "compacting") {
      publish(owner.compactingFrom);
    }

    owner.compactingFrom = null;
  }

  function observeApproval(name: string, value: unknown) {
    const event = parseToolApprovalEvent(name, value);

    if (event && owner.mounted) {
      setApprovals((current) => applyToolApprovalEvent(current, event));
    }
  }

  const chat = useChat({
    connection,
    threadId,
    persistence: true,
    onCustomEvent: (name, value) => {
      observeCompaction(name, value);
      observeApproval(name, value);
    },
  });
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
    let submitted = false;

    try {
      const { revision } = await readThread(threadId);

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

  function beginCompaction(runId: string) {
    flushSync(() => publish("compacting"));
    owner.submitting = true;
    owner.terminal = null;
    owner.compactingFrom = null;
    owner.runId = runId;
    setError(null);
    setNotice(null);
  }

  function observeRunEvent(data: unknown, runId: string) {
    owner.terminal = terminalResult(data, runId) ?? owner.terminal;
    const custom = customEventSchema.safeParse(data);

    if (custom.success) {
      observeCompaction(custom.data.name, custom.data.value);
    }
  }

  async function refreshMessages() {
    const { messages } = await readThread(threadId);

    if (owner.mounted) {
      chat.setMessages(messages as UIMessage[]);
    }
  }

  async function compact(): Promise<SendResult> {
    if (owner.phase !== "ready") {
      throw new Error("目前無法整理上下文");
    }

    const runId = crypto.randomUUID();
    beginCompaction(runId);

    try {
      for await (const data of serverSentData(await openCompactRun(threadId, runId))) {
        observeRunEvent(data, runId);
      }

      await refreshMessages();
    } catch (cause) {
      if (cause instanceof RunRejectedError) {
        publish("ready");
        throw cause;
      }
    } finally {
      owner.submitting = false;
    }

    settle();

    return owner.terminal ?? "uncertain";
  }

  function runCommand(command: ComposerCommand): Promise<SendResult> {
    return { compact }[command]();
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
    notice,
    approvals,
    decideApproval: sendApprovalDecision,
    send,
    runCommand,
    navigate,
  };
}
