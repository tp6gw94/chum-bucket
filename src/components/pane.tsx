import { PlusIcon, XIcon } from "lucide-react";
import type { SendResult } from "../hooks/use-threads";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Composer } from "./composer";
import { MessageList } from "./message-list";
import { PaneShell } from "./pane-shell";
import { ProgressPanel } from "./progress-panel";
import { StatusBadge } from "./status-badge";
import { type Pane as PaneModel } from "./types";

const PANE_KIND = {
  main: {
    width: 720,
    label: () => "主對話",
    empty: "還沒有訊息，輸入第一則訊息開始對話。",
    placeholder: "輸入訊息",
    hint: "送出後會使用目前的 thread；輸入 / 可選擇指令",
  },
  agent: {
    width: 440,
    label: (title: string) => `附屬對話：${title}`,
    empty: "這是附屬對話。第一則訊息會先帶入主對話的摘要，不會影響主對話。",
    placeholder: "輸入附屬對話訊息",
    hint: "第一則訊息會帶入主對話摘要；輸入 / 可選擇指令",
  },
} as const;

function PaneHeader({
  pane,
  onOpenAgentPane,
  onClose,
}: {
  pane: PaneModel;
  onOpenAgentPane: () => void;
  onClose?: () => void;
}) {
  return (
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
  );
}

function PaneAlerts({
  isHydrating,
  hydrationError,
  notice,
}: {
  isHydrating: boolean;
  hydrationError?: string | null;
  notice?: string | null;
}) {
  return (
    <>
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
      {notice ? (
        <p role="alert" className="px-4 py-2 text-sm text-destructive">
          {notice}
        </p>
      ) : null}
    </>
  );
}

export function Pane({
  pane,
  onOpenAgentPane,
  onClose,
  onSend,
  sendDisabled = false,
  isHydrating = false,
  hydrationError,
  notice,
}: {
  pane: PaneModel;
  onOpenAgentPane: () => void;
  onClose?: () => void;
  onSend?: (text: string) => Promise<SendResult>;
  sendDisabled?: boolean;
  isHydrating?: boolean;
  hydrationError?: string | null;
  notice?: string | null;
}) {
  const kind = PANE_KIND[pane.kind];
  const label = kind.label(pane.title);

  return (
    <PaneShell label={label} defaultWidth={kind.width}>
      <PaneHeader pane={pane} onOpenAgentPane={onOpenAgentPane} onClose={onClose} />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {pane.messages.length === 0 ? (
          <p className="m-auto text-sm text-muted-foreground">{kind.empty}</p>
        ) : (
          <MessageList
            messages={pane.messages}
            agent={pane.agent}
            isStreaming={pane.status === "running"}
            testing={pane.testing}
            onTestingUpdate={pane.onTestingUpdate}
          />
        )}
        <ProgressPanel status={pane.status} label="對話脈絡壓縮" lines={pane.progress} />
      </div>
      <PaneAlerts isHydrating={isHydrating} hydrationError={hydrationError} notice={notice} />
      <Composer
        label={`${label}輸入-${pane.id}`}
        placeholder={kind.placeholder}
        hint={kind.hint}
        onSend={onSend}
        disabled={sendDisabled || !onSend}
        className="border-t"
      />
    </PaneShell>
  );
}
