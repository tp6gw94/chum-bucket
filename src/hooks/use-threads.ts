import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { flushSync } from "react-dom";
import { StreamProcessor, type StreamChunk } from "@tanstack/ai";
import { parseComposerCommand } from "../composer-commands";
import { fetchServerSentEvents, useChat } from "@tanstack/ai-react";
import { parseCompactionEvent } from "@/shared/compaction-event";
import {
  parsePublishedTesting,
  parseTestView,
  parseTestingProjectionEvent,
} from "@/shared/testing-event";
import type { TestRunId, TestView } from "@/shared/testing";
import { mergeHydratedTestingView, mergeTestingView } from "../lib/testing-projections";
import {
  SIDE_SCOPE_HEADER,
  SideChatOperationError,
  isDefinitiveTransferRejection,
  transferReceiptSchema,
  type TransferReceipt,
} from "@/shared/side-chat";

const threadSchema = z.object({ id: z.uuid(), title: z.string() });
type ThreadRecord = z.infer<typeof threadSchema>;
export type PageEntry =
  | { kind: "choose" }
  | { kind: "invalid" }
  | { kind: "thread"; threadId: string };
export type ThreadPhase = "loading" | "ready" | "busy" | "compacting" | "uncertain" | "load-error";
export type SendResult = "succeeded" | "failed" | "uncertain";
export type CompactNotice = "done" | "skipped" | "failed";

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

