import { ArrowDownIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect } from "react";
import type { SendResult } from "../hooks/use-threads";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "@/components/ui/message-scroller";
import { Composer } from "./composer";
import { CompactMarker, MessageList } from "./message-list";
import { PaneShell } from "./pane-shell";
import { ProgressPanel } from "./progress-panel";
import { StatusBadge } from "./status-badge";
import { type Pane as PaneModel } from "./types";

type PanePresentation = Readonly<{
  defaultWidth: number;
  placeholder: string;
  hint: string;
  emptyCopy: string;
  progressLabel: string;
}>;

const PANE_PRESENTATION: Record<PaneModel["kind"], PanePresentation> = {
  main: {
    defaultWidth: 720,
    placeholder: "輸入訊息",
    hint: "送出後會使用目前的 thread",
    emptyCopy: "還沒有訊息，輸入第一則訊息開始對話。",
    progressLabel: "主對話進度",
  },
  agent: {
    defaultWidth: 440,
    placeholder: "附屬對話尚未連接執行，僅為預留窗格",
    hint: "此窗格為 UI 預留狀態，不會呼叫 agent",
    emptyCopy: "這是預留的附屬對話窗格，尚未連接 agent 執行。",
    progressLabel: "附屬對話進度",
  },
};

function paneShellLabel(pane: PaneModel): string {
  return pane.kind === "main" ? "主對話" : `附屬對話：${pane.title}`;
}

function composerFieldLabel(pane: PaneModel): string {
  const prefix = pane.kind === "main" ? "主對話" : pane.title;
  return `${prefix}輸入-${pane.id}`;
}

function HydrationFeedback({
  isHydrating,
  hydrationError,
}: {
  isHydrating: boolean;
  hydrationError?: string | null;
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
    </>
  );
}

function PaneMessages({ pane, presentation }: { pane: PaneModel; presentation: PanePresentation }) {
  if (pane.messages.length === 0) {
    return (
      <>
        <MessageScrollerItem className="m-auto">
          <p className="text-sm text-muted-foreground">{presentation.emptyCopy}</p>
        </MessageScrollerItem>
        {pane.status === "compacting" ? <CompactMarker /> : null}
      </>
    );
  }
  return (
    <MessageList
      messages={pane.messages}
      agent={pane.agent}
      isStreaming={pane.status === "running"}
      compacting={pane.status === "compacting"}
    />
  );
}

function TranscriptAutoFollow({ pane }: { pane: PaneModel }) {
  const { scrollToEnd } = useMessageScroller();
  useEffect(() => {
    scrollToEnd({ behavior: "auto" });
  }, [scrollToEnd, pane.messages, pane.status]);
  return null;
}

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
  const presentation = PANE_PRESENTATION[pane.kind];

  return (
    <PaneShell label={paneShellLabel(pane)} defaultWidth={presentation.defaultWidth}>
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
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport aria-label={`${pane.title}對話訊息`} className="p-4">
            <MessageScrollerContent className="gap-4">
              <TranscriptAutoFollow pane={pane} />
              <PaneMessages pane={pane} presentation={presentation} />
              {pane.progress.length > 0 ? (
                <MessageScrollerItem messageId="pane-progress">
                  <ProgressPanel
                    status={pane.status}
                    label={presentation.progressLabel}
                    lines={pane.progress}
                  />
                </MessageScrollerItem>
              ) : null}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton direction="end">
            <ArrowDownIcon />
            <span className="sr-only">跳到最新</span>
          </MessageScrollerButton>
        </MessageScroller>
      </MessageScrollerProvider>
      <HydrationFeedback isHydrating={isHydrating} hydrationError={hydrationError} />
      <Composer
        label={composerFieldLabel(pane)}
        placeholder={presentation.placeholder}
        hint={presentation.hint}
        onSend={onSend}
        disabled={sendDisabled || !onSend}
        className="border-t"
      />
    </PaneShell>
  );
}
