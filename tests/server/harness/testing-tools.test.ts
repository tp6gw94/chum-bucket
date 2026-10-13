import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ToolExecutionContext, UIMessage } from "@tanstack/ai";
import {
  browserHandoffSchema,
  type DesignReference,
  type FillValueSnapshot,
  type PlanCase,
  type SelectionSnapshot,
  type TestingRequestInput,
} from "../../../shared/testing";
import type { ModelCall } from "../../../server/harness/model-turn";
import {
  assembleRequirements,
  digestOf,
  type CanonicalPlan,
} from "../../../server/harness/testing-domain";
import {
  testingRoleToolNames,
  withTestingRoleTools,
  type DesignCaptureResult,
  type TestingNativeHost,
  type TestingNativeInvocation,
} from "../../../server/harness/testing-tools";
import {
  mcpFixture,
  sourceReadPages,
  sourceReadRule,
  withMcpEnvironment,
} from "../../fixtures/mcp-fixture";
import type { RunTools } from "../../../server/harness/tools";
import type { BrowserAdapter } from "../../../server/harness/tools/use-browser";

const hostFixture: BrowserAdapter = {
  identity: { id: "playwright-chromium", version: "v1" },
  adapterVersion: "playwright-jev-v1",
  run: async (_planCase, check) => ({
    state: "observed",
    observed: check.kind === "functional" ? "Submitted" : "16px",
    browser: { selections: [] },
  }),
};

const design: DesignReference = { fileKey: "abc", nodeId: "1:2" };

const intent: TestingRequestInput = {
  goal: "checkout flow",
  sources: [
    { kind: "jira", issueKey: "PROJ-1" },
    { kind: "confluence", pageId: "123" },
  ],
  targetUrl: "http://127.0.0.1:4173/app",
  design,
};

function testPlan(): CanonicalPlan {
  const planCase: PlanCase = {
    id: "case-1",
    title: "Submit the form",
    preconditions: [],
    actions: [
      { kind: "navigate", path: "/app" },
      { kind: "click", target: "submit" },
    ],
    checks: [
      {
        id: "check-f",
        criterionId: "AC-1",
        kind: "functional",
        expectedObservation: "Submitted",
      },
      {
        id: "check-s",
        criterionId: "AC-1",
        kind: "style",
        design,
        property: "padding-left",
        tolerance: { kind: "numeric", unit: "px", maxDelta: 1 },
      },
    ],
  };

  return {
    requirementsDigest: "req-digest",
    goal: intent.goal,
    targetUrl: intent.targetUrl,
    design,
    criteria: [{ id: "AC-1", statement: "Submitting the form shows Submitted" }],
    unresolved: [],
    cases: [planCase],
    assignments: { ac: ["check-f"], ui: ["check-s"] },
  };
}

const context: ToolExecutionContext = {
  toolCallId: "test-call",
  emitCustomEvent: () => undefined,
};

function modelCall(name: string, input: unknown = {}): ModelCall {
  return { id: `call-${name}`, name, arguments: JSON.stringify(input), input };
}

function designCapture(raw: unknown): DesignCaptureResult {
  const node = (raw as { nodes?: unknown[] }).nodes?.[0] as Record<string, unknown>;
  const properties: Record<string, string> = {};

  if (typeof node.paddingLeft === "number") {
    properties["padding-left"] = `${node.paddingLeft}px`;
  }

  if (typeof node.itemSpacing === "number") {
    properties.gap = `${node.itemSpacing}px`;
  }

  if (typeof node.opacity === "number") {
    properties.opacity = String(node.opacity);
  }

  return {
    properties,
    capture: {
      reference: design,
      propertiesDigest: digestOf(properties),
      complete: true,
      capturedAt: "2026-01-02T00:00:00.000Z",
    },
  };
}

