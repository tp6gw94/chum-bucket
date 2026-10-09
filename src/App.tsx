import "./styles/globals.css";

import { useEffect, useRef, useState } from "react";

import { Pane } from "./components/pane";
import { SideChatPane } from "./components/side-chat-pane";
import { useSideChats } from "./hooks/use-side-chats";
import { ThreadSidebar } from "./components/thread-sidebar";
import { TopBar } from "./components/top-bar";
import type { Pane as PaneModel, RunStatus, ThreadSummary } from "./components/types";
import {
  createThread,
  readPageEntry,
  threadUrl,
  useThread,
  useThreadList,
  type ThreadPhase,
} from "./hooks/use-threads";
import { Button } from "@/components/ui/button";
import { Provider } from "./Provider";

function claimErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "建立對話失敗";
}

async function resolveEntryId(id: string | null): Promise<string> {
  return id ?? (await createThread()).id;
}

function threadTitle(threads: readonly { id: string; title: string }[], threadId: string): string {
  return threads.find((item) => item.id === threadId)?.title ?? "新對話";
}

function paneStatus(phase: ThreadPhase): RunStatus {
  if (phase === "compacting") {
    return "compacting";
  }
  return phase === "busy" ? "running" : "idle";
}

function toMainPane(
  threadId: string,
  threads: readonly { id: string; title: string }[],
  messages: PaneModel["messages"],
  status: RunStatus,
): PaneModel {
  return {
    id: threadId ?? "draft",
    title: threadTitle(threads, threadId),
    agent: "main",
    status,
    progress: [],
    messages,
    kind: "main",
  };
}

function toSidebarSummary(
  thread: { id: string; title: string },
  threadId: string,
  activeStatus: RunStatus,
  activePaneCount: number,
): ThreadSummary {
  const active = thread.id === threadId;
  return {
    ...thread,
    agent: "main",
    status: active ? activeStatus : "idle",
    paneCount: active ? activePaneCount : 1,
  };
}

function ThreadEntry() {
  const { threads, error } = useThreadList();
  const claim = useRef(false);
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  async function enter(id: string | null) {
    if (claim.current) {
      return;
    }
    claim.current = true;
    setBusy(true);
    try {
      window.location.assign(threadUrl(await resolveEntryId(id)));
    } catch (cause) {
      claim.current = false;
      setBusy(false);
      setCreateError(claimErrorMessage(cause));
    }
  }
  return (
    <main className="mx-auto flex max-w-lg flex-col gap-3 p-6">
      <h1>選擇對話</h1>
      <Button disabled={busy} onClick={() => void enter(null)}>
        建立新對話
      </Button>
      {threads.map((thread) => (
        <Button
          key={thread.id}
          disabled={busy}
          variant="outline"
          onClick={() => void enter(thread.id)}
        >
          {thread.title}
        </Button>
      ))}
      {error || createError ? <p role="alert">{createError ?? error}</p> : null}
    </main>
  );
}

function ThreadPage({ threadId }: { threadId: string }) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const sideChats = useSideChats(threadId);
  const { threads, error: listError } = useThreadList();
  const thread = useThread(threadId);
  const { messages, send } = thread;
  const sendDisabled = thread.phase !== "ready";
  const mainPane = toMainPane(threadId, threads, messages, paneStatus(thread.phase));
  const threadSummaries = threads.map((item) =>
    toSidebarSummary(item, threadId, mainPane.status, 1 + sideChats.entries.length),
  );
  const hydrationError = [thread.error, sideChats.error].filter(Boolean).join(" ");

  return (
    <Provider>
      <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
        <TopBar sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((open) => !open)} />
        <div className="flex min-h-0 flex-1">
          <ThreadSidebar
            threads={threadSummaries}
            open={sidebarOpen}
            selectedThreadId={threadId}
            error={listError}
            disabled={sendDisabled}
            onNewThread={() => thread.navigate(null)}
            onSelectThread={thread.navigate}
          />
          <main
            role="region"
            aria-label="對話窗格，可左右捲動"
            tabIndex={0}
            className="flex min-w-0 flex-1 snap-x snap-proximity items-stretch overflow-x-auto overflow-y-hidden overscroll-x-contain"
          >
            <Pane
              key={mainPane.id}
              pane={mainPane}
              onOpenAgentPane={() => void sideChats.open()}
              openDisabled={sendDisabled || sideChats.opening}
              onSend={send}
              sendDisabled={sendDisabled}
              isHydrating={thread.phase === "loading"}
              hydrationError={hydrationError}
              compactNotice={thread.compactNotice}
            />
            {sideChats.entries.map((entry) => (
              <SideChatPane
                key={entry.id}
                entry={entry}
                scope={sideChats.scope}
                mainBusy={
                  thread.phase === "busy" ||
                  thread.phase === "compacting" ||
                  thread.phase === "loading"
                }
                acceptIntoMain={thread.acceptExternalRun}
                onClose={() => sideChats.close(entry.id)}
              />
            ))}
          </main>
        </div>
      </div>
    </Provider>
  );
}

const App = () => {
  const [entry] = useState(readPageEntry);
  useEffect(() => {
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) {
        window.location.reload();
      }
    };
    window.addEventListener("pageshow", restore);
    return () => window.removeEventListener("pageshow", restore);
  }, []);
  if (entry.kind === "invalid") {
    return (
      <main role="alert" className="p-6">
        對話網址無效，請確認 threadId。
      </main>
    );
  }
  if (entry.kind === "choose") {
    return (
      <Provider>
        <ThreadEntry />
      </Provider>
    );
  }
  return <ThreadPage threadId={entry.threadId} />;
};

export default App;
