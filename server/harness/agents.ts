import type { Tool } from "@tanstack/ai";
import { artifactKinds, type ArtifactKind, type Role } from "../../shared/testing";
import { mainSystemPrompt, openuiInstructions, qaSystemPrompt } from "./prompts";
import { discoveryToolName } from "./tools/atlassian";
import { codeModeToolName } from "./tools/code-mode";
import { delegateTaskTool } from "./tools/delegate-task";
import { edit, read, write } from "./tools/fs";
import { getFigma } from "./tools/get-figma";
import { verifyAcTool, verifyUiTool } from "./tools/use-browser";

export const MODEL = "deepseek-ai/DeepSeek-V4.1-Flash";

export type Route = "direct" | "codemode";

type AtlassianFactory = Readonly<{
  kind: "atlassian";
  names: readonly string[];
  routes?: Readonly<Partial<Record<string, readonly Route[]>>>;
}>;
type ToolEntry = Readonly<Pick<Tool, "name" | "metadata">> | AtlassianFactory;

export type RoleLimits = Readonly<{
  maxTurns: number;
  maxToolCalls: number;
  maxNestedCalls: number;
}>;

type AgentBase = Readonly<{
  model: typeof MODEL;
  tools: readonly ToolEntry[];
  codeMode: "enabled" | "disabled";
  systemPrompt: () => string;
}>;

type ConversationAgent = AgentBase & Readonly<{ kind: "conversation" }>;

type QaAgent = AgentBase &
  Readonly<{
    kind: "qa";
    artifact: ArtifactKind;
    registration: string;
    profile: string;
    limits: RoleLimits;
  }>;

const qaLimits: RoleLimits = { maxTurns: 8, maxToolCalls: 24, maxNestedCalls: 8 };
const browserLimits: RoleLimits = { maxTurns: 20, maxToolCalls: 60, maxNestedCalls: 8 };

const atlassianRead: AtlassianFactory = {
  kind: "atlassian",
  names: ["jira_get_issue", "confluence_get_page"],
};

export const agentRegistry = {
  main: {
    kind: "conversation",
    model: MODEL,
    tools: [getFigma, read, write, edit, delegateTaskTool],
    codeMode: "enabled",
    systemPrompt: mainSystemPrompt,
  },
  side: {
    kind: "conversation",
    model: MODEL,
    tools: [getFigma, read, write, edit],
    codeMode: "enabled",
    systemPrompt: () => openuiInstructions(),
  },
  atlassian: {
    kind: "qa",
    model: MODEL,
    artifact: artifactKinds.atlassian,
    tools: [atlassianRead],
    registration: "atlassian_read",
    codeMode: "enabled",
    profile: "requirements-v1",
    limits: qaLimits,
    systemPrompt: () => qaSystemPrompt("atlassian"),
  },
  planner: {
    kind: "qa",
    model: MODEL,
    artifact: artifactKinds.planner,
    tools: [],
    registration: "none",
    codeMode: "enabled",
    profile: "plan-v1",
    limits: qaLimits,
    systemPrompt: () => qaSystemPrompt("planner"),
  },
  ac: {
    kind: "qa",
    model: MODEL,
    artifact: artifactKinds.ac,
    tools: [verifyAcTool],
    registration: "browser_ac",
    codeMode: "disabled",
    profile: "ac-v1",
    limits: browserLimits,
    systemPrompt: () => qaSystemPrompt("ac"),
  },
  ui: {
    kind: "qa",
    model: MODEL,
    artifact: artifactKinds.ui,
    tools: [getFigma, verifyUiTool],
    registration: "browser_ui",
    codeMode: "disabled",
    profile: "ui-v1",
    limits: browserLimits,
    systemPrompt: () => qaSystemPrompt("ui"),
  },
} as const satisfies Record<"main" | "side", ConversationAgent> & Record<Role, QaAgent>;

export type AgentId = keyof typeof agentRegistry;
export type ConversationAgentId = "main" | "side";

const ALL_ROUTES: readonly Route[] = ["direct", "codemode"];

function isFactory(entry: ToolEntry): entry is AtlassianFactory {
  return "kind" in entry && entry.kind === "atlassian";
}

function entries(agentId: AgentId): readonly ToolEntry[] {
  return agentRegistry[agentId].tools;
}

export function toolNamesFor(agentId: AgentId): string[] {
  return entries(agentId).flatMap((entry) => (isFactory(entry) ? [...entry.names] : [entry.name]));
}

export function atlassianNamesFor(agentId: AgentId): readonly string[] {
  return entries(agentId).flatMap((entry) => (isFactory(entry) ? entry.names : []));
}

export function allowsTool(agentId: AgentId, name: string, route: Route): boolean {
  const agent = agentRegistry[agentId];

  if (name === codeModeToolName) {
    return route === "direct" && agent.codeMode === "enabled";
  }

  if (name === discoveryToolName) {
    return route === "direct" && atlassianNamesFor(agentId).length > 0;
  }

  const entry = entries(agentId).find((candidate) =>
    isFactory(candidate) ? candidate.names.includes(name) : candidate.name === name,
  );

  if (!entry) {
    return false;
  }

  if (isFactory(entry)) {
    return (entry.routes?.[name] ?? ALL_ROUTES).includes(route);
  }

  return entry.metadata?.direct === true ? route === "direct" : true;
}

export type ToolAccess = Readonly<{
  permits: (name: string, route: Route) => boolean;
  atlassianNames: readonly string[];
}>;

export function agentAccess(agentId: AgentId): ToolAccess {
  return {
    permits: (name, route) => allowsTool(agentId, name, route),
    atlassianNames: atlassianNamesFor(agentId),
  };
}

export function roleDefinition(role: Role) {
  return agentRegistry[role];
}

export function roleSystemPrompt(role: Role, profile: string): string {
  const definition = roleDefinition(role);

  if (definition.profile !== profile) {
    throw new Error(`Role ${role} profile ${profile} is no longer supported`);
  }

  return definition.systemPrompt();
}
