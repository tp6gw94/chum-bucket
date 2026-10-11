import { setTimeout as delay } from "node:timers/promises";
import { createPlaywrightFixture } from "./playwright-check";
import { DBOS } from "@dbos-inc/dbos-sdk";
import type { UIMessage } from "@tanstack/ai";
import { z } from "zod";
import {
  DESIGN_CAPTURE_NATIVE,
  SOURCE_CAPTURE_NATIVE,
  TESTING_WORKFLOW_VERSION,
  ackDelivery,
  appendTrustedObservation,
  appendTrustedReceipt,
  claimActualTask,
  readStartCancelDeliveries,
  type TestingExecution,
} from "./testing-store";
import { guardActualIO, readTestingExecution } from "./run-store";
import {
  digestOf,
  canonicalizePlan,
  checksForRole,
  sameDesign,
  sameSource,
  validateRequirements,
  validateResults,
  type CanonicalPlan,
  type Requirements,
  type SourceCapture,
  type TrustedToolReceipt,
  type Validation,
} from "./testing-domain";
import {
  requestedFigmaTarget,
  withTestingRoleTools,
  type DesignCaptureResult,
  type TestingNativeEnvelope,
  type TestingNativeHost,
  type TestingNativeInvocation,
  type TestingNativeReceiptReference,
} from "./testing-tools";
import { runAgentLoop, type AgentCheckpoint, type AgentSession } from "./agent-loop";
import { roleRegistry, roleSystemPrompt } from "./agents";
import { roleFeedbackPrompt, roleTaskPrompt } from "./prompts";
import type { ConversationState } from "./conversation";
import {
  browserOutputSchema,
  designCaptureSchema,
  type DesignReference,
  type PlanCheck,
  type RoleId,
  type Source,
} from "../../shared/testing";
import type { AdapterYieldChunk } from "@tanstack/ai";
import type { RunTools } from "./tools";

export type TestingChildInput = Readonly<{
  taskId: string;
  attemptNonce: number;
  childWorkflowId: string;
  parentRunId: string;
  operationId: string;
  role: RoleId;
}>;

export type TestingChildResult =
  | Readonly<{ state: "proposed"; proposal: unknown }>
  | Readonly<{ state: "denied"; reason: string }>
  | Readonly<{ state: "failed"; reason: string }>;

type Transport = {
  controller: AbortController;
  inflight: Set<Promise<unknown>>;
  quiet: Promise<void>;
  resolve: () => void;
  aborted: boolean;
  closed: boolean;
};

const transports = new Map<string, Transport>();

function abortTransport(transport: Transport): void {
  transport.aborted = true;
  transport.controller.abort();
}

function refuse(transport: Transport): void {
  if (transport.aborted || transport.closed || transport.controller.signal.aborted) {
    transport.aborted = true;
    throw new Error("Testing transport refuses new effects");
  }
}

export function testingTransportState(workflowId: string): "absent" | "closed" | "live" {
  const transport = transports.get(workflowId);

  if (!transport) {
    return "absent";
  }

  return transport.closed ? "closed" : "live";
}

export async function abortTestingTransports(workflowIds: readonly string[]): Promise<boolean> {
  const known = workflowIds.flatMap((id) => {
    const transport = transports.get(id);

    return transport ? [transport] : [];
  });

  for (const transport of known) {
    transport.aborted = true;
    transport.controller.abort();
  }

  await Promise.all(known.map((transport) => transport.quiet));

  return workflowIds.every((id) => testingTransportState(id) !== "live");
}

export async function drainTestingTransports(): Promise<void> {
  const current = [...transports.values()];

  for (const transport of current) {
    transport.aborted = true;
    transport.controller.abort();
  }

  await Promise.all(current.map((transport) => transport.quiet));
}

function bindTransport(workflowId: string): Transport {
  const existing = transports.get(workflowId);

  if (existing && !existing.closed) {
    return existing;
  }

  let resolve = () => undefined;
  const quiet = new Promise<void>((done) => {
    resolve = () => {
      done();
    };
  });
  const transport: Transport = {
    controller: new AbortController(),
    inflight: new Set(),
    quiet,
    resolve,
    aborted: false,
    closed: false,
  };
  transports.set(workflowId, transport);

  return transport;
}

function track<T>(transport: Transport, start: () => Promise<T>): Promise<T> {
  refuse(transport);
  const done = start().finally(() => {
    transport.inflight.delete(done);
  });
  transport.inflight.add(done);

  return done;
}

async function settleTransport(workflowId: string, transport: Transport): Promise<void> {
  transport.aborted = true;
  transport.controller.abort();

  for (;;) {
    const pending = [...transport.inflight];

    if (pending.length === 0) {
      break;
    }

    await Promise.allSettled(pending);
  }

  transport.closed = true;
  transport.resolve();

  if (transports.get(workflowId) === transport) {
    transports.delete(workflowId);
  }
}

