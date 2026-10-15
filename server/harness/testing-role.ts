import type { UIMessage } from "@tanstack/ai";
import type { Role, RoleCompletion, RoleTask } from "../../shared/testing";
import type { AgentLoopResult } from "./agent-loop";
import type { ConversationState } from "./conversation";
import type { Validation } from "./testing-domain";
import { roleTaskPrompt } from "./role-prompts";

function finalText(conversation: ConversationState): string {
  const message = [...conversation.context].reverse().find((item) => item.role === "assistant");

  return (
    message?.parts
      .filter((part) => part.type === "text")
      .map((part) => part.content)
      .join("") ?? ""
  );
}

function proposalFor(role: Role, conversation: ConversationState): unknown {
  if (role !== "planner") {
    return null;
  }

  try {
    return JSON.parse(finalText(conversation));
  } catch {
    return undefined;
  }
}

function feedback(taskId: string, issues: string[]): UIMessage {
  return {
    id: `${taskId}/feedback`,
    role: "user",
    parts: [
      {
        type: "text",
        content: `Private validation failed: ${issues
          .slice(0, 20)
          .map((issue) => issue.slice(0, 512))
          .join("; ")}`,
      },
    ],
  };
}

function rejection(role: Role, issues: string[]): RoleCompletion {
  return {
    state: "failed",
    candidate: null,
    findings: null,
    reason: role === "atlassian" ? "source_reads_incomplete" : "proposal_rejected",
    issues: issues.slice(0, 8).map((issue) => issue.slice(0, 240)),
  };
}

type RolePasses = {
  role: Role;
  taskId: string;
  task: RoleTask;
  pass: (
    conversation: ConversationState,
    maxTurns: number,
    prefix: string,
  ) => Promise<AgentLoopResult>;
  validate: (candidate: unknown, name: string) => Promise<Validation>;
};

function passesFor(role: Role) {
  return role === "ac" || role === "ui"
    ? [{ turns: 20, prefix: "a", validation: "proposal" }]
    : [
        { turns: 6, prefix: "a", validation: "proposal" },
        { turns: 2, prefix: "b", validation: "proposal-2" },
      ];
}

function readyCompletion(
  role: Role,
  candidate: unknown,
  payload: Extract<Validation, { valid: true }>["payload"],
  conversation: ConversationState,
): RoleCompletion {
  const qa = role === "ac" || role === "ui";

  return {
    state: "ready",
    candidate: role === "planner" ? candidate : payload,
    findings: qa ? finalText(conversation) || null : null,
  };
}

export async function runRolePasses(input: RolePasses): Promise<RoleCompletion> {
  const { role, taskId, task } = input;
  const messages: UIMessage[] = [
    {
      id: `${taskId}/task`,
      role: "user",
      parts: [{ type: "text", content: roleTaskPrompt(role, task) }],
    },
  ];
  let conversation: ConversationState = { display: messages, context: messages };

  for (const pass of passesFor(role)) {
    const result = await input.pass(conversation, pass.turns, pass.prefix);
    conversation = result.conversation;

    if (result.state === "limit") {
      return { state: "failed", candidate: null, findings: null, reason: "budget" };
    }

    const candidate = proposalFor(role, conversation);
    const validation = await input.validate(candidate, pass.validation);

    if (validation.valid) {
      return readyCompletion(role, candidate, validation.payload, conversation);
    }

    if (pass.prefix === "b") {
      return rejection(role, validation.issues);
    }

    const message = feedback(taskId, validation.issues);
    conversation = {
      display: [...conversation.display, message],
      context: [...conversation.context, message],
    };
  }

  throw new Error("Role did not finish");
}
