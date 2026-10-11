import { ArrowDownIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import type { SendResult, CompactNotice } from "../hooks/use-threads";
import { Marker, MarkerContent } from "@/components/ui/marker";
import type { TestRunId, TestView } from "../../shared/testing";

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
import { MessageList } from "./message-list";
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

const EMPTY_TESTING_VIEWS: readonly TestView[] = [];

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
    placeholder: "在固定主對話快照上繼續討論",
    hint: "獨立討論，不會修改主對話。關閉後捨棄。",
    emptyCopy: "附屬對話已建立，輸入訊息開始獨立討論。",
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

function PaneMessages({
  pane,
  presentation,
  onSend,
  actionsDisabled,
  testingViews,
  onCancelTesting,
  activeRunId,
}: {
  pane: PaneModel;
  presentation: PanePresentation;
  onSend?: (text: string) => Promise<SendResult>;
  actionsDisabled: boolean;
  testingViews: readonly TestView[];
  onCancelTesting?: (runId: TestRunId) => Promise<void>;
  activeRunId?: string | null;
}) {
  return (
    <>
      {pane.messages.length === 0 ? (
        <MessageScrollerItem className="m-auto">
          <p className="text-sm text-muted-foreground">{presentation.emptyCopy}</p>
        </MessageScrollerItem>
      ) : null}
      <MessageList
        messages={pane.messages}
        agent={pane.agent}
        onSend={onSend}
        disabled={actionsDisabled}
        isStreaming={pane.status === "running"}
        compacting={pane.status === "compacting"}
        testingViews={pane.kind === "main" ? testingViews : EMPTY_TESTING_VIEWS}
        onCancelTesting={onCancelTesting}
        activeRunId={activeRunId}
      />
    </>
  );
}

function TranscriptAutoFollow({ pane }: { pane: PaneModel }) {
  const { scrollToEnd } = useMessageScroller();
  useEffect(() => {
    scrollToEnd({ behavior: "auto" });
  }, [scrollToEnd, pane.messages, pane.status]);

  return null;
}

const COMPACT_NOTICE_COPY: Record<CompactNotice, string> = {
  done: "上下文已整理，完整摘要與原文已保留。",
  skipped: "目前沒有足夠的可整理歷史，原文與上下文未變更。",
  failed: "整理上下文失敗，原文與上下文已保留。",
};

function CompactNoticeMarker({ notice }: { notice?: CompactNotice | null }) {
  if (!notice) {
    return null;
  }

  return (
    <Marker role={notice === "failed" ? "alert" : "status"}>
      <MarkerContent>{COMPACT_NOTICE_COPY[notice]}</MarkerContent>
    </Marker>
  );
}

function PaneHeader({
  pane,
  onOpenAgentPane,
  onClose,
  headerAction,
  openDisabled,
}: {
  pane: PaneModel;
  onOpenAgentPane?: () => void;
  onClose?: () => void;
  headerAction?: ReactNode;
  openDisabled: boolean;
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

function PaneTranscript({
  pane,
  presentation,
  onSend,
  actionsDisabled,
  testingViews,
  onCancelTesting,
  activeRunId,
}: {
  pane: PaneModel;
  presentation: PanePresentation;
  onSend?: (text: string) => Promise<SendResult>;
  actionsDisabled: boolean;
  testingViews: readonly TestView[];
  onCancelTesting?: (runId: TestRunId) => Promise<void>;
  activeRunId?: string | null;
}) {
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport aria-label={`${pane.title}對話訊息`} className="p-4">
          <MessageScrollerContent className="gap-4">
            <TranscriptAutoFollow pane={pane} />
            <PaneMessages
              pane={pane}
              presentation={presentation}
              onSend={onSend}
              actionsDisabled={actionsDisabled}
              testingViews={testingViews}
              onCancelTesting={onCancelTesting}
              activeRunId={activeRunId}
            />
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
  compactNotice,
  headerAction,
  footer,
  openDisabled = false,
  testingViews = EMPTY_TESTING_VIEWS,
  onCancelTesting,
  activeRunId,
}: {
  pane: PaneModel;
  onOpenAgentPane?: () => void;
  onClose?: () => void;
  onSend?: (text: string) => Promise<SendResult>;
  sendDisabled?: boolean;
  isHydrating?: boolean;
  hydrationError?: string | null;
  compactNotice?: CompactNotice | null;
  headerAction?: ReactNode;
  footer?: ReactNode;
  openDisabled?: boolean;
  testingViews?: readonly TestView[];
  onCancelTesting?: (runId: TestRunId) => Promise<void>;
  activeRunId?: string | null;
}) {
  const presentation = PANE_PRESENTATION[pane.kind];
  const actionsDisabled = sendDisabled || isHydrating || pane.status !== "idle" || !onSend;

  return (
    <PaneShell label={paneShellLabel(pane)} defaultWidth={presentation.defaultWidth}>
      <PaneHeader
        pane={pane}
        onOpenAgentPane={onOpenAgentPane}
        onClose={onClose}
        headerAction={headerAction}
        openDisabled={openDisabled}
      />
      <PaneTranscript
        pane={pane}
        presentation={presentation}
        onSend={onSend}
        actionsDisabled={actionsDisabled}
        testingViews={testingViews}
        onCancelTesting={onCancelTesting}
        activeRunId={activeRunId}
      />
      <CompactNoticeMarker notice={compactNotice} />
      <HydrationFeedback isHydrating={isHydrating} hydrationError={hydrationError} />
      {footer}
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
