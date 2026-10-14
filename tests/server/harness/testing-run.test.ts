import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { AdapterYieldChunk } from "@tanstack/ai";
import { DELEGATE_TASK_TOOL, withRunTools } from "../../../server/harness/tools";
import {
  GuardDenial,
  designProperties,
  extractJson,
  failureReason,
  observeStream,
  restoreDesignCapture,
  rolePassTurns,
} from "../../../server/harness/testing-child";
import { assembleRequirements, digestOf } from "../../../server/harness/testing-domain";
import { roleFeedbackPrompt } from "../../../server/harness/prompts";
import { hostTestingRuntime, type TestingExecution } from "../../../server/harness/testing-store";
import { ROLE_IDS, delegationInputSchema } from "../../../shared/testing";

const { scriptedEvents } = createRequire(import.meta.url)(
  "../../fixtures/testing-runtime-external-fixture.mjs",
) as {
  scriptedEvents: (options: {
    systemPrompts: string[];
    messages: unknown[];
  }) => Array<Record<string, unknown>>;
};

test("source read feedback names unread sources without dumping read text and stays bounded", () => {
  const output = { result: JSON.stringify({ key: "PROJ-123", summary: "private source body" }) };
  const decision = assembleRequirements(
    {
      goal: "Checkout",
      sources: [
        { kind: "jira", issueKey: "PROJ-123" },
        { kind: "confluence", pageId: "77" },
      ],
    },
    [
      {
        nativeName: "jira_get_issue",
        input: { issue_key: "PROJ-123" },
        output,
        outputDigest: digestOf(output),
        bindings: { capturedAt: "2026-10-13T00:00:00.000Z" },
      },
    ],
  );
  assert.equal(decision.kind, "rejected");
  if (decision.kind !== "rejected") throw new Error("Expected private rejection");
  assert.equal(
    roleFeedbackPrompt(decision.issues),
    "Private validation failed: task.sources[1]: confluence:77 has no successful read",
  );
  const bounded = roleFeedbackPrompt(
    Array.from({ length: 25 }, (_, index) => `${index}:` + "x".repeat(600)),
  );
  assert.equal(bounded.length, "Private validation failed: ".length + 20 * 512 + 19 * 2);
  assert.equal(bounded.includes("20:"), false);
});

test("AC and UI use their full 20 turns in one pass while planner and atlassian keep 6 with 2 feedback turns", () => {
  const runtime = hostTestingRuntime({ model: "owner-model", build: "owner-build" });

  assert.deepEqual(
    ROLE_IDS.map((role) => [role, rolePassTurns(runtime, role)]),
    [
      ["atlassian", { initial: 6, feedback: 2 }],
      ["planner", { initial: 6, feedback: 2 }],
      ["ac", { initial: 20, feedback: 0 }],
      ["ui", { initial: 20, feedback: 0 }],
    ],
  );
});

test("design capture rejects truncated output, the wrong node, and missing properties", () => {
  const reference = { fileKey: "CheckoutDemo", nodeId: "12:34" };
  assert.throws(
    () => designProperties({ truncated: true, nodes: [{ id: "12:34" }] }, reference, ["width"]),
    /truncated/,
  );
  assert.throws(
    () =>
      designProperties(
        {
          fileKey: "CheckoutDemo",
          truncated: false,
          nodes: [{ id: "9:9", absoluteBoundingBox: { width: 10 } }],
        },
        reference,
        ["width"],
      ),
    /root node/,
  );
  assert.deepEqual(
    designProperties(
      {
        fileKey: "CheckoutDemo",
        truncated: false,
        nodes: [{ id: "12:34", absoluteBoundingBox: { width: 320, height: 48 }, opacity: 1 }],
      },
      reference,
      ["width", "opacity"],
    ),
    { width: "320px", opacity: "1" },
  );
});

