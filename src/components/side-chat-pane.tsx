import { useRef, useState } from "react";
import { FileTextIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  SideChatOperationError,
  summaryDraftSchema,
  summaryTransferFailure,
  transferReceiptSchema,
  type SummaryDraft,
  type SummaryTransfer,
  type TransferReceipt,
} from "@/shared/side-chat";
import { useThread } from "../hooks/use-threads";
import { sideRequest, type SideChatEntry } from "../hooks/use-side-chats";
import { Pane } from "./pane";

type SummaryState =
  | { kind: "empty" }
  | { kind: "previewing" }
  | SummaryTransfer
  | { kind: "confirming"; draft: SummaryDraft; text: string; key: string }
  | { kind: "accepted"; receipt: TransferReceipt };

export function SummaryPreview({
  id,
  title,
  text,
  confirming,
  unresolved = false,
  ready,
  mainBusy,
  onEdit,
  onConfirm,
}: {
  id: string;
  title: string;
  text: string;
  confirming: boolean;
  unresolved?: boolean;
  ready: boolean;
  mainBusy: boolean;
  onEdit: (text: string) => void;
  onConfirm: () => void;
}) {
  return (
    <Card
      size="sm"
      className="mx-3 mb-3 max-h-[40vh] shrink-0 overflow-y-auto"
      aria-label={`${title}摘要預覽`}
    >
      <CardHeader>
        <CardTitle>摘要預覽</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <label htmlFor={`summary-${id}`}>編輯回填摘要</label>
        <textarea
          id={`summary-${id}`}
          aria-label="編輯回填摘要"
          rows={5}
          maxLength={8_000}
          className="w-full resize-y rounded-md border border-input bg-background p-2 text-sm focus-visible:outline-ring"
          value={text}
          disabled={confirming || unresolved}
          onChange={(event) => onEdit(event.target.value)}
        />
        <p className="text-sm text-muted-foreground">
          只摘要附屬討論。確認後會送出主對話並啟動模型回應。
        </p>
        {unresolved ? (
          <p role="status" className="text-sm text-muted-foreground">
            回填結果尚未確認。已鎖定原摘要，重試同一筆回填不會重複送出。
          </p>
        ) : null}
        <Button
          size="sm"
          disabled={!ready || confirming || (!unresolved && mainBusy) || !text.trim()}
          onClick={onConfirm}
        >
          {confirming ? "回填中" : unresolved ? "重試同一筆回填" : "確認回填並送出"}
        </Button>
        {mainBusy && !unresolved ? (
          <p role="status" className="text-sm text-muted-foreground">
            主對話忙碌中，草稿已保留。
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

type ConfirmingSummary = Extract<SummaryState, { kind: "confirming" }>;
type ActiveDraft = SummaryTransfer | ConfirmingSummary;
type AcceptIntoMain = (
  accept: () => Promise<TransferReceipt>,
  transferKey: string,
) => Promise<TransferReceipt>;

function activeDraftOf(summary: SummaryState): ActiveDraft | null {
  return summary.kind === "draft" || summary.kind === "confirming" || summary.kind === "unresolved"
    ? summary
    : null;
}

function confirmableDraft(
  draft: ActiveDraft | null,
  commandActive: boolean,
  ready: boolean,
): draft is SummaryTransfer {
  return (
    draft !== null &&
    draft.kind !== "confirming" &&
    !commandActive &&
    ready &&
    draft.text.trim().length > 0
  );
}

function paneStatus(phase: ReturnType<typeof useThread>["phase"]) {
  if (phase === "compacting") {
    return "compacting" as const;
  }

  return phase === "busy" ? ("running" as const) : ("idle" as const);
}

async function transferSummary(
  entryId: string,
  scope: string,
  draft: SummaryTransfer,
): Promise<TransferReceipt> {
  const accepted = transferReceiptSchema.parse(
    await sideRequest(`/${entryId}/transfer`, scope, {
      method: "POST",
      body: JSON.stringify({
        draftId: draft.draft.id,
        transferKey: draft.key,
        text: draft.text,
      }),
    }),
  );

  if (accepted.sideChatId !== entryId) {
    throw new Error("摘要回填收據不符");
  }

  return accepted;
}

function useSummaryTransfer({
  entry,
  scope,
  ready,
  mainBusy,
  acceptIntoMain,
  onClose,
}: {
  entry: SideChatEntry;
  scope: string;
  ready: boolean;
  mainBusy: boolean;
  acceptIntoMain: AcceptIntoMain;
  onClose: () => void;
}) {
  const [summary, setSummary] = useState<SummaryState>({ kind: "empty" });
  const [error, setError] = useState<string | null>(null);
  const command = useRef(false);
  const activeDraft = activeDraftOf(summary);
  const summaryLocked = summary.kind === "confirming" || summary.kind === "unresolved";

  async function preview() {
    if (!ready || command.current || summaryLocked) {
      return;
    }

    command.current = true;
    setError(null);
    const previous = summary;
    setSummary({ kind: "previewing" });

    try {
      const draft = summaryDraftSchema.parse(
        await sideRequest(`/${entry.id}/summary`, scope, { method: "POST" }),
      );
      setSummary({ kind: "draft", draft, text: draft.text, key: crypto.randomUUID() });
    } catch (cause) {
      setSummary(previous);
      setError(cause instanceof Error ? cause.message : "產生摘要失敗");
    } finally {
      command.current = false;
    }
  }

  async function confirm() {
    if (!confirmableDraft(activeDraft, command.current, ready)) {
      return;
    }

    if (mainBusy && activeDraft.kind !== "unresolved") {
      setError("主對話忙碌中，摘要草稿已保留。請稍後再確認。");

      return;
    }

    command.current = true;
    setError(null);
    setSummary({ ...activeDraft, kind: "confirming" });

    try {
      const receipt = await acceptIntoMain(
        () => transferSummary(entry.id, scope, activeDraft),
        activeDraft.key,
      );
      setSummary({ kind: "accepted", receipt });
      onClose();
    } catch (cause) {
      setSummary(summaryTransferFailure(activeDraft, cause));
      setError(cause instanceof Error ? cause.message : "回填結果尚未確認，請重試同一筆回填。");
    } finally {
      command.current = false;
    }
  }

  function edit(text: string) {
    setSummary((current) =>
      current.kind === "draft" && !command.current
        ? { ...current, text, key: crypto.randomUUID() }
        : current,
    );
  }

  function assertSendable() {
    if (command.current || summaryLocked) {
      throw new SideChatOperationError("blocked", "請先確認同一筆摘要回填的結果。");
    }
  }

  return { summary, error, activeDraft, summaryLocked, preview, confirm, edit, assertSendable };
}

type SummaryTransferFlow = ReturnType<typeof useSummaryTransfer>;

function SummaryButton({ flow, ready }: { flow: SummaryTransferFlow; ready: boolean }) {
  const previewing = flow.summary.kind === "previewing";

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={!ready || previewing || flow.summaryLocked}
      onClick={() => void flow.preview()}
    >
      <FileTextIcon data-icon="inline-start" />
      {previewing ? "產生摘要中" : "預覽摘要"}
    </Button>
  );
}

function SideChatFooter({
  flow,
  entry,
  ready,
  mainBusy,
}: {
  flow: SummaryTransferFlow;
  entry: SideChatEntry;
  ready: boolean;
  mainBusy: boolean;
}) {
  const { activeDraft, summary, error } = flow;

  return (
    <>
      {activeDraft ? (
        <SummaryPreview
          id={entry.id}
          title={entry.title}
          text={activeDraft.text}
          confirming={summary.kind === "confirming"}
          unresolved={summary.kind === "unresolved"}
          ready={ready}
          mainBusy={mainBusy}
          onEdit={flow.edit}
          onConfirm={() => void flow.confirm()}
        />
      ) : null}
      {summary.kind === "accepted" ? (
        <p role="status" className="px-4 py-2 text-sm">
          摘要已送入主對話，主模型已開始回應。
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="px-4 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
}

export function SideChatPane({
  entry,
  scope,
  mainBusy,
  acceptIntoMain,
  onClose,
}: {
  entry: SideChatEntry;
  scope: string;
  mainBusy: boolean;
  acceptIntoMain: AcceptIntoMain;
  onClose: () => void;
}) {
  const thread = useThread(entry.id, scope);
  const ready = thread.phase === "ready";
  const flow = useSummaryTransfer({ entry, scope, ready, mainBusy, acceptIntoMain, onClose });

  return (
    <Pane
      pane={{
        id: entry.id,
        title: entry.title,
        agent: "獨立討論",
        kind: "agent",
        status: paneStatus(thread.phase),
        progress: [],
        messages: thread.messages,
      }}
      onSend={(text) => {
        flow.assertSendable();

        return thread.send(text);
      }}
      sendDisabled={!ready || flow.summaryLocked}
      onClose={onClose}
      isHydrating={thread.phase === "loading"}
      hydrationError={thread.error}
      compactNotice={thread.compactNotice}
      headerAction={<SummaryButton flow={flow} ready={ready} />}
      footer={<SideChatFooter flow={flow} entry={entry} ready={ready} mainBusy={mainBusy} />}
    />
  );
}
