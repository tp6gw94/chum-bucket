import type { UIMessage } from "@tanstack/ai-react";
import type { TestView } from "../../shared/testing";
import type { ToolApprovals } from "../../shared/tool-approval";
import type { TestingViews } from "../lib/testing-views";
import type { DecideToolApproval } from "./tool-approvals";

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
  approvals?: ToolApprovals;
  onApprovalDecision?: DecideToolApproval;
}

export interface ThreadSummary {
  id: string;
  title: string;
  agent: string;
  status: RunStatus;
  paneCount: number;
}