function fixtureHost(options: {
  fixture?: BrowserAdapter;
  invokeDelayMs?: number;
  design?: (raw: unknown) => DesignCaptureResult;
  restoredDesign?: DesignCaptureResult;
}) {
  const invocations: TestingNativeInvocation[] = [];
  const designInputs: Readonly<{
    reference: DesignReference;
    raw: unknown;
    nativeReceipt: { receiptId: string; outputDigest: string };
  }>[] = [];
  let receipts = 0;
  const host: TestingNativeHost = {
    browserFixture: options.fixture,
    restoredDesign: options.restoredDesign,
    async invoke(invocation, work) {
      invocations.push(invocation);

      if (options.invokeDelayMs) {
        await delay(options.invokeDelayMs);
      }

      const output = await work();
      const handoff = browserHandoffSchema.safeParse(output);

      if (handoff.success) {
        return { kind: "ephemeral", output: handoff.data };
      }

      receipts += 1;

      return {
        kind: "receipted",
        output,
        receiptId: `receipt-${receipts}`,
        outputDigest: digestOf(output),
      };
    },
    async captureDesign(input) {
      designInputs.push(input);

      return (options.design ?? designCapture)(input.raw);
    },
  };

  return { host, invocations, designInputs };
}

async function discoveryHistory(
  tools: RunTools,
  toolNames: readonly string[],
): Promise<UIMessage[]> {
  const id = `discovery-${toolNames.join("-")}`;
  const argumentsText = JSON.stringify({ toolNames });
  const output = await tools.executeTool(
    [],
    { id, name: "discover_atlassian_tools", arguments: argumentsText, input: { toolNames } },
    context,
  );

  return [
    {
      id: `${id}-message`,
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id,
          name: "discover_atlassian_tools",
          arguments: argumentsText,
          state: "complete",
        },
        {
          type: "tool-result",
          toolCallId: id,
          content: JSON.stringify(output),
          state: "complete",
        },
      ],
    },
  ];
}

test("role catalog derives from the domain authority", () => {
  assert.deepEqual(testingRoleToolNames("atlassian"), [
    "jira_get_issue",
    "jira_add_comment",
    "confluence_get_page",
  ]);
  assert.deepEqual(testingRoleToolNames("planner"), []);
  assert.deepEqual(testingRoleToolNames("ac"), ["verify_ac"]);
  assert.deepEqual(testingRoleToolNames("ui"), ["verify_ui", "get_figma"]);
});

test("planner keeps zero-binding codemode, rejects every native call, and never opens MCP", async () => {
  const fixture = mcpFixture();
  await withMcpEnvironment(
    async () => {
      const harness = fixtureHost({ fixture: hostFixture });
      await withTestingRoleTools(
        { role: "planner", intent, requirements: null, plan: null, host: harness.host },
        async (tools) => {
          const turn = await tools.getModelTools([]);
          const names = turn.definitions.map((definition) => definition.name);
          assert.deepEqual(names, ["codemode"]);
          assert.doesNotMatch(turn.systemPrompt, /external_|planner_compute/);
          assert.doesNotMatch(turn.definitions[0]!.description, /external_|planner_compute/);

          for (const name of [
            "planner_compute",
            "jira_get_issue",
            "confluence_get_page",
            "read",
            "write",
            "edit",
            "run_tests",
            "delegate_to_agent",
            "verify_ac",
            "get_figma",
          ]) {
            await assert.rejects(
              () => tools.executeTool([], modelCall(name), context),
              new RegExp(`Unknown tool|not available to the planner role`),
            );
          }

          const sandbox = (await tools.executeTool(
            [],
            modelCall("codemode", {
              code: `
                const values: number[] = [1, 3, 5].map((value: number) => value * 2);
                return values.reduce((sum, value) => sum + value, 0);
              `,
            }),
            context,
          )) as { success: boolean; result: unknown };
          assert.equal(sandbox.success, true);
          assert.equal(sandbox.result, 18);
          const namesInSandbox = (await tools.executeTool(
            [],
            modelCall("codemode", {
              code: `return Object.keys(globalThis).filter((name) => name.startsWith("external_"));`,
            }),
            context,
          )) as { success: boolean; result: unknown };
          assert.deepEqual(namesInSandbox, { success: true, result: [], logs: [] });

          for (const name of [
            "external_read",
            "external_write",
            "external_run_tests",
            "external_planner_compute",
          ]) {
            const forged = (await tools.executeTool(
              [],
              modelCall("codemode", { code: `await ${name}({}); return "ran";` }),
              context,
            )) as { success: boolean };
            assert.equal(forged.success, false, `${name} is unavailable`);
          }
        },
      );
      assert.equal(harness.invocations.length, 0);
      assert.equal(fixture.requests.length, 0);
    },
    true,
    fixture,
  );
});