export function sourceAnchors(raw: unknown, limit = 24, nativeName?: string): readonly string[] {
  if (nativeName === "jira_get_issue" && isRecord(raw) && typeof raw.result === "string") {
    try {
      const issue: unknown = JSON.parse(raw.result);

      if (!isRecord(issue) || typeof issue.key !== "string" || !issue.key.trim()) {
        return [];
      }

      raw = [issue.description, issue.key, issue.summary, issue];
    } catch {
      return [];
    }
  }

  const found = new Set<string>();

  const visit = (value: unknown) => {
    if (found.size >= limit) {
      return;
    }

    if (typeof value === "string") {
      const text = value.trim();

      if (text.length > 0 && text.length <= 512) {
        found.add(text);
      }

      return;
    }

    if (Array.isArray(value)) {
      value.forEach(visit);

      return;
    }

    if (value && typeof value === "object") {
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        visit((value as Record<string, unknown>)[key]);
      }
    }
  };

  visit(raw);

  return [...found];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jiraSource(issueKey: unknown, sources: readonly Source[]): Source | null {
  return typeof issueKey === "string"
    ? (sources.find((source) => source.kind === "jira" && source.issueKey === issueKey) ?? null)
    : null;
}

function confluenceSource(pageId: unknown, sources: readonly Source[]): Source | null {
  return typeof pageId === "string"
    ? (sources.find((source) => source.kind === "confluence" && source.pageId === pageId) ?? null)
    : null;
}

function authorizedSource(
  nativeName: string,
  input: unknown,
  sources: readonly Source[],
): Source | null {
  if (!isRecord(input)) {
    return null;
  }

  if (nativeName === "jira_get_issue") {
    return jiraSource(input.issue_key, sources);
  }

  return nativeName === "confluence_get_page" ? confluenceSource(input.page_id, sources) : null;
}

function normalizeJson(value: unknown): unknown {
  const json = JSON.stringify(value);

  if (json === undefined) {
    throw new Error("Tool output is not JSON");
  }

  return JSON.parse(json) as unknown;
}

function colorString(fills: unknown): string | null {
  if (!Array.isArray(fills)) {
    return null;
  }

  const color = (
    fills[0] as { color?: { r?: number; g?: number; b?: number; a?: number } } | undefined
  )?.color;

  if (
    !color ||
    typeof color.r !== "number" ||
    typeof color.g !== "number" ||
    typeof color.b !== "number"
  ) {
    return null;
  }

  const channel = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255);
  const alpha = typeof color.a === "number" ? color.a : 1;

  return `rgba(${channel(color.r)}, ${channel(color.g)}, ${channel(color.b)}, ${alpha})`;
}

export function designProperties(
  raw: unknown,
  reference: DesignReference,
  requested: readonly string[],
): Readonly<Record<string, string>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Figma output is truncated or incomplete");
  }

  const record = raw as Record<string, unknown>;

  if (record.truncated === true) {
    throw new Error("Figma output is truncated or incomplete");
  }

  if (record.fileKey !== reference.fileKey) {
    throw new Error("Figma output does not match the requested file");
  }

  const nodes = Array.isArray(record.nodes) ? record.nodes : [];
  const root = nodes[0];

  if (!root || typeof root !== "object" || Array.isArray(root)) {
    throw new Error("Figma output does not contain the requested root node");
  }

  const node = root as Record<string, unknown>;

  if (node.visible === false || node.id !== reference.nodeId) {
    throw new Error("Figma output does not contain the requested root node");
  }

  const properties: Record<string, string> = {};

  for (const property of requested) {
    const value = cssProperty(node, property);

    if (value === null) {
      throw new Error(`Host design capture is missing property ${property}`);
    }

    properties[property] = value;
  }

  return properties;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function boxSize(node: Record<string, unknown>, property: "width" | "height"): string | null {
  const box = node.absoluteBoundingBox;

  if (!isRecord(box)) {
    return null;
  }

  const size = box[property];

  return finiteNumber(size) ? `${size}px` : null;
}

function cssProperty(node: Record<string, unknown>, property: string): string | null {
  const sized = property === "width" || property === "height" ? boxSize(node, property) : null;

  if (sized !== null) {
    return sized;
  }

  if (property === "opacity" && finiteNumber(node.opacity)) {
    return String(node.opacity);
  }

  if (property === "backgroundColor" || property === "color") {
    return colorString(node.fills);
  }

  const direct = node[property];

  return finiteNumber(direct) ? `${direct}px` : null;
}

function pinnedRequirements(execution: TestingExecution): Requirements | null {
  const artifact = execution.artifacts.find((item) => item.kind === "requirements");

  return artifact ? (artifact.payload as Requirements) : null;
}

function pinnedPlan(execution: TestingExecution): CanonicalPlan | null {
  const artifact = execution.artifacts.find((item) => item.kind === "plan");

  return artifact ? (artifact.payload as CanonicalPlan) : null;
}

function assistantText(conversation: ConversationState): string {
  const assistant = [...conversation.context]
    .reverse()
    .find((message) => message.role === "assistant");

  return (
    assistant?.parts
      .filter((part) => part.type === "text")
      .map((part) => ("content" in part ? String(part.content) : ""))
      .join("") ?? ""
  );
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start < 0 || end <= start) {
    throw new Error("Role output is not JSON");
  }

  return JSON.parse(text.slice(start, end + 1)) as unknown;
}

type ExecutionTask = TestingExecution["tasks"][number];
type ExecutionReceipt = ExecutionTask["receipts"][number];

function validationIssues(validation: Validation<unknown>): string[] {
  return validation.kind === "rejected" ? [...validation.issues] : [];
}

