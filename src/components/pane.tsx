import { PlusIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { CompactNotice, SendResult } from "../hooks/use-threads";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Composer } from "./composer";
import { MessageList } from "./message-list";
import { PaneShell } from "./pane-shell";
import { ProgressPanel } from "./progress-panel";
import { StatusBadge } from "./status-badge";
import { type Pane as PaneModel } from "./types";

const DEFAULT_WIDTH = { main: 720, agent: 440 } as const;

const COMPACT_NOTICE_COPY: Record<CompactNotice, string> = {
  done: "上下文已整理，完整摘要與原文已保留。",
  skipped: "目前沒有足夠的可整理歷史，原文與上下文未變更。",
  failed: "整理上下文失敗，原文與上下文已保留。",
};

const PANE_COPY = {
  main: {
    label: () => "主對話",
    empty: "還沒有訊息，輸入第一則訊息開始對話。",
    progress: "主對話進度",
    placeholder: "輸入訊息",
    hint: "輸入 /compact 可整理上下文",
  },
  agent: {
    label: (title: string) => `附屬對話：${title}`,
    empty: "附屬對話已建立，輸入訊息開始獨立討論。",
    progress: "附屬對話進度",
    placeholder: "輸入附屬對話訊息",
    hint: "附屬對話不會修改主對話，關閉後即刪除",
  },
} as const;

function PaneHeader({
  pane,
  onOpenAgentPane,
  openDisabled,
  headerAction,
  onClose,
}: {
  pane: PaneModel;
  onOpenAgentPane?: () => void;
  openDisabled: boolean;
  headerAction?: ReactNode;
  onClose?: () => void;
}) {
  return (
    <header className="flex shrink-0 flex-col gap-2.5 border-b bg-card px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">{pane.title}</h2>
        <Badge variant="outline">{pane.agent}</Badge>
        <StatusBadge status={pane.status} runningLabel="執行中" idleLabel="待命" />
        <div className="ml-auto flex items-center gap-1">
          {pane.kind === "main" && onOpenAgentPane ? (
            <Button variant="outline" size="sm" disabled={openDisabled} onClick={onOpenAgentPane}>
              <PlusIcon data-icon="inline-start" />
              開啟附屬對話
            </Button>
          ) : null}
          {headerAction}
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

function PaneMessages({
  pane,
  compactNotice,
}: {
  pane: PaneModel;
  compactNotice?: CompactNotice | null;
}) {
  const copy = PANE_COPY[pane.kind];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      {pane.messages.length === 0 ? (
        <p className="m-auto text-sm text-muted-foreground">{copy.empty}</p>
      ) : (
        <MessageList
          messages={pane.messages}
          agent={pane.agent}
          isStreaming={pane.status === "running"}
        />
      )}
      {compactNotice ? (
        <Marker role={compactNotice === "failed" ? "alert" : "status"}>
          <MarkerContent>{COMPACT_NOTICE_COPY[compactNotice]}</MarkerContent>
        </Marker>
      ) : null}
      <ProgressPanel status={pane.status} label={copy.progress} lines={pane.progress} />
    </div>
  );
}

function HydrationState({ loading, error }: { loading: boolean; error?: string | null }) {
  return (
    <>
      {loading ? (
        <p role="status" className="px-4 text-sm">
          正在載入對話…
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="px-4 py-2 text-sm text-destructive">
          <p>{error}</p>
          <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
            重新載入
          </Button>
        </div>
      ) : null}
    </>
  );
}

export function Pane({
  pane,
  onOpenAgentPane,
  openDisabled = false,
  onClose,
  onSend,
  sendDisabled = false,
  isHydrating = false,
  hydrationError,
  compactNotice,
  headerAction,
  footer,
}: {
  pane: PaneModel;
  onOpenAgentPane?: () => void;
  openDisabled?: boolean;
  onClose?: () => void;
  onSend?: (text: string) => Promise<SendResult>;
  sendDisabled?: boolean;
  isHydrating?: boolean;
  hydrationError?: string | null;
  compactNotice?: CompactNotice | null;
  headerAction?: ReactNode;
  footer?: ReactNode;
}) {
  const copy = PANE_COPY[pane.kind];

  return (
    <PaneShell
      label={copy.label(pane.title)}
      defaultWidth={pane.kind === "main" ? DEFAULT_WIDTH.main : DEFAULT_WIDTH.agent}
    >
      <PaneHeader
        pane={pane}
        onOpenAgentPane={onOpenAgentPane}
        openDisabled={openDisabled}
        headerAction={headerAction}
        onClose={onClose}
      />
      <PaneMessages pane={pane} compactNotice={compactNotice} />
      <HydrationState loading={isHydrating} error={hydrationError} />
      {footer}
      <Composer
        label={`${pane.kind === "main" ? "主對話" : pane.title}輸入-${pane.id}`}
        placeholder={copy.placeholder}
        hint={copy.hint}
        onSend={onSend}
        disabled={sendDisabled || !onSend}
        className="border-t"
      />
    </PaneShell>
  );
}
