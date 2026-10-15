import { createParser, Renderer, type ParseResult } from "@openuidev/react-lang";
import { MarkDownRenderer } from "@openuidev/react-ui";
import { openuiLibrary } from "@openuidev/react-ui/genui-lib";
import { useMemo } from "react";
import remarkGfm from "remark-gfm";

import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Message, MessageContent, MessageGroup, MessageHeader } from "@/components/ui/message";
import type { TestView } from "../../shared/testing";
import type { ToolApprovals } from "../../shared/tool-approval";
import type { TestingViews } from "../lib/testing-views";
import { TestingPanel } from "./testing-panel";
import { ToolApprovalList, type DecideToolApproval } from "./tool-approvals";
import { type ChatMessage } from "./types";
import { ToolCall } from "./tool-call";

type TestingProps = {
  testing?: TestingViews;
  onTestingUpdate?: (view: TestView) => void;
  approvals?: ToolApprovals;
  onApprovalDecision?: DecideToolApproval;
};

const assistantReplyParser = createParser(openuiLibrary.toJSONSchema(), openuiLibrary.root);
const openuiStart = /^\s*\$?[A-Za-z_]\w*\s*=(?!=)/;
const markdownOptions = { remarkPlugins: [remarkGfm] };

export function parseAssistantReply(text: string): ParseResult {
  return assistantReplyParser.parse(text);
}

function AssistantMessage({ text, isStreaming }: { text: string; isStreaming: boolean }) {
  const result = useMemo(
    () => (isStreaming ? null : parseAssistantReply(text)),
    [text, isStreaming],
  );
  const errors = result?.meta.errors ?? [];

  if (!openuiStart.test(text) || result?.root === null) {
    return (
      <Bubble variant="muted" align="start">
        <BubbleContent>
          <MarkDownRenderer textMarkdown={text} options={markdownOptions} />
        </BubbleContent>
      </Bubble>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      {errors.length > 0 ? (
        <p className="text-xs text-destructive">
          部分元件無法解析：
          {[...new Set(errors.map((error) => error.component))].join("、")}
        </p>
      ) : null}
      <Renderer response={text} library={openuiLibrary} isStreaming={isStreaming} />
    </div>
  );
}

function SummaryMessage({ text }: { text: string }) {
  const [preamble = "", ...body] = text.split("\n\n");

  return (
    <div className="flex flex-col gap-2">
      <Marker variant="separator">
        <MarkerContent>對話摘要</MarkerContent>
      </Marker>
      <details className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
        <summary className="cursor-pointer text-muted-foreground select-none">{preamble}</summary>
        <div className="mt-2 min-w-0">
          <MarkDownRenderer textMarkdown={body.join("\n\n")} options={markdownOptions} />
        </div>
      </details>
    </div>
  );
}

function ToolCallWithTesting({
  part,
  testing,
  onTestingUpdate,
  approvals,
  onApprovalDecision,
}: TestingProps & { part: Extract<ChatMessage["parts"][number], { type: "tool-call" }> }) {
  const delegated = part.name === "delegate_task";
  const view = delegated ? testing?.[part.id] : undefined;

  return (
    <>
      <ToolCall part={part} />
      {view ? <TestingPanel view={view} onUpdate={onTestingUpdate ?? (() => undefined)} /> : null}
      {delegated && approvals ? (
        <ToolApprovalList
          approvals={approvals}
          requestKey={part.id}
          onDecide={onApprovalDecision}
        />
      ) : null}
    </>
  );
}

function ChatMessageRow({
  message,
  agent,
  isStreaming,
  ...testingProps
}: TestingProps & {
  message: ChatMessage;
  agent: string;
  isStreaming: boolean;
}) {
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.content)
    .join("");

  if (message.role === "system") {
    return (
      <Marker variant="separator">
        <MarkerContent>{text}</MarkerContent>
      </Marker>
    );
  }

  if (message.metadata?.fromSummary === true) {
    return <SummaryMessage text={text} />;
  }

  const align = message.role === "user" ? "end" : "start";
  const header = message.role === "assistant" ? agent : null;

  return (
    <Message align={align}>
      <MessageContent>
        {header ? <MessageHeader>{header}</MessageHeader> : null}
        {message.role === "assistant" ? (
          <div className="flex min-w-0 flex-col gap-2">
            {message.parts.map((part) =>
              part.type === "tool-call" ? (
                <ToolCallWithTesting key={part.id} part={part} {...testingProps} />
              ) : null,
            )}
            {text.trim() !== "" ? <AssistantMessage text={text} isStreaming={isStreaming} /> : null}
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
  ...testingProps
}: TestingProps & {
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
          {...testingProps}
        />
      ))}
    </MessageGroup>
  );
}