function requirementsReview(
  execution: TestingExecution,
  proposal: unknown,
): Pick<ProposalReview, "issues" | "failureReason"> {
  const captures =
    execution.tasks
      .find((task) => task.frame.role === "atlassian")
      ?.receipts.filter((receipt) => receipt.nativeName === SOURCE_CAPTURE_NATIVE)
      .map((receipt) => receipt.output as SourceCapture) ?? [];

  const decision = validateRequirements(proposal, {
    goal: execution.intent.goal,
    selection: execution.intent.criteria,
    captures,
  });

  if (decision.kind !== "not_extractable") {
    return { issues: validationIssues(decision) };
  }

  const uncoveredSource = execution.intent.sources.some(
    (source) => !captures.some((capture) => sameSource(capture.reference, source)),
  );

  if (uncoveredSource) {
    return { issues: ["task.sources: source captures do not cover the request"] };
  }

  return { issues: [], failureReason: "requirements_not_extractable" };
}

function planIssues(
  execution: TestingExecution,
  requirements: Requirements,
  proposal: unknown,
): string[] {
  const validation = canonicalizePlan(proposal, {
    requirements,
    requirementsDigest: digestOf(requirements),
    goal: execution.intent.goal,
    targetUrl: execution.intent.targetUrl,
    design: execution.intent.design ?? null,
    bounds: execution.runtime.bounds,
  });

  if (validation.kind !== "accepted") {
    return validationIssues(validation);
  }

  return validation.value.cases.flatMap((planCase) =>
    planCase.checks.flatMap((check) =>
      (check.kind === "functional" ? !check.observation : !check.target)
        ? [`Check ${check.id} requires a typed executable observation or style target`]
        : [],
    ),
  );
}

function trustedBrowserReceipt(receipt: ExecutionReceipt, role: "ac" | "ui"): TrustedToolReceipt[] {
  if (
    !["use_browser", role === "ac" ? "verify_ac" : "verify_ui"].includes(receipt.nativeName) ||
    !isObjectLike(receipt.bindings)
  ) {
    return [];
  }

  const bindings = receipt.bindings as { fixture?: { id: string; version: string } };

  if (!bindings.fixture) {
    return [];
  }

  const output = receipt.output as { checkId?: string };

  return [
    {
      id: receipt.id,
      role,
      checkId: output.checkId ?? "",
      inputDigest: receipt.inputDigest,
      outputDigest: receipt.outputDigest,
      output: receipt.output,
      fixture: bindings.fixture,
    },
  ];
}

function isObjectLike(value: unknown): boolean {
  return Boolean(value) && typeof value === "object";
}

function resultIssues(
  execution: TestingExecution,
  role: "ac" | "ui",
  plan: CanonicalPlan,
  proposal: unknown,
): string[] {
  const task = execution.tasks.find((item) => item.frame.role === role);
  const receipts = (task?.receipts ?? []).flatMap((receipt) =>
    trustedBrowserReceipt(receipt, role),
  );

  return validationIssues(
    validateResults(proposal, {
      role,
      cases: plan.cases,
      checks: checksForRole(plan.cases, role),
      receipts,
    }),
  );
}

function proposalIssues(role: RoleId, execution: TestingExecution, proposal: unknown): string[] {
  const requirements = pinnedRequirements(execution);

  if (!requirements) {
    return ["requirements_missing"];
  }

  if (role === "planner") {
    return planIssues(execution, requirements, proposal);
  }

  const plan = pinnedPlan(execution);

  if (!plan) {
    return ["plan_missing"];
  }

  return resultIssues(execution, role === "ac" ? "ac" : "ui", plan, proposal);
}

function feedbackConversation(
  conversation: ConversationState,
  issues: readonly string[],
): ConversationState {
  const message: UIMessage = {
    id: `feedback-${conversation.context.length}`,
    role: "user",
    parts: [{ type: "text", content: roleFeedbackPrompt(issues) }],
  };

  return {
    display: [...conversation.display, message],
    context: [...conversation.context, message],
  };
}

const designReceiptBindingSchema = z.strictObject({
  nativeName: z.literal("get_figma"),
  nativeOutputDigest: z.string().min(1).max(128),
});

const figmaRequestSchema = z
  .object({ target: z.string(), nodeId: z.string().optional() })
  .passthrough();

function designCaptureIntact(
  receipt: ExecutionReceipt,
  task: ExecutionTask,
  captured: DesignReference,
  design: DesignReference,
): boolean {
  return (
    receipt.taskId === task.frame.taskId &&
    receipt.attemptNonce === task.frame.attemptNonce &&
    receipt.route === "direct" &&
    receipt.outputDigest === digestOf(receipt.output) &&
    sameDesign(captured, design)
  );
}

function linkedDesignNative(
  task: ExecutionTask,
  capture: ExecutionReceipt,
  binding: z.infer<typeof designReceiptBindingSchema>,
): ExecutionReceipt {
  const native = task.receipts.find(
    (receipt) =>
      receipt.taskId === task.frame.taskId &&
      receipt.attemptNonce === task.frame.attemptNonce &&
      receipt.slot === capture.slot &&
      receipt.nativeName === binding.nativeName &&
      receipt.outputDigest === binding.nativeOutputDigest,
  );

  if (!native || native.outputDigest !== digestOf(native.output)) {
    throw new Error("Stored design capture has no matching native response");
  }

  return native;
}

