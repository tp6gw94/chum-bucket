import type { UIMessage } from "@tanstack/ai-react";

export type RunStatus = "running" | "compacting" | "idle";

export type ChatMessage = UIMessage & {
  metadata?: { fromSummary?: boolean };
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