test("role cancellation reaches zero-binding codemode before sandbox execution", async () => {
  const harness = fixtureHost({ fixture: hostFixture });
  const controller = new AbortController();
  await withTestingRoleTools(
    { role: "planner", intent, requirements: null, plan: null, host: harness.host },
    async (tools) => {
      controller.abort();
      await assert.rejects(
        () => tools.executeTool([], modelCall("codemode", { code: "return 1;" }), context),
        /cancelled/,
      );
    },
    controller.signal,
  );
  assert.equal(harness.invocations.length, 0);
});

test("discovered comments have no actual Code Mode callable or stub", async () => {
  const fixture = mcpFixture();
  await withMcpEnvironment(
    async () => {
      const harness = fixtureHost({ fixture: hostFixture });
      await withTestingRoleTools(
        { role: "atlassian", intent, requirements: null, plan: null, host: harness.host },
        async (tools) => {
          const history = await discoveryHistory(tools, ["jira_add_comment"]);
          const turn = await tools.getModelTools(history);
          assert.ok(turn.definitions.some((definition) => definition.name === "jira_add_comment"));
          assert.doesNotMatch(turn.systemPrompt, /external_jira_add_comment/);
          const outcome = (await tools.executeTool(
            history,
            modelCall("codemode", { code: "return typeof external_jira_add_comment;" }),
            context,
          )) as { result: unknown };
          assert.equal(outcome.result, "undefined");
          assert.equal(
            fixture.requests.filter(
              (request) =>
                request.message.method === "tools/call" &&
                request.message.params?.name === "jira_add_comment",
            ).length,
            0,
          );
        },
      );
    },
    true,
    fixture,
  );
});