function assertStoredFigmaRequest(input: unknown, design: DesignReference): void {
  const request = figmaRequestSchema.safeParse(input);

  if (!request.success) {
    throw new Error("Stored Figma request input is invalid");
  }

  if (!sameDesign(requestedFigmaTarget(request.data.target, request.data.nodeId), design)) {
    throw new Error("Stored Figma request does not match the requested design");
  }
}

export function restoreDesignCapture(
  execution: TestingExecution,
  taskId: string,
  design: DesignReference,
  requested: readonly string[],
): DesignCaptureResult | null {
  const task = execution.tasks.find((candidate) => candidate.frame.taskId === taskId);

  if (!task) {
    throw new Error("Design recovery task is outside the execution");
  }

  const captureReceipt = task.receipts.findLast(
    (receipt) => receipt.nativeName === DESIGN_CAPTURE_NATIVE,
  );

  if (!captureReceipt) {
    return null;
  }

  const binding = designReceiptBindingSchema.safeParse(captureReceipt.bindings);
  const capture = designCaptureSchema.safeParse(captureReceipt.output);

  if (
    !binding.success ||
    !capture.success ||
    !designCaptureIntact(captureReceipt, task, capture.data.reference, design)
  ) {
    throw new Error("Stored design capture failed host recovery validation");
  }

  const native = linkedDesignNative(task, captureReceipt, binding.data);
  assertStoredFigmaRequest(native.input, design);
  const properties = designProperties(native.output, design, requested);

  if (capture.data.propertiesDigest !== digestOf(properties)) {
    throw new Error("Stored design capture properties do not match its native response");
  }

  return { properties, capture: capture.data };
}

type NativeInvocationReceipt = Readonly<{
  taskId: string;
  attemptNonce: number;
  slot: string;
  nativeName: string;
  input: unknown;
  output: unknown;
  outputDigest: string;
}>;

function nativeReceiptFor(
  receipts: ReadonlyMap<string, NativeInvocationReceipt>,
  reference: TestingNativeReceiptReference,
  input: TestingChildInput,
  raw: unknown,
  names: readonly string[],
): NativeInvocationReceipt {
  const receipt = receipts.get(reference.receiptId);
  const digest = digestOf(raw);

  if (
    !receipt ||
    receipt.taskId !== input.taskId ||
    receipt.attemptNonce !== input.attemptNonce ||
    !names.includes(receipt.nativeName) ||
    receipt.outputDigest !== reference.outputDigest ||
    receipt.outputDigest !== digest ||
    receipt.outputDigest !== digestOf(receipt.output)
  ) {
    throw new Error("Capture is not linked to its native invocation");
  }

  return receipt;
}

const BROWSER_CHECK_KINDS: Partial<Record<RoleId, "functional" | "style">> = {
  ac: "functional",
  ui: "style",
};

type PlannedCheck = Readonly<{ planCase: CanonicalPlan["cases"][number]; check: PlanCheck }>;

function plannedCheck(plan: CanonicalPlan | null, checkId: string): PlannedCheck | undefined {
  return plan?.cases
    .flatMap((planCase) => planCase.checks.map((check) => ({ planCase, check })))
    .find(({ check }) => check.id === checkId);
}

function browserEvidenceInScope(
  evidence: z.infer<typeof browserOutputSchema>["evidence"],
  match: PlannedCheck,
  execution: TestingExecution,
): boolean {
  return (
    evidence.origin === "browser" &&
    evidence.browser !== undefined &&
    evidence.kind === match.check.kind &&
    evidence.caseId === match.planCase.id &&
    evidence.checkId === match.check.id &&
    evidence.fixture.id === execution.runtime.fixture.id &&
    evidence.fixture.version === execution.runtime.fixture.version &&
    evidence.adapterVersion === execution.runtime.versions.adapter
  );
}

function browserReceiptBindings(
  output: unknown,
  role: RoleId,
  plan: CanonicalPlan | null,
  execution: TestingExecution,
): Record<string, unknown> {
  const parsed = browserOutputSchema.safeParse(output);

  if (!parsed.success) {
    throw new Error("Browser output is outside the canonical host scope");
  }

  const kind = BROWSER_CHECK_KINDS[role];
  const match = plannedCheck(plan, parsed.data.checkId);

  if (
    !kind ||
    !match ||
    match.check.kind !== kind ||
    !browserEvidenceInScope(parsed.data.evidence, match, execution)
  ) {
    throw new Error("Browser output is outside the canonical host scope");
  }

  return {
    fixture: execution.runtime.fixture,
    adapterVersion: execution.runtime.versions.adapter,
    checkId: match.check.id,
  };
}

type DeliveryRecord = Awaited<ReturnType<typeof readStartCancelDeliveries>>[number];

const CANCEL_PROGRESS = new Map<string | null, "cancel_requested" | "stopped">([
  [null, "cancel_requested"],
  ["cancel_requested", "stopped"],
]);

function taskDelivery(
  deliveries: readonly DeliveryRecord[],
  taskId: string,
  kind: "start" | "cancel",
): DeliveryRecord | undefined {
  return deliveries.find((delivery) => delivery.taskId === taskId && delivery.kind === kind);
}

function cancelSettled(cancel: DeliveryRecord | undefined): boolean {
  return !cancel || cancel.acknowledgement === "stopped";
}

