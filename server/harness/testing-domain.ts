import { createHash } from "node:crypto";
import type { z } from "zod";
import {
  evidenceSchema,
  planProposalSchema,
  type Check,
  type DelegationInput,
  type Design,
  type FigmaLink,
  type FunctionalCheck,
  type PlanArtifact,
  type PlanCase,
  type PlanProposal,
  type Requirements,
  type ResultArtifact,
  type Role,
  type Source,
  type StyleCheck,
  type Tolerance,
} from "../../shared/testing";

export const TESTING_WORKFLOW_VERSION = "testing-child-v3";
export const MAX_FEEDBACK_ISSUES = 20;
export const MAX_FEEDBACK_ISSUE_CHARS = 512;
export const MAX_FAILURE_ISSUES = 8;
export const MAX_FAILURE_ISSUE_CHARS = 240;
const MAX_FIGMA_LINKS = 20;

export type Receipt = Readonly<{
  id: string;
  slot: string;
  nativeName: string;
  route: string;
  input: unknown;
  output: unknown;
  inputDigest: string;
  outputDigest: string;
  bindings: Readonly<Record<string, string>>;
  createdAt: string;
}>;

export type Evaluation<T> = { ok: true; value: T } | { ok: false; issues: string[] };

type AtlassianIntent = Extract<DelegationInput, { role: "atlassian" }>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }

  return value;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function digestOf(value: unknown): string {
  return sha256(JSON.stringify(canonical(value)) ?? "null");
}

export function operationIdFor(parentRunId: string, toolCallId: string): string {
  return `testing-${sha256(`${parentRunId}\0${toolCallId}`).slice(0, 32)}`;
}

export function taskIdFor(operationId: string, role: Role): string {
  return `${operationId}-${role}`;
}

export function childWorkflowIdFor(operationId: string, role: Role): string {
  return `testing-${role}-${sha256(`${TESTING_WORKFLOW_VERSION}\0${operationId}\0${role}`).slice(0, 24)}`;
}

export function artifactRefFor(operationId: string, role: Role, payloadDigest: string): string {
  return `art-${sha256(`${operationId}\0${role}\0${payloadDigest}`).slice(0, 40)}`;
}

function sourceKey(source: Source): string {
  return source.kind === "jira" ? `jira:${source.issueKey}` : `confluence:${source.pageId}`;
}

export function clipIssues(issues: readonly string[], count: number, chars: number): string[] {
  return issues
    .slice(0, count)
    .map((issue) => (issue.length > chars ? issue.slice(0, chars) : issue));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const FIGMA_HOSTS = new Set(["figma.com", "www.figma.com"]);

export function figmaLinkOf(url: string, label?: string): FigmaLink | undefined {
  const parsed = URL.parse(url);

  if (!parsed || parsed.protocol !== "https:" || !FIGMA_HOSTS.has(parsed.hostname)) {
    return undefined;
  }

  const match = /^\/(?:file|design|proto)\/([A-Za-z0-9]+)(?:\/|$)/.exec(parsed.pathname);

  if (!match) {
    return undefined;
  }

  const nodeId = parsed.searchParams.get("node-id")?.replace(/-/g, ":");

  return {
    url: parsed.href,
    ...(label ? { label: label.slice(0, 500) } : {}),
    fileKey: match[1]!,
    ...(nodeId && /^\d+:\d+$/.test(nodeId) ? { nodeId } : {}),
  };
}

function remoteLinkOf(entry: unknown): FigmaLink | undefined {
  const item = record(entry);
  const target = record(item?.object) ?? item;

  return figmaLinkOf(text(target?.url), text(target?.title) || undefined);
}

function figmaLinks(remoteLinks: readonly unknown[]): FigmaLink[] {
  const unique = new Map<string, FigmaLink>();

  for (const link of remoteLinks.map(remoteLinkOf)) {
    if (link && !unique.has(link.url)) {
      unique.set(link.url, link);
    }
  }

  return [...unique.values()].slice(0, MAX_FIGMA_LINKS);
}

function figmaUrlsIn(value: string): { url: string }[] {
  return [...value.matchAll(/https:\/\/(?:www\.)?figma\.com\/[^\s)\]>"'|]+/g)].map((match) => ({
    url: match[0],
  }));
}

