import type { ReactNode } from "react";
import type { ActionEvent } from "@openuidev/react-lang";
import { PlusIcon, XIcon } from "lucide-react";
import { cn } from "cn";
import type { SendResult, ThreadNotice } from "../hooks/use-threads";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Composer } from "./composer";
import { MessageList } from "./message-list";
import { runAction } from "./openui-actions";
import { PaneShell } from "./pane-shell";
import { ProgressPanel } from "./progress-panel";
import { StatusBadge } from "./status-badge";
import { type Pane as PaneModel } from "./types";

const DEFAULT_WIDTH = { main: 720, agent: 440 } as const;

const COPY = {
  main: {
    label: () => "主對話",
    empty: "還沒有訊息，輸入第一則訊息開始對話。輸入 /compact 可以整理上下文。",
    placeholder: "輸入訊息",
    hint: "送出後會使用目前的 thread",
    progress: "主對話進度",
  },
  agent: {
    label: (title: string) => `附屬對話：${title}`,
    empty: "附屬對話從主對話目前的內容開始，在這裡問旁支問題不會影響主對話。",
    placeholder: "問一個旁支問題",
    hint: "關閉或重新整理頁面會刪除這段附屬對話",
    progress: "附屬對話進度",
  },
} as const;

function PaneHeader({
  pane,
  onOpenAgentPane,
  onClose,
  actions,
}: {
  pane: PaneModel;
  onOpenAgentPane?: () => void;
  onClose?: () => void;
  actions?: ReactNode;
}) {
  return (
    <header className="flex shrink-0 flex-col gap-2.5 border-b bg-card px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">{pane.title}</h2>
        <Badge variant="outline">{pane.agent}</Badge>
        <StatusBadge status={pane.status} runningLabel="執行中" idleLabel="待命" />
        <div className="ml-auto flex items-center gap-1">
          {actions}
          {onOpenAgentPane ? (
            <Button variant="outline" size="sm" onClick={onOpenAgentPane}>
              <PlusIcon data-icon="inline-start" />
              開啟附屬對話
            </Button>
          ) : null}
          {onClose ? (
            <Button variant="ghost" size="sm" onClick={onClose}>
              <XIcon data-icon="inline-start" />
              關閉
            </Button>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function NoticeLine({ notice }: { notice: ThreadNotice }) {
  const failed = notice.state === "failed";

  return (
    <p
      role={failed ? "alert" : "status"}
      className={cn("px-4 py-1 text-sm", failed ? "text-destructive" : "text-muted-foreground")}
    >
      {notice.message}
    </p>
  );
}

function HydrationAlert({ message }: { message: string }) {
  return (
    <div role="alert" className="px-4 py-2 text-sm text-destructive">
      <p>{message}</p>
      <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
        重新載入
      </Button>
    </div>
  );
}

function actionHandler(
  onSend: ((text: string) => Promise<SendResult>) | undefined,
  enabled: boolean,
) {
  const send =
    onSend && enabled ? (text: string) => void onSend(text).catch(() => undefined) : undefined;

  return (event: ActionEvent) =>
    runAction(event, {
      open: (url) => window.open(url, "_blank", "noopener,noreferrer"),
      send,
    });
}

type SendHandler = (text: string) => Promise<SendResult>;

function PaneMessages({
  pane,
  onSend,
  enabled,
}: {
  pane: PaneModel;
  onSend?: SendHandler;
  enabled: boolean;
}) {
  if (pane.messages.length === 0) {
    return <p className="m-auto text-sm text-muted-foreground">{COPY[pane.kind].empty}</p>;
  }

  return (
    <MessageList
      messages={pane.messages}
      agent={pane.agent}
      isStreaming={pane.status === "running"}
      onAction={actionHandler(onSend, enabled)}
    />
  );
}

function PaneStatus({
  isHydrating,
  hydrationError,
  notice,
}: {
  isHydrating?: boolean;
  hydrationError?: string | null;
  notice?: ThreadNotice | null;
}) {
  return (
    <>
      {isHydrating ? (
        <p role="status" className="px-4 text-sm">
          正在載入對話…
        </p>
      ) : null}
      {notice ? <NoticeLine notice={notice} /> : null}
      {hydrationError ? <HydrationAlert message={hydrationError} /> : null}
    </>
  );
}

export function Pane({
  pane,
  onOpenAgentPane,
  onClose,
  onSend,
  sendDisabled,
  isHydrating,
  hydrationError,
  notice,
  actions,
  children,
}: {
  pane: PaneModel;
  onOpenAgentPane?: () => void;
  onClose?: () => void;
  onSend?: SendHandler;
  sendDisabled?: boolean;
  isHydrating?: boolean;
  hydrationError?: string | null;
  notice?: ThreadNotice | null;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const copy = COPY[pane.kind];
  const label = copy.label(pane.title);
  const enabled = !sendDisabled && onSend !== undefined;

  return (
    <PaneShell label={label} defaultWidth={DEFAULT_WIDTH[pane.kind]}>
      <PaneHeader
        pane={pane}
        onOpenAgentPane={onOpenAgentPane}
        onClose={onClose}
        actions={actions}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <PaneMessages pane={pane} onSend={onSend} enabled={enabled} />
        <ProgressPanel status={pane.status} label={copy.progress} lines={pane.progress} />
        {children}
      </div>
      <PaneStatus isHydrating={isHydrating} hydrationError={hydrationError} notice={notice} />
      <Composer
        label={`${label}輸入-${pane.id}`}
        placeholder={copy.placeholder}
        hint={copy.hint}
        onSend={onSend}
        disabled={!enabled}
        className="border-t"
      />
    </PaneShell>
  );
}