test("design recovery recomputes properties from the exact persisted native receipt", () => {
  const reference = { fileKey: "CheckoutDemo", nodeId: "12:34" };
  const raw = {
    fileKey: "CheckoutDemo",
    truncated: false,
    nodes: [{ id: "12:34", absoluteBoundingBox: { width: 320 } }],
  };
  const properties = { width: "320px" };
  const capture = {
    reference,
    propertiesDigest: digestOf(properties),
    complete: true,
    capturedAt: "2026-01-03T00:00:00.000Z",
  };
  const execution = {
    tasks: [
      {
        frame: { taskId: "task-ui", attemptNonce: 2 },
        receipts: [
          {
            id: "native-slot-figma",
            taskId: "task-ui",
            attemptNonce: 2,
            slot: "slot-figma",
            nativeName: "get_figma",
            route: "direct",
            input: { target: "CheckoutDemo", nodeId: "12:34" },
            output: raw,
            outputDigest: digestOf(raw),
            bindings: {},
          },
          {
            id: "design-slot-figma",
            taskId: "task-ui",
            attemptNonce: 2,
            slot: "slot-figma",
            nativeName: "design_capture",
            route: "direct",
            input: { reference },
            output: capture,
            outputDigest: digestOf(capture),
            bindings: { nativeName: "get_figma", nativeOutputDigest: digestOf(raw) },
          },
        ],
      },
    ],
  } as unknown as TestingExecution;
  assert.deepEqual(restoreDesignCapture(execution, "task-ui", reference, ["width"]), {
    properties,
    capture,
  });
  assert.throws(
    () => restoreDesignCapture(execution, "task-ui", reference, ["height"]),
    /missing property height/,
  );
  const mismatched = structuredClone(execution) as unknown as TestingExecution;
  const mismatchedTask = mismatched.tasks[0]! as unknown as {
    receipts: Array<{ slot: string }>;
  };
  mismatchedTask.receipts[1]!.slot = "different-slot";
  assert.throws(
    () => restoreDesignCapture(mismatched, "task-ui", reference, ["width"]),
    /matching native response/,
  );
});

test("delegate_task is direct-only on the main scope and rejected by execution", async () => {
  await withRunTools(
    async (tools) => {
      const side = await tools.getModelTools([]);
      assert.equal(
        side.definitions.some((tool) => tool.name === DELEGATE_TASK_TOOL),
        false,
      );
      assert.deepEqual(side.definitions.map((tool) => tool.name).sort(), [
        "codemode",
        "edit",
        "get_figma",
        "read",
        "write",
      ]);
      assert.doesNotMatch(side.systemPrompt, /external_delegate_task/);
      await assert.rejects(
        () =>
          tools.executeTool(
            [],
            { id: "forged", name: DELEGATE_TASK_TOOL, arguments: "{}", input: {} },
            { emitCustomEvent: () => undefined },
          ),
        /direct-only/,
      );
    },
    undefined,
    "side",
  );
  await withRunTools(
    async (tools) => {
      const main = await tools.getModelTools([]);
      assert.equal(
        main.definitions.some((tool) => tool.name === DELEGATE_TASK_TOOL),
        true,
      );
      const publicInput = {
        goal: "Verify checkout",
        sources: [{ kind: "jira", issueKey: "CHUM-42" }],
        role: "atlassian",
        summary: "Read checkout requirements",
      };
      assert.equal(delegationInputSchema.safeParse(publicInput).success, true);
      assert.equal(
        delegationInputSchema.safeParse({ ...publicInput, childWorkflowId: "forged" }).success,
        false,
      );
      assert.doesNotMatch(main.systemPrompt, /external_delegate_task/);
      await assert.rejects(
        () =>
          tools.executeTool(
            [],
            { id: "forged", name: DELEGATE_TASK_TOOL, arguments: "{}", input: {} },
            { emitCustomEvent: () => undefined },
          ),
        /direct-only/,
      );
    },
    undefined,
    "main",
  );
});

test("stream close waits for physical provider shutdown after a consumer rejects", async () => {
  let returned = false;
  let returnFinishedBeforeConsumerError = false;
  const outcomes: string[] = [];
  const stream: AsyncIterable<AdapterYieldChunk> = {
    [Symbol.asyncIterator]() {
      let yielded = false;

      return {
        async next(): Promise<IteratorResult<AdapterYieldChunk>> {
          if (yielded) {
            return { done: true, value: undefined };
          }

          yielded = true;

          return {
            done: false,
            value: {
              type: "RUN_STARTED",
              threadId: "provider",
              runId: "provider",
            } as AdapterYieldChunk,
          };
        },
        async return(): Promise<IteratorResult<AdapterYieldChunk>> {
          await new Promise((resolve) => setTimeout(resolve, 25));
          returned = true;

          return { done: true, value: undefined };
        },
      };
    },
  };
  await assert.rejects(
    async () => {
      for await (const _event of observeStream(
        stream,
        async (outcome) => {
          outcomes.push(outcome);
        },
        new AbortController().signal,
      )) {
        throw new Error("consumer validation failed");
      }
    },
    (error: unknown) => {
      returnFinishedBeforeConsumerError = returned && outcomes.join(",") === "failed";

      return error instanceof Error && error.message === "consumer validation failed";
    },
  );
  assert.equal(returnFinishedBeforeConsumerError, true);
  assert.deepEqual(outcomes, ["failed"]);
});

