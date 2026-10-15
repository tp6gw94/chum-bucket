import { useState } from "react";
import { FileTextIcon, SendIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { previewSideChatSummary, transferSideChat, type SideChat } from "../hooks/use-side-chats";
import { threadStatus, useThread } from "../hooks/use-threads";
import { Pane } from "./pane";

type Draft = { text: string; error: string | null; sending: boolean };

function SummaryCard({
  draft,
  onChange,
  onTransfer,
}: {
  draft: Draft;
  onChange: (text: string) => void;
  onTransfer: () => void;
}) {
  return (
    <Card className="flex flex-col gap-2 p-3" aria-label="摘要預覽">
      <h3 className="text-sm font-semibold">摘要預覽</h3>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        編輯回填摘要
        <textarea
          className="min-h-32 rounded-md border bg-background p-2 text-sm text-foreground"
          value={draft.text}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      {draft.error ? (
        <p role="alert" className="text-xs text-destructive">
          {draft.error}
        </p>
      ) : null}
      <Button
        size="sm"
        className="self-end"
        disabled={draft.sending || !draft.text.trim()}
        onClick={onTransfer}
      >
        <SendIcon data-icon="inline-start" />
        確認回填並送出
      </Button>
    </Card>
  );
}

function message(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

function useSummaryDraft(chatId: string, mainReady: boolean, onTransferred: () => void) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  async function preview() {
    setPreviewing(true);
    setPreviewError(null);

    try {
      setDraft({ text: await previewSideChatSummary(chatId), error: null, sending: false });
    } catch (cause) {
      setPreviewError(message(cause, "產生摘要失敗"));
    } finally {
      setPreviewing(false);
    }
  }

  async function send(current: Draft) {
    setDraft({ ...current, error: null, sending: true });

    try {
      await transferSideChat(chatId, current.text.trim());
      onTransferred();
    } catch (cause) {
      setDraft({ ...current, sending: false, error: message(cause, "回填摘要失敗") });
    }
  }

  function transfer() {
    if (draft && !mainReady) {
      setDraft({ ...draft, error: "主對話正在執行，草稿已保留，請稍後再確認。" });
    } else if (draft) {
      void send(draft);
    }
  }

  return {
    draft,
    previewing,
    previewError,
    preview,
    transfer,
    edit: (text: string) => setDraft((current) => current && { ...current, text }),
  };
}

type SummaryDraft = ReturnType<typeof useSummaryDraft>;

function PreviewButton({ busy, summary }: { busy: boolean; summary: SummaryDraft }) {
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy || summary.previewing}
      onClick={() => void summary.preview()}
    >
      <FileTextIcon data-icon="inline-start" />
      {summary.previewing ? "整理中" : "預覽摘要"}
    </Button>
  );
}

function SummaryArea({ summary }: { summary: SummaryDraft }) {
  return (
    <>
      {summary.previewError ? (
        <p role="alert" className="text-xs text-destructive">
          {summary.previewError}
        </p>
      ) : null}
      {summary.draft ? (
        <SummaryCard draft={summary.draft} onChange={summary.edit} onTransfer={summary.transfer} />
      ) : null}
    </>
  );
}

export function SideChatPane({
  chat,
  mainReady,
  onClose,
  onTransferred,
}: {
  chat: SideChat;
  mainReady: boolean;
  onClose: () => void;
  onTransferred: () => void;
}) {
  const thread = useThread(chat.id);
  const summary = useSummaryDraft(chat.id, mainReady, onTransferred);
  const status = threadStatus(thread.phase);

  return (
    <Pane
      pane={{
        id: chat.id,
        title: chat.title,
        agent: "btw",
        status,
        progress: [],
        messages: thread.messages,
        kind: "agent",
      }}
      onClose={onClose}
      onSend={thread.send}
      sendDisabled={thread.phase !== "ready"}
      isHydrating={thread.phase === "loading"}
      hydrationError={thread.error}
      notice={thread.notice}
      actions={<PreviewButton busy={status !== "idle"} summary={summary} />}
    >
      <SummaryArea summary={summary} />
    </Pane>
  );
}
