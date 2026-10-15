import { allowsTool, agentRegistry, toolNamesFor, type AgentId } from "./agents";
import { withCodeMode } from "./tools/code-mode";
import type { RunTools } from "./tools";

export function agentTools(agentId: AgentId, native: RunTools): RunTools {
  const scoped: RunTools = {
    async getModelTools(messages) {
      return (await native.getModelTools(messages)).filter((tool) =>
        allowsTool(agentId, tool.name, "direct"),
      );
    },
    executeTool(messages, call, context, route = "direct") {
      if (!allowsTool(agentId, call.name, route)) {
        throw new Error(`Tool ${call.name} is not allowed for ${agentId}`);
      }

      return native.executeTool(messages, call, context, route);
    },
  };

  if (agentRegistry[agentId].codeMode === "disabled") {
    return scoped;
  }

  return withCodeMode(scoped, {
    sandboxed: new Set(
      toolNamesFor(agentId).filter((name) => allowsTool(agentId, name, "codemode")),
    ),
    allowEmpty: true,
  });
}
