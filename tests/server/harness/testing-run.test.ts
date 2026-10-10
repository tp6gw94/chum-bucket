import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { AdapterYieldChunk } from "@tanstack/ai";
import { RUN_TESTS_TOOL, withRunTools } from "../../../server/harness/tools";
import {
  designProperties,
  hostBrowserOutcomes,
  observeStream,
  restoreDesignCapture,
  sourceAnchors,
} from "../../../server/harness/testing-child";
import { deriveFrontier } from "../../../server/harness/testing-policy";
import { digestOf } from "../../../server/harness/testing-domain";
import type { TestingExecution } from "../../../server/harness/testing-store";
import { testingRequestInputSchema, type PlanCheck } from "../../../shared/testing";

const { scriptedEvents } = createRequire(import.meta.url)(
  "../../fixtures/testing-runtime-external-fixture.mjs",
) as {
  scriptedEvents: (options: {
    systemPrompts: string[];
    messages: unknown[];
  }) => Array<Record<string, unknown>>;
};

test("source anchors come from actual leaf strings", () => {
  assert.deepEqual(sourceAnchors({ issue: { summary: "AC-1", empty: "  " }, count: 1 }), ["AC-1"]);
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

test("host browser outcomes do not copy the model expected observation", () => {
  const checks = [
    {
      id: "check-1",
      criterionId: "crit:AC-1",
      kind: "functional",
      expectedObservation: "UNIQUE-EXPECTED",
    },
  ] as const satisfies readonly PlanCheck[];
  const outcome = hostBrowserOutcomes(checks)["check-1"];
  assert.notEqual(
    outcome && "observed" in outcome ? outcome.observed : outcome?.reason,
    "UNIQUE-EXPECTED",
  );
});

test("run_tests is direct-only on the main scope and rejected by execution", async () => {
  await withRunTools(async (tools) => {
    const ordinary = await tools.getModelTools([]);
    assert.equal(
      ordinary.definitions.some((tool) => tool.name === RUN_TESTS_TOOL),
      false,
    );
    assert.doesNotMatch(ordinary.systemPrompt, /external_run_tests/);
    await assert.rejects(
      () =>
        tools.executeTool(
          [],
          { id: "forged", name: RUN_TESTS_TOOL, arguments: "{}", input: {} },
          { emitCustomEvent: () => undefined },
        ),
      /direct-only/,
    );
  });
  await withRunTools(
    async (tools) => {
      const main = await tools.getModelTools([]);
      assert.equal(
        main.definitions.some((tool) => tool.name === RUN_TESTS_TOOL),
        true,
      );
      const publicInput = {
        goal: "Verify checkout",
        sources: [{ kind: "jira", issueKey: "CHUM-42" }],
        criteria: { kind: "all" },
        targetUrl: "https://preview.example.test/checkout",
      };
      assert.equal(testingRequestInputSchema.safeParse(publicInput).success, true);
      assert.equal(
        testingRequestInputSchema.safeParse({ ...publicInput, childWorkflowId: "forged" }).success,
        false,
      );
      assert.doesNotMatch(main.systemPrompt, /external_run_tests/);
      await assert.rejects(
        () =>
          tools.executeTool(
            [],
            { id: "forged", name: RUN_TESTS_TOOL, arguments: "{}", input: {} },
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
      content: JSON.stringify({
        output: { fields: { summary: "Order confirmation page" } },
        sourceCapture: { anchors: ["Order confirmation page"] },
      }),
    },
    { id: "requirements-json", role: "assistant", content: "{}" },
    { id: "feedback-3", role: "user", content: "Private validation feedback" },
  ];
  const options = {
    systemPrompts: ["Extract grounded acceptance criteria."],
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
  const content = events.find((event) => event.type === "TEXT_MESSAGE_CONTENT")?.delta;
  const requirements = JSON.parse(String(content)) as {
    criteria: Array<{ anchor: string; source: { issueKey: string } }>;
  };
  assert.equal(requirements.criteria[0]?.anchor, "Order confirmation page");
  assert.equal(requirements.criteria[0]?.source.issueKey, "CHUM-42");
});

test("planner fixture uses the accepted requirement identity from its root task", () => {
  const events = scriptedEvents({
    systemPrompts: ["Plan reproducible test cases."],
    messages: [
      {
        role: "user",
        content: `testing-role:planner\ntesting-task:\n${JSON.stringify({
          targetUrl: "https://preview.example.test/orders",
          requirements: {
            criteria: [{ id: "crit:AC-9", key: "AC-9", statement: "Receipt appears" }],
          },
        })}`,
      },
    ],
  });
  const content = events.find((event) => event.type === "TEXT_MESSAGE_CONTENT")?.delta;
  const proposal = JSON.parse(String(content)) as {
    cases: Array<{ checks: Array<{ criterionId: string }> }>;
  };
  assert.equal(proposal.cases[0]?.checks[0]?.criterionId, "crit:AC-9");
});

test("frontier dispatches only missing required roles", () => {
  const execution = {
    finished: false,
    cancelRequested: false,
    decisions: [{ kind: "satisfied", role: "atlassian", ref: "req", origin: "produced" }],
    artifacts: [
      {
        kind: "plan",
        payload: { assignments: { ui: [] } },
      },
    ],
  } as unknown as TestingExecution;
  assert.deepEqual(deriveFrontier({ ...execution, decisions: [] } as TestingExecution), [
    "atlassian",
  ]);
  assert.deepEqual(deriveFrontier(execution), ["planner"]);
});
