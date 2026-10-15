import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolExecutionContext, UIMessage } from "@tanstack/ai";
import type { PlanArtifact, Role } from "../../../shared/testing";
import { digestOf, type Receipt, type RoleContext } from "../../../server/harness/testing-domain";
import { withRoleTools, type RoleStore } from "../../../server/harness/testing-tools";
import type { ModelCall } from "../../../server/harness/model-turn";
import { mcpFixture, withMcpEnvironment } from "../../fixtures/mcp-fixture";

const design = { fileKey: "abc123", nodeId: "1:2" };

const plan: PlanArtifact = {
  criteria: [{ id: "AC-1", statement: "Submit shows a confirmation" }],
  unresolved: [],
  cases: [
    {
      id: "case-1",
      title: "Submit order",
      preconditions: [],
      actions: [{ kind: "navigate", path: "/" }],
      checks: [
        {
          id: "check-1",
          criterionId: "AC-1",
          kind: "functional",
          expectedObservation: "Thanks",
          observation: { kind: "text", target: "confirmation", comparison: "contains" },
        },
        {
          id: "check-2",
          criterionId: "AC-1",
          kind: "style",
          design,
          property: "color",
          target: "submit button",
          tolerance: { kind: "exact" },
        },
      ],
    },
  ],
  assignments: { ac: ["check-1"], ui: ["check-2"] },
  requirementsRef: "art-1",
  requirementsDigest: digestOf("requirements"),
  goal: "Checkout works",
  targetUrl: null,
  design,
};

type Recorded = Parameters<RoleStore["recordReceipt"]>[0];

function fakeStore(options: { denied?: boolean; receipts?: Receipt[] } = {}) {
  const recorded: Recorded[] = [];
  const guarded: Parameters<RoleStore["guard"]>[0][] = [];
  const store: RoleStore = {
    guard: async (input) => {
      guarded.push(input);

      return options.denied ? { state: "denied", reason: "budget" } : { state: "allowed" };
    },
    recordReceipt: async (input) => {
      recorded.push(input);

      return {
        receiptId: `receipt-${recorded.length}`,
        outputDigest: digestOf(input.output),
        duplicate: false,
      };
    },
    receipts: async () => options.receipts ?? [],
  };

  return { store, recorded, guarded };
}

function runtime(role: Role, context: RoleContext, store: RoleStore) {
  return {
    child: {
      taskId: `task-${role}`,
      attemptNonce: 1,
      childWorkflowId: `child-${role}`,
      parentRunId: "run",
      operationId: "testing-op",
      role,
    },
    context,
    store,
  };
}

const context: ToolExecutionContext = { toolCallId: "call-1", emitCustomEvent: () => {} };

function call(name: string, input: Record<string, unknown>): ModelCall {
  return { id: "call-1", name, arguments: JSON.stringify(input), input };
}

async function withoutJev<T>(use: () => Promise<T>): Promise<T> {
  const previous = process.env.JEV_API_KEY;
  delete process.env.JEV_API_KEY;

  try {
    return await withMcpEnvironment(use, false);
  } finally {
    if (previous !== undefined) {
      process.env.JEV_API_KEY = previous;
    }
  }
}

const acContext: RoleContext = {
  role: "ac",
  planRef: "art-2",
  plan,
  targetUrl: "http://localhost:4173/",
};

test("ac role exposes only verify_ac and records finished evidence", async () => {
  const { store, recorded, guarded } = fakeStore();

  await withoutJev(() =>
    withRoleTools(runtime("ac", acContext, store), async (tools) => {
      const turn = await tools.getModelTools([]);
      assert.deepEqual(
        turn.definitions.map((definition) => definition.name),
        ["verify_ac"],
      );

      const output = (await tools.executeTool(
        [],
        call("verify_ac", { checkId: "check-1" }),
        context,
      )) as Record<string, unknown>;
      const evidence = output.evidence as { check: { outcome: string; reason: string } };

      assert.equal(output.checkId, "check-1");
      assert.equal(output.receiptId, "receipt-1");
      assert.equal(evidence.check.outcome, "blocked");
      assert.match(evidence.check.reason, /JEV_API_KEY/);

      await assert.rejects(
        tools.executeTool([], call("verify_ac", { checkId: "check-2" }), context),
        /Unknown scoped check/,
      );
    }),
  );

  assert.deepEqual(
    guarded.map((entry) => [entry.kind, entry.step, entry.name]),
    [
      ["tool", "tool:call-1", "verify_ac"],
      ["tool", "tool:call-1", "verify_ac"],
    ],
  );
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.slot, "task-ac-io-call-1");
  assert.deepEqual(recorded[0]!.bindings, {
    checkId: "check-1",
    fixture: "playwright-chromium@v1",
    adapter: "playwright-jev-v1",
  });
});

