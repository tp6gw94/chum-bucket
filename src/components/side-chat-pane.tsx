import { useState } from "react";
import { FileTextIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { sideSummarySchema, sideTransferredSchema } from "@/shared/side-chat";
import { useThread } from "../hooks/use-threads";
import { sideRequest, type SideChatEntry } from "../hooks/use-side-chats";
import { Pane } from "./pane";

type SummaryState =
  | { kind: "empty" }
  | { kind: "previewing" }
  | { kind: "draft"; text: string }
  | { kind: "confirming"; text: string };

export function SummaryPreview({
  id,
  title,
  text,
  confirming,
  ready,
  mainBusy,
  onEdit,
  onConfirm,
}: {
  id: string;
  title: string;
  text: string;
  confirming: boolean;
  ready: boolean;
  mainBusy: boolean;
  onEdit: (text: string) => void;
  onConfirm: () => void;
}) {
  return (
    <Card
      size="sm"
      className="mx-3 mb-3 max-h-80 shrink-0 overflow-y-auto"
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
          disabled={confirming}
          onChange={(event) => onEdit(event.target.value)}
        />
        <p className="text-sm text-muted-foreground">
          只摘要附屬討論。確認後會送出主對話並啟動模型回應。
        </p>
        <Button
          size="sm"
          disabled={!ready || confirming || mainBusy || !text.trim()}
          onClick={onConfirm}
        >
          {confirming ? "回填中" : "確認回填並送出"}
        </Button>
        {mainBusy ? (
          <p role="status" className="text-sm text-muted-foreground">
            主對話忙碌中，草稿已保留。
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function paneStatus(phase: ReturnType<typeof useThread>["phase"]) {
  if (phase === "compacting") {
    return "compacting" as const;
  }

  return phase === "busy" ? ("running" as const) : ("idle" as const);
}

async function transferSummary(id: string, text: string) {
  const { runId } = sideTransferredSchema.parse(
    await sideRequest(`/${id}/transfer`, { method: "POST", body: JSON.stringify({ text }) }),
  );

  return runId;
}

type AcceptIntoMain = (accept: () => Promise<string>) => Promise<void>;

function useSideSummary(id: string, acceptIntoMain: AcceptIntoMain, onClose: () => void) {
  const [summary, setSummary] = useState<SummaryState>({ kind: "empty" });
  const [error, setError] = useState<string | null>(null);

  async function preview() {
    const previous = summary;
    setSummary({ kind: "previewing" });
    setError(null);

    try {
      const { text } = sideSummarySchema.parse(
        await sideRequest(`/${id}/summary`, { method: "POST" }),
      );
      setSummary({ kind: "draft", text });
    } catch (cause) {
      setSummary(previous);
      setError(cause instanceof Error ? cause.message : "產生摘要失敗");
    }
  }

  async function confirm(text: string) {
    setSummary({ kind: "confirming", text });
    setError(null);

    try {
      await acceptIntoMain(() => transferSummary(id, text));
      onClose();
    } catch (cause) {
      setSummary({ kind: "draft", text });
      setError(cause instanceof Error ? cause.message : "回填失敗，草稿已保留。");
    }
  }

  return {
    summary,
    error,
    preview,
    confirm,
    edit: (text: string) => setSummary({ kind: "draft", text }),
  };
}

export function SideChatPane({
  entry,
  mainBusy,
  acceptIntoMain,
  onClose,
}: {
  entry: SideChatEntry;
  mainBusy: boolean;
  acceptIntoMain: AcceptIntoMain;
  onClose: () => void;
}) {
  const thread = useThread(entry.id, true);
  const ready = thread.phase === "ready";
  const { summary, error, preview, confirm, edit } = useSideSummary(
    entry.id,
    acceptIntoMain,
    onClose,
  );
  const confirming = summary.kind === "confirming";

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
      onSend={thread.send}
      sendDisabled={!ready || confirming}
      onClose={onClose}
      isHydrating={thread.phase === "loading"}
      hydrationError={thread.error}
      compactNotice={thread.compactNotice}
      headerAction={
        <Button
          variant="outline"
          size="sm"
          disabled={!ready || summary.kind === "previewing" || confirming}
          onClick={() => void preview()}
        >
          <FileTextIcon data-icon="inline-start" />
          {summary.kind === "previewing" ? "產生摘要中" : "預覽摘要"}
        </Button>
      }
      footer={
        <>
          {summary.kind === "draft" || summary.kind === "confirming" ? (
            <SummaryPreview
              id={entry.id}
              title={entry.title}
              text={summary.text}
              confirming={confirming}
              ready={ready}
              mainBusy={mainBusy}
              onEdit={edit}
              onConfirm={() => void confirm(summary.text)}
            />
          ) : null}
          {error ? (
            <p role="alert" className="px-4 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </>
      }
    />
  );
}
