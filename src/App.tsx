import "./styles/globals.css";

import { useEffect, useRef, useState } from "react";

import { Pane } from "./components/pane";
import { SideChatPane } from "./components/side-chat-pane";
import { ThreadSidebar } from "./components/thread-sidebar";
import { TopBar } from "./components/top-bar";
import type { Pane as PaneModel, ThreadSummary } from "./components/types";
import {
  createThread,
  readPageEntry,
  threadUrl,
  useThread,
  useThreadList,
} from "./hooks/use-threads";
import { useSideChats } from "./hooks/use-side-chats";
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

function ThreadPage({ threadId }: { threadId: string }) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const { threads, error: listError } = useThreadList();
  const thread = useThread(threadId);
  const sideChats = useSideChats(threadId);
  const sendDisabled = thread.phase !== "ready";
  const mainBusy = thread.phase === "busy" || thread.phase === "compacting";

  const mainPane: PaneModel = {
    id: threadId,
    title: threads.find((item) => item.id === threadId)?.title ?? "新對話",
    agent: "main",
    status: thread.phase === "compacting" ? "compacting" : mainBusy ? "running" : "idle",
    progress: [],
    messages: thread.messages,
    kind: "main",
  };

  const threadSummaries: ThreadSummary[] = threads.map((item) => ({
    ...item,
    agent: "main",
    status: item.id === threadId ? mainPane.status : "idle",
    paneCount: item.id === threadId ? 1 + sideChats.entries.length : 1,
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
          />
          <main
            role="region"
            aria-label="對話窗格，可左右捲動"
            tabIndex={0}
            className="flex min-w-0 flex-1 snap-x snap-proximity items-stretch overflow-x-auto overflow-y-hidden overscroll-x-contain"
          >
            <Pane
              pane={mainPane}
              onOpenAgentPane={() => void sideChats.open()}
              openDisabled={sendDisabled || sideChats.opening}
              onSend={thread.send}
              sendDisabled={sendDisabled}
              isHydrating={thread.phase === "loading"}
              hydrationError={[thread.error, sideChats.error].filter(Boolean).join(" ") || null}
              compactNotice={thread.compactNotice}
            />
            {sideChats.entries.map((entry) => (
              <SideChatPane
                key={entry.id}
                entry={entry}
                mainBusy={mainBusy || thread.phase === "loading"}
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
