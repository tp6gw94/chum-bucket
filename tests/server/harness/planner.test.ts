import assert from "node:assert/strict";
import { test } from "node:test";
import { EventType, type AdapterYieldChunk } from "@tanstack/ai";
import type { AgentChatStream } from "../../../server/harness/agent-loop";
import { roleRegistry, roleSystemPrompt } from "../../../server/harness/agents";
import { runPlanner } from "../../../server/harness/planner";
import {
  roleFeedbackPrompt,
  roleFinalTurnPrompt,
  roleTaskPrompt,
  type RoleTaskInput,
} from "../../../server/harness/prompts";
import type { Requirements } from "../../../server/harness/testing-domain";
import { testingIntentSchema } from "../../../shared/testing";

type ModelRequest = Parameters<AgentChatStream>[0];

const intent = testingIntentSchema.parse({
  goal: "Checkout",
  sources: [{ kind: "jira", issueKey: "PROJ-1" }],
  targetUrl: null,
  task: {
    version: 2,
    input: {
      role: "planner",
      summary: "Plan the checkout subset",
      requirementsRef: "requirements-1",
    },
  },
});

const requirements: Requirements = {
  goal: "Checkout",
  sources: [
    {
      reference: { kind: "jira", issueKey: "PROJ-1" },
      text: "The checkout heading is Checkout",
      links: [],
      digest: "digest-1",
      capturedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

const task = { intent, requirements, plan: null } satisfies RoleTaskInput;

const accepted = {
  criteria: [{ id: "AC-1", statement: "The checkout heading is Checkout" }],
  unresolved: [],
  cases: [
    {
      id: "case-1",
      title: "Checkout heading",
      preconditions: [],
      actions: [{ kind: "navigate", path: "/" }],
      checks: [
        {
          id: "check-1",
          criterionId: "AC-1",
          kind: "functional",
          expectedObservation: "Checkout",
          observation: { kind: "text", target: "page heading", comparison: "equals" },
        },
      ],
    },
  ],
};

async function* textReply(text: string, messageId: string): AsyncGenerator<AdapterYieldChunk> {
  yield { type: EventType.RUN_STARTED, threadId: "thread", runId: "provider-run" };
  yield { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" };
  yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text };
  yield { type: EventType.TEXT_MESSAGE_END, messageId };
  yield { type: EventType.RUN_FINISHED, threadId: "thread", runId: "provider-run" };
}

async function* codemodeReply(code: string, toolCallId: string): AsyncGenerator<AdapterYieldChunk> {
  yield { type: EventType.RUN_STARTED, threadId: "thread", runId: "provider-run" };
  yield { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: "codemode" };
  yield { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: JSON.stringify({ code }) };
  yield { type: EventType.TOOL_CALL_END, toolCallId, input: { code } };
  yield { type: EventType.RUN_FINISHED, threadId: "thread", runId: "provider-run" };
}

function plannerSession(replies: readonly (string | Error | AsyncGenerator<AdapterYieldChunk>)[]) {
  const pending = [...replies];
  const requests: ModelRequest[] = [];

  return {
    requests,
    session: {
      runId: "planner-eval",
      assertExecution: async () => {},
      emit: async () => {},
      chatStream: async (options: ModelRequest) => {
        requests.push(options);
        const next = pending.shift();

        if (next === undefined) {
          throw new Error("Unexpected model call");
        }

        if (next instanceof Error) {
          throw next;
        }

        return typeof next === "string" ? textReply(next, `assistant-${requests.length}`) : next;
      },
    },
  };
}

function messageText(message: { content: unknown }): string {
  return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}

test("a valid first proposal is returned ready from the real planner prompt, system prompt, and codemode tools", async () => {
  const { session, requests } = plannerSession([JSON.stringify(accepted)]);
  const result = await runPlanner({
    task,
    session,
    signal: new AbortController().signal,
  });

  assert.deepEqual(result, {
    state: "ready",
    completion: { role: "planner", proposal: accepted },
  });
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.model, roleRegistry.planner.model);
  assert.deepEqual(
    request.tools.map((definition) => definition.name),
    ["codemode"],
  );
  assert.equal(request.systemPrompts[0], roleSystemPrompt("planner", roleRegistry.planner.profile));
  const prompt = roleTaskPrompt("planner", task);
  assert.equal(messageText(request.messages[0]!), prompt);
  assert.match(prompt, /"summary":"Plan the checkout subset"/);
});

test("a codemode turn runs its sandbox computation and the result reaches the next model request", async () => {
  const { session, requests } = plannerSession([
    codemodeReply("return 6 * 7;", "call-1"),
    JSON.stringify(accepted),
  ]);
  const result = await runPlanner({
    task,
    session,
    signal: new AbortController().signal,
  });

  assert.deepEqual(result, {
    state: "ready",
    completion: { role: "planner", proposal: accepted },
  });
  assert.equal(requests.length, 2);
  const toolMessages = requests[1]!.messages.filter((message) => message.role === "tool");
  assert.equal(toolMessages.length, 1);
  assert.match(String(toolMessages[0]!.content), /"result":42/);
});

test("the planner gets six turns with the last one closed to tools before its repair pass", async () => {
  const { session, requests } = plannerSession([
    ...Array.from({ length: 5 }, (_, index) => codemodeReply("return 1;", `call-a-${index}`)),
    "not json at all",
    JSON.stringify(accepted),
  ]);
  const result = await runPlanner({
    task,
    session,
    signal: new AbortController().signal,
  });

  assert.deepEqual(result, {
    state: "ready",
    completion: { role: "planner", proposal: accepted },
  });
  assert.deepEqual(
    requests.map((request) => request.tools.map((definition) => definition.name)),
    [["codemode"], ["codemode"], ["codemode"], ["codemode"], ["codemode"], [], ["codemode"]],
  );
  assert.equal(requests[5]!.systemPrompts[1], roleFinalTurnPrompt("planner"));
});

test("a failed model request is retried within the same turn", async () => {
  const { session, requests } = plannerSession([
    new Error("provider unavailable"),
    JSON.stringify(accepted),
  ]);
  const result = await runPlanner({
    task,
    session,
    signal: new AbortController().signal,
  });

  assert.deepEqual(result, {
    state: "ready",
    completion: { role: "planner", proposal: accepted },
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]!.messages, requests[0]!.messages);
});

test("a rejected first proposal gets one repair pass carrying the private feedback and the full conversation", async () => {
  const { session, requests } = plannerSession(["not json at all", JSON.stringify(accepted)]);
  const result = await runPlanner({
    task,
    session,
    signal: new AbortController().signal,
  });

  assert.deepEqual(result, {
    state: "ready",
    completion: { role: "planner", proposal: accepted },
  });
  assert.equal(requests.length, 2);
  const repair = requests[1]!;
  assert.equal(repair.messages.length, 3);
  assert.equal(messageText(repair.messages[0]!), roleTaskPrompt("planner", task));
  assert.equal(
    messageText(repair.messages.at(-1)!),
    roleFeedbackPrompt(["Role output is not valid JSON"]),
  );
});

test("a proposal rejected twice fails with the public issues of the second review", async () => {
  const withoutObservation = {
    criteria: [{ id: "AC-1", statement: "The checkout heading is Checkout" }],
    unresolved: [],
    cases: [
      {
        id: "case-1",
        title: "Checkout heading",
        preconditions: [],
        actions: [{ kind: "navigate", path: "/" }],
        checks: [
          {
            id: "check-1",
            criterionId: "AC-1",
            kind: "functional",
            expectedObservation: "Checkout",
          },
        ],
      },
    ],
  };
  const { session, requests } = plannerSession([
    "not json at all",
    JSON.stringify(withoutObservation),
  ]);
  const result = await runPlanner({
    task,
    session,
    signal: new AbortController().signal,
  });

  assert.deepEqual(result, {
    state: "failed",
    reason: "proposal_rejected",
    issues: ["Check check-1 requires a typed executable observation or style target"],
  });
  assert.equal(requests.length, 2);
});