export async function createThread(): Promise<ThreadRecord> {
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
  const [threads, setThreads] = useState<ThreadRecord[]>([]);
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

function isHydrationRequest(url: string | URL | Request, init?: RequestInit): boolean {
  const method = init?.method ?? (url instanceof Request ? url.method : "GET");
  if (method.toUpperCase() !== "GET") {
    return false;
  }
  const parsed = new URL(url instanceof Request ? url.url : String(url), window.location.href);
  return (
    parsed.pathname === "/api/chat" &&
    parsed.searchParams.has("threadId") &&
    !parsed.searchParams.has("runId")
  );
}

export function useThread(threadId: string, sideScope?: string) {
  const scopedFetch: typeof fetch = (url, init) => {
    const headers = new Headers(init?.headers);
    if (sideScope) {
      headers.set(SIDE_SCOPE_HEADER, sideScope);
    }
    return fetch(url, { ...init, headers });
  };
  const [phase, setPhase] = useState<ThreadPhase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [compactNotice, setCompactNotice] = useState<CompactNotice | null>(null);
  const [testingViews, setTestingViews] = useState<readonly TestView[]>([]);
  const owner = useRef({
    phase: "loading" as ThreadPhase,
    mounted: true,
    hydrating: true,
    submitting: false,
    runId: null as string | null,
    terminal: null as SendResult | null,
    compactOperationId: null as string | null,
    commandRejected: false,
    unresolvedTransferKey: null as string | null,
    hydrationTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    terminalTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    commandController: null as AbortController | null,
  }).current;
  function publish(next: ThreadPhase) {
    owner.phase = next;
    if (owner.mounted) {
      setPhase(next);
    }
  }
  function settle() {
    owner.compactOperationId = null;
    if (!owner.mounted || owner.hydrating || owner.submitting) {
      return;
    }
    if (owner.terminal) {
      publish("ready");
      setError(owner.terminal === "failed" ? "執行失敗，已保留原文。" : null);
    } else if (owner.commandRejected) {
      publish("uncertain");
      setError("命令未被接受，對話已變更或忙碌中，請重新載入。");
    } else {
      publish("uncertain");
      setError("執行結果尚未確認，請重新載入此對話。原文已保留，請勿重複送出。");
    }
  }
  const observedStream = useRef<
    ((stream: AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>) | null
  >(null);
  const connection = useMemo(() => {
    const hydrationFetch: typeof fetch = async (url, init) => {
      const response = await scopedFetch(url, init);
      if (!sideScope && isHydrationRequest(url, init)) {
        void response
          .clone()
          .json()
          .then((payload: unknown) => {
            const published = parsePublishedTesting(payload);
            if (published && owner.mounted) {
              setTestingViews((current) => mergeHydratedTestingView(current, published));
            }
          })
          .catch(() => undefined);
      }
      return response;
    };
    const base = fetchServerSentEvents("/api/chat", { fetchClient: hydrationFetch });
    let hydration: ReturnType<NonNullable<typeof base.hydrate>> | undefined;
    const observe = async function* (stream: AsyncIterable<StreamChunk>) {
      try {
        for await (const chunk of stream) {
          const terminal = terminalResult(chunk, owner.runId);
          if (terminal) {
            owner.terminal = terminal;
            owner.compactOperationId = null;
          }
          const compaction = parseCompactionEvent(chunk);
          if (!owner.terminal && compaction && compaction.runId === owner.runId) {
            if (compaction.state === "started") {
              owner.compactOperationId = compaction.operationId;
              publish("compacting");
            } else {
              if (owner.mounted) {
                setCompactNotice(compaction.state);
              }
              owner.compactOperationId = null;
              publish("busy");
            }
          }
          if (!sideScope) {
            const projection = parseTestingProjectionEvent(chunk);
            if (projection && owner.mounted) {
              setTestingViews((current) => mergeTestingView(current, projection));
            }
          }
          yield chunk;
        }
      } finally {
        owner.compactOperationId = null;
        if (owner.mounted) {
          owner.terminalTimer = setTimeout(settle, 0);
        }
      }
    };
    observedStream.current = observe;
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
              owner.compactOperationId = null;
              publish("load-error");
              setError(`載入對話失敗：${errorMessage(cause)}`);
            }
            throw cause;
          }));
      },
    };
  }, [threadId, sideScope]);
  const chat = useChat({ connection, threadId, persistence: true });
  useEffect(() => {
    owner.mounted = true;
    return () => {
      owner.mounted = false;
      owner.commandController?.abort();
      clearTimeout(owner.hydrationTimer);
      clearTimeout(owner.terminalTimer);
    };
  }, [owner]);

  async function currentRevision() {
    const response = await scopedFetch(
      sideScope
        ? `/api/chat?threadId=${encodeURIComponent(threadId)}`
        : `/api/thread/${encodeURIComponent(threadId)}`,
    );
    if (!response.ok) {
      throw new Error(`載入對話失敗（HTTP ${response.status}）`);
    }
    const { revision } = z
      .object({ revision: z.number().int().nonnegative() })
      .parse(await response.json());
    if (!owner.mounted) {
      throw new Error("頁面已離開");
    }
    return revision;
  }

  async function sendCompact(revision: number, command: "compact") {
    owner.runId = `run-${crypto.randomUUID()}`;
    const controller = new AbortController();
    owner.commandController = controller;
    const transport = fetchServerSentEvents("/api/compact", {
      fetchClient: async (_url, init) => {
        const response = await scopedFetch("/api/compact", {
          ...init,
          body: JSON.stringify({
            threadId,
            runId: owner.runId,
            baseRevision: revision,
            kind: command,
          }),
        });
        if (response.status === 409) {
          owner.commandRejected = true;
        }
        return response;
      },
      reconnect: { maxAttempts: 0 },
    });
    const stream = transport.connect([], {}, controller.signal, {
      runId: owner.runId,
      threadId,
    });
    await consumeAcceptedStream(stream);
  }

  async function consumeAcceptedStream(stream: AsyncIterable<StreamChunk>) {
    const processor = new StreamProcessor({ initialMessages: structuredClone(chat.messages) });
    for await (const chunk of observedStream.current!(stream)) {
      processor.processChunk(chunk);
      if (owner.mounted) {
        chat.setMessages(processor.getMessages());
      }
    }
  }

  async function acceptExternalRun(
    accept: () => Promise<TransferReceipt>,
    transferKey: string,
  ): Promise<TransferReceipt> {
    if (
      owner.submitting ||
      (owner.phase !== "ready" &&
        !(owner.phase === "uncertain" && owner.unresolvedTransferKey === transferKey))
    ) {
      throw new SideChatOperationError(
        "blocked",
        owner.unresolvedTransferKey
          ? "主對話有尚未確認的回填，請先在原附屬對話重試同一筆回填。"
          : "主對話忙碌或結果尚未確認，摘要草稿已保留。",
      );
    }
    owner.unresolvedTransferKey = transferKey;
    flushSync(() => publish("busy"));
    owner.submitting = true;
    owner.terminal = null;
    owner.commandRejected = false;
    owner.compactOperationId = null;
    setError(null);
    setCompactNotice(null);
    let receipt: TransferReceipt;
    try {
      receipt = transferReceiptSchema.parse(await accept());
      if (receipt.parentThreadId !== threadId || receipt.transferKey !== transferKey) {
        throw new Error("摘要回填收據不符");
      }
    } catch (cause) {
      owner.submitting = false;
      if (isDefinitiveTransferRejection(cause)) {
        owner.unresolvedTransferKey = null;
        publish("ready");
        throw cause;
      }
      const uncertain = new SideChatOperationError(
        "uncertain",
        "回填結果尚未確認。請在原附屬對話重試同一筆回填，請勿另行送出。",
        { cause },
      );
      publish("uncertain");
      setError(uncertain.message);
      throw uncertain;
    }
    owner.unresolvedTransferKey = null;
    owner.runId = receipt.mainRunId;
    const controller = new AbortController();
    owner.commandController = controller;
    void consumeAcceptedStream(connection.joinRun(receipt.mainRunId, controller.signal))
      .catch((cause: unknown) => {
        if (owner.mounted) {
          setError(errorMessage(cause));
        }
      })
      .finally(() => {
        owner.submitting = false;
        owner.commandController = null;
        settle();
      });
    return receipt;
  }

  async function send(text: string): Promise<SendResult> {
    if (owner.phase !== "ready" || !text.trim()) {
      throw new Error("目前無法送出訊息");
    }
    const command = parseComposerCommand(text);
    flushSync(() => publish(command ? "compacting" : "busy"));
    owner.submitting = true;
    owner.terminal = null;
    owner.commandRejected = false;
    owner.compactOperationId = null;
    setError(null);
    setCompactNotice(null);
    let submitted = false;
    try {
      const revision = await currentRevision();
      submitted = true;
      if (command) {
        await sendCompact(revision, command);
      } else {
        await chat.sendMessage(text, { body: { baseRevision: revision } });
      }
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
      owner.commandController = null;
    }
    settle();
    return owner.commandRejected ? "failed" : (owner.terminal ?? "uncertain");
  }
  async function cancelTesting(runId: TestRunId): Promise<void> {
    if (sideScope) {
      throw new Error("附屬對話不支援測試取消。");
    }
    let response: Response;
    try {
      response = await fetch(`/api/testing/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId }),
      });
    } catch {
      throw new Error("取消要求無法送出，請稍後再試。");
    }
    if (!response.ok) {
      throw new Error(`伺服器回應異常（HTTP ${response.status}）。`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("伺服器回應無法解析。");
    }
    const view = parseTestView(payload);
    if (!view || view.runId !== runId) {
      throw new Error("伺服器回應與取消要求不符。");
    }
    if (owner.mounted) {
      setTestingViews((current) => mergeTestingView(current, view));
    }
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
    compactNotice,
    testingViews,
    cancelTesting,
    send,
    compact: () => send("/compact"),
    acceptExternalRun,
    navigate,
  };
}