export function authorizedRead(name: string, input: unknown, intent: AtlassianIntent): string {
  const args = record(input);
  const issueKey = text(args?.issue_key).trim().toUpperCase();
  const pageId = text(args?.page_id).trim();
  const source = intent.sources.find((candidate) =>
    candidate.kind === "jira"
      ? name === "jira_get_issue" && candidate.issueKey.toUpperCase() === issueKey
      : name === "confluence_get_page" && candidate.pageId === pageId,
  );

  if (!source) {
    throw new Error(`${name} may only read sources listed in task.sources`);
  }

  return sourceKey(source);
}

function jiraText(output: Record<string, unknown>, source: Extract<Source, { kind: "jira" }>) {
  const key = text(output.key) || source.issueKey;
  const heading = [key, text(output.summary)].filter(Boolean).join(" ");

  return [heading, text(output.description)].filter(Boolean).join("\n\n");
}

function confluenceText(output: Record<string, unknown>): string {
  const metadata = record(output.metadata);
  const title = text(metadata?.title);
  const body = text(record(output.content)?.value) || text(record(metadata?.content)?.value);

  return [title, body].filter(Boolean).join("\n\n");
}

const sourceReaders = {
  jira: "jira_get_issue",
  confluence: "confluence_get_page",
} as const satisfies Record<Source["kind"], string>;

function successfulRead(source: Source, receipts: readonly Receipt[]): Receipt | undefined {
  return receipts.find((receipt) => {
    const output = record(receipt.output);

    return (
      receipt.nativeName === sourceReaders[source.kind] &&
      receipt.bindings.source === sourceKey(source) &&
      !!output &&
      typeof output.error !== "string"
    );
  });
}

export function assembleRequirements(
  intent: AtlassianIntent,
  receipts: readonly Receipt[],
): Evaluation<Requirements> {
  const issues: string[] = [];
  const sources: Requirements["sources"] = [];

  for (const [index, source] of intent.sources.entries()) {
    const receipt = successfulRead(source, receipts);

    if (!receipt) {
      issues.push(`task.sources[${index}]: ${sourceKey(source)} has no successful read`);
      continue;
    }

    const output = record(receipt.output)!;
    const body = source.kind === "jira" ? jiraText(output, source) : confluenceText(output);
    sources.push({
      reference: source,
      text: body,
      links: figmaLinks([
        ...(Array.isArray(output.remote_links) ? output.remote_links : []),
        ...figmaUrlsIn(body),
      ]),
      digest: digestOf(body),
      capturedAt: receipt.createdAt,
    });
  }

  return issues.length
    ? { ok: false, issues }
    : { ok: true, value: { goal: intent.goal, sources } };
}

export function parseRoleJson(raw: string | null): Evaluation<unknown> {
  const trimmed = (raw ?? "").trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)?.[1];

  try {
    return { ok: true, value: JSON.parse(fenced ?? trimmed) };
  } catch {
    return { ok: false, issues: ["Role output is not valid JSON"] };
  }
}

function zodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "output"}: ${issue.message}`);
}

function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();

  return [...new Set(ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false))))];
}

function sameDesign(left: Design, right: Design | null): boolean {
  return !!right && left.fileKey === right.fileKey && left.nodeId === right.nodeId;
}

type PlanRules = Readonly<{
  criteria: ReadonlySet<string>;
  design: Design | null;
  strict: boolean;
}>;

function duplicateIssues(plan: PlanProposal): string[] {
  const deferred = plan.deferredCases ?? [];
  const checks = plan.cases.flatMap((planCase) => planCase.checks);

  return [
    ...duplicates(plan.criteria.map((criterion) => criterion.id)).map(
      (id) => `criteria: duplicate id ${id}`,
    ),
    ...duplicates([...plan.cases, ...deferred].map((entry) => entry.id)).map(
      (id) => `cases: duplicate id ${id}`,
    ),
    ...duplicates(checks.map((check) => check.id)).map((id) => `checks: duplicate id ${id}`),
  ];
}

function functionalIssues(check: FunctionalCheck, rules: PlanRules): string[] {
  return rules.strict && !check.observation ? ["functional checks need an observation"] : [];
}

function styleIssues(check: StyleCheck, rules: PlanRules): string[] {
  const issues = sameDesign(check.design, rules.design)
    ? []
    : ["style design must equal the delegated design"];

  return rules.strict && !check.target ? [...issues, "style checks need a target"] : issues;
}

function checkIssues(check: Check, rules: PlanRules): string[] {
  const known = rules.criteria.has(check.criterionId)
    ? []
    : [`unknown criterionId ${check.criterionId}`];
  const specific =
    check.kind === "style" ? styleIssues(check, rules) : functionalIssues(check, rules);

  return [...known, ...specific];
}

function caseIssues(planCase: PlanCase, rules: PlanRules): string[] {
  const preconditions =
    rules.strict && planCase.preconditions.length
      ? [`cases.${planCase.id}.preconditions: must be []; express setup as actions`]
      : [];

  return [
    ...planCase.checks.flatMap((check) =>
      checkIssues(check, rules).map((issue) => `cases.${planCase.id}.checks.${check.id}: ${issue}`),
    ),
    ...preconditions,
  ];
}

function deferredIssues(plan: PlanProposal, rules: PlanRules): string[] {
  return (plan.deferredCases ?? []).flatMap((deferred) =>
    deferred.expectations
      .filter((expectation) => !rules.criteria.has(expectation.criterionId))
      .map(
        (expectation) =>
          `deferredCases.${deferred.id}: unknown criterionId ${expectation.criterionId}`,
      ),
  );
}

function planIssues(plan: PlanProposal, design: Design | null, strict: boolean): string[] {
  const rules: PlanRules = {
    criteria: new Set(plan.criteria.map((criterion) => criterion.id)),
    design,
    strict,
  };

  return [
    ...duplicateIssues(plan),
    ...plan.cases.flatMap((planCase) => caseIssues(planCase, rules)),
    ...deferredIssues(plan, rules),
  ];
}

export type CanonicalPlan = PlanProposal & Pick<PlanArtifact, "assignments">;

export function canonicalizePlan(
  raw: unknown,
  context: { design: Design | null; strict: boolean },
): Evaluation<CanonicalPlan> {
  const parsed = planProposalSchema.safeParse(raw);

  if (!parsed.success) {
    return { ok: false, issues: zodIssues(parsed.error) };
  }

  const issues = planIssues(parsed.data, context.design, context.strict);

  if (issues.length) {
    return { ok: false, issues };
  }

  const checks = parsed.data.cases.flatMap((planCase) => planCase.checks);

  return {
    ok: true,
    value: {
      ...parsed.data,
      assignments: {
        ac: checks.filter((check) => check.kind === "functional").map((check) => check.id),
        ui: checks.filter((check) => check.kind === "style").map((check) => check.id),
      },
    },
  };
}

function verifyToolName(role: "ac" | "ui"): "verify_ac" | "verify_ui" {
  return role === "ac" ? "verify_ac" : "verify_ui";
}

export function caseOfCheck(plan: PlanProposal, checkId: string) {
  for (const planCase of plan.cases) {
    const check = planCase.checks.find((candidate) => candidate.id === checkId);

    if (check) {
      return { planCase, check };
    }
  }

  return undefined;
}

function finishedReceipt(receipts: readonly Receipt[], tool: string, checkId: string) {
  return receipts.findLast((receipt) => {
    const evidence = evidenceSchema.safeParse(record(receipt.output)?.evidence);

    return (
      receipt.nativeName === tool &&
      receipt.bindings.checkId === checkId &&
      evidence.success &&
      evidence.data.check.checkId === checkId
    );
  });
}

export function assembleToolResults(input: {
  role: "ac" | "ui";
  plan: PlanArtifact;
  planRef: string;
  targetUrl: string;
  receipts: readonly Receipt[];
}): Evaluation<ResultArtifact> {
  const tool = verifyToolName(input.role);
  const issues: string[] = [];
  const checks: ResultArtifact["checks"] = [];

  for (const [index, checkId] of input.plan.assignments[input.role].entries()) {
    const receipt = finishedReceipt(input.receipts, tool, checkId);
    const located = caseOfCheck(input.plan, checkId);

    if (!receipt || !located) {
      issues.push(`task.checks[${index}]: ${checkId} has no finished ${tool} result`);
      continue;
    }

    const evidence = evidenceSchema.parse(record(receipt.output)!.evidence);
    checks.push({
      caseId: located.planCase.id,
      checkId,
      outcome: evidence.check.outcome,
      evidence,
      receiptId: receipt.id,
      outputDigest: receipt.outputDigest,
    });
  }

  return issues.length
    ? { ok: false, issues }
    : { ok: true, value: { planRef: input.planRef, targetUrl: input.targetUrl, checks } };
}

const styleProperties = [
  "color",
  "backgroundColor",
  "fontSize",
  "fontWeight",
  "opacity",
  "cornerRadius",
  "borderRadius",
  "letterSpacing",
  "lineHeight",
  "width",
  "height",
] as const;
export type StyleProperty = (typeof styleProperties)[number];

export function isStyleProperty(property: string): property is StyleProperty {
  return (styleProperties as readonly string[]).includes(property);
}

export type DesignCapture = Readonly<{
  fileKey: string;
  nodeId: string;
  properties: Partial<Record<StyleProperty, string>>;
}>;

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function solidFill(node: Record<string, unknown> | undefined): string | undefined {
  const fills = Array.isArray(node?.fills) ? node.fills : [];
  const fill = fills
    .map(record)
    .find((entry) => entry?.type === "SOLID" && entry.visible !== false);
  const color = record(fill?.color);

  if (!color) {
    return undefined;
  }

  const channel = (key: string) => Math.round((number(color[key]) ?? 0) * 255);
  const alpha = round((number(color.a) ?? 1) * (number(fill?.opacity) ?? 1));

  return alpha === 1
    ? `rgb(${channel("r")}, ${channel("g")}, ${channel("b")})`
    : `rgba(${channel("r")}, ${channel("g")}, ${channel("b")}, ${alpha})`;
}

function firstText(node: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!node || node.type === "TEXT") {
    return node;
  }

  for (const child of Array.isArray(node.children) ? node.children : []) {
    const found = firstText(record(child));

    if (found) {
      return found;
    }
  }

  return undefined;
}

function entries(values: Record<string, number | string | undefined>) {
  return Object.fromEntries(
    Object.entries(values)
      .filter((entry): entry is [string, number | string] => entry[1] !== undefined)
      .map(([key, value]) => [key, typeof value === "number" ? String(round(value)) : value]),
  ) as Partial<Record<StyleProperty, string>>;
}

function capturedRoot(output: unknown, design: Design): Record<string, unknown> | undefined {
  const response = record(output);
  const nodes = Array.isArray(response?.nodes) ? response.nodes : [];
  const root = record(nodes[0]);

  return root?.id === design.nodeId && response?.truncated !== true ? root : undefined;
}

function boxProperties(root: Record<string, unknown>) {
  const box = record(root.absoluteBoundingBox);
  const corners = Array.isArray(root.rectangleCornerRadii) ? root.rectangleCornerRadii : [];
  const radius = number(root.cornerRadius) ?? number(corners[0]);

  return {
    width: number(box?.width),
    height: number(box?.height),
    cornerRadius: radius,
    borderRadius: radius,
    opacity: number(root.opacity) ?? 1,
    backgroundColor: root.type === "TEXT" ? undefined : solidFill(root),
  };
}

function textProperties(root: Record<string, unknown>) {
  const node = firstText(root);
  const style = record(node?.style);

  return {
    color: solidFill(node),
    fontSize: number(style?.fontSize),
    fontWeight: number(style?.fontWeight),
    letterSpacing: number(style?.letterSpacing),
    lineHeight: number(style?.lineHeightPx),
  };
}

export function designCaptureOf(output: unknown, design: Design): DesignCapture | undefined {
  const root = capturedRoot(output, design);

  return root
    ? {
        fileKey: design.fileKey,
        nodeId: design.nodeId,
        properties: entries({ ...boxProperties(root), ...textProperties(root) }),
      }
    : undefined;
}

function rgba(value: string): number[] | undefined {
  const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/.exec(
    value.trim(),
  );

  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 1) * 255]
    : undefined;
}

export type StyleComparison =
  | { outcome: "inside_tolerance" | "outside_tolerance" }
  | { outcome: "blocked"; reason: string };

export function compareStyle(
  property: StyleProperty,
  expected: string,
  observed: string,
  tolerance: Tolerance,
): StyleComparison {
  const maxDelta = tolerance.kind === "numeric" ? tolerance.maxDelta : 0.01;

  if (property === "color" || property === "backgroundColor") {
    const left = rgba(expected);
    const right = rgba(observed);

    if (!left || !right) {
      return { outcome: "blocked", reason: `Cannot compare ${property} values` };
    }

    const delta = Math.max(...left.map((channel, index) => Math.abs(channel - right[index]!)));

    return { outcome: delta <= Math.max(maxDelta, 0.5) ? "inside_tolerance" : "outside_tolerance" };
  }

  const left = Number.parseFloat(expected);
  const right = Number.parseFloat(observed);

  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return { outcome: "blocked", reason: `Cannot compare ${property} values` };
  }

  return {
    outcome: Math.abs(left - right) <= maxDelta ? "inside_tolerance" : "outside_tolerance",
  };
}

export type RoleContext =
  | { role: "atlassian"; intent: AtlassianIntent }
  | {
      role: "planner";
      requirementsRef: string;
      requirements: Requirements;
      design: Design | null;
    }
  | { role: "ac" | "ui"; planRef: string; plan: PlanArtifact; targetUrl: string };

export function evaluateRole(
  context: RoleContext,
  completion: { finalText: string | null; receipts: readonly Receipt[] },
): Evaluation<unknown> {
  switch (context.role) {
    case "atlassian":
      return assembleRequirements(context.intent, completion.receipts);

    case "planner": {
      const json = parseRoleJson(completion.finalText);

      if (!json.ok) {
        return json;
      }

      const plan = canonicalizePlan(json.value, { design: context.design, strict: true });

      return plan.ok
        ? {
            ok: true,
            value: {
              ...plan.value,
              requirementsRef: context.requirementsRef,
              requirementsDigest: digestOf(context.requirements),
              goal: context.requirements.goal,
              targetUrl: null,
              design: context.design,
            } satisfies PlanArtifact,
          }
        : plan;
    }

    default:
      return assembleToolResults({ ...context, role: context.role, receipts: completion.receipts });
  }
}

export function failureCodeFor(
  role: Role,
): "source_reads_incomplete" | "proposal_rejected" | "checks_incomplete" {
  if (role === "atlassian") {
    return "source_reads_incomplete";
  }

  return role === "planner" ? "proposal_rejected" : "checks_incomplete";
}
