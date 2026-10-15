import { useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DeleteThreadDialog } from "./delete-thread-dialog";
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
  onDeleteThread,
}: {
  threads: ThreadSummary[];
  open: boolean;
  selectedThreadId: string | null;
  error: string | null;
  disabled?: boolean;
  onNewThread: () => void;
  onSelectThread: (id: string) => void;
  onDeleteThread: (thread: ThreadSummary) => Promise<void>;
}) {
  const [pending, setPending] = useState<{ thread: ThreadSummary; open: boolean } | null>(null);

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
          {threads.map((thread) => (
            <ThreadItem
              key={thread.id}
              thread={thread}
              selected={thread.id === selectedThreadId}
              disabled={disabled}
              onSelect={() => onSelectThread(thread.id)}
              onDelete={() => setPending({ thread, open: true })}
            />
          ))}
        </div>
      </aside>
      {pending ? (
        <DeleteThreadDialog
          thread={pending.thread}
          open={pending.open}
          onOpenChange={(open) => setPending({ ...pending, open })}
          onConfirm={onDeleteThread}
        />
      ) : null}
    </div>
  );
}

function ThreadItem({
  thread,
  selected,
  disabled,
  onSelect,
  onDelete,
}: {
  thread: ThreadSummary;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const extraPanes = thread.paneCount - 1;

  return (
    <div role="listitem" className="group/thread relative">
      <Button
        disabled={disabled}
        variant={selected ? "secondary" : "ghost"}
        aria-current={selected ? "page" : undefined}
        onClick={onSelect}
        className="h-auto w-full flex-col items-start justify-start gap-1.5 py-2 pr-9 pl-2.5 text-left whitespace-normal"
      >
        <span className="w-full truncate text-sm font-medium">{thread.title}</span>
        <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <StatusBadge status={thread.status} runningLabel="執行中" idleLabel="待命" />
          <span>{thread.agent}</span>
          {extraPanes > 0 ? <span>{`附屬窗格 ${extraPanes}`}</span> : null}
        </span>
      </Button>
      <Button
        disabled={disabled}
        variant="ghost"
        size="icon-xs"
        aria-label={`刪除「${thread.title}」`}
        onClick={onDelete}
        className="absolute top-1.5 right-1.5 text-muted-foreground opacity-0 group-hover/thread:opacity-100 hover:text-destructive focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <Trash2Icon />
      </Button>
    </div>
  );
}
