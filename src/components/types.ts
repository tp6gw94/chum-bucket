import type { UIMessage } from "@tanstack/ai-react";
import type { SideChatOrigin } from "../../shared/side-chat";

export type RunStatus = "running" | "compacting" | "idle";

export type ChatMessage = UIMessage & {
  metadata?: { fromSummary?: boolean; sideChatOrigin?: SideChatOrigin };
};

export interface Pane {
  id: string;
  title: string;
  agent: string;
  status: RunStatus;
  progress: string[];
  messages: ChatMessage[];
  kind: "main" | "agent";
}

export interface ThreadSummary {
  id: string;
  title: string;
  agent: string;
  status: RunStatus;
  paneCount: number;
}
