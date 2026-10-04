import { createParser, Renderer, type ParseResult } from "@openuidev/react-lang";
import { openuiLibrary } from "@openuidev/react-ui/genui-lib";
import { useMemo } from "react";

import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Message, MessageContent, MessageGroup, MessageHeader } from "@/components/ui/message";
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
    return "摘要";
  }
  if (message.role === "assistant") {
    return agent;
  }
  return null;
}

function AssistantMessage({ text, isStreaming }: { text: string; isStreaming: boolean }) {
  const result = useMemo(
    () => (isStreaming ? null : parseAssistantReply(text)),
    [text, isStreaming],
  );
  const presentation = assistantPresentation(text, result);
  if (presentation.kind === "raw") {
    return (
      <Bubble variant="muted" align="start">
        <BubbleContent className="whitespace-pre-wrap">
          <p className="mb-1 text-xs text-destructive">無法解析為 OpenUI Lang，以下為原始回覆。</p>
          {presentation.text}
        </BubbleContent>
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
      <Renderer response={text} library={openuiLibrary} isStreaming={isStreaming} />
    </div>
  );
}

function AssistantBody({
  message,
  text,
  isStreaming,
}: {
  message: ChatMessage;
  text: string;
  isStreaming: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {message.parts.map((part) =>
        part.type === "tool-call" ? <ToolCall key={part.id} part={part} /> : null,
      )}
      {text.trim() !== "" ? <AssistantMessage text={text} isStreaming={isStreaming} /> : null}
    </div>
  );
}

function ChatMessageRow({
  message,
  agent,
  isStreaming,
}: {
  message: ChatMessage;
  agent: string;
  isStreaming: boolean;
}) {
  const text = messageText(message);
  if (message.role === "system") {
    return (
      <Marker variant="separator">
        <MarkerContent>{text}</MarkerContent>
      </Marker>
    );
  }
  const align = MESSAGE_ALIGN[message.role];
  const header = messageHeader(message, agent);
  return (
    <Message align={align}>
      <MessageContent>
        {header ? <MessageHeader>{header}</MessageHeader> : null}
        {message.role === "assistant" ? (
          <AssistantBody message={message} text={text} isStreaming={isStreaming} />
        ) : (
          <Bubble variant="default" align={align}>
            <BubbleContent className="whitespace-pre-wrap">{text}</BubbleContent>
          </Bubble>
        )}
      </MessageContent>
    </Message>
  );
}

export function MessageList({
  messages,
  agent,
  isStreaming = false,
}: {
  messages: ChatMessage[];
  agent: string;
  isStreaming?: boolean;
}) {
  const streamingId = isStreaming ? messages.at(-1)?.id : undefined;

  return (
    <MessageGroup className="gap-4">
      {messages.map((message) => (
        <ChatMessageRow
          key={message.id}
          message={message}
          agent={agent}
          isStreaming={message.id === streamingId && message.role === "assistant"}
        />
      ))}
    </MessageGroup>
  );
}
