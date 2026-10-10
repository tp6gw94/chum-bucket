import { setTimeout as delay } from "node:timers/promises";
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
  validateRequirements,
  validateResults,
  type CanonicalPlan,
  type Requirements,
  type SourceCapture,
} from "./testing-domain";
import {
  requestedFigmaTarget,
  withTestingRoleTools,
  type DesignCaptureResult,
  type TestingNativeHost,
  type TestingNativeReceiptReference,
} from "./testing-tools";
import { runAgentLoop, type AgentCheckpoint, type AgentSession } from "./agent-loop";
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
import type { MockBrowserOutcome } from "./tools/use-browser";
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

function refuse(transport: Transport): void {
  if (transport.aborted || transport.closed || transport.controller.signal.aborted) {
    transport.aborted = true;
    throw new Error("Testing transport refuses new effects");
  }
}

export function testingTransportQuiet(workflowId: string): Promise<boolean> {
  const transport = transports.get(workflowId);
  if (!transport) {
    return Promise.resolve(false);
  }
  transport.aborted = true;
  transport.controller.abort();
  return transport.quiet.then(() => transport.closed);
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

export function sourceAnchors(raw: unknown, limit = 24): readonly string[] {
  const found: string[] = [];
  const visit = (value: unknown) => {
    if (found.length >= limit) {
      return;
    }
    if (typeof value === "string") {
      const text = value.trim();
      if (text.length > 0 && text.length <= 512) {
        found.push(text);
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
  return [...new Set(found)];
}

function authorizedSource(
  nativeName: string,
  input: unknown,
  sources: readonly Source[],
): Source | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  if (nativeName === "jira_get_issue" && typeof record.issue_key === "string") {
    return (
      sources.find((source) => source.kind === "jira" && source.issueKey === record.issue_key) ??
      null
    );
  }
  if (nativeName === "confluence_get_page" && typeof record.page_id === "string") {
    return (
      sources.find((source) => source.kind === "confluence" && source.pageId === record.page_id) ??
      null
    );
  }
  return null;
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

function cssProperty(node: Record<string, unknown>, property: string): string | null {
  if (property === "width" || property === "height") {
    const box = node.absoluteBoundingBox;
    if (box && typeof box === "object" && !Array.isArray(box)) {
      const size = (box as Record<string, unknown>)[property];
      if (typeof size === "number" && Number.isFinite(size)) {
        return `${size}px`;
      }
    }
  }
  if (property === "opacity" && typeof node.opacity === "number" && Number.isFinite(node.opacity)) {
    return String(node.opacity);
  }
  if (property === "backgroundColor" || property === "color") {
    return colorString(node.fills);
  }
  const direct = node[property];
  if (typeof direct === "number" && Number.isFinite(direct)) {
    return `${direct}px`;
  }
  return null;
}

export function hostBrowserOutcomes(
  checks: readonly PlanCheck[],
): Readonly<Record<string, MockBrowserOutcome>> {
  const outcomes: Record<string, MockBrowserOutcome> = {};
  for (const check of checks) {
    const bucket = Number.parseInt(digestOf(check.id).slice(0, 2), 16) % 3;
    if (bucket === 0) {
      outcomes[check.id] = { state: "blocked", reason: "Host fixture blocked this check" };
      continue;
    }
    outcomes[check.id] =
      check.kind === "functional"
        ? { state: "observed", observed: "host-fixture-observed" }
        : { state: "observed", observed: bucket === 1 ? "16px" : "1px" };
  }
  return outcomes;
}

function pinnedRequirements(execution: TestingExecution): Requirements | null {
  const artifact = execution.artifacts.find((item) => item.kind === "requirements");
  return artifact ? (artifact.payload as Requirements) : null;
}

function pinnedPlan(execution: TestingExecution): CanonicalPlan | null {
  const artifact = execution.artifacts.find((item) => item.kind === "plan");
  return artifact ? (artifact.payload as CanonicalPlan) : null;
}

function taskText(role: RoleId, execution: TestingExecution): string {
  const plan = pinnedPlan(execution);
  const checks =
    plan?.cases.flatMap((planCase) =>
      planCase.checks.map((check) => ({ id: check.id, caseId: planCase.id, kind: check.kind })),
    ) ?? [];
  return [
    `testing-role:${role}`,
    "testing-task:",
    JSON.stringify({
      goal: execution.intent.goal,
      sources: execution.intent.sources,
      criteria: execution.intent.criteria,
      requirements: pinnedRequirements(execution),
      targetUrl: execution.intent.targetUrl,
      design: execution.intent.design ?? null,
      checks,
    }),
    "Return one JSON object and no prose. Atlassian criteria use anchors copied from tool results. Planner returns cases. AC and UI return checks citing receiptId and outputDigest from use_browser. Do not invent receipt ids.",
  ].join("\n");
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

function proposalIssues(role: RoleId, execution: TestingExecution, proposal: unknown): string[] {
  if (role === "atlassian") {
    const captures =
      execution.tasks
        .find((task) => task.frame.role === "atlassian")
        ?.receipts.filter((receipt) => receipt.nativeName === SOURCE_CAPTURE_NATIVE)
        .map((receipt) => receipt.output as SourceCapture) ?? [];
    const validation = validateRequirements(proposal, {
      goal: execution.intent.goal,
      selection: execution.intent.criteria,
      captures,
    });
    return validation.kind === "rejected" ? [...validation.issues] : [];
  }
  const requirements = pinnedRequirements(execution);
  if (!requirements) {
    return ["requirements_missing"];
  }
  if (role === "planner") {
    const validation = canonicalizePlan(proposal, {
      requirements,
      requirementsDigest: digestOf(requirements),
      goal: execution.intent.goal,
      targetUrl: execution.intent.targetUrl,
      design: execution.intent.design ?? null,
      bounds: execution.runtime.bounds,
    });
    return validation.kind === "rejected" ? [...validation.issues] : [];
  }
  const plan = pinnedPlan(execution);

  if (!plan) {
    return ["plan_missing"];
  }

  const browserRole: "ac" | "ui" = role === "ac" ? "ac" : "ui";
  const checks = checksForRole(plan.cases, browserRole);
  const task = execution.tasks.find((item) => item.frame.role === role);
  const receipts = (task?.receipts ?? []).flatMap((receipt) => {
    if (
      receipt.nativeName !== "use_browser" ||
      !receipt.bindings ||
      typeof receipt.bindings !== "object"
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
        role: browserRole,
        checkId: output.checkId ?? "",
        inputDigest: receipt.inputDigest,
        outputDigest: receipt.outputDigest,
        output: receipt.output,
        fixture: bindings.fixture,
      },
    ];
  });
  const validation = validateResults(proposal, {
    role: browserRole,
    cases: plan.cases,
    checks,
    receipts,
  });
  return validation.kind === "rejected" ? [...validation.issues] : [];
}

function feedbackConversation(
  conversation: ConversationState,
  issues: readonly string[],
): ConversationState {
  const message: UIMessage = {
    id: `feedback-${conversation.context.length}`,
    role: "user",
    parts: [{ type: "text", content: `Private validation failed: ${issues.join("; ")}` }],
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
  const captures = task.receipts
    .filter((receipt) => receipt.nativeName === DESIGN_CAPTURE_NATIVE)
    .toReversed();
  const captureReceipt = captures[0];
  if (!captureReceipt) {
    return null;
  }
  const binding = designReceiptBindingSchema.safeParse(captureReceipt.bindings);
  const capture = designCaptureSchema.safeParse(captureReceipt.output);
  if (
    !binding.success ||
    !capture.success ||
    captureReceipt.taskId !== taskId ||
    captureReceipt.attemptNonce !== task.frame.attemptNonce ||
    captureReceipt.route !== "direct" ||
    captureReceipt.outputDigest !== digestOf(captureReceipt.output) ||
    capture.data.reference.fileKey !== design.fileKey ||
    capture.data.reference.nodeId !== design.nodeId
  ) {
    throw new Error("Stored design capture failed host recovery validation");
  }
  const native = task.receipts.find(
    (receipt) =>
      receipt.taskId === taskId &&
      receipt.attemptNonce === task.frame.attemptNonce &&
      receipt.slot === captureReceipt.slot &&
      receipt.nativeName === binding.data.nativeName &&
      receipt.outputDigest === binding.data.nativeOutputDigest,
  );
  if (!native || native.outputDigest !== digestOf(native.output)) {
    throw new Error("Stored design capture has no matching native response");
  }
  const input = z
    .object({ target: z.string(), nodeId: z.string().optional() })
    .passthrough()
    .safeParse(native.input);
  if (!input.success) {
    throw new Error("Stored Figma request input is invalid");
  }
  const requestedReference = requestedFigmaTarget(input.data.target, input.data.nodeId);
  if (
    requestedReference.fileKey !== design.fileKey ||
    requestedReference.nodeId !== design.nodeId
  ) {
    throw new Error("Stored Figma request does not match the requested design");
  }
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
  const kind = role === "ac" ? "functional" : role === "ui" ? "style" : null;
  const match = plan?.cases
    .flatMap((planCase) => planCase.checks.map((check) => ({ planCase, check })))
    .find(({ check }) => check.id === parsed.data.checkId);
  if (
    !kind ||
    !match ||
    match.check.kind !== kind ||
    parsed.data.evidence.kind !== kind ||
    parsed.data.evidence.caseId !== match.planCase.id ||
    parsed.data.evidence.checkId !== match.check.id ||
    parsed.data.evidence.fixture.id !== execution.runtime.fixture.id ||
    parsed.data.evidence.fixture.version !== execution.runtime.fixture.version ||
    parsed.data.evidence.adapterVersion !== execution.runtime.versions.adapter
  ) {
    throw new Error("Browser output is outside the canonical host scope");
  }
  return {
    fixture: execution.runtime.fixture,
    adapterVersion: execution.runtime.versions.adapter,
    checkId: match.check.id,
  };
}

async function acknowledgeDrain(input: TestingChildInput): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const deliveries = await readStartCancelDeliveries(input.operationId);
    const start = deliveries.find(
      (delivery) => delivery.taskId === input.taskId && delivery.kind === "start",
    );
    const cancel = deliveries.find(
      (delivery) => delivery.taskId === input.taskId && delivery.kind === "cancel",
    );
    if (cancel?.acknowledgement === null) {
      await ackDelivery(cancel.key, "cancel_requested").catch(() => undefined);
    } else if (cancel?.acknowledgement === "cancel_requested") {
      await ackDelivery(cancel.key, "stopped").catch(() => undefined);
    }
    if ((!cancel || cancel.acknowledgement === "stopped") && start?.acknowledgement === null) {
      await ackDelivery(start.key, "quiet").catch(() => undefined);
    }
    const again = await readStartCancelDeliveries(input.operationId);
    const startDone = again.find(
      (delivery) => delivery.taskId === input.taskId && delivery.kind === "start",
    );
    const cancelDone = again.find(
      (delivery) => delivery.taskId === input.taskId && delivery.kind === "cancel",
    );
    if (
      startDone?.acknowledgement === "quiet" &&
      (!cancelDone || cancelDone.acknowledgement === "stopped")
    ) {
      return;
    }
    await delay(50);
  }
}

async function executeTestingChild(input: TestingChildInput): Promise<TestingChildResult> {
  const transport = bindTransport(input.childWorkflowId);
  const signal = transport.controller.signal;
  let pendingModelStep = "model-0";
  let owned = false;
  try {
    const claimed = await DBOS.runStep(() => claimActualTask(input), { name: "claim" });
    if ("state" in claimed && claimed.state === "denied") {
      owned =
        claimed.reason === "cancel_requested" ||
        claimed.reason === "deadline" ||
        claimed.reason === "terminal";
      return { state: "denied", reason: claimed.reason };
    }
    owned = true;
    const execution = await readTestingExecution(input.parentRunId, input.operationId);
    const deliveries = await readStartCancelDeliveries(input.operationId);
    if (
      execution.cancelRequested ||
      execution.finished ||
      deliveries.some((delivery) => delivery.taskId === input.taskId && delivery.kind === "cancel")
    ) {
      transport.aborted = true;
      transport.controller.abort();
      return {
        state: "denied",
        reason: execution.cancelRequested ? "cancel_requested" : "terminal",
      };
    }
    const deadline = AbortSignal.timeout(Math.max(0, Date.parse(execution.deadline) - Date.now()));
    const onDeadline = () => {
      transport.aborted = true;
      transport.controller.abort();
    };
    deadline.addEventListener("abort", onDeadline, { once: true });
    void track(transport, async () => {
      while (!transport.aborted && !signal.aborted) {
        const again = await readStartCancelDeliveries(input.operationId).catch(() => []);
        const cancel = again.find(
          (delivery) => delivery.taskId === input.taskId && delivery.kind === "cancel",
        );
        const claimedAgain = await claimActualTask(input).catch(() => ({
          state: "denied" as const,
          reason: "scope" as const,
        }));
        if (cancel || "state" in claimedAgain) {
          transport.aborted = true;
          transport.controller.abort();
          if (cancel?.acknowledgement === null) {
            await ackDelivery(cancel.key, "cancel_requested").catch(() => undefined);
          }
          return;
        }
        await delay(200, undefined, { signal }).catch(() => undefined);
      }
    }).catch(() => undefined);
    const requirements = pinnedRequirements(execution);
    const plan = pinnedPlan(execution);
    const requested = [
      ...new Set(
        plan?.cases.flatMap((planCase) =>
          planCase.checks.flatMap((check) => (check.kind === "style" ? [check.property] : [])),
        ) ?? [],
      ),
    ];
    const nativeReceipts = new Map<string, NativeInvocationReceipt>();
    const restoredDesign =
      input.role === "ui" && execution.intent.design
        ? (restoreDesignCapture(execution, input.taskId, execution.intent.design, requested) ??
          undefined)
        : undefined;
    const host: TestingNativeHost = {
      async invoke(invocation, work) {
        refuse(transport);
        const guard = await guardActualIO({
          taskId: input.taskId,
          parentRunId: input.parentRunId,
          attemptNonce: input.attemptNonce,
          childWorkflowId: input.childWorkflowId,
          kind: invocation.route === "codemode" ? "nested" : "tool",
        });
        if (guard.state !== "allowed") {
          transport.aborted = true;
          transport.controller.abort();
          throw new Error(guard.reason);
        }
        if (transport.aborted || signal.aborted) {
          await appendTrustedObservation({
            taskId: input.taskId,
            attemptNonce: input.attemptNonce,
            key: `tool-abort-${guard.slot}`,
            body: {
              kind: "tool_settled",
              outcome: "cancelled",
              at: new Date().toISOString(),
            },
          }).catch(() => undefined);
          throw new Error("Testing transport refuses new effects");
        }
        const at = new Date().toISOString();
        await appendTrustedObservation({
          taskId: input.taskId,
          attemptNonce: input.attemptNonce,
          key: `tool-start-${guard.slot}`,
          body: {
            kind: "tool_started",
            toolName: invocation.nativeName,
            route: invocation.route,
            at,
          },
        });
        try {
          const output = normalizeJson(await track(transport, () => work()));
          const nativeInput = normalizeJson(invocation.input);
          const receiptId = `native-${guard.slot}-${invocation.nativeName}`;
          const bindings =
            invocation.nativeName === "use_browser"
              ? browserReceiptBindings(output, input.role, plan, execution)
              : {};
          const stored = await appendTrustedReceipt({
            id: receiptId,
            taskId: input.taskId,
            attemptNonce: input.attemptNonce,
            slot: guard.slot,
            nativeName: invocation.nativeName,
            route: invocation.route,
            input: nativeInput,
            output,
            bindings,
          });
          if (stored.outputDigest !== digestOf(output)) {
            throw new Error("Receipt digest drift");
          }
          nativeReceipts.set(receiptId, {
            taskId: input.taskId,
            attemptNonce: input.attemptNonce,
            slot: guard.slot,
            nativeName: invocation.nativeName,
            input: nativeInput,
            output,
            outputDigest: stored.outputDigest,
          });
          await appendTrustedObservation({
            taskId: input.taskId,
            attemptNonce: input.attemptNonce,
            key: `tool-settle-${guard.slot}`,
            body: { kind: "tool_settled", outcome: "completed", at: new Date().toISOString() },
          });
          return { output, receiptId, outputDigest: stored.outputDigest };
        } catch (error) {
          await appendTrustedObservation({
            taskId: input.taskId,
            attemptNonce: input.attemptNonce,
            key: `tool-fail-${guard.slot}`,
            body: {
              kind: "tool_settled",
              outcome: signal.aborted ? "cancelled" : "failed",
              at: new Date().toISOString(),
            },
          }).catch(() => undefined);
          throw error;
        }
      },
      async captureSource(capture) {
        const output = normalizeJson(capture.raw);
        const native = nativeReceiptFor(nativeReceipts, capture.nativeReceipt, input, output, [
          "jira_get_issue",
          "confluence_get_page",
        ]);
        const authorized = authorizedSource(
          native.nativeName,
          native.input,
          execution.intent.sources,
        );
        const matches =
          authorized?.kind === "jira" &&
          capture.reference.kind === "jira" &&
          authorized.issueKey === capture.reference.issueKey
            ? true
            : authorized?.kind === "confluence" &&
              capture.reference.kind === "confluence" &&
              authorized.pageId === capture.reference.pageId;
        const anchors = sourceAnchors(output);
        if (!matches || anchors.length === 0) {
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
      },
      async captureDesign(capture) {
        const output = normalizeJson(capture.raw);
        const native = nativeReceiptFor(nativeReceipts, capture.nativeReceipt, input, output, [
          "get_figma",
        ]);
        const nativeInput = z
          .object({ target: z.string(), nodeId: z.string().optional() })
          .passthrough()
          .safeParse(native.input);
        const reference = execution.intent.design;
        if (!nativeInput.success || !reference) {
          throw new Error("Figma capture is not linked to a valid request");
        }
        const requestedReference = requestedFigmaTarget(
          nativeInput.data.target,
          nativeInput.data.nodeId,
        );
        if (
          capture.reference.fileKey !== reference.fileKey ||
          capture.reference.nodeId !== reference.nodeId ||
          requestedReference.fileKey !== reference.fileKey ||
          requestedReference.nodeId !== reference.nodeId
        ) {
          throw new Error("Figma capture does not match the requested design");
        }
        const properties = designProperties(output, reference, requested);
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
      },
      restoredDesign,
      browserFixture: plan
        ? {
            identity: execution.runtime.fixture,
            adapterVersion: execution.runtime.versions.adapter,
            outcomes: hostBrowserOutcomes(plan.cases.flatMap((planCase) => planCase.checks)),
          }
        : undefined,
    };
    const checkpoint = childCheckpoint(transport, (name) => {
      if (name.includes("model")) {
        pendingModelStep = name.replaceAll(":", "-");
      }
    });
    const prompt = taskText(input.role, execution);
    const initial: ConversationState = {
      display: [{ id: "task", role: "user", parts: [{ type: "text", content: prompt }] }],
      context: [{ id: "task", role: "user", parts: [{ type: "text", content: prompt }] }],
    };
    return await withTestingRoleTools(
      {
        role: input.role,
        intent: execution.intent,
        requirements,
        plan,
        host,
      },
      async (tools) => {
        const session = childSession(
          input,
          execution,
          transport,
          signal,
          () => pendingModelStep,
          tools,
        );
        const first = await runAgentLoop({
          session,
          conversation: initial,
          model: execution.runtime.model,
          prompt,
          compaction: { kind: "bounded", maxTurn: Math.min(6, execution.runtime.limits.turns) },
          checkpoint: prefixed(checkpoint, "a"),
          signal,
        });
        const decision = await DBOS.runStep(
          async () => {
            const latest = await readTestingExecution(input.parentRunId, input.operationId);
            try {
              const proposal = extractJson(assistantText(first.conversation));
              return { proposal, issues: proposalIssues(input.role, latest, proposal) };
            } catch (error) {
              return {
                proposal: null,
                issues: [error instanceof Error ? error.message : "invalid json"],
              };
            }
          },
          { name: "proposal" },
        );
        if (decision.issues.length === 0) {
          return { state: "proposed", proposal: decision.proposal } satisfies TestingChildResult;
        }
        const second = await runAgentLoop({
          session,
          conversation: feedbackConversation(first.conversation, decision.issues),
          model: execution.runtime.model,
          prompt,
          compaction: { kind: "bounded", maxTurn: 2 },
          checkpoint: prefixed(checkpoint, "b"),
          signal,
        });
        const again = await DBOS.runStep(
          async () => {
            const latest = await readTestingExecution(input.parentRunId, input.operationId);
            try {
              const proposal = extractJson(assistantText(second.conversation));
              return { proposal, issues: proposalIssues(input.role, latest, proposal) };
            } catch (error) {
              return {
                proposal: null,
                issues: [error instanceof Error ? error.message : "invalid json"],
              };
            }
          },
          { name: "proposal-2" },
        );
        return again.issues.length === 0
          ? { state: "proposed" as const, proposal: again.proposal }
          : { state: "failed" as const, reason: "proposal_rejected" };
      },
      signal,
    );
  } catch (error) {
    const reason = signal.aborted
      ? "cancelled"
      : error instanceof Error
        ? error.message
        : "child_failed";
    return { state: "failed", reason };
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
      const { MODEL } = await import("./run-store");
      if (execution.runtime.model !== MODEL) {
        throw new Error("Testing runtime model is not the host resolver");
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
        const stream = await deepinfra(MODEL).chatStream(options);
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

async function closeProviderIterator(
  iterator: AsyncIterator<AdapterYieldChunk>,
  pending: Promise<IteratorResult<AdapterYieldChunk>> | null,
): Promise<void> {
  let returned: IteratorResult<AdapterYieldChunk> | void = undefined;
  if (iterator.return) {
    try {
      returned = await iterator.return();
    } catch {
      returned = undefined;
    }
  }
  if (pending) {
    try {
      const result = await pending;
      if (result.done) {
        return;
      }
    } catch {
      return;
    }
  }
  if (!pending && returned?.done) {
    return;
  }
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
