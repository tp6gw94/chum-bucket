import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import {
  agentRegistry,
  allowsTool,
  roleSystemPrompt,
  toolNamesFor,
} from "../../../server/harness/agents";
import {
  delegationInputSchema,
  sourceSchema,
  designSchema,
  type Plan,
  type Receipt,
  type RoleTask,
} from "../../../shared/testing";
import {
  assembleRequirements,
  canonicalizePlan,
  assembleToolResults,
  digestOf,
} from "../../../server/harness/testing-domain";
import { withMainTools } from "../../../server/harness/tools";
import { withRoleTools } from "../../../server/harness/testing-tools";
import { delegateTask } from "../../../server/harness/testing-run";
import { roleTaskPrompt } from "../../../server/harness/role-prompts";
import { BUILD, MODEL, type AcceptedRun } from "../../../server/harness/run-store";

const task: RoleTask = {
  summary: "Plan",
  goal: "Checkout",
  sources: [],
  requirements: { goal: "Checkout", sources: [] },
  plan: null,
  design: null,
  targetUrl: null,
  checks: [],
};
const proposal = {
  criteria: [{ id: "AC-1", statement: "Confirmation is visible" }],
  unresolved: [],
  cases: [
    {
      id: "case-1",
      title: "Checkout",
      preconditions: [],
      actions: [],
      checks: [
        {
          id: "check-1",
          criterionId: "AC-1",
          kind: "functional",
          expectedObservation: "Thank you",
          observation: { kind: "text", target: "Confirmation", comparison: "equals" },
        },
      ],
    },
  ],
};
const context = { toolCallId: "call", emitCustomEvent: () => undefined };

test("registry is the authority for direct and sandbox permissions", async () => {
  for (const route of ["direct", "codemode"] as const) {
    assert.equal(allowsTool("main", "jira_get_issue", route), false);
    assert.equal(allowsTool("main", "discover_atlassian_tools", route), false);
    assert.equal(allowsTool("planner", "read", route), false);
    assert.equal(allowsTool("atlassian", "jira_search", route), false);
  }
  assert.equal(allowsTool("main", "delegate_task", "direct"), true);
  assert.equal(allowsTool("main", "delegate_task", "codemode"), false);
  assert.equal(allowsTool("ac", "verify_ac", "codemode"), false);
  assert.deepEqual(toolNamesFor("planner"), []);
  assert.deepEqual(toolNamesFor("ac"), ["verify_ac"]);
  assert.deepEqual(toolNamesFor("ui"), ["get_figma", "verify_ui"]);
  assert.throws(() => roleSystemPrompt("planner", "old-profile"));
  assert.ok(roleSystemPrompt("planner", agentRegistry.planner.profile));
  assert.deepEqual(JSON.parse(roleTaskPrompt("planner", task).split("testing-task:\n")[1]), task);
  await withMainTools(async (tools) => {
    const definitions = await tools.getModelTools([]);
    assert.equal(
      definitions.some((tool) => tool.name === "delegate_task"),
      false,
    );
    assert.equal(
      definitions.some((tool) => tool.description.includes("external_delegate_task")),
      false,
    );
    await assert.rejects(
      async () =>
        tools.executeTool(
          [],
          { id: "x", name: "jira_get_issue", input: {}, arguments: "{}" },
          context,
        ),
      /not allowed/,
    );
  }, false);
});

test("delegation input rejects extra fields and empty source lists", () => {
  assert.equal(sourceSchema.safeParse({ kind: "jira", issueKey: "PROJ-1" }).success, true);
  assert.equal(designSchema.safeParse({ fileKey: "abc", nodeId: "1:2" }).success, true);
  assert.equal(
    delegationInputSchema.safeParse({
      role: "atlassian",
      summary: "Read",
      goal: "Goal",
      sources: [],
    }).success,
    false,
  );
  for (const extra of [
    { goal: "No" },
    { targetUrl: "http://localhost" },
    { childWorkflowId: "No" },
  ]) {
    assert.equal(
      delegationInputSchema.safeParse({
        role: "planner",
        summary: "Plan",
        requirementsRef: "ref",
        ...extra,
      }).success,
      false,
    );
  }
});