test("atlassian role restricts discovery and reads and returns the raw read output", async () => {
  const fixture = mcpFixture();
  await withMcpEnvironment(
    async () => {
      const harness = fixtureHost({ fixture: hostFixture });
      await withTestingRoleTools(
        { role: "atlassian", intent, requirements: null, plan: null, host: harness.host },
        async (tools) => {
          const first = await tools.getModelTools([]);
          assert.deepEqual(
            first.definitions.map((definition) => definition.name),
            ["discover_atlassian_tools", "codemode"],
          );
          assert.doesNotMatch(first.systemPrompt, /external_/);
          const initialMcpRequests = fixture.requests.length;
          const beforeDiscoveryCode = (await tools.executeTool(
            [],
            modelCall("codemode", { code: "return [4, 5, 6].map((value) => value * value);" }),
            context,
          )) as { success: boolean; result: unknown };
          assert.deepEqual(beforeDiscoveryCode.result, [16, 25, 36]);

          for (const name of [
            "external_jira_get_issue",
            "external_read",
            "external_write",
            "external_run_tests",
          ]) {
            const forged = (await tools.executeTool(
              [],
              modelCall("codemode", { code: `await ${name}({}); return "ran";` }),
              context,
            )) as { success: boolean };
            assert.equal(forged.success, false, `${name} is unavailable before discovery`);
          }

          assert.equal(harness.invocations.length, 0);
          assert.equal(fixture.requests.length, initialMcpRequests);
          const discovery = first.definitions[0]!;
          const toolNames = (
            discovery.inputSchema.properties as Record<string, { items?: { enum?: unknown } }>
          ).toolNames;
          assert.deepEqual(toolNames?.items?.enum, [
            "jira_get_issue",
            "jira_add_comment",
            "confluence_get_page",
          ]);
          await assert.rejects(
            () =>
              tools.executeTool(
                [],
                modelCall("discover_atlassian_tools", { toolNames: ["jira_search"] }),
                context,
              ),
            /restricted to required read-only tools/,
          );
          assert.equal(harness.invocations.length, 0);

          const history = await discoveryHistory(tools, ["jira_get_issue", "confluence_get_page"]);
          assert.equal(harness.invocations.length, 1);
          assert.equal(harness.invocations[0]!.nativeName, "discover_atlassian_tools");
          assert.equal(harness.invocations[0]!.route, "direct");

          const second = await tools.getModelTools(history);
          const remoteNames = second.definitions.map((definition) => definition.name);
          assert.deepEqual(remoteNames.toSorted(), [
            "codemode",
            "confluence_get_page",
            "discover_atlassian_tools",
            "jira_get_issue",
          ]);
          assert.match(second.systemPrompt, /declare function external_jira_get_issue\(/);
          assert.match(second.systemPrompt, /declare function external_confluence_get_page\(/);
          assert.doesNotMatch(
            second.systemPrompt,
            /external_jira_add_comment|external_run_tests|external_read|external_write/,
          );

          await assert.rejects(
            () =>
              tools.executeTool(
                history,
                modelCall("jira_get_issue", { issue_key: "OTHER-9" }),
                context,
              ),
            /not authorized for the requested sources/,
          );
          await assert.rejects(
            () =>
              tools.executeTool(
                history,
                modelCall("jira_add_comment", { issue_key: "PROJ-1" }),
                context,
              ),
            /require durable orchestration approval/,
          );
          assert.equal(harness.invocations.length, 1);

          const read = await tools.executeTool(
            history,
            modelCall("jira_get_issue", { issue_key: "PROJ-1" }),
            context,
          );
          assert.equal(harness.invocations.length, 2);
          assert.deepEqual(harness.invocations[1]!.input, {
            issue_key: "PROJ-1",
            fields: "summary,description",
            include: "remote_links",
          });
          assert.deepEqual(read, { issue: "PROJ-1" });

          await assert.rejects(
            () =>
              tools.executeTool(
                history,
                modelCall("confluence_get_page", { page_id: "999" }),
                context,
              ),
            /not authorized for the requested sources/,
          );
          const page = await tools.executeTool(
            history,
            modelCall("confluence_get_page", { page_id: "123", include_metadata: false }),
            context,
          );
          assert.equal(harness.invocations.length, 3);
          assert.deepEqual(harness.invocations[2]!.input, {
            page_id: "123",
            include_metadata: true,
          });
          assert.equal(page, "Native tool result");

          const sandbox = (await tools.executeTool(
            history,
            modelCall("codemode", {
              code: "const r = await external_jira_get_issue({ issue_key: 'PROJ-1' }); return r.issue;",
            }),
            context,
          )) as { success: boolean; result: unknown };
          assert.equal(sandbox.success, true);
          assert.equal(sandbox.result, "PROJ-1");
          assert.equal(harness.invocations.length, 4);
          assert.equal(harness.invocations[3]!.route, "codemode");

          for (const name of [
            "external_jira_add_comment",
            "external_run_tests",
            "external_read",
            "external_write",
          ]) {
            const forged = (await tools.executeTool(
              history,
              modelCall("codemode", { code: `await ${name}({}); return "ran";` }),
              context,
            )) as { success: boolean };
            assert.equal(forged.success, false, `${name} is not a granted readonly binding`);
          }

          assert.equal(harness.invocations.length, 4);
        },
      );
    },
    true,
    fixture,
  );
});

test("Jira reads request the issue body and the assembled requirements carry the description", async () => {
  const description = "## 驗收條件\n1. AC-1 結帳成功";
  const fixture = mcpFixture({
    pages: sourceReadPages,
    rules: [
      sourceReadRule(
        "jira_get_issue",
        { issue_key: "PROJ-1", fields: "summary,status,description" },
        { key: "PROJ-1", summary: "結帳失敗", description },
      ),
    ],
  });
  await withMcpEnvironment(
    async () => {
      const harness = fixtureHost({ fixture: hostFixture });
      await withTestingRoleTools(
        { role: "atlassian", intent, requirements: null, plan: null, host: harness.host },
        async (tools) => {
          const history = await discoveryHistory(tools, ["jira_get_issue"]);
          const output = await tools.executeTool(
            history,
            modelCall("jira_get_issue", { issue_key: "PROJ-1", fields: "summary,status" }),
            context,
          );
          assert.deepEqual(harness.invocations[1]!.input, {
            issue_key: "PROJ-1",
            fields: "summary,status,description",
            include: "remote_links",
          });
          assert.deepEqual(
            fixture.calls().map((record) => record.message.params?.arguments),
            [
              {
                issue_key: "PROJ-1",
                fields: "summary,status,description",
                include: "remote_links",
                update_history: false,
              },
            ],
          );
          const reference = { kind: "jira" as const, issueKey: "PROJ-1" };
          const capturedAt = "2026-01-02T00:00:00.000Z";
          assert.deepEqual(
            assembleRequirements({ goal: "checkout flow", sources: [reference] }, [
              {
                nativeName: "jira_get_issue",
                input: harness.invocations[1]!.input,
                output,
                outputDigest: digestOf(output),
                bindings: { capturedAt },
              },
            ]),
            {
              kind: "accepted",
              value: {
                goal: "checkout flow",
                sources: [
                  {
                    reference,
                    text: `PROJ-1 結帳失敗\n\n${description}`,
                    links: [],
                    digest: digestOf(output),
                    capturedAt,
                  },
                ],
              },
            },
          );
        },
      );
    },
    true,
    fixture,
  );
});

test("AC role returns Host receipt envelopes and rejects foreign tools", async () => {
  const harness = fixtureHost({ fixture: hostFixture });
  await withTestingRoleTools(
    { role: "ac", intent, requirements: null, plan: testPlan(), host: harness.host },
    async (tools) => {
      const turn = await tools.getModelTools([]);
      assert.deepEqual(
        turn.definitions.map((definition) => definition.name),
        ["verify_ac", "codemode"],
      );

      for (const name of ["get_figma", "read", "write", "edit", "run_tests"]) {
        await assert.rejects(
          () => tools.executeTool([], modelCall(name, { checkId: "check-f" }), context),
          /Unknown tool/,
        );
      }

      assert.equal(harness.invocations.length, 0);

      const direct = (await tools.executeTool(
        [],
        modelCall("verify_ac", { checkId: "check-f" }),
        context,
      )) as {
        checkId: string;
        evidence: { outcome: string } & Record<string, unknown>;
        receiptId: string;
        outputDigest: string;
      };
      assert.equal(direct.checkId, "check-f");
      assert.equal(direct.evidence.outcome, "pass");
      assert.deepEqual(direct.evidence.fixture, {
        id: "playwright-chromium",
        version: "v1",
      });
      assert.equal(direct.evidence.adapterVersion, "playwright-jev-v1");
      assert.equal(direct.receiptId, "receipt-1");
      assert.match(direct.outputDigest, /^[0-9a-f]{64}$/);
      assert.equal(harness.invocations.length, 1);
      assert.equal(harness.invocations[0]!.nativeName, "verify_ac");
      assert.equal(harness.invocations[0]!.route, "direct");

      const sandbox = (await tools.executeTool(
        [],
        modelCall("codemode", { code: "return typeof external_verify_ac;" }),
        context,
      )) as { success: boolean; result: unknown };
      assert.equal(sandbox.success, true);
      assert.equal(sandbox.result, "undefined");
      assert.equal(harness.invocations.length, 1);

      await assert.rejects(
        () => tools.executeTool([], modelCall("verify_ac", { checkId: "missing" }), context),
        /Unknown scoped check/,
      );
    },
  );
});

test("selection and fill value handoffs reach the model without receipt fields while the resolved result keeps the terminal envelope", async () => {
  const image = {
    path: `${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}.png`,
    digest: "d".repeat(64),
  };
  const handoff: SelectionSnapshot = {
    kind: "selection",
    id: "h1",
    caseId: "case-1",
    ordinal: 1,
    laterHandoffsAllowed: 2,
    expiresAt: "2026-10-13T00:03:00.000Z",
    url: "http://127.0.0.1:4173/app",
    target: { intent: "submit", operation: "click", at: { kind: "action", index: 1 } },
    candidates: [{ id: "c0", description: "untrusted page text" }],
    links: [],
    diagnostics: {
      code: "uncertain_or_invalid_selection",
      choice: "none",
      confidence: 0.9,
      probability: 0.9,
      gap: 0.8,
      probabilityTotal: 1,
      candidateCount: 2,
      probabilityCount: 2,
    },
    image,
  };
  const fill: FillValueSnapshot = {
    kind: "fill_value",
    id: "h2",
    caseId: "case-1",
    laterSelectionHandoffs: 2,
    expiresAt: "2026-10-13T00:06:00.000Z",
    url: "http://127.0.0.1:4173/app",
    target: { intent: "note", operation: "fill", at: { kind: "action", index: 2 } },
    field: { id: "c1", description: "untrusted note field" },
    links: [],
    image,
  };
  const choice = { handoffId: "h1", decision: { kind: "choose", candidateId: "c0" } };
  const resolution = {
    handoffId: "h2",
    decision: { kind: "abandon", reason: "No note field" },
  };
  const received: unknown[] = [];
  const harness = fixtureHost({
    fixture: {
      ...hostFixture,
      run: async (_planCase, _check, decided) => {
        received.push(decided ?? null);

        if (!decided) {
          return { state: "selection_required", handoff };
        }

        return decided.handoffId === "h1"
          ? { state: "fill_value_required", handoff: fill }
          : { state: "blocked", reason: "handoff_abandoned", browser: { selections: [] } };
      },
    },
  });
  await withTestingRoleTools(
    { role: "ac", intent, requirements: null, plan: testPlan(), host: harness.host },
    async (tools) => {
      assert.deepEqual(
        await tools.executeTool([], modelCall("verify_ac", { checkId: "check-f" }), context),
        { state: "selection_required", checkId: "check-f", handoff },
      );
      assert.deepEqual(
        await tools.executeTool(
          [],
          modelCall("verify_ac", { checkId: "check-f", resolution: choice }),
          context,
        ),
        { state: "fill_value_required", checkId: "check-f", handoff: fill },
      );
      const resolved = (await tools.executeTool(
        [],
        modelCall("verify_ac", { checkId: "check-f", resolution }),
        context,
      )) as Record<string, unknown>;

      assert.deepEqual(Object.keys(resolved).sort(), [
        "checkId",
        "evidence",
        "outputDigest",
        "receiptId",
      ]);
      assert.equal(resolved.receiptId, "receipt-1");
      assert.equal(
        resolved.outputDigest,
        digestOf({ checkId: resolved.checkId, evidence: resolved.evidence }),
      );
    },
  );
  assert.deepEqual(received, [null, choice, resolution]);
  assert.deepEqual(
    harness.invocations.map((invocation) => invocation.input),
    [
      { checkId: "check-f" },
      { checkId: "check-f", resolution: choice },
      { checkId: "check-f", resolution },
    ],
  );
});

function planWithOnly(kind: "functional" | "style"): CanonicalPlan {
  const plan = testPlan();

  return {
    ...plan,
    cases: plan.cases.map((planCase) => ({
      ...planCase,
      checks: planCase.checks.filter((check) => check.kind === kind),
    })),
  };
}

test("browser roles refuse to start without checks of their own kind", async () => {
  const harness = fixtureHost({ fixture: hostFixture });
  await assert.rejects(
    () =>
      withTestingRoleTools(
        { role: "ac", intent, requirements: null, plan: planWithOnly("style"), host: harness.host },
        async () => undefined,
      ),
    { message: "No functional checks are assigned to the browser role" },
  );
  await assert.rejects(
    () =>
      withTestingRoleTools(
        {
          role: "ui",
          intent,
          requirements: null,
          plan: planWithOnly("functional"),
          host: harness.host,
        },
        async () => undefined,
      ),
    { message: "No style checks are assigned to the browser role" },
  );
});

test("browser roles scope verify_ac to their own kind across cases in plan order", async () => {
  const base = testPlan();
  const [first] = base.cases;
  const plan: CanonicalPlan = {
    ...base,
    cases: [
      {
        ...first!,
        checks: [
          {
            id: "s-1",
            criterionId: "AC-1",
            kind: "style",
            design,
            property: "gap",
            tolerance: { kind: "numeric", unit: "px", maxDelta: 1 },
          },
          { id: "f-1", criterionId: "AC-1", kind: "functional", expectedObservation: "one" },
        ],
      },
      {
        ...first!,
        id: "case-2",
        checks: [
          { id: "f-2", criterionId: "AC-1", kind: "functional", expectedObservation: "two" },
        ],
      },
    ],
    assignments: { ac: ["f-1", "f-2"], ui: ["s-1"] },
  };
  const harness = fixtureHost({
    fixture: {
      ...hostFixture,
      run: async (_planCase, check) => ({
        state: "observed",
        observed: check.id === "f-1" ? "one" : check.id === "f-2" ? "two" : "16px",
        browser: { selections: [] },
      }),
    },
  });
  await withTestingRoleTools(
    { role: "ac", intent, requirements: null, plan, host: harness.host },
    async (tools) => {
      for (const checkId of ["f-1", "f-2"]) {
        const result = (await tools.executeTool(
          [],
          modelCall("verify_ac", { checkId }),
          context,
        )) as { checkId: string };
        assert.equal(result.checkId, checkId);
      }

      await assert.rejects(
        () => tools.executeTool([], modelCall("verify_ac", { checkId: "s-1" }), context),
        /Unknown scoped check/,
      );
    },
  );
});

function figmaDocument(document: Record<string, unknown>) {
  return { nodes: { "1:2": { document } } };
}

function figmaFetch(document: Record<string, unknown>, calls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    calls.push(String(input));

    return Response.json(figmaDocument(document));
  }) as typeof fetch;
}

