import type { ActionEvent } from "@openuidev/react-lang";
import { PlusIcon, XIcon } from "lucide-react";
import type { SendResult } from "../hooks/use-threads";

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

export function Pane({
  pane,
  onOpenAgentPane,
  onClose,
  onSend,
  sendDisabled = false,
  isHydrating = false,
  hydrationError,
}: {
  pane: PaneModel;
  onOpenAgentPane: () => void;
  onClose?: () => void;
  onSend?: (text: string) => Promise<SendResult>;
  sendDisabled?: boolean;
  isHydrating?: boolean;
  hydrationError?: string | null;
}) {
  const isMain = pane.kind === "main";

  function handleAction(event: ActionEvent) {
    runAction(event, {
      open: (url) => window.open(url, "_blank", "noopener,noreferrer"),
      send:
        onSend && !sendDisabled ? (text) => void onSend(text).catch(() => undefined) : undefined,
    });
  }

  return (
    <PaneShell
      label={isMain ? "主對話" : `附屬對話：${pane.title}`}
      defaultWidth={isMain ? DEFAULT_WIDTH.main : DEFAULT_WIDTH.agent}
    >
      <header className="flex shrink-0 flex-col gap-2.5 border-b bg-card px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold">{pane.title}</h2>
          <Badge variant="outline">{pane.agent}</Badge>
          <StatusBadge status={pane.status} runningLabel="執行中" idleLabel="待命" />
          <div className="ml-auto flex items-center gap-1">
            <Button variant="outline" size="sm" onClick={onOpenAgentPane}>
              <PlusIcon data-icon="inline-start" />
              開啟附屬對話
            </Button>
            {onClose ? (
              <Button variant="ghost" size="sm" onClick={onClose}>
                <XIcon data-icon="inline-start" />
                關閉
              </Button>
            ) : null}
          </div>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {pane.messages.length === 0 ? (
          <p className="m-auto text-sm text-muted-foreground">
            {isMain
              ? "還沒有訊息，輸入第一則訊息開始對話。"
              : "這是預留的附屬對話窗格，尚未連接 agent 執行。"}
          </p>
        ) : (
          <MessageList
            messages={pane.messages}
            agent={pane.agent}
            isStreaming={pane.status === "running"}
            onAction={handleAction}
          />
        )}
        <ProgressPanel
          status={pane.status}
          label={isMain ? "主對話進度" : "附屬對話進度"}
          lines={pane.progress}
        />
      </div>
      {isHydrating ? (
        <p role="status" className="px-4 text-sm">
          正在載入對話…
        </p>
      ) : null}
      {hydrationError ? (
        <div role="alert" className="px-4 py-2 text-sm text-destructive">
          <p>{hydrationError}</p>
          <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
            重新載入
          </Button>
        </div>
      ) : null}
      <Composer
        label={`${isMain ? "主對話" : pane.title}輸入-${pane.id}`}
        placeholder={isMain ? "輸入訊息" : "附屬對話尚未連接執行，僅為預留窗格"}
        hint={isMain ? "送出後會使用目前的 thread" : "此窗格為 UI 預留狀態，不會呼叫 agent"}
        onSend={onSend}
        disabled={sendDisabled || !onSend}
        className="border-t"
      />
    </PaneShell>
  );
}
