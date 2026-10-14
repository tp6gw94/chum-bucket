import { createParser, Renderer, type ParseResult } from "@openuidev/react-lang";
import { MarkDownRenderer } from "@openuidev/react-ui";
import { openuiLibrary } from "@openuidev/react-ui/genui-lib";
import { useMemo } from "react";
import remarkGfm from "remark-gfm";

import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Message, MessageContent, MessageGroup, MessageHeader } from "@/components/ui/message";
import { type ChatMessage } from "./types";
import { ToolCall } from "./tool-call";

const assistantReplyParser = createParser(openuiLibrary.toJSONSchema(), openuiLibrary.root);
const openuiLine = /^[ \t]*\$?[A-Za-z_]\w*[ \t]*=(?!=)/m;
const markdownOptions = { remarkPlugins: [remarkGfm] };

export function parseAssistantReply(text: string): ParseResult {
  return assistantReplyParser.parse(text);
}

export function splitAssistantReply(text: string): { prose: string; code: string | null } {
  const match = openuiLine.exec(text);

  if (!match) {
    return { prose: text, code: null };
  }

  return { prose: text.slice(0, match.index).trim(), code: text.slice(match.index) };
}

function Prose({ text }: { text: string }) {
  return (
    <Bubble variant="muted" align="start">
      <BubbleContent>
        <MarkDownRenderer textMarkdown={text} options={markdownOptions} />
      </BubbleContent>
    </Bubble>
  );
}

function AssistantMessage({ text, isStreaming }: { text: string; isStreaming: boolean }) {
  const { prose, code } = useMemo(() => splitAssistantReply(text), [text]);
  const result = useMemo(
    () => (isStreaming || code === null ? null : parseAssistantReply(code)),
    [code, isStreaming],
  );
  const errors = result?.meta.errors ?? [];

  if (code === null || result?.root === null) {
    return <Prose text={text} />;
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      {prose ? <Prose text={prose} /> : null}
      {errors.length > 0 ? (
        <p className="text-xs text-destructive">
          部分元件無法解析：
          {[...new Set(errors.map((error) => error.component))].join("、")}
        </p>
      ) : null}
      <Renderer response={code} library={openuiLibrary} isStreaming={isStreaming} />
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
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.content)
    .join("");
  const lastIndex = message.parts.length - 1;

  if (message.role === "system") {
    return (
      <Marker variant="separator">
        <MarkerContent>{text}</MarkerContent>
      </Marker>
    );
  }

  const align = message.role === "user" ? "end" : "start";
  const header = message.metadata?.fromSummary
    ? "摘要"
    : message.role === "assistant"
      ? agent
      : null;

  return (
    <Message align={align}>
      <MessageContent>
        {header ? <MessageHeader>{header}</MessageHeader> : null}
        {message.role === "assistant" ? (
          <div className="flex min-w-0 flex-col gap-2">
            {message.parts.map((part, index) =>
              part.type === "tool-call" ? (
                <ToolCall key={part.id} part={part} />
              ) : part.type === "text" && part.content.trim() !== "" ? (
                <AssistantMessage
                  key={index}
                  text={part.content}
                  isStreaming={isStreaming && index === lastIndex}
                />
              ) : null,
            )}
          </div>
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
