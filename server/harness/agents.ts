import { getFigma } from "./tools/get-figma";
import { read, write, edit } from "./tools/fs";
import { delegateTaskTool } from "./tools/delegate-task";
import { verifyAc, verifyUi } from "./tools/verify-browser";
import { rolePrompt } from "./role-prompts";
import { openuiInstructions } from "./prompts";
import type { Role } from "../../shared/testing";
import { atlassianRouteAllowed } from "./tools/atlassian-policy";

export const AGENT_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash";
const atlassianFactory = {
  names: ["jira_get_issue", "confluence_get_page", "jira_add_comment"],
} as const;
const main = {
  kind: "conversation",
  systemPrompt: openuiInstructions,
  model: AGENT_MODEL,
  tools: [getFigma, read, write, edit, delegateTaskTool],
  codeMode: "enabled",
} as const;
export const agentRegistry = {
  main,
  atlassian: {
    kind: "qa",
    systemPrompt: rolePrompt("atlassian"),
    model: AGENT_MODEL,
    tools: [atlassianFactory],
    codeMode: "enabled",
    artifact: "requirements",
    profile: "requirements-v1",
    registration: "atlassian_read",
    maxTurns: 8,
  },
  planner: {
    kind: "qa",
    systemPrompt: rolePrompt("planner"),
    model: AGENT_MODEL,
    tools: [],
    codeMode: "enabled",
    artifact: "plan",
    profile: "plan-v1",
    registration: "none",
    maxTurns: 8,
  },
  ac: {
    kind: "qa",
    systemPrompt: rolePrompt("ac"),
    model: AGENT_MODEL,
    tools: [verifyAc],
    codeMode: "disabled",
    artifact: "ac-result",
    profile: "ac-v1",
    registration: "browser_ac",
    maxTurns: 20,
  },
  ui: {
    kind: "qa",
    systemPrompt: rolePrompt("ui"),
    model: AGENT_MODEL,
    tools: [getFigma, verifyUi],
    codeMode: "enabled",
    artifact: "ui-result",
    profile: "ui-v1",
    registration: "browser_ui",
    maxTurns: 20,
  },
} as const;
export type AgentId = keyof typeof agentRegistry;
export type ToolRoute = "direct" | "codemode";

type PermissionTool =
  | { name: string; metadata?: { direct?: boolean } }
  | { names: readonly string[] };

export function toolNamesFor(agentId: AgentId): string[] {
  const tools: readonly PermissionTool[] = agentRegistry[agentId].tools;

  return tools.flatMap((tool) => ("names" in tool ? [...tool.names] : [tool.name]));
}

export function allowsTool(agentId: AgentId, name: string, route: ToolRoute): boolean {
  const agent = agentRegistry[agentId];

  if (name === "execute_typescript") {
    return route === "direct" && agent.codeMode === "enabled";
  }

  if (name === "discover_atlassian_tools") {
    return route === "direct" && agent.tools.some((tool) => "names" in tool);
  }

  const tools: readonly PermissionTool[] = agent.tools;
  const tool = tools.find((entry) =>
    "names" in entry ? entry.names.includes(name) : entry.name === name,
  );

  if (!tool) {
    return false;
  }

  if ("names" in tool) {
    return atlassianRouteAllowed(name, route);
  }

  return route === "direct" || !("metadata" in tool && tool.metadata?.direct);
}

export function roleSystemPrompt(role: Role, profile: string): string {
  if (agentRegistry[role].profile !== profile) {
    throw new Error("Incompatible role profile");
  }

  return agentRegistry[role].systemPrompt;
}
