import assert from "node:assert/strict";
import test from "node:test";
import { toolDefinition, type ToolExecutionContext } from "@tanstack/ai";
import { z } from "zod";
import { agentRegistry } from "../../../../server/harness/agents";
import { withRunTools } from "../../../../server/harness/tools";

const context: ToolExecutionContext = { emitCustomEvent: () => undefined };

function call(name: string, input: unknown) {
  return { id: "registry-call", name, input, arguments: JSON.stringify(input) };
}

test("a tool registered once is advertised and executable directly and through codemode", async (t) => {
  const environment = ["JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN", "ATLASSIAN_MCP_URL"];
  const previous = environment.map((key) => [key, process.env[key]] as const);
  const original = agentRegistry.main.tools;
  const probe = toolDefinition({
    name: "registry_probe",
    description: "Return the supplied value from a registry-owned tool.",
    inputSchema: z.strictObject({ value: z.string().trim() }),
  }).server(async ({ value }) => ({ value }));

  for (const key of environment) {
    delete process.env[key];
  }

  Object.defineProperty(agentRegistry.main, "tools", { value: [...original, probe] });
  t.after(() => {
    Object.defineProperty(agentRegistry.main, "tools", { value: original });

    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  await withRunTools(async (tools) => {
    const turn = await tools.getModelTools([]);
    assert.ok(turn.definitions.some((definition) => definition.name === probe.name));
    assert.deepEqual(
      await tools.executeTool([], call(probe.name, { value: " exact value " }), context),
      { value: "exact value" },
    );
    assert.deepEqual(
      await tools.executeTool(
        [],
        call("codemode", { code: 'return external_registry_probe({ value: "sandbox value" });' }),
        context,
      ),
      { success: true, result: { value: "sandbox value" }, logs: [] },
    );
    await assert.rejects(tools.executeTool([], call(probe.name, { value: 123 }), context));
  });
});