test("UI captures Figma lazily from the requested node and blocks incomplete output", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.FIGMA_API_KEY;
  process.env.FIGMA_API_KEY = "test-key";
  const calls: string[] = [];
  globalThis.fetch = figmaFetch(
    { id: "1:2", name: "Frame", type: "FRAME", paddingLeft: 16 },
    calls,
  );

  try {
    const harness = fixtureHost({ fixture: hostFixture });
    await withTestingRoleTools(
      { role: "ui", intent, requirements: null, plan: testPlan(), host: harness.host },
      async (tools) => {
        const turn = await tools.getModelTools([]);
        assert.deepEqual(
          turn.definitions.map((definition) => definition.name),
          ["get_figma", "verify_ui", "codemode"],
        );
        await assert.rejects(
          () => tools.executeTool([], modelCall("verify_ui", { checkId: "check-s" }), context),
          /requires an accepted Figma capture/,
        );
        await assert.rejects(
          () =>
            tools.executeTool(
              [],
              modelCall("get_figma", {
                target: "https://www.figma.com/design/xyz/Other?node-id=1-2",
              }),
              context,
            ),
          /restricted to the requested design/,
        );
        assert.equal(calls.length, 0);
        assert.equal(harness.invocations.length, 0);

        const output = await tools.executeTool(
          [],
          modelCall("get_figma", {
            target: "https://www.figma.com/design/abc/Test?node-id=1-2",
          }),
          context,
        );
        assert.ok(output);
        assert.equal(calls.length, 1);
        assert.match(calls[0]!, /\/v1\/files\/abc\/nodes/);
        assert.match(calls[0]!, /ids=1%3A2|ids=1:2/);
        assert.equal(harness.designInputs.length, 1);
        assert.deepEqual(harness.designInputs[0]!.reference, design);
        assert.equal(harness.designInputs[0]!.nativeReceipt.receiptId, "receipt-1");
        assert.equal(
          harness.designInputs[0]!.nativeReceipt.outputDigest,
          digestOf(harness.designInputs[0]!.raw),
        );

        const sandbox = (await tools.executeTool(
          [],
          modelCall("codemode", {
            code: "return [typeof external_get_figma, typeof external_verify_ui];",
          }),
          context,
        )) as { success: boolean; result: unknown };
        assert.equal(sandbox.success, true);
        assert.deepEqual(sandbox.result, ["function", "undefined"]);
        assert.equal(harness.invocations.length, 1);

        const browser = (await tools.executeTool(
          [],
          modelCall("verify_ui", { checkId: "check-s" }),
          context,
        )) as { evidence: { outcome: string; expected: string }; receiptId: string };
        assert.equal(browser.evidence.outcome, "inside_tolerance");
        assert.equal(browser.evidence.expected, "16px");
        assert.equal(browser.receiptId, "receipt-2");
      },
    );

    const incomplete = fixtureHost({
      fixture: hostFixture,
      design: () => ({
        properties: {},
        capture: {
          reference: design,
          propertiesDigest: digestOf({}),
          complete: true,
          capturedAt: "2026-01-02T00:00:00.000Z",
        },
      }),
    });
    await withTestingRoleTools(
      { role: "ui", intent, requirements: null, plan: testPlan(), host: incomplete.host },
      async (tools) => {
        await assert.rejects(
          () =>
            tools.executeTool(
              [],
              modelCall("get_figma", {
                target: "https://www.figma.com/design/abc/Test?node-id=1-2",
              }),
              context,
            ),
          /missing property padding-left/,
        );
        await assert.rejects(
          () => tools.executeTool([], modelCall("verify_ui", { checkId: "check-s" }), context),
          /requires an accepted Figma capture/,
        );
      },
    );

    globalThis.fetch = figmaFetch(
      {
        id: "1:2",
        name: "Large",
        type: "FRAME",
        children: Array.from({ length: 25 }, (_, index) => ({
          id: `2:${index}`,
          name: "界".repeat(1000),
          type: "TEXT",
          characters: "x".repeat(2000),
        })),
      },
      calls,
    );
    const truncated = fixtureHost({ fixture: hostFixture });
    await withTestingRoleTools(
      { role: "ui", intent, requirements: null, plan: testPlan(), host: truncated.host },
      async (tools) => {
        await assert.rejects(
          () =>
            tools.executeTool(
              [],
              modelCall("get_figma", {
                target: "https://www.figma.com/design/abc/Test?node-id=1-2",
              }),
              context,
            ),
          /truncated or incomplete/,
        );
        assert.equal(truncated.designInputs.length, 0);
        await assert.rejects(
          () => tools.executeTool([], modelCall("verify_ui", { checkId: "check-s" }), context),
          /requires an accepted Figma capture/,
        );
      },
    );
  } finally {
    globalThis.fetch = originalFetch;

    if (originalKey === undefined) {
      delete process.env.FIGMA_API_KEY;
    } else {
      process.env.FIGMA_API_KEY = originalKey;
    }
  }
});