test("denied guards stop tool execution before any receipt", async () => {
  const { store, recorded } = fakeStore({ denied: true });

  await withoutJev(() =>
    withRoleTools(runtime("ac", acContext, store), async (tools) => {
      await assert.rejects(
        tools.executeTool([], call("verify_ac", { checkId: "check-1" }), context),
        /Denied: budget/,
      );
    }),
  );

  assert.equal(recorded.length, 0);
});

const uiContext: RoleContext = { ...acContext, role: "ui" };

test("ui role hides verify_ui until the design is captured", async () => {
  const { store } = fakeStore();

  await withoutJev(() =>
    withRoleTools(runtime("ui", uiContext, store), async (tools) => {
      const turn = await tools.getModelTools([]);
      assert.deepEqual(
        turn.definitions.map((definition) => definition.name),
        ["get_figma"],
      );

      await assert.rejects(
        tools.executeTool([], call("get_figma", { target: "other999", nodeId: "1:2" }), context),
        /limited to task\.design/,
      );
      await assert.rejects(
        tools.executeTool([], call("get_figma", { target: "abc123", nodeId: "9:9" }), context),
        /limited to task\.design/,
      );
    }),
  );
});

test("ui role resumes with a captured design from earlier receipts", async () => {
  const capture: Receipt = {
    id: "r-0",
    slot: "task-ui-io-old",
    nativeName: "design_capture",
    route: "direct",
    input: {},
    output: { ...design, properties: { color: "rgb(255, 0, 0)" } },
    inputDigest: digestOf({}),
    outputDigest: digestOf({}),
    bindings: design,
    createdAt: "2026-10-15T00:00:00.000Z",
  };
  const { store } = fakeStore({ receipts: [capture] });

  await withoutJev(() =>
    withRoleTools(runtime("ui", uiContext, store), async (tools) => {
      const turn = await tools.getModelTools([]);
      assert.deepEqual(turn.definitions.map((definition) => definition.name).sort(), [
        "get_figma",
        "verify_ui",
      ]);
    }),
  );
});

test("planner role only gets code mode with no external tools", async () => {
  const { store } = fakeStore();
  const planner: RoleContext = {
    role: "planner",
    requirementsRef: "art-1",
    requirements: { goal: "g", sources: [] },
    design: null,
  };

  await withoutJev(() =>
    withRoleTools(runtime("planner", planner, store), async (tools) => {
      const turn = await tools.getModelTools([]);

      assert.ok(turn.definitions.every((definition) => definition.name === "codemode"));
      await assert.rejects(tools.executeTool([], call("read", { path: "/etc/hosts" }), context));
    }),
  );
});

const atlassianContext: RoleContext = {
  role: "atlassian",
  intent: {
    role: "atlassian",
    summary: "Read TEST-1 and leave a comment",
    goal: "Checkout works",
    sources: [{ kind: "jira", issueKey: "TEST-1" }],
  },
};

test("atlassian role sees jira_add_comment as an approval proposal that never runs directly", async () => {
  const { store } = fakeStore();
  const fixture = mcpFixture();

  await withMcpEnvironment(
    () =>
      withRoleTools(runtime("atlassian", atlassianContext, store), async (tools) => {
        const toolNames = ["jira_get_issue", "jira_add_comment"];
        const discovery = (await tools.executeTool(
          [],
          call("discover_atlassian_tools", { toolNames }),
          context,
        )) as { tools: { name: string; description: string; inputSchema: unknown }[] };
        const proposed = discovery.tools.find((tool) => tool.name === "jira_add_comment")!;

        assert.match(proposed.description, /approve/);
        assert.deepEqual(Object.keys((proposed.inputSchema as { properties: object }).properties), [
          "issue_key",
          "body",
        ]);
        assert.equal(
          discovery.tools.find((tool) => tool.name === "jira_get_issue")!.description,
          "Read an issue",
        );

        const history: UIMessage[] = [
          {
            id: "discovery-message",
            role: "assistant",
            parts: [
              {
                type: "tool-call",
                id: "call-1",
                name: "discover_atlassian_tools",
                arguments: JSON.stringify({ toolNames }),
                state: "complete",
              },
              {
                type: "tool-result",
                toolCallId: "call-1",
                content: JSON.stringify(discovery),
                state: "complete",
              },
            ],
          },
        ];
        const turn = await tools.getModelTools(history);

        assert.deepEqual(
          turn.definitions.find((tool) => tool.name === "jira_add_comment"),
          {
            name: "jira_add_comment",
            description: proposed.description,
            inputSchema: proposed.inputSchema,
          },
        );
        await assert.rejects(
          tools.executeTool(
            history,
            call("jira_add_comment", { issue_key: "TEST-1", body: "Looks good" }),
            context,
          ),
          /cannot run directly/,
        );
        assert.equal(
          fixture.calls().some((request) => request.message.params?.name === "jira_add_comment"),
          false,
        );
      }),
    true,
    fixture,
  );
});
