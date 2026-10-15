import type { UIMessage } from "@tanstack/ai-react";
import type { TestView } from "../../shared/testing";
import type { TestingViews } from "../lib/testing-views";

export type RunStatus = "running" | "idle";

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
  testing?: TestingViews;
  onTestingUpdate?: (view: TestView) => void;
}

export interface ThreadSummary {
  id: string;
  title: string;
  agent: string;
  status: RunStatus;
  paneCount: number;
}
