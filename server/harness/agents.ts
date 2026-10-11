import type { ArtifactKind, RoleId } from "../../shared/testing";
import { ROLE_IDS } from "../../shared/testing";
import {
  compactionSystemPrompt,
  openuiInstructions,
  qaSystemPrompts,
  sideSummarySystemPrompt,
} from "./prompts";

export const MODEL = "deepseek-ai/DeepSeek-V4.1-Flash";

export type AtlassianToolPolicy = Readonly<{ required: boolean }>;

export const atlassianTools: ReadonlyMap<string, AtlassianToolPolicy> = new Map([
  ["jira_get_issue", { required: true }],
  ["jira_search", { required: false }],
  ["confluence_get_page", { required: true }],
  ["confluence_search", { required: false }],
  ["confluence_get_comments", { required: false }],
]);

export const atlassianToolNames: readonly string[] = [...atlassianTools.keys()];

const requiredAtlassianToolNames: readonly string[] = [...atlassianTools]
  .filter(([, policy]) => policy.required)
  .map(([name]) => name);

export const capabilityToolNames = {
  workspace: ["read", "write", "edit"],
  figma_read: ["get_figma"],
  browser_ac: ["verify_ac"],
  browser_ui: ["verify_ui"],
  atlassian_read: requiredAtlassianToolNames,
} as const;

type Capability = keyof typeof capabilityToolNames;
type ConversationCapability = "workspace" | "figma_read";
type QaCapability = "atlassian_read" | "browser_ac" | "browser_ui" | "figma_read";

type ConversationAgent = Readonly<{
  kind: "conversation";
  model: string;
  codeMode: "enabled";
  delegation: "direct" | "none";
  systemPrompt: (extra?: string) => string;
}>;

type QaAgent = Readonly<{
  kind: "qa";
  model: string;
  artifact: ArtifactKind;
  capabilities: readonly QaCapability[];
  codeMode: "enabled";
  profile: string;
  systemPrompt: string;
}>;

type AgentDefinitions = {
  main: ConversationAgent &
    Readonly<{
      capabilities: readonly Extract<ConversationCapability, "workspace" | "figma_read">[];
      delegation: "direct";
    }>;
  atlassian: QaAgent;
  planner: QaAgent & Readonly<{ capabilities: readonly [] }>;
  ac: QaAgent;
  ui: QaAgent;
};

export const agentRegistry = {
  main: {
    kind: "conversation",
    model: MODEL,
    capabilities: ["workspace", "figma_read"],
    codeMode: "enabled",
    delegation: "direct",
    systemPrompt: openuiInstructions,
  },
  atlassian: {
    kind: "qa",
    model: MODEL,
    artifact: "requirements",
    capabilities: ["atlassian_read"],
    codeMode: "enabled",
    profile: "requirements-v2",
    systemPrompt: qaSystemPrompts.atlassian,
  },
  planner: {
    kind: "qa",
    model: MODEL,
    artifact: "plan",
    capabilities: [],
    codeMode: "enabled",
    profile: "planning-v2",
    systemPrompt: qaSystemPrompts.planner,
  },
  ac: {
    kind: "qa",
    model: MODEL,
    artifact: "ac-result",
    capabilities: ["browser_ac"],
    codeMode: "enabled",
    profile: "functional-v2",
    systemPrompt: qaSystemPrompts.ac,
  },
  ui: {
    kind: "qa",
    model: MODEL,
    artifact: "ui-result",
    capabilities: ["browser_ui", "figma_read"],
    codeMode: "enabled",
    profile: "style-v2",
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
export type ToolRoute = "direct" | "codemode";

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
  return agentRegistry[agentId].capabilities.flatMap((capability: Capability) => [
    ...capabilityToolNames[capability],
  ]);
}

export function allowsTool(agentId: AgentId, name: string, route: ToolRoute): boolean {
  const agent = agentRegistry[agentId];

  if (name === "codemode") {
    return route === "direct" && agent.codeMode === "enabled";
  }

  if (name === "delegate_task") {
    return route === "direct" && agent.kind === "conversation" && agent.delegation === "direct";
  }

  if (name === "discover_atlassian_tools") {
    return route === "direct" && toolNamesFor(agentId).some((tool) => atlassianTools.has(tool));
  }

  return toolNamesFor(agentId).includes(name);
}

export function roleSystemPrompt(role: RoleId, profile: string): string {
  const definition = roleRegistry[role];

  if (profile !== definition.profile) {
    throw new Error("Testing agent profile is incompatible with this worker");
  }

  return definition.systemPrompt;
}
