import { createParser, Renderer, type ActionEvent, type ParseResult } from "@openuidev/react-lang";
import { openuiLibrary } from "@openuidev/react-ui/genui-lib";
import { useMemo, useRef, useState } from "react";

import type { SendResult } from "../hooks/use-threads";

import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Message, MessageContent, MessageHeader } from "@/components/ui/message";
import { MessageScrollerItem } from "@/components/ui/message-scroller";
import { type ChatMessage } from "./types";
import { ToolCall } from "./tool-call";

const assistantReplyParser = createParser(openuiLibrary.toJSONSchema(), openuiLibrary.root);

const MESSAGE_ALIGN = {
  system: "start",
  user: "end",
  assistant: "start",
} as const;

export function parseAssistantReply(text: string): ParseResult {
  return assistantReplyParser.parse(text);
}

export function formatActionMessage(event: ActionEvent): string | null {
  if (event.type !== "continue_conversation") {
    return null;
  }

  const details: {
    formState?: Record<string, unknown>;
    formName?: string;
    context?: unknown;
  } = {};

  if (event.formState !== undefined) {
    details.formState = event.formState;
  }

  if (event.formName !== undefined) {
    details.formName = event.formName;
  }

  if (
    Object.prototype.hasOwnProperty.call(event.params, "context") &&
    event.params.context !== undefined
  ) {
    details.context = event.params.context;
  }

  if (Object.keys(details).length === 0) {
    return event.humanFriendlyMessage;
  }

  return `${event.humanFriendlyMessage}\n\n${JSON.stringify(details, null, 2)}`;
}

type ActionStatus = { kind: "idle" } | { kind: "pending" } | { kind: "error"; message: string };

type AssistantPresentation =
  | { kind: "raw"; text: string }
  | { kind: "render"; text: string; errorNames: readonly string[] };

function isRawFallback(text: string, result: ParseResult | null): boolean {
  return result !== null && result.root === null && text.trim() !== "";
}

function parseErrorNames(result: ParseResult | null): readonly string[] {
  const errors = result?.meta.errors ?? [];

  return [...new Set(errors.map((error) => error.component))];
}

function assistantPresentation(text: string, result: ParseResult | null): AssistantPresentation {
  if (isRawFallback(text, result)) {
    return { kind: "raw", text };
  }

  return { kind: "render", text, errorNames: parseErrorNames(result) };
}

function messageText(message: ChatMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.content)
    .join("");
}

function messageHeader(message: ChatMessage, agent: string): string | null {
  if (message.metadata?.fromSummary) {
    return "壓縮摘要";
  }

  if (message.role === "assistant") {
    return agent;
  }

  return null;
}