async function advanceDeliveries(
  deliveries: readonly DeliveryRecord[],
  taskId: string,
): Promise<void> {
  const start = taskDelivery(deliveries, taskId, "start");
  const cancel = taskDelivery(deliveries, taskId, "cancel");
  const next = cancel ? CANCEL_PROGRESS.get(cancel.acknowledgement) : undefined;

  if (cancel && next) {
    await ackDelivery(cancel.key, next).catch(() => undefined);
  }

  if (cancelSettled(cancel) && start?.acknowledgement === null) {
    await ackDelivery(start.key, "quiet").catch(() => undefined);
  }
}

function drained(deliveries: readonly DeliveryRecord[], taskId: string): boolean {
  return (
    taskDelivery(deliveries, taskId, "start")?.acknowledgement === "quiet" &&
    cancelSettled(taskDelivery(deliveries, taskId, "cancel"))
  );
}

export async function acknowledgeDrain(input: TestingChildInput): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await advanceDeliveries(await readStartCancelDeliveries(input.operationId), input.taskId);

    if (drained(await readStartCancelDeliveries(input.operationId), input.taskId)) {
      return;
    }

    await delay(50);
  }
}

type ChildRun = Readonly<{
  input: TestingChildInput;
  execution: TestingExecution;
  transport: Transport;
  signal: AbortSignal;
  deadline: AbortSignal;
  plan: CanonicalPlan | null;
  requested: readonly string[];
  systemPrompt: string;
  nativeReceipts: Map<string, NativeInvocationReceipt>;
}>;

const OWNED_DENIALS: ReadonlySet<string> = new Set(["cancel_requested", "deadline", "terminal"]);

function observe(input: TestingChildInput, key: string, body: unknown) {
  return appendTrustedObservation({
    taskId: input.taskId,
    attemptNonce: input.attemptNonce,
    key,
    body,
  });
}

function childCancelled(
  execution: TestingExecution,
  deliveries: readonly DeliveryRecord[],
  taskId: string,
): boolean {
  return (
    execution.cancelRequested ||
    execution.finished ||
    taskDelivery(deliveries, taskId, "cancel") !== undefined
  );
}

function armDeadline(execution: TestingExecution, transport: Transport): AbortSignal {
  const deadline = AbortSignal.timeout(Math.max(0, Date.parse(execution.deadline) - Date.now()));
  deadline.addEventListener("abort", () => abortTransport(transport), { once: true });

  return deadline;
}

async function cancellationObserved(
  input: TestingChildInput,
  transport: Transport,
): Promise<boolean> {
  const again = await readStartCancelDeliveries(input.operationId).catch(() => []);
  const cancel = taskDelivery(again, input.taskId, "cancel");
  const claimedAgain = await claimActualTask(input).catch(() => ({
    state: "denied" as const,
    reason: "scope" as const,
  }));

  if (!cancel && !("state" in claimedAgain)) {
    return false;
  }

  abortTransport(transport);

  if (cancel?.acknowledgement === null) {
    await ackDelivery(cancel.key, "cancel_requested").catch(() => undefined);
  }

  return true;
}

function watchCancellation(input: TestingChildInput, transport: Transport, signal: AbortSignal) {
  void track(transport, async () => {
    while (!transport.aborted && !signal.aborted) {
      if (await cancellationObserved(input, transport)) {
        return;
      }

      await delay(200, undefined, { signal }).catch(() => undefined);
    }
  }).catch(() => undefined);
}

function styleProperties(plan: CanonicalPlan | null): readonly string[] {
  return [
    ...new Set(
      plan?.cases.flatMap((planCase) =>
        planCase.checks.flatMap((check) => (check.kind === "style" ? [check.property] : [])),
      ) ?? [],
    ),
  ];
}

async function guardNativeCall(
  run: ChildRun,
  invocation: TestingNativeInvocation,
): Promise<string> {
  refuse(run.transport);
  const guard = await guardActualIO({
    taskId: run.input.taskId,
    parentRunId: run.input.parentRunId,
    attemptNonce: run.input.attemptNonce,
    childWorkflowId: run.input.childWorkflowId,
    kind: invocation.route === "codemode" ? "nested" : "tool",
  });

  if (guard.state !== "allowed") {
    abortTransport(run.transport);
    throw new Error(guard.reason);
  }

  if (run.transport.aborted || run.signal.aborted) {
    await observe(run.input, `tool-abort-${guard.slot}`, {
      kind: "tool_settled",
      outcome: "cancelled",
      at: new Date().toISOString(),
    }).catch(() => undefined);
    throw new Error("Testing transport refuses new effects");
  }

  return guard.slot;
}

async function storeNativeReceipt(
  run: ChildRun,
  invocation: TestingNativeInvocation,
  slot: string,
  output: unknown,
): Promise<TestingNativeEnvelope> {
  const { input } = run;
  const nativeInput = normalizeJson(invocation.input);
  const receiptId = `native-${slot}-${invocation.nativeName}`;
  const bindings = ["use_browser", "verify_ac", "verify_ui"].includes(invocation.nativeName)
    ? browserReceiptBindings(output, input.role, run.plan, run.execution)
    : {};
  const stored = await appendTrustedReceipt({
    id: receiptId,
    taskId: input.taskId,
    attemptNonce: input.attemptNonce,
    slot,
    nativeName: invocation.nativeName,
    route: invocation.route,
    input: nativeInput,
    output,
    bindings,
  });

  if (stored.outputDigest !== digestOf(output)) {
    throw new Error("Receipt digest drift");
  }

  run.nativeReceipts.set(receiptId, {
    taskId: input.taskId,
    attemptNonce: input.attemptNonce,
    slot,
    nativeName: invocation.nativeName,
    input: nativeInput,
    output,
    outputDigest: stored.outputDigest,
  });
  await observe(input, `tool-settle-${slot}`, {
    kind: "tool_settled",
    outcome: "completed",
    at: new Date().toISOString(),
  });

  return { output, receiptId, outputDigest: stored.outputDigest };
}