test("UI tools reuse a host-restored capture without requesting Figma again", async () => {
  const properties = { "padding-left": "16px" };
  const restoredDesign: DesignCaptureResult = {
    properties,
    capture: {
      reference: design,
      propertiesDigest: digestOf(properties),
      complete: true,
      capturedAt: "2026-01-03T00:00:00.000Z",
    },
  };
  const harness = fixtureHost({ fixture: hostFixture, restoredDesign });
  await withTestingRoleTools(
    { role: "ui", intent, requirements: null, plan: testPlan(), host: harness.host },
    async (tools) => {
      const output = (await tools.executeTool(
        [],
        modelCall("verify_ui", { checkId: "check-s" }),
        context,
      )) as { evidence: { outcome: string; expected: string } };
      assert.equal(output.evidence.outcome, "inside_tolerance");
      assert.equal(output.evidence.expected, "16px");
    },
  );
  assert.deepEqual(
    harness.invocations.map((invocation) => invocation.nativeName),
    ["verify_ui"],
  );
});

test("factory waits for pending native work and threads abort through the tool context", async () => {
  const harness = fixtureHost({ fixture: hostFixture, invokeDelayMs: 25 });
  const controller = new AbortController();
  let finished = false;
  await withTestingRoleTools(
    { role: "ac", intent, requirements: null, plan: testPlan(), host: harness.host },
    async (tools) => {
      const pending = tools.executeTool([], modelCall("verify_ac", { checkId: "check-f" }), {
        ...context,
        abortSignal: controller.signal,
      });
      void pending.then(
        () => {
          finished = true;
        },
        () => {
          finished = true;
        },
      );
    },
    controller.signal,
  );
  assert.equal(finished, true);

  const aborted = fixtureHost({ fixture: hostFixture });
  const abortedController = new AbortController();
  abortedController.abort();
  await withTestingRoleTools(
    { role: "ac", intent, requirements: null, plan: testPlan(), host: aborted.host },
    async (tools) => {
      await assert.rejects(
        () =>
          tools.executeTool([], modelCall("verify_ac", { checkId: "check-f" }), {
            ...context,
            abortSignal: abortedController.signal,
          }),
        /abort/i,
      );
    },
  );
  assert.equal(aborted.invocations.length, 0);

  const threaded = fixtureHost({ fixture: hostFixture });
  const threadedController = new AbortController();
  await withTestingRoleTools(
    { role: "ac", intent, requirements: null, plan: testPlan(), host: threaded.host },
    async (tools) => {
      await tools.executeTool([], modelCall("verify_ac", { checkId: "check-f" }), {
        ...context,
        abortSignal: threadedController.signal,
      });
      threadedController.abort();
      assert.equal(threaded.invocations[0]!.context.abortSignal?.aborted, true);
    },
    threadedController.signal,
  );
});