test("scripted provider IDs are stable and do not collide with conversation history", () => {
  const messages = [
    {
      id: "history-message",
      role: "assistant",
      parts: [{ type: "tool-call", id: "read-jira", name: "jira_get_issue" }],
    },
    {
      id: "discovery-result",
      role: "tool",
      name: "discover_atlassian_tools",
      toolCallId: "discover-sources",
      content: JSON.stringify(["jira_get_issue"]),
    },
    {
      id: "history-result",
      role: "tool",
      name: "jira_get_issue",
      toolCallId: "read-jira",
      content: JSON.stringify({ result: JSON.stringify({ key: "CHUM-42", summary: "Order" }) }),
    },
    { id: "requirements-json", role: "assistant", content: "{}" },
    { id: "feedback-3", role: "user", content: "Private validation feedback" },
  ];
  const options = {
    systemPrompts: ["Read the requested sources."],
    messages: [
      {
        role: "user",
        content: `testing-role:atlassian\ntesting-task:\n${JSON.stringify({ sources: [{ kind: "jira", issueKey: "CHUM-42" }] })}`,
      },
      ...messages,
    ],
  };
  const events = scriptedEvents(options);
  assert.deepEqual(events, scriptedEvents(options));
  const historyIds = new Set<string>();

  const collect = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(collect);

      return;
    }

    if (!value || typeof value !== "object") {
      return;
    }

    for (const [key, item] of Object.entries(value)) {
      if (
        typeof item === "string" &&
        ["id", "messageId", "toolCallId", "tool_call_id", "threadId", "runId"].includes(key)
      ) {
        historyIds.add(item);
      }

      collect(item);
    }
  };

  collect(messages);
  const generatedIds = events.flatMap((event) =>
    [event.messageId, event.toolCallId, event.threadId, event.runId].filter(
      (value): value is string => typeof value === "string",
    ),
  );
  assert.equal(
    generatedIds.some((id) => historyIds.has(id)),
    false,
  );
  assert.equal(
    events.find((event) => event.type === "TEXT_MESSAGE_CONTENT")?.delta,
    "Requested sources were read.",
  );
});

test("planner fixture defines criteria from raw source text and references them", () => {
  const events = scriptedEvents({
    systemPrompts: ["Plan reproducible test cases."],
    messages: [
      {
        role: "user",
        content: `testing-role:planner\ntesting-task:\n${JSON.stringify({
          targetUrl: "https://preview.example.test/orders",
          requirements: {
            sources: [{ text: "CHUM-9 Orders\n\n## 驗收條件\n1. AC-9 Receipt appears" }],
          },
        })}`,
      },
    ],
  });
  const content = events.find((event) => event.type === "TEXT_MESSAGE_CONTENT")?.delta;
  const proposal = JSON.parse(String(content)) as {
    criteria: Array<{ id: string; statement: string }>;
    cases: Array<{ checks: Array<{ criterionId: string }> }>;
  };
  assert.deepEqual(proposal.criteria, [{ id: "AC-9", statement: "Receipt appears" }]);
  assert.equal(proposal.cases[0]?.checks[0]?.criterionId, "AC-9");
});

test("the retired whole-pipeline tool is rejected instead of rerouted", async () => {
  await withRunTools(
    async (tools) => {
      await assert.rejects(
        () =>
          tools.executeTool(
            [],
            { id: "legacy", name: "run_tests", arguments: "{}", input: {} },
            { emitCustomEvent: () => undefined },
          ),
        /retired/,
      );
      const main = await tools.getModelTools([]);
      assert.equal(
        main.definitions.some((tool) => tool.name === "delegate_task"),
        true,
      );
      assert.equal(
        main.definitions.some((tool) => tool.name === "run_tests"),
        false,
      );
    },
    undefined,
    "main",
  );
});

test("role output that is not valid JSON is reported without echoing the model text", () => {
  const secret = "sk-secret-token-value";
  for (const text of [`no json here ${secret}`, `{"a": ${secret}}`, `{ broken ${secret} }`]) {
    assert.throws(
      () => extractJson(text),
      (error) => error instanceof Error && error.message === "Role output is not valid JSON",
    );
  }
  assert.deepEqual(extractJson('prefix {"cases":[]} suffix'), { cases: [] });
});

test("a guard denial keeps its reason through the abort while a plain cancel still reads cancelled", () => {
  const denied = new AbortController();
  denied.abort(new GuardDenial("budget"));
  assert.equal(failureReason(new Error("budget"), denied.signal), "budget");

  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal(failureReason(new Error("budget"), cancelled.signal), "cancelled");

  const cancelledFirst = new AbortController();
  cancelledFirst.abort();
  cancelledFirst.abort(new GuardDenial("budget"));
  assert.equal(failureReason(new Error("budget"), cancelledFirst.signal), "cancelled");

  assert.equal(failureReason(new Error("x"), new AbortController().signal), "x");
});