async function invokeNative(
  run: ChildRun,
  invocation: TestingNativeInvocation,
  work: () => Promise<unknown>,
): Promise<TestingNativeEnvelope> {
  const slot = await guardNativeCall(run, invocation);
  await observe(run.input, `tool-start-${slot}`, {
    kind: "tool_started",
    toolName: invocation.nativeName,
    route: invocation.route,
    at: new Date().toISOString(),
  });

  try {
    const output = normalizeJson(await track(run.transport, () => work()));

    return await storeNativeReceipt(run, invocation, slot, output);
  } catch (error) {
    await observe(run.input, `tool-fail-${slot}`, {
      kind: "tool_settled",
      outcome: run.signal.aborted ? "cancelled" : "failed",
      at: new Date().toISOString(),
    }).catch(() => undefined);
    throw error;
  }
}

type CaptureRequest<R> = Readonly<{
  reference: R;
  raw: unknown;
  nativeReceipt: TestingNativeReceiptReference;
}>;

async function captureSourceReceipt(
  run: ChildRun,
  capture: CaptureRequest<Source>,
): Promise<SourceCapture> {
  const { input } = run;
  const output = normalizeJson(capture.raw);
  const native = nativeReceiptFor(run.nativeReceipts, capture.nativeReceipt, input, output, [
    "jira_get_issue",
    "confluence_get_page",
  ]);
  const authorized = authorizedSource(
    native.nativeName,
    native.input,
    run.execution.intent.sources,
  );
  const anchors = sourceAnchors(output, 24, native.nativeName);

  if (!authorized || !sameSource(authorized, capture.reference) || anchors.length === 0) {
    throw new Error("Source capture is not linked to the requested source");
  }

  const body: SourceCapture = {
    reference: capture.reference,
    digest: native.outputDigest,
    anchors: [...anchors],
    capturedAt: new Date().toISOString(),
  };
  await appendTrustedReceipt({
    id: `capture-${native.slot}`,
    taskId: input.taskId,
    attemptNonce: input.attemptNonce,
    slot: native.slot,
    nativeName: SOURCE_CAPTURE_NATIVE,
    route: "direct",
    input: { reference: capture.reference },
    output: body,
    bindings: {
      nativeName: native.nativeName,
      nativeOutputDigest: native.outputDigest,
    },
  });

  return body;
}

async function captureDesignReceipt(
  run: ChildRun,
  capture: CaptureRequest<DesignReference>,
): Promise<DesignCaptureResult> {
  const { input } = run;
  const output = normalizeJson(capture.raw);
  const native = nativeReceiptFor(run.nativeReceipts, capture.nativeReceipt, input, output, [
    "get_figma",
  ]);
  const nativeInput = figmaRequestSchema.safeParse(native.input);
  const reference = run.execution.intent.design;

  if (!nativeInput.success || !reference) {
    throw new Error("Figma capture is not linked to a valid request");
  }

  const requestedReference = requestedFigmaTarget(nativeInput.data.target, nativeInput.data.nodeId);

  if (!sameDesign(capture.reference, reference) || !sameDesign(requestedReference, reference)) {
    throw new Error("Figma capture does not match the requested design");
  }

  const properties = designProperties(output, reference, run.requested);
  const body = {
    reference,
    propertiesDigest: digestOf(properties),
    complete: true as const,
    capturedAt: new Date().toISOString(),
  };
  await appendTrustedReceipt({
    id: `design-${native.slot}`,
    taskId: input.taskId,
    attemptNonce: input.attemptNonce,
    slot: native.slot,
    nativeName: DESIGN_CAPTURE_NATIVE,
    route: "direct",
    input: { reference },
    output: body,
    bindings: { nativeName: native.nativeName, nativeOutputDigest: native.outputDigest },
  });

  return { properties, capture: body };
}

function restoredDesignFor(run: ChildRun): DesignCaptureResult | undefined {
  const design = run.execution.intent.design;

  if (run.input.role !== "ui" || !design) {
    return undefined;
  }

  return restoreDesignCapture(run.execution, run.input.taskId, design, run.requested) ?? undefined;
}

function childHost(run: ChildRun): TestingNativeHost {
  const { execution } = run;

  return {
    invoke: (invocation, work) => invokeNative(run, invocation, work),
    captureSource: (capture) => captureSourceReceipt(run, capture),
    captureDesign: (capture) => captureDesignReceipt(run, capture),
    restoredDesign: restoredDesignFor(run),
    browserFixture:
      (run.input.role === "ac" || run.input.role === "ui") && execution.intent.targetUrl
        ? createPlaywrightFixture(
            execution.intent.targetUrl,
            run.input.role,
            run.signal,
            undefined,
            run.input.taskId,
          )
        : undefined,
  };
}

type ProposalReview = {
  proposal: unknown;
  issues: string[];
  failureReason?: "requirements_not_extractable";
};