test("requirements preserve source text and require every scoped source", () => {
  const input = {
    role: "atlassian" as const,
    summary: "Read",
    goal: "Goal",
    sources: [{ kind: "jira" as const, issueKey: "PROJ-1" }],
  };
  const output = { key: "PROJ-1", fields: { summary: "Title", description: "  raw\n\ntext  " } };
  const receipt: Receipt = {
    id: "r",
    taskId: "t",
    name: "jira_get_issue",
    route: "direct",
    input: { issue_key: "PROJ-1" },
    output,
    outputDigest: digestOf(output),
    capturedAt: "2026-10-15T00:00:00Z",
  };
  const result = assembleRequirements(input, [receipt]);
  assert.equal(result.valid, true);
  if (result.valid && "sources" in result.payload) {
    assert.equal(result.payload.sources[0].text, "PROJ-1 Title\n  raw\n\ntext  ");
  }
  assert.equal(
    assembleRequirements(input, [{ ...receipt, output: { isError: true } }]).valid,
    false,
  );
  assert.equal(assembleRequirements(input, []).valid, false);
});

test("requirements accept MCP result envelopes while rejecting wrapped tool failures", () => {
  const intent = {
    role: "atlassian" as const,
    summary: "Read",
    goal: "Goal",
    sources: [{ kind: "jira" as const, issueKey: "PROJ-1" }],
  };
  const issue = { key: "PROJ-1", summary: "Title", description: "  original\n\ntext  " };
  const json = JSON.stringify(issue);
  const assemble = (output: unknown) =>
    assembleRequirements(intent, [
      {
        id: "receipt",
        taskId: "task",
        name: "jira_get_issue",
        route: "direct",
        input: { issue_key: "PROJ-1" },
        output,
        outputDigest: digestOf(output),
        capturedAt: "2026-10-15T00:00:00Z",
      },
    ]);

  for (const output of [
    { result: json },
    { result: issue },
    JSON.stringify({ result: json }),
    { content: [{ type: "text", text: JSON.stringify({ result: json }) }] },
    { structuredContent: { result: json } },
  ]) {
    const result = assemble(output);
    assert.equal(result.valid, true);

    if (result.valid && "sources" in result.payload) {
      assert.equal(result.payload.sources[0].text, "PROJ-1 Title\n  original\n\ntext  ");
    }
  }

  for (const output of [
    { isError: true, result: json },
    { result: { isError: true, ...issue } },
    { result: JSON.stringify({ isError: true, ...issue }) },
    { result: "not JSON" },
  ]) {
    assert.equal(assemble(output).valid, false);
  }
});

test("host validates plan identities and computes role assignments", () => {
  const valid = canonicalizePlan(proposal, task);
  assert.equal(valid.valid, true);
  if (valid.valid) {
    assert.deepEqual((valid.payload as Plan).assignments, { ac: ["check-1"], ui: [] });
  }
  assert.equal(
    canonicalizePlan({ ...proposal, criteria: [...proposal.criteria, ...proposal.criteria] }, task)
      .valid,
    false,
  );
  const invalid = structuredClone(proposal);
  invalid.cases[0].checks[0].criterionId = "missing";
  assert.equal(canonicalizePlan(invalid, task).valid, false);
  const style = {
    id: "style-1",
    criterionId: "AC-1",
    kind: "style",
    design: { fileKey: "file", nodeId: "1:2" },
    target: "Button",
    property: "width",
    tolerance: { kind: "exact" },
  };
  assert.equal(
    canonicalizePlan({ ...proposal, cases: [{ ...proposal.cases[0], checks: [style] }] }, task)
      .valid,
    false,
  );
});

test("tool observations retain conflicts and missing evidence, excluding forged bindings", () => {
  const valid = canonicalizePlan(proposal, task);
  assert.equal(valid.valid, true);
  if (!valid.valid) {
    return;
  }
  const scoped = { ...task, plan: valid.payload as Plan, checks: ["check-1", "missing"] };
  const receipt = (outcome: "pass" | "fail"): Receipt => {
    const output = {
      origin: "browser",
      fixture: { id: "playwright-chromium", version: "v1" },
      checkId: "check-1",
      caseId: "case-1",
      outcome,
    };
    return {
      id: outcome,
      taskId: "task",
      name: "verify_ac",
      route: "direct",
      input: { checkId: "check-1" },
      checkId: "check-1",
      output,
      outputDigest: digestOf(output),
      capturedAt: "now",
    };
  };
  const result = assembleToolResults("ac", scoped, [
    receipt("pass"),
    receipt("fail"),
    { ...receipt("pass"), checkId: "forged" },
  ]);
  assert.equal(result.payload.checks.length, 2);
  assert.deepEqual(result.conflictingChecks, ["check-1"]);
  assert.deepEqual(result.missingChecks, ["missing"]);
});

