import type { Tool } from "@tanstack/ai";
import type { ArtifactKind, RoleId } from "../../shared/testing";
import { ROLE_IDS } from "../../shared/testing";
import {
  compactionSystemPrompt,
  openuiInstructions,
  qaSystemPrompts,
  sideSummarySystemPrompt,
} from "./prompts";
import {
  atlassianToolFactory,
  atlassianTools,
  discoveryToolName,
  type AtlassianToolFactory,
  type ToolRoute,
} from "./tools/atlassian-policy";
import { delegateTaskTool } from "./tools/delegate-task";
import { edit, read, write } from "./tools/fs";
import { getFigma } from "./tools/get-figma";
import { verifyAcTool, verifyUiTool } from "./tools/use-browser";

export type { ToolRoute };

export const MODEL = "deepseek-ai/DeepSeek-V4.1-Flash";

type AgentTool = Tool | AtlassianToolFactory;

type ConversationAgent = Readonly<{
  kind: "conversation";
  model: string;
  tools: readonly AgentTool[];
  codeMode: "enabled";
  systemPrompt: (extra?: string) => string;
}>;

type QaAgent = Readonly<{
  kind: "qa";
  model: string;
  artifact: ArtifactKind;
  tools: readonly AgentTool[];
  registration: string;
  codeMode: "enabled";
  profile: string;
  systemPrompt: string;
}>;

type AgentDefinitions = {
  main: ConversationAgent;
  atlassian: QaAgent;
  planner: QaAgent;
  ac: QaAgent;
  ui: QaAgent;
};

function toolNamesOf(tool: AgentTool): readonly string[] {
  return "names" in tool ? tool.names : [tool.name];
}

export const agentRegistry = {
  main: {
    kind: "conversation",
    model: MODEL,
    tools: [getFigma, read, write, edit, delegateTaskTool],
    codeMode: "enabled",
    systemPrompt: openuiInstructions,
  },
  atlassian: {
    kind: "qa",
    model: MODEL,
    artifact: "requirements",
    tools: [atlassianToolFactory],
    registration: "atlassian_read",
    codeMode: "enabled",
    profile: "requirements-v4",
    systemPrompt: qaSystemPrompts.atlassian,
  },
  planner: {
    kind: "qa",
    model: MODEL,
    artifact: "plan",
    tools: [],
    registration: "none",
    codeMode: "enabled",
    profile: "planning-v4",
    systemPrompt: qaSystemPrompts.planner,
  },
  ac: {
    kind: "qa",
    model: MODEL,
    artifact: "ac-result",
    tools: [verifyAcTool],
    registration: "browser_ac",
    codeMode: "enabled",
    profile: "functional-v4",
    systemPrompt: qaSystemPrompts.ac,
  },
  ui: {
    kind: "qa",
    model: MODEL,
    artifact: "ui-result",
    tools: [verifyUiTool, getFigma],
    registration: "browser_ui+figma_read",
    codeMode: "enabled",
    profile: "style-v4",
    systemPrompt: qaSystemPrompts.ui,
  },
} as const satisfies AgentDefinitions;

export type AgentId = keyof typeof agentRegistry;
export type AgentModel = (typeof agentRegistry)[AgentId]["model"];
export const summaryModelTasks = {
  compaction: { model: MODEL, systemPrompt: compactionSystemPrompt },
  "side-summary": { model: MODEL, systemPrompt: sideSummarySystemPrompt },
} as const;
export type SummaryPurpose = keyof typeof summaryModelTasks;

export const roleRegistry = Object.fromEntries(
  ROLE_IDS.map((role) => [role, agentRegistry[role]]),
) as { readonly [R in RoleId]: (typeof agentRegistry)[R] };

export const providerModels: readonly AgentModel[] = [
  ...new Set(
    [...Object.values(agentRegistry), ...Object.values(summaryModelTasks)].map(
      (entry) => entry.model,
    ),
  ),
];

export function toolNamesFor(agentId: AgentId): readonly string[] {
  const tools: readonly AgentTool[] = agentRegistry[agentId].tools;

  return tools.flatMap((tool) => [...toolNamesOf(tool)]);
}

export function allowsTool(agentId: AgentId, name: string, route: ToolRoute): boolean {
  const agent = agentRegistry[agentId];

  if (name === "codemode") {
    return route === "direct" && agent.codeMode === "enabled";
  }

  if (name === discoveryToolName) {
    return route === "direct" && toolNamesFor(agentId).some((tool) => atlassianTools.has(tool));
  }

  const tools: readonly AgentTool[] = agent.tools;
  const reference = tools.find((tool) => toolNamesOf(tool).includes(name));

  if (!reference) {
    return false;
  }

  if ("metadata" in reference && reference.metadata?.direct === true) {
    return route === "direct";
  }

  return atlassianTools.get(name)?.routes?.includes(route) ?? true;
}

export function roleSystemPrompt(role: RoleId, profile: string): string {
  const definition = roleRegistry[role];

  if (profile !== definition.profile) {
    throw new Error("Testing agent profile is incompatible with this worker");
  }

  return definition.systemPrompt;
}