function reviewProposal(
  input: TestingChildInput,
  conversation: ConversationState,
  name: string,
): Promise<ProposalReview> {
  return DBOS.runStep(
    async (): Promise<ProposalReview> => {
      const latest = await readTestingExecution(input.parentRunId, input.operationId);

      try {
        const proposal = extractJson(assistantText(conversation));

        return input.role === "atlassian"
          ? { proposal, ...requirementsReview(latest, proposal) }
          : { proposal, issues: proposalIssues(input.role, latest, proposal) };
      } catch (error) {
        return {
          proposal: null,
          issues: [error instanceof Error ? error.message : "invalid json"],
        };
      }
    },
    { name },
  );
}

async function runRoleLoops(run: ChildRun, tools: RunTools): Promise<TestingChildResult> {
  const { input, execution, signal } = run;
  const step = { current: "model-0" };
  const checkpoint = childCheckpoint(run.transport, (name) => {
    if (name.includes("model")) {
      step.current = name.replaceAll(":", "-");
    }
  });
  const prompt = roleTaskPrompt(input.role, {
    intent: execution.intent,
    requirements: pinnedRequirements(execution),
    plan: pinnedPlan(execution),
    bounds: execution.runtime.bounds,
  });
  const initial: ConversationState = {
    display: [{ id: "task", role: "user", parts: [{ type: "text", content: prompt }] }],
    context: [{ id: "task", role: "user", parts: [{ type: "text", content: prompt }] }],
  };
  const session = childSession(input, execution, run.transport, signal, () => step.current, tools);
  const loop = (conversation: ConversationState, maxTurn: number, prefix: string) =>
    runAgentLoop({
      session,
      conversation,
      model: roleRegistry[input.role].model,
      prompt: run.systemPrompt,
      compaction: { kind: "bounded", maxTurn },
      checkpoint: prefixed(checkpoint, prefix),
      signal,
    });
  const first = await loop(initial, Math.min(6, execution.runtime.limits.turns), "a");
  const decision = await reviewProposal(input, first.conversation, "proposal");

  if (decision.failureReason) {
    return { state: "failed", reason: decision.failureReason };
  }

  if (decision.issues.length === 0) {
    return { state: "proposed", proposal: decision.proposal };
  }

  const second = await loop(feedbackConversation(first.conversation, decision.issues), 2, "b");
  const again = await reviewProposal(input, second.conversation, "proposal-2");

  if (again.failureReason) {
    return { state: "failed", reason: again.failureReason };
  }

  return again.issues.length === 0
    ? { state: "proposed", proposal: again.proposal }
    : { state: "failed", reason: "proposal_rejected" };
}

async function runClaimedChild(
  input: TestingChildInput,
  transport: Transport,
): Promise<TestingChildResult> {
  const signal = transport.controller.signal;
  const execution = await readTestingExecution(input.parentRunId, input.operationId);
  const deliveries = await readStartCancelDeliveries(input.operationId);

  if (childCancelled(execution, deliveries, input.taskId)) {
    abortTransport(transport);

    return {
      state: "denied",
      reason: execution.cancelRequested ? "cancel_requested" : "terminal",
    };
  }

  const systemPrompt = roleSystemPrompt(input.role, execution.runtime.profiles[input.role]);
  const deadline = armDeadline(execution, transport);
  watchCancellation(input, transport, signal);
  const plan = pinnedPlan(execution);
  const run: ChildRun = {
    input,
    execution,
    transport,
    signal,
    deadline,
    plan,
    requested: styleProperties(plan),
    systemPrompt,
    nativeReceipts: new Map(),
  };

  return withTestingRoleTools(
    {
      role: input.role,
      intent: execution.intent,
      requirements: pinnedRequirements(execution),
      plan,
      host: childHost(run),
    },
    (tools) => runRoleLoops(run, tools),
    signal,
  );
}

function failureReason(error: unknown, signal: AbortSignal): string {
  if (signal.aborted) {
    return "cancelled";
  }

  return error instanceof Error ? error.message : "child_failed";
}

async function executeTestingChild(input: TestingChildInput): Promise<TestingChildResult> {
  const transport = bindTransport(input.childWorkflowId);
  let owned = false;

  try {
    const claimed = await DBOS.runStep(() => claimActualTask(input), { name: "claim" });

    if ("state" in claimed && claimed.state === "denied") {
      owned = OWNED_DENIALS.has(claimed.reason);

      return { state: "denied", reason: claimed.reason };
    }

    owned = true;

    return await runClaimedChild(input, transport);
  } catch (error) {
    return { state: "failed", reason: failureReason(error, transport.controller.signal) };
  } finally {
    await settleTransport(input.childWorkflowId, transport);

    if (owned) {
      await acknowledgeDrain(input);
    }
  }
}

function prefixed(checkpoint: AgentCheckpoint, prefix: string): AgentCheckpoint {
  return (input) => checkpoint({ ...input, name: `${prefix}:${input.name}` });
}

function childCheckpoint(transport: Transport, note: (name: string) => void): AgentCheckpoint {
  return ({ name, retry, shouldRetry, work }) => {
    note(name);
    const guarded = () => work();

    return retry
      ? DBOS.runStep(guarded, {
          name,
          ...retry,
          shouldRetry: () => !transport.controller.signal.aborted && (shouldRetry?.() ?? true),
        })
      : DBOS.runStep(guarded, { name });
  };
}