test("planner sandbox has no external bindings and cannot bypass scope", async () => {
  await withRoleTools(
    {
      role: "planner",
      taskId: "task",
      task,
      state: { receipts: [] },
      guard: async () => undefined,
      append: async () => undefined,
    },
    async (tools) => {
      const definitions = await tools.getModelTools([]);
      assert.deepEqual(
        definitions.map((tool) => tool.name),
        ["execute_typescript"],
      );
      assert.equal(definitions[0].description.includes("external_" + "read"), false);
      await assert.rejects(
        async () =>
          tools.executeTool(
            [],
            { id: "call", name: "get_figma", input: {}, arguments: "{}" },
            context,
          ),
        /not allowed/,
      );
      const output = (await tools.executeTool(
        [],
        {
          id: "call",
          name: "execute_typescript",
          input: { typescriptCode: "return 2 + 2" },
          arguments: "{}",
        },
        context,
      )) as { success: boolean; result: number };
      assert.equal(output.success, true);
      assert.equal(output.result, 4);
    },
  );
});

test("side conversation delegation is rejected before reserving a task", async () => {
  const checkpoint = mock.method(DBOS, "runStep", async (work: () => Promise<unknown>) => work());
  try {
    const run: AcceptedRun = {
      threadId: "thread",
      runId: "run",
      baseRevision: 0,
      message: { id: "m", text: "plan" },
      messages: [],
      context: [],
      model: MODEL,
      build: BUILD,
      prompt: "prompt",
      delegationAllowed: false,
    };
    await assert.rejects(
      delegateTask(run, { id: "call", name: "delegate_task", input: {}, arguments: "{}" }),
      /Side conversations/,
    );
    assert.equal(checkpoint.mock.callCount(), 1);
  } finally {
    checkpoint.mock.restore();
  }
});

test("planner receives exactly one private feedback round; QA findings have no feedback", async () => {
  const { runRolePasses } = await import("../../../server/harness/testing-role");
  const passes: { turns: number; prefix: string }[] = [];
  let validations = 0;
  const result = await runRolePasses({
    role: "planner",
    taskId: "task",
    task,
    pass: async (conversation, turns, prefix) => {
      passes.push({ turns, prefix });
      if (prefix === "b") {
        assert.equal(
          conversation.context.filter((message) => message.id === "task/feedback").length,
          1,
        );
      }
      const next = [
        ...conversation.context,
        {
          id: prefix,
          role: "assistant" as const,
          parts: [{ type: "text" as const, content: JSON.stringify(proposal) }],
        },
      ];
      return { state: "done", conversation: { display: next, context: next } };
    },
    validate: async (_candidate, name) => {
      validations++;
      assert.equal(name, validations === 1 ? "proposal" : "proposal-2");
      return { valid: false, issues: ["Duplicate check ID"] };
    },
  });
  assert.equal(result.state, "failed");
  assert.equal(result.reason, "proposal_rejected");
  assert.deepEqual(passes, [
    { turns: 6, prefix: "a" },
    { turns: 2, prefix: "b" },
  ]);
  let qaPasses = 0;
  const findings = await runRolePasses({
    role: "ac",
    taskId: "task",
    task,
    pass: async (conversation, turns) => {
      qaPasses++;
      assert.equal(turns, 20);
      const next = [
        ...conversation.context,
        {
          id: "findings",
          role: "assistant" as const,
          parts: [{ type: "text" as const, content: "Checks are incomplete." }],
        },
      ];
      return { state: "done", conversation: { display: next, context: next } };
    },
    validate: async () => ({ valid: true, payload: { checks: [] } }),
  });
  assert.equal(qaPasses, 1);
  assert.equal(findings.findings, "Checks are incomplete.");
});

