import type { UIMessage } from "@tanstack/ai";
import type { RoleId } from "../../shared/testing";
import {
  runAgentLoop,
  type AgentCheckpoint,
  type AgentLoopResult,
  type AgentOrchestration,
  type AgentSession,
} from "./agent-loop";
import { roleRegistry } from "./agents";
import type { ConversationState } from "./conversation";
import {
  roleFeedbackPrompt,
  roleFinalTurnPrompt,
  roleTaskPrompt,
  type RoleTaskInput,
} from "./prompts";
import { canonicalizePlan, digestOf, publicIssues, type Requirements } from "./testing-domain";
import type { RoleCompletion } from "./testing-store";

export type ReviewName = "proposal" | "proposal-2";

export type RoleReview<R extends RoleId = RoleId> = Readonly<{
  completion: RoleCompletion & { role: R };
  issues: readonly string[];
}>;

export type RoleLoopResult =
  | Readonly<{ state: "ready"; completion: RoleCompletion }>
  | Readonly<{
      state: "failed";
      reason: "proposal_rejected" | "source_reads_incomplete" | "context_overflow" | "budget";
      issues?: readonly string[];
    }>;

export type PlannerResult =
  | Readonly<{ state: "ready"; completion: { role: "planner"; proposal: unknown } }>
  | Readonly<{ state: "failed"; reason: "proposal_rejected"; issues: readonly string[] }>;

type PlannerReviewContext = Pick<RoleTaskInput, "intent" | "requirements">;

type RoleRunInput = Readonly<{
  role: RoleId;
  task: RoleTaskInput;
  turns: number;
  systemPrompt: string;
  session: AgentSession;
  checkpoint: AgentCheckpoint;
  orchestration?: AgentOrchestration;
  signal: AbortSignal;
  review: (conversation: ConversationState, name: ReviewName) => Promise<RoleReview>;
}>;

const FEEDBACK_TURNS = 2;
const CONTEXT_OVERFLOW_ISSUE = "Model context capacity exceeded";

export function rolePassTurns(
  turns: number,
  role: RoleId,
): Readonly<{ initial: number; feedback: number }> {
  return role === "ac" || role === "ui"
    ? { initial: turns, feedback: 0 }
    : { initial: turns - FEEDBACK_TURNS, feedback: FEEDBACK_TURNS };
}

type MessageParts = ConversationState["context"][number]["parts"];

function textOfParts(parts: MessageParts): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => ("content" in part ? String(part.content) : ""))
    .join("");
}

function assistantText(conversation: ConversationState): string {
  const assistant = [...conversation.context]
    .reverse()
    .find((message) => message.role === "assistant");

  return assistant ? textOfParts(assistant.parts) : "";
}

export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start < 0 || end <= start) {
    throw new Error("Role output is not valid JSON");
  }

  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    throw new Error("Role output is not valid JSON");
  }
}

function planIssues(
  context: PlannerReviewContext & { requirements: Requirements },
  proposal: unknown,
): string[] {
  const validation = canonicalizePlan(proposal, {
    requirementsDigest: digestOf(context.requirements),
    goal: context.intent.goal,
    targetUrl: context.intent.targetUrl,
    design: context.intent.design ?? null,
  });

  if (validation.kind === "rejected") {
    return [...validation.issues];
  }

  return validation.value.cases.flatMap((planCase) =>
    planCase.checks
      .filter((check) => (check.kind === "functional" ? !check.observation : !check.target))
      .map((check) => `Check ${check.id} requires a typed executable observation or style target`),
  );
}

function proposalIssues(context: PlannerReviewContext, proposal: unknown): string[] {
  const { requirements } = context;

  return requirements
    ? planIssues({ ...context, requirements }, proposal)
    : ["requirements_missing"];
}

export function reviewPlanner(
  context: PlannerReviewContext,
  conversation: ConversationState,
): RoleReview<"planner"> {
  try {
    const proposal = extractJson(assistantText(conversation));

    return { completion: { role: "planner", proposal }, issues: proposalIssues(context, proposal) };
  } catch (error) {
    return {
      completion: { role: "planner", proposal: null },
      issues: [error instanceof Error ? error.message : "invalid json"],
    };
  }
}

function feedbackConversation(
  conversation: ConversationState,
  issues: readonly string[],
): ConversationState {
  const message: UIMessage = {
    id: `feedback-${conversation.context.length}`,
    role: "user",
    parts: [{ type: "text", content: roleFeedbackPrompt(issues) }],
  };

  return {
    display: [...conversation.display, message],
    context: [...conversation.context, message],
  };
}

function qaChildResult(role: "ac" | "ui", result: AgentLoopResult): RoleLoopResult {
  switch (result.state) {
    case "done": {
      const message = result.conversation.context.at(-1);
      const text = message?.role === "assistant" ? textOfParts(message.parts) : "";

      return { state: "ready", completion: { role, findings: text.trim() ? text : null } };
    }

    case "overflow":
      return { state: "failed", reason: "context_overflow", issues: [CONTEXT_OVERFLOW_ISSUE] };
    case "limit":
      return { state: "failed", reason: "budget" };
  }
}

function prefixed(checkpoint: AgentCheckpoint, prefix: string): AgentCheckpoint {
  return (input) => checkpoint({ ...input, name: `${prefix}:${input.name}` });
}

export function runRole(
  input: RoleRunInput & {
    role: "planner";
    review: (conversation: ConversationState, name: ReviewName) => Promise<RoleReview<"planner">>;
  },
): Promise<PlannerResult>;
export function runRole(input: RoleRunInput): Promise<RoleLoopResult>;

export async function runRole(input: RoleRunInput): Promise<RoleLoopResult> {
  const { role, session, signal } = input;
  const prompt = roleTaskPrompt(role, input.task);
  const initial: ConversationState = {
    display: [{ id: "task", role: "user", parts: [{ type: "text", content: prompt }] }],
    context: [{ id: "task", role: "user", parts: [{ type: "text", content: prompt }] }],
  };
  const loop = (conversation: ConversationState, maxTurn: number, prefix: string) =>
    runAgentLoop({
      session,
      conversation,
      model: roleRegistry[role].model,
      prompt: input.systemPrompt,
      compaction: { kind: "bounded", maxTurn },
      finalTurn: roleFinalTurnPrompt(role),
      checkpoint: prefixed(input.checkpoint, prefix),
      orchestration: input.orchestration,
      signal,
    });
  const passes = rolePassTurns(input.turns, role);
  const first = await loop(initial, passes.initial, "a");

  if (role === "ac" || role === "ui") {
    return qaChildResult(role, first);
  }

  const decision = await input.review(first.conversation, "proposal");

  if (decision.issues.length === 0) {
    return { state: "ready", completion: decision.completion };
  }

  const second = await loop(
    feedbackConversation(first.conversation, decision.issues),
    passes.feedback,
    "b",
  );
  const again = await input.review(second.conversation, "proposal-2");

  if (again.issues.length === 0) {
    return { state: "ready", completion: again.completion };
  }

  return {
    state: "failed",
    reason: role === "atlassian" ? "source_reads_incomplete" : "proposal_rejected",
    issues: publicIssues(again.issues),
  };
}
