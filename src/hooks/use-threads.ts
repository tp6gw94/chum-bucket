import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { z } from "zod";
import { flushSync } from "react-dom";
import { StreamProcessor, type StreamChunk } from "@tanstack/ai";
import { parseComposerCommand } from "../composer-commands";
import { fetchServerSentEvents, useChat } from "@tanstack/ai-react";
import { parseCompactionEvent } from "@/shared/compaction-event";
import {
  parsePublishedTasks,
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

type ThreadOwner = {
  phase: ThreadPhase;
  mounted: boolean;
  hydrating: boolean;
  submitting: boolean;
  runId: string | null;
  terminal: SendResult | null;
  compactOperationId: string | null;
  commandRejected: boolean;
  unresolvedTransferKey: string | null;
  hydrationTimer: ReturnType<typeof setTimeout> | undefined;
  terminalTimer: ReturnType<typeof setTimeout> | undefined;
  commandController: AbortController | null;
};

type ThreadState = Readonly<{
  owner: ThreadOwner;
  setPhase: (phase: ThreadPhase) => void;
  setError: (error: string | null) => void;
  setCompactNotice: (notice: CompactNotice | null) => void;
  setTestingViews: Dispatch<SetStateAction<readonly TestView[]>>;
}>;

type StreamObserver = (stream: AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>;
type BaseConnection = ReturnType<typeof fetchServerSentEvents>;
type HydrationResult = Awaited<ReturnType<NonNullable<BaseConnection["hydrate"]>>>;

function createOwner(): ThreadOwner {
  return {
    phase: "loading",
    mounted: true,
    hydrating: true,
    submitting: false,
    runId: null,
    terminal: null,
    compactOperationId: null,
    commandRejected: false,
    unresolvedTransferKey: null,
    hydrationTimer: undefined,
    terminalTimer: undefined,
    commandController: null,
  };
}

function scopedFetcher(sideScope: string | undefined): typeof fetch {
  return (url, init) => {
    const headers = new Headers(init?.headers);

    if (sideScope) {
      headers.set(SIDE_SCOPE_HEADER, sideScope);
    }

    return fetch(url, { ...init, headers });
  };
}

function publish(state: ThreadState, next: ThreadPhase) {
  state.owner.phase = next;

  if (state.owner.mounted) {
    state.setPhase(next);
  }
}

function settle(state: ThreadState) {
  const { owner } = state;
  owner.compactOperationId = null;

  if (!owner.mounted || owner.hydrating || owner.submitting) {
    return;
  }

  if (owner.terminal) {
    publish(state, "ready");
    state.setError(owner.terminal === "failed" ? "執行失敗，已保留原文。" : null);

    return;
  }

  publish(state, "uncertain");
  state.setError(
    owner.commandRejected
      ? "命令未被接受，對話已變更或忙碌中，請重新載入。"
      : "執行結果尚未確認，請重新載入此對話。原文已保留，請勿重複送出。",
  );
}

function observeCompaction(state: ThreadState, chunk: StreamChunk) {
  const { owner } = state;
  const compaction = parseCompactionEvent(chunk);

  if (owner.terminal || !compaction || compaction.runId !== owner.runId) {
    return;
  }

  if (compaction.state === "started") {
    owner.compactOperationId = compaction.operationId;
    publish(state, "compacting");

    return;
  }

  if (owner.mounted) {
    state.setCompactNotice(compaction.state);
  }

  owner.compactOperationId = null;
  publish(state, "busy");
}

function observeProjection(state: ThreadState, chunk: StreamChunk) {
  const projection = parseTestingProjectionEvent(chunk);

  if (projection && state.owner.mounted) {
    state.setTestingViews((current) => mergeTestingView(current, projection));
  }
}

function observeChunk(state: ThreadState, chunk: StreamChunk, sideScope: string | undefined) {
  const { owner } = state;
  const terminal = terminalResult(chunk, owner.runId);

  if (terminal) {
    owner.terminal = terminal;
    owner.compactOperationId = null;
  }

  observeCompaction(state, chunk);

  if (!sideScope) {
    observeProjection(state, chunk);
  }
}

function streamObserver(state: ThreadState, sideScope: string | undefined): StreamObserver {
  return async function* (stream) {
    try {
      for await (const chunk of stream) {
        observeChunk(state, chunk, sideScope);
        yield chunk;
      }
    } finally {
      state.owner.compactOperationId = null;

      if (state.owner.mounted) {
        state.owner.terminalTimer = setTimeout(() => settle(state), 0);
      }
    }
  };
}

function absorbPublishedTesting(state: ThreadState, response: Response) {
  void response
    .clone()
    .json()
    .then((payload: unknown) => {
      const published = parsePublishedTasks(payload);

      if (state.owner.mounted) {
        state.setTestingViews((current) => published.reduce(mergeHydratedTestingView, current));
      }
    })
    .catch(() => undefined);
}

function hydrationFetcher(
  state: ThreadState,
  scopedFetch: typeof fetch,
  sideScope: string | undefined,
): typeof fetch {
  return async (url, init) => {
    const response = await scopedFetch(url, init);

    if (!sideScope && isHydrationRequest(url, init)) {
      absorbPublishedTesting(state, response);
    }

    return response;
  };
}

function finishHydration(state: ThreadState) {
  const { owner } = state;
  owner.hydrating = false;

  if (!owner.mounted) {
    return;
  }

  if (owner.terminal) {
    settle(state);
  } else if (!owner.runId && owner.phase === "loading") {
    publish(state, "ready");
  }
}

function hydrated(state: ThreadState, result: HydrationResult): HydrationResult {
  const { owner } = state;

  if (!owner.mounted) {
    return result;
  }

  owner.runId = result.activeRun?.runId ?? null;

  if (owner.runId) {
    publish(state, "busy");
  }

  owner.hydrationTimer = setTimeout(() => finishHydration(state), 0);

  return result;
}

function hydrationFailed(state: ThreadState, cause: unknown): never {
  if (state.owner.mounted) {
    state.owner.compactOperationId = null;
    publish(state, "load-error");
    state.setError(`載入對話失敗：${errorMessage(cause)}`);
  }

  throw cause;
}

function createConnection(state: ThreadState, sideScope: string | undefined) {
  const base = fetchServerSentEvents("/api/chat", {
    fetchClient: hydrationFetcher(state, scopedFetcher(sideScope), sideScope),
  });
  const observe = streamObserver(state, sideScope);
  let hydration: Promise<HydrationResult> | undefined;

  return {
    observe,
    connection: {
      ...base,
      async *connect(...args: Parameters<typeof base.connect>) {
        state.owner.runId = args[3]?.runId ?? null;

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
          .then((result) => hydrated(state, result))
          .catch((cause: unknown) => hydrationFailed(state, cause)));
      },
    },
  };
}

type ThreadConnection = ReturnType<typeof createConnection>["connection"];

type ThreadRuntime = Readonly<{
  state: ThreadState;
  threadId: string;
  sideScope: string | undefined;
  chat: ReturnType<typeof useChat>;
  connection: ThreadConnection;
  observe: StreamObserver;
}>;

async function currentRevision(runtime: ThreadRuntime) {
  const { threadId, sideScope } = runtime;
  const response = await scopedFetcher(sideScope)(
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

  if (!runtime.state.owner.mounted) {
    throw new Error("頁面已離開");
  }

  return revision;
}

async function consumeAcceptedStream(runtime: ThreadRuntime, stream: AsyncIterable<StreamChunk>) {
  const { chat, state } = runtime;
  const processor = new StreamProcessor({ initialMessages: structuredClone(chat.messages) });

  for await (const chunk of runtime.observe(stream)) {
    processor.processChunk(chunk);

    if (state.owner.mounted) {
      chat.setMessages(processor.getMessages());
    }
  }
}

async function sendCompact(runtime: ThreadRuntime, revision: number, command: "compact") {
  const { owner } = runtime.state;
  const { threadId } = runtime;
  owner.runId = `run-${crypto.randomUUID()}`;
  const controller = new AbortController();
  owner.commandController = controller;
  const transport = fetchServerSentEvents("/api/compact", {
    fetchClient: async (_url, init) => {
      const response = await scopedFetcher(runtime.sideScope)("/api/compact", {
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
  await consumeAcceptedStream(runtime, stream);
}

function beginSubmission(state: ThreadState, phase: ThreadPhase) {
  const { owner } = state;
  flushSync(() => publish(state, phase));
  owner.submitting = true;
  owner.terminal = null;
  owner.commandRejected = false;
  owner.compactOperationId = null;
  state.setError(null);
  state.setCompactNotice(null);
}

function transferBlocked(owner: ThreadOwner, transferKey: string): boolean {
  if (owner.submitting) {
    return true;
  }

  return (
    owner.phase !== "ready" &&
    !(owner.phase === "uncertain" && owner.unresolvedTransferKey === transferKey)
  );
}

async function acceptedReceipt(
  runtime: ThreadRuntime,
  accept: () => Promise<TransferReceipt>,
  transferKey: string,
): Promise<TransferReceipt> {
  const { state } = runtime;

  try {
    const receipt = transferReceiptSchema.parse(await accept());

    if (receipt.parentThreadId !== runtime.threadId || receipt.transferKey !== transferKey) {
      throw new Error("摘要回填收據不符");
    }

    return receipt;
  } catch (cause) {
    state.owner.submitting = false;

    if (isDefinitiveTransferRejection(cause)) {
      state.owner.unresolvedTransferKey = null;
      publish(state, "ready");
      throw cause;
    }

    const uncertain = new SideChatOperationError(
      "uncertain",
      "回填結果尚未確認。請在原附屬對話重試同一筆回填，請勿另行送出。",
      { cause },
    );
    publish(state, "uncertain");
    state.setError(uncertain.message);
    throw uncertain;
  }
}

function joinAcceptedRun(runtime: ThreadRuntime, receipt: TransferReceipt) {
  const { state } = runtime;
  const { owner } = state;
  owner.unresolvedTransferKey = null;
  owner.runId = receipt.mainRunId;
  const controller = new AbortController();
  owner.commandController = controller;
  void consumeAcceptedStream(
    runtime,
    runtime.connection.joinRun(receipt.mainRunId, controller.signal),
  )
    .catch((cause: unknown) => {
      if (owner.mounted) {
        state.setError(errorMessage(cause));
      }
    })
    .finally(() => {
      owner.submitting = false;
      owner.commandController = null;
      settle(state);
    });
}

async function acceptExternalRun(
  runtime: ThreadRuntime,
  accept: () => Promise<TransferReceipt>,
  transferKey: string,
): Promise<TransferReceipt> {
  const { state } = runtime;
  const { owner } = state;

  if (transferBlocked(owner, transferKey)) {
    throw new SideChatOperationError(
      "blocked",
      owner.unresolvedTransferKey
        ? "主對話有尚未確認的回填，請先在原附屬對話重試同一筆回填。"
        : "主對話忙碌或結果尚未確認，摘要草稿已保留。",
    );
  }

  owner.unresolvedTransferKey = transferKey;
  beginSubmission(state, "busy");
  const receipt = await acceptedReceipt(runtime, accept, transferKey);
  joinAcceptedRun(runtime, receipt);

  return receipt;
}

async function dispatchTurn(
  runtime: ThreadRuntime,
  text: string,
  command: ReturnType<typeof parseComposerCommand>,
  revision: number,
) {
  if (command) {
    await sendCompact(runtime, revision, command);
  } else {
    await runtime.chat.sendMessage(text, { body: { baseRevision: revision } });
  }
}

function sendResult(owner: ThreadOwner): SendResult {
  return owner.commandRejected ? "failed" : (owner.terminal ?? "uncertain");
}

async function send(runtime: ThreadRuntime, text: string): Promise<SendResult> {
  const { state } = runtime;
  const { owner } = state;

  if (owner.phase !== "ready" || !text.trim()) {
    throw new Error("目前無法送出訊息");
  }

  const command = parseComposerCommand(text);
  beginSubmission(state, command ? "compacting" : "busy");
  let submitted = false;

  try {
    const revision = await currentRevision(runtime);
    submitted = true;
    await dispatchTurn(runtime, text, command, revision);
  } catch (cause) {
    if (!submitted) {
      publish(state, "ready");
      throw cause;
    }
  } finally {
    if (submitted) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    owner.submitting = false;
    owner.commandController = null;
  }

  settle(state);

  return sendResult(owner);
}

async function requestTestingCancel(threadId: string, runId: TestRunId): Promise<unknown> {
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

  try {
    return await response.json();
  } catch {
    throw new Error("伺服器回應無法解析。");
  }
}

async function cancelTesting(runtime: ThreadRuntime, runId: TestRunId): Promise<void> {
  if (runtime.sideScope) {
    throw new Error("附屬對話不支援測試取消。");
  }

  const view = parseTestView(await requestTestingCancel(runtime.threadId, runId));

  if (!view || view.runId !== runId) {
    throw new Error("伺服器回應與取消要求不符。");
  }

  if (runtime.state.owner.mounted) {
    runtime.state.setTestingViews((current) => mergeTestingView(current, view));
  }
}

function navigate(runtime: ThreadRuntime, id: string | null) {
  if (runtime.state.owner.phase !== "ready" || id === runtime.threadId) {
    return false;
  }

  const url = threadUrl(id);
  flushSync(() => publish(runtime.state, "busy"));
  window.location.assign(url);

  return true;
}

export function useThread(threadId: string, sideScope?: string) {
  const [phase, setPhase] = useState<ThreadPhase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [compactNotice, setCompactNotice] = useState<CompactNotice | null>(null);
  const [testingViews, setTestingViews] = useState<readonly TestView[]>([]);
  const owner = useRef(createOwner()).current;
  const state: ThreadState = { owner, setPhase, setError, setCompactNotice, setTestingViews };
  const observedStream = useRef<StreamObserver | null>(null);
  const connection = useMemo(() => {
    const created = createConnection(state, sideScope);
    observedStream.current = created.observe;

    return created.connection;
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
  const runtime: ThreadRuntime = {
    state,
    threadId,
    sideScope,
    chat,
    connection,
    observe: (stream) => observedStream.current!(stream),
  };

  return {
    messages: chat.messages,
    phase,
    error,
    compactNotice,
    testingViews,
    activeRunId: owner.runId,
    cancelTesting: (runId: TestRunId) => cancelTesting(runtime, runId),
    send: (text: string) => send(runtime, text),
    compact: () => send(runtime, "/compact"),
    acceptExternalRun: (accept: () => Promise<TransferReceipt>, transferKey: string) =>
      acceptExternalRun(runtime, accept, transferKey),
    navigate: (id: string | null) => navigate(runtime, id),
  };
}