function AssistantMessage({
  text,
  isStreaming,
  controlsDisabled,
  onAction,
}: {
  text: string;
  isStreaming: boolean;
  controlsDisabled: boolean;
  onAction: (event: ActionEvent) => void;
}) {
  const result = useMemo(
    () => (isStreaming ? null : parseAssistantReply(text)),
    [text, isStreaming],
  );
  const presentation = assistantPresentation(text, result);

  if (presentation.kind === "raw") {
    return (
      <Bubble variant="muted" align="start">
        <BubbleContent className="whitespace-pre-wrap">{presentation.text}</BubbleContent>
      </Bubble>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      {presentation.errorNames.length > 0 ? (
        <p className="text-xs text-destructive">
          部分元件無法解析：
          {presentation.errorNames.join("、")}
        </p>
      ) : null}
      <fieldset
        disabled={controlsDisabled}
        inert={controlsDisabled}
        className="m-0 min-w-0 border-0 p-0"
      >
        <Renderer
          response={text}
          library={openuiLibrary}
          isStreaming={isStreaming}
          onAction={onAction}
        />
      </fieldset>
    </div>
  );
}

function AssistantBody({
  message,
  text,
  isStreaming,
  controlsDisabled,
  onAction,
}: {
  message: ChatMessage;
  text: string;
  isStreaming: boolean;
  controlsDisabled: boolean;
  onAction: (event: ActionEvent) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {message.parts.map((part) =>
        part.type === "tool-call" ? <ToolCall key={part.id} part={part} /> : null,
      )}
      {text.trim() !== "" ? (
        <AssistantMessage
          text={text}
          isStreaming={isStreaming}
          controlsDisabled={controlsDisabled}
          onAction={onAction}
        />
      ) : null}
    </div>
  );
}

function ChatMessageRow({
  message,
  agent,
  isStreaming,
  controlsDisabled,
  onAction,
}: {
  message: ChatMessage;
  agent: string;
  isStreaming: boolean;
  controlsDisabled: boolean;
  onAction: (event: ActionEvent) => void;
}) {
  const text = messageText(message);

  if (message.role === "system") {
    return (
      <Marker variant="separator">
        <MarkerContent>{text}</MarkerContent>
      </Marker>
    );
  }

  const align = message.metadata?.fromSummary ? "start" : MESSAGE_ALIGN[message.role];
  const header = messageHeader(message, agent);

  return (
    <Message align={align}>
      <MessageContent>
        {header ? <MessageHeader>{header}</MessageHeader> : null}
        {message.metadata?.fromSummary ? (
          <Bubble variant="muted" align="start">
            <BubbleContent className="whitespace-pre-wrap">{text}</BubbleContent>
          </Bubble>
        ) : message.role === "assistant" ? (
          <AssistantBody
            message={message}
            text={text}
            isStreaming={isStreaming}
            controlsDisabled={controlsDisabled}
            onAction={onAction}
          />
        ) : (
          <Bubble variant="default" align={align}>
            <BubbleContent className="whitespace-pre-wrap">{text}</BubbleContent>
          </Bubble>
        )}
      </MessageContent>
    </Message>
  );
}

export function CompactMarker() {
  return (
    <MessageScrollerItem messageId="transient-compact-status">
      <Marker role="status" variant="separator">
        <MarkerContent>compact...</MarkerContent>
      </Marker>
    </MessageScrollerItem>
  );
}

const ACTION_RESULT_ERRORS: Partial<Record<SendResult, string>> = {
  failed: "執行失敗，原文已保留。",
  uncertain: "結果尚未確認，請重新載入對話，原文已保留。",
};

function actionStatusFor(result: SendResult): ActionStatus {
  const message = ACTION_RESULT_ERRORS[result];

  return message ? { kind: "error", message } : { kind: "idle" };
}

function actionFailure(cause: unknown): ActionStatus {
  const message =
    cause instanceof Error && cause.message.trim() !== ""
      ? `送出互動訊息失敗：${cause.message}`
      : "送出互動訊息失敗，請確認對話狀態後再操作。";

  return { kind: "error", message };
}

export function MessageList({
  messages,
  agent,
  onSend,
  disabled = false,
  isStreaming = false,
  compacting = false,
}: {
  messages: ChatMessage[];
  agent: string;
  onSend?: (text: string) => Promise<SendResult>;
  disabled?: boolean;
  isStreaming?: boolean;
  compacting?: boolean;
}) {
  const actionLock = useRef(false);
  const [actionStatus, setActionStatus] = useState<ActionStatus>({ kind: "idle" });
  const sendBlocked = disabled || isStreaming || compacting || !onSend;
  const controlsDisabled = sendBlocked || actionStatus.kind === "pending";
  const streamingId = isStreaming ? messages.at(-1)?.id : undefined;

  async function handleAction(event: ActionEvent) {
    if (event.type !== "continue_conversation" || sendBlocked || actionLock.current) {
      return;
    }

    actionLock.current = true;
    setActionStatus({ kind: "pending" });

    try {
      const text = formatActionMessage(event);
      setActionStatus(text === null ? { kind: "idle" } : actionStatusFor(await onSend(text)));
    } catch (cause) {
      setActionStatus(actionFailure(cause));
    } finally {
      actionLock.current = false;
    }
  }

  return (
    <>
      {messages.map((message) => (
        <MessageScrollerItem key={message.id} messageId={message.id}>
          <ChatMessageRow
            message={message}
            agent={agent}
            isStreaming={message.id === streamingId && message.role === "assistant"}
            controlsDisabled={controlsDisabled}
            onAction={handleAction}
          />
        </MessageScrollerItem>
      ))}
      {compacting ? <CompactMarker /> : null}
      {actionStatus.kind === "pending" ? (
        <p role="status" className="text-sm text-muted-foreground">
          正在送出互動訊息…
        </p>
      ) : null}
      {actionStatus.kind === "error" ? (
        <p role="alert" className="text-sm text-destructive">
          {actionStatus.message}
        </p>
      ) : null}
    </>
  );
}
