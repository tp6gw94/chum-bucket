import { PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { StatusBadge } from "./status-badge";
import { type ThreadSummary } from "./types";

export function ThreadSidebar({
  threads,
  open,
  selectedThreadId,
  error,
  disabled = false,
  onNewThread,
  onSelectThread,
}: {
  threads: ThreadSummary[];
  open: boolean;
  selectedThreadId: string | null;
  error: string | null;
  disabled?: boolean;
  onNewThread: () => void;
  onSelectThread: (id: string) => void;
}) {
  return (
    <div
      className={cn(
        "shrink-0 overflow-hidden transition-[width] duration-200 ease-out motion-reduce:transition-none",
        open ? "w-60 lg:w-[17rem]" : "w-0",
      )}
    >
      <aside
        id="thread-sidebar"
        aria-label="Thread 清單"
        aria-hidden={!open}
        inert={!open}
        className="flex h-full w-60 flex-col gap-1.5 overflow-y-auto border-r bg-card p-3 lg:w-[17rem]"
      >
        <Button size="sm" className="w-full" disabled={disabled} onClick={onNewThread}>
          <PlusIcon data-icon="inline-start" />新 thread
        </Button>
        <h2 className="mt-2 px-1 text-xs font-medium tracking-widest text-muted-foreground uppercase">
          Threads
        </h2>
        {error ? (
          <p role="alert" className="px-1 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <div role="list" className="flex flex-col gap-1">
          {threads.map((thread) => {
            const extraPanes = thread.paneCount - 1;

            return (
              <Button
                key={thread.id}
                disabled={disabled}
                variant={thread.id === selectedThreadId ? "secondary" : "ghost"}
                aria-current={thread.id === selectedThreadId ? "page" : undefined}
                onClick={() => onSelectThread(thread.id)}
                className="h-auto w-full flex-col items-start justify-start gap-1.5 px-2.5 py-2 text-left whitespace-normal"
              >
                <span className="w-full truncate text-sm font-medium">{thread.title}</span>
                <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <StatusBadge status={thread.status} runningLabel="執行中" idleLabel="待命" />
                  <span>{thread.agent}</span>
                  {extraPanes > 0 ? <span>{`附屬窗格 ${extraPanes}`}</span> : null}
                </span>
              </Button>
            );
          })}
        </div>
      </aside>
    </div>
  );
}
