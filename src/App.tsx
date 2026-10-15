import "./styles/globals.css";

import { useEffect, useRef, useState } from "react";

import { Pane } from "./components/pane";
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
      const selected = id ?? (await createThread()).id;
      window.location.assign(threadUrl(selected));
    } catch (cause) {
      claim.current = false;
      setBusy(false);
      setCreateError(cause instanceof Error ? cause.message : "建立對話失敗");
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

function paneStatus(phase: ThreadPhase): RunStatus {
  return phase === "compacting" ? "compacting" : phase === "busy" ? "running" : "idle";
}

function mainPaneProps(thread: ReturnType<typeof useThread>) {
  return {
    onSend: thread.send,
    onCommand: thread.runCommand,
    notice: thread.notice,
    isHydrating: thread.phase === "loading",
    hydrationError: thread.error,
  };
}

function ThreadPage({ threadId }: { threadId: string }) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [agentPanes, setAgentPanes] = useState<PaneModel[]>([]);
  const { threads, error: listError, remove } = useThreadList(threadId);
  const thread = useThread(threadId);
  const sendDisabled = thread.phase !== "ready";

  function openAgentPane() {
    setAgentPanes((panes) => [
      ...panes,
      {
        id: crypto.randomUUID(),
        title: `附屬對話 ${panes.length + 1}`,
        agent: "尚未連接",
        status: "idle",
        progress: [],
        messages: [],
        kind: "agent",
      },
    ]);
  }

  function closeAgentPane(id: string) {
    setAgentPanes((panes) => panes.filter((pane) => pane.id !== id));
  }

  const mainPane: PaneModel = {
    id: threadId ?? "draft",
    title: threads.find((item) => item.id === threadId)?.title ?? "新對話",
    agent: "main",
    status: paneStatus(thread.phase),
    progress: [],
    messages: thread.messages,
    kind: "main",
  };
  const panes = [mainPane, ...agentPanes];

  const threadSummaries: ThreadSummary[] = threads.map((thread) => ({
    ...thread,
    agent: "main",
    status: thread.id === threadId ? mainPane.status : "idle",
    paneCount: thread.id === threadId ? panes.length : 1,
  }));

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
            onDeleteThread={remove}
          />
          <main
            role="region"
            aria-label="對話窗格，可左右捲動"
            tabIndex={0}
            className="flex min-w-0 flex-1 snap-x snap-proximity items-stretch overflow-x-auto overflow-y-hidden overscroll-x-contain"
          >
            {panes.map((pane) => (
              <Pane
                key={pane.id}
                pane={pane}
                onOpenAgentPane={openAgentPane}
                onClose={pane.kind === "agent" ? () => closeAgentPane(pane.id) : undefined}
                sendDisabled={sendDisabled}
                {...(pane.kind === "main" ? mainPaneProps(thread) : {})}
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
