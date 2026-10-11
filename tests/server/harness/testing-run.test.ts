import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { AdapterYieldChunk } from "@tanstack/ai";
import { DELEGATE_TASK_TOOL, withRunTools } from "../../../server/harness/tools";
import {
  designProperties,
  hostBrowserOutcomes,
  observeStream,
  restoreDesignCapture,
  sourceAnchors,
} from "../../../server/harness/testing-child";
import {
  digestOf,
  sourceCaptureView,
  validateRequirements,
} from "../../../server/harness/testing-domain";
import { roleFeedbackPrompt } from "../../../server/harness/prompts";
import type { TestingExecution } from "../../../server/harness/testing-store";
import { delegationInputSchema, type PlanCheck } from "../../../shared/testing";

const { scriptedEvents } = createRequire(import.meta.url)(
  "../../fixtures/testing-runtime-external-fixture.mjs",
) as {
  scriptedEvents: (options: {
    systemPrompts: string[];
    messages: unknown[];
  }) => Array<Record<string, unknown>>;
};

test("private ID feedback identifies the selected capture without dumping source and stays bounded", () => {
  const source = { kind: "jira" as const, issueKey: "PROJ-123" };
  const capture = {
    reference: source,
    digest: "selected-native-digest",
    anchors: ["private source body"],
    capturedAt: "today",
  };
  const validId = sourceCaptureView(capture).anchorRefs[0]!.id;
  const decision = validateRequirements(
    {
      criteria: [
        { key: "AC-1", statement: "Checkout succeeds", source, anchorId: "later-read-id" },
      ],
      unresolved: [],
    },
    { goal: "Checkout", selection: { kind: "all" }, captures: [capture] },
  );
  assert.equal(decision.kind, "rejected");
  if (decision.kind !== "rejected") throw new Error("Expected private rejection");
  const feedback = roleFeedbackPrompt(decision.issues);
  assert.match(feedback, /host-selected capture/);
  assert.ok(feedback.includes(capture.digest));
  assert.ok(feedback.includes(validId));
  assert.equal(feedback.includes(capture.anchors[0]!), false);
  const bounded = roleFeedbackPrompt(
    Array.from({ length: 25 }, (_, index) => `${index}:` + "x".repeat(600)),
  );
  assert.equal(bounded.length, "Private validation failed: ".length + 20 * 512 + 19 * 2);
  assert.equal(bounded.includes("20:"), false);
});

test("source anchors come from actual leaf strings", () => {
  assert.deepEqual(sourceAnchors({ issue: { summary: "AC-1", empty: "  " }, count: 1 }), ["AC-1"]);
});

test("source anchors decode the Jira result envelope without treating serialized JSON as evidence", () => {
  const issue = { key: "FETM-78", summary: "Plan checkout", description: "d".repeat(456) };
  assert.deepEqual(sourceAnchors({ result: JSON.stringify(issue) }, 24, "jira_get_issue"), [
    "d".repeat(456),
    "FETM-78",
    "Plan checkout",
  ]);
  assert.deepEqual(
    sourceAnchors(
      { result: JSON.stringify({ ...issue, description: "d".repeat(2048) }) },
      24,
      "jira_get_issue",
    ),
    ["FETM-78", "Plan checkout"],
  );
  for (const result of ["", "{broken", "null", "[]", "{}", '{"error":"not found"}']) {
    assert.deepEqual(sourceAnchors({ result }, 24, "jira_get_issue"), [], result);
  }
  assert.deepEqual(sourceAnchors({ description: '{"key":"FETM-78"}' }), ['{"key":"FETM-78"}']);
});

test("Jira content anchors survive metadata exhausting the leaf budget", () => {
  const metadata = Object.fromEntries(
    Array.from({ length: 30 }, (_, index) => [`custom-${index}`, { field_id: `field-${index}` }]),
  );
  const anchors = sourceAnchors(
    {
      result: JSON.stringify({
        ...metadata,
        key: "FETM-78",
        summary: "Plan checkout",
        description: "The product costs NT$100",
      }),
    },
    24,
    "jira_get_issue",
  );
  assert.deepEqual(anchors.slice(0, 3), ["The product costs NT$100", "FETM-78", "Plan checkout"]);
});

test("non-Jira result wrappers keep generic leaf anchors without decoding", () => {
  const page = { title: "Confluence page", body: "Checkout rules" };
  const result = JSON.stringify(page);
  for (const nativeName of [undefined, "confluence_get_page", "unknown_tool"]) {
    assert.deepEqual(sourceAnchors({ result }, 24, nativeName), [result]);
    assert.deepEqual(sourceAnchors({ result: page }, 24, nativeName), [
      "Checkout rules",
      "Confluence page",
    ]);
    assert.deepEqual(
      sourceAnchors({ result: [{ title: "Confluence page" }, "Checkout rules"] }, 24, nativeName),
      ["Confluence page", "Checkout rules"],
    );
    assert.deepEqual(sourceAnchors({ result: '{"key":"FETM-78"}' }, 24, nativeName), [
      '{"key":"FETM-78"}',
    ]);
  }
});

test("Jira plain objects and object or array results retain generic leaf behavior", () => {
  const issue = { key: "FETM-78", summary: "Plan checkout", description: "Checkout rules" };
  const expected = ["Checkout rules", "FETM-78", "Plan checkout"];
  assert.deepEqual(sourceAnchors(issue, 24, "jira_get_issue"), expected);
  assert.deepEqual(sourceAnchors({ result: issue }, 24, "jira_get_issue"), expected);
  assert.deepEqual(sourceAnchors({ result: [issue] }, 24, "jira_get_issue"), expected);
});

test("duplicate Jira priority anchors do not spend the unique anchor budget", () => {
  const result = JSON.stringify({
    description: "Checkout description",
    key: "FETM-78",
    summary: "Plan checkout",
    details: ["detail-1", "detail-2", "detail-3", "detail-4"],
    zAcceptance: "Tail acceptance",
    zzOverflow: "Over budget",
  });
  assert.deepEqual(sourceAnchors({ result }, 8, "jira_get_issue"), [
    "Checkout description",
    "FETM-78",
    "Plan checkout",
    "detail-1",
    "detail-2",
    "detail-3",
    "detail-4",
    "Tail acceptance",
  ]);
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
        criteria: { kind: "all" },
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