function childSession(
  input: TestingChildInput,
  execution: TestingExecution,
  transport: Transport,
  signal: AbortSignal,
  step: () => string,
  tools: RunTools,
): AgentSession {
  return {
    runId: input.childWorkflowId,
    assertExecution: async () => {
      const claimed = await claimActualTask(input);

      if ("state" in claimed && claimed.state === "denied") {
        transport.controller.abort();
        throw new Error(claimed.reason);
      }
    },
    emit: async () => undefined,
    chatStream: async (options) => {
      const guard = await guardActualIO({
        taskId: input.taskId,
        parentRunId: input.parentRunId,
        attemptNonce: input.attemptNonce,
        childWorkflowId: input.childWorkflowId,
        kind: "model",
        step: step(),
      });

      if (guard.state === "denied") {
        transport.controller.abort();
        throw new Error(guard.reason);
      }

      await appendTrustedObservation({
        taskId: input.taskId,
        attemptNonce: input.attemptNonce,
        key: `model-start-${guard.slot}`,
        body: { kind: "attempt_started", activity: "model", at: new Date().toISOString() },
      });
      const { deepinfra } = await import("./provider");

      const model = roleRegistry[input.role].model;

      if (execution.runtime.model !== model) {
        throw new Error("Testing role model is incompatible with the common runtime snapshot");
      }

      let release: () => void = () => undefined;
      const done = new Promise<void>((resolve) => {
        release = resolve;
      });
      transport.inflight.add(done);
      let settlement: Promise<void> | null = null;

      const settle = (outcome: "completed" | "failed" | "cancelled") => {
        if (!settlement) {
          settlement = appendTrustedObservation({
            taskId: input.taskId,
            attemptNonce: input.attemptNonce,
            key: `model-settle-${guard.slot}`,
            body: { kind: "attempt_settled", outcome, at: new Date().toISOString() },
          })
            .then(() => undefined)
            .finally(() => {
              release();
              transport.inflight.delete(done);
            });
        }

        return settlement;
      };

      try {
        const stream = await deepinfra(model).chatStream(options);

        return observeStream(stream, settle, signal);
      } catch (error) {
        await settle(signal.aborted ? "cancelled" : "failed").catch(() => undefined);
        throw error;
      }
    },
    tools,
  };
}

function nextWithAbort(
  iterator: AsyncIterator<AdapterYieldChunk>,
  signal: AbortSignal,
): Readonly<{
  pending: Promise<IteratorResult<AdapterYieldChunk>>;
  result: Promise<IteratorResult<AdapterYieldChunk>>;
}> {
  const pending = Promise.resolve().then(() => iterator.next());
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });

    if (signal.aborted) {
      onAbort();
    }
  });

  return {
    pending,
    result: Promise.race([pending, aborted]).finally(() => {
      signal.removeEventListener("abort", onAbort);
    }),
  };
}

async function returnIterator(
  iterator: AsyncIterator<AdapterYieldChunk>,
): Promise<IteratorResult<AdapterYieldChunk> | void> {
  if (!iterator.return) {
    return undefined;
  }

  try {
    return await iterator.return();
  } catch {
    return undefined;
  }
}

async function pendingStops(pending: Promise<IteratorResult<AdapterYieldChunk>>): Promise<boolean> {
  try {
    return Boolean((await pending).done);
  } catch {
    return true;
  }
}

async function drainIterator(iterator: AsyncIterator<AdapterYieldChunk>): Promise<void> {
  for (;;) {
    try {
      if ((await iterator.next()).done) {
        return;
      }
    } catch {
      return;
    }
  }
}

async function closeProviderIterator(
  iterator: AsyncIterator<AdapterYieldChunk>,
  pending: Promise<IteratorResult<AdapterYieldChunk>> | null,
): Promise<void> {
  const returned = await returnIterator(iterator);
  const stopped = pending ? await pendingStops(pending) : Boolean(returned?.done);

  if (!stopped) {
    await drainIterator(iterator);
  }
}

export async function* observeStream(
  stream: AsyncIterable<AdapterYieldChunk>,
  settle: (outcome: "completed" | "failed" | "cancelled") => Promise<void>,
  signal: AbortSignal,
): AsyncGenerator<AdapterYieldChunk> {
  const iterator = stream[Symbol.asyncIterator]();
  let providerFinished = false;
  let settled = false;
  let pending: Promise<IteratorResult<AdapterYieldChunk>> | null = null;
  let outcome: "completed" | "failed" | "cancelled" = "failed";

  const settleOnce = async (value: "completed" | "failed" | "cancelled") => {
    if (settled) {
      return;
    }

    settled = true;
    await settle(value);
  };

  try {
    for (;;) {
      const next = nextWithAbort(iterator, signal);
      pending = next.pending;
      const result = await next.result;
      pending = null;

      if (result.done) {
        providerFinished = true;
        outcome = signal.aborted ? "cancelled" : "completed";
        await settleOnce(outcome);

        return;
      }

      yield result.value;
    }
  } catch (error) {
    outcome = signal.aborted ? "cancelled" : "failed";
    throw error;
  } finally {
    if (!providerFinished) {
      await closeProviderIterator(iterator, pending);
      providerFinished = true;
    }

    if (!settled) {
      await settleOnce(outcome).catch(() => undefined);
    }
  }
}

export const testingChildWorkflow = DBOS.registerWorkflow(executeTestingChild, {
  name: TESTING_WORKFLOW_VERSION,
});