test("operation, workflow and artifact identities survive replay and preserve scope", async () => {
  const { operationIdFor, workflowIdFor, artifactFor } =
    await import("../../../server/harness/testing-store");
  const operationId = operationIdFor("run", "call");
  assert.equal(operationIdFor("run", "call"), operationId);
  assert.notEqual(operationIdFor("run-2", "call"), operationId);
  const childWorkflowId = workflowIdFor(operationId, "atlassian");
  const input: import("../../../server/harness/testing-store").TestingInput = {
    operationId,
    childWorkflowId,
    parentRunId: "run",
    threadId: "thread",
    requestKey: "call",
    intent: {
      role: "atlassian" as const,
      summary: "Read",
      goal: "Goal",
      sources: [{ kind: "jira" as const, issueKey: "PROJ-1" }],
    },
    task,
    deadline: 1,
    profile: agentRegistry.atlassian.profile,
    model: MODEL,
    dependencies: [],
  };
  const artifact = artifactFor(input, { goal: "Goal", sources: [] });
  assert.deepEqual(artifactFor(input, { sources: [], goal: "Goal" }), artifact);
  assert.notEqual(artifactFor(input, { sources: [], goal: "Different" }).ref, artifact.ref);
  assert.notEqual(workflowIdFor(operationId, "planner"), childWorkflowId);
});

test("scoped tools reject unrelated source reads, Figma nodes and checks", async () => {
  const create = (
    role: "atlassian" | "ui",
    scoped: RoleTask,
    work: Parameters<typeof withRoleTools>[1],
  ) =>
    withRoleTools(
      {
        role,
        taskId: "task",
        task: scoped,
        state: { receipts: [] },
        guard: async () => undefined,
        append: async () => undefined,
      },
      work,
    );
  await create(
    "atlassian",
    { ...task, sources: [{ kind: "jira", issueKey: "PROJ-1" }] },
    async (tools) => {
      await assert.rejects(
        async () =>
          tools.executeTool(
            [],
            { id: "x", name: "jira_get_issue", input: { issue_key: "PROJ-2" }, arguments: "{}" },
            context,
          ),
        /outside delegated scope/,
      );
      await assert.rejects(
        async () =>
          tools.executeTool(
            [],
            {
              id: "x",
              name: "discover_atlassian_tools",
              input: { toolNames: ["jira_search"] },
              arguments: "{}",
            },
            context,
          ),
        /outside delegated scope/,
      );
    },
  );
  await create("ui", { ...task, design: { fileKey: "file", nodeId: "1:2" } }, async (tools) => {
    assert.equal(
      (await tools.getModelTools([])).some((tool) => tool.name === "verify_ui"),
      false,
    );
    await assert.rejects(
      async () =>
        tools.executeTool(
          [],
          { id: "x", name: "get_figma", input: { target: "file", nodeId: "2:3" }, arguments: "{}" },
          context,
        ),
      /outside delegated scope/,
    );
    await assert.rejects(
      async () =>
        tools.executeTool(
          [],
          { id: "x", name: "verify_ui", input: { checkId: "other" }, arguments: "{}" },
          context,
        ),
      /Capture/,
    );
  });
});

test("testing endpoints validate scope before touching persistence", async () => {
  const { default: app } = await import("../../../server/testing");
  assert.equal((await app.request("/testing-op")).status, 400);
  assert.equal(
    (
      await app.request("/testing-op/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: "invalid" }),
      })
    ).status,
    400,
  );
});

test("missing delegation tables produce an actionable non-retryable error without query parameters", async () => {
  const { testingOrchestration } = await import("../../../server/harness/testing-run");
  const databaseError = Object.assign(new Error('relation "testing_operations" does not exist'), {
    code: "42P01",
  });
  const queryError = new Error(
    "Failed query: insert into testing_operations; params: private-input",
    { cause: databaseError },
  );
  const checkpoint = mock.method(DBOS, "runStep", async () => {
    throw queryError;
  });

  try {
    const run: AcceptedRun = {
      threadId: "thread",
      runId: "run",
      baseRevision: 0,
      message: { id: "m", text: "Read Jira" },
      messages: [],
      context: [],
      model: MODEL,
      build: BUILD,
      prompt: "prompt",
    };
    const result = await testingOrchestration(run)({
      id: "call",
      name: "delegate_task",
      input: {},
      arguments: "{}",
    });
    assert.equal(result.state, "handled");

    if (result.state === "handled") {
      assert.equal(result.error, true);
      const output = result.output as { code: string; retryable: boolean; error: string };
      assert.equal(output.code, "migration_required");
      assert.equal(output.retryable, false);
      assert.match(output.error, /pnpm db:migrate/);
      assert.equal(output.error.includes("private-input"), false);
    }
  } finally {
    checkpoint.mock.restore();
  }
});
