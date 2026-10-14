import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { mock } from "node:test";
import { scriptedEvents } from "./testing-runtime-external-fixture.mjs";

export const findings = {
  ac: "AC-1 checks the owned application chooser heading. The expected text is 選擇對話. Consult the host browser receipt for the observed text and execution status; this prose is not tool evidence. Missing browser evidence prevents a pass. Both checks now have their own bound receipts. Assembling the corrected final output.",
  ui: "The host captured the fixture Figma design for Checkout, including its width. The browser check measures the owned application chooser heading. Consult the host receipt for the actual width and comparison. These intentionally different synthetic resources do not prove design conformance. Missing browser evidence prevents a pass.",
  status: "Both checks now have their own bound receipts. Assembling the corrected final output.",
};

export const firstFindings =
  "FIRST_FINDINGS: the AC-1 chooser heading check ran once. Consult the host browser receipt for the observed text. This prose is not tool evidence.";
export const secondReplies = { "answer-once": "", "answer-once-see-above": "See above." };
export const overflowMessage =
  "400 This model's maximum context length is 131072 tokens. However, your messages resulted in 148211 tokens. Please reduce the length of the messages.";

function overflowEvents(identity, model) {
  const detail = {
    message: overflowMessage,
    type: "invalid_request_error",
    param: "messages",
    code: "context_length_exceeded",
  };
  return [
    identity,
    {
      type: "RUN_ERROR",
      runId: identity.runId,
      threadId: identity.threadId,
      model,
      timestamp: Date.now(),
      message: overflowMessage,
      code: detail.code,
      rawEvent: detail,
      error: { message: overflowMessage, code: detail.code },
    },
  ];
}

if (process.argv.some((arg) => /server\/index\.ts$/.test(arg))) {
  await import("./delegation-runtime-preload.mjs");
  const record = (value) =>
    appendFileSync(
      `${process.env.DELEGATION_EVIDENCE}/qa-fixture.jsonl`,
      `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, notLiveProvider: true, ...value })}\n`,
    );
  const { deepinfra } = await import("../../server/harness/provider.ts");
  const adapter = deepinfra("deepseek-ai/DeepSeek-V4.1-Flash");
  const textOf = (message) =>
    typeof message.content === "string"
      ? message.content
      : (message.content ?? []).map((part) => part.text ?? "").join("");
  mock.method(Object.getPrototypeOf(adapter), "chatStream", async function* (options) {
    const messages = options.messages ?? [];
    const users = messages.filter((message) => message.role === "user").map(textOf);
    const role =
      users.find((text) => text.startsWith("testing-role:"))?.match(/testing-role:([a-z]+)/)?.[1] ??
      "main";
    const last = users.at(-1) ?? "";
    const intent =
      role === "main" && last.startsWith("fixture ") ? JSON.parse(last.slice(8)) : undefined;
    if (role === "main")
      record({
        boundary: "main-tool-input",
        outputs: messages.filter((message) => message.role === "tool").map(textOf),
      });
    let events = scriptedEvents(options, { intent, ordinary: role === "main" && !intent });
    const scenario = process.env.QA_REPORT_SCENARIO ?? "prose";
    const designatedFinal = (options.systemPrompts ?? []).some((prompt) =>
      prompt.includes("designated public findings turn"),
    );
    if (role === "planner") {
      events = events.map((event) => {
        if (event.type !== "TEXT_MESSAGE_CONTENT") return event;
        const plan = JSON.parse(event.delta);
        for (const planCase of plan.cases) {
          planCase.actions = [{ kind: "navigate", path: "/" }];
          for (const check of planCase.checks) {
            if (check.kind === "functional") {
              check.expectedObservation = "選擇對話";
              check.observation.target = "選擇對話";
            } else check.target = "選擇對話";
          }
        }
        if (scenario === "partial") {
          const first = plan.cases[0].checks.find((check) => check.kind === "functional");
          plan.cases[0].checks.push({ ...first, id: "partial-missing-check" });
        }
        return { ...event, delta: JSON.stringify(plan) };
      });
    }
    const hasObservation = messages.some(
      (message) => message.role === "tool" && textOf(message).includes("receiptId"),
    );
    const pauseMarker = `${process.env.DELEGATION_EVIDENCE}/qa-model-pause-entered`;
    if (
      role === "ac" &&
      hasObservation &&
      process.env.QA_REPORT_PAUSE_MS &&
      !existsSync(pauseMarker)
    ) {
      writeFileSync(pauseMarker, String(process.pid));
      record({ boundary: "qa-model-paused", role });
      await delay(Number(process.env.QA_REPORT_PAUSE_MS), undefined, {
        signal: options.request?.signal,
      });
    }
    const acObserved = role === "ac" && hasObservation;
    const answerOnce = acObserved && Object.hasOwn(secondReplies, scenario);
    const answeredOnce = messages.some(
      (message) => message.role === "assistant" && textOf(message).includes(firstFindings),
    );
    let outcome = "scripted";
    if (acObserved && scenario === "overflow") {
      events = overflowEvents(events[0], options.model);
      outcome = "run-error-context-length-exceeded";
    } else if (
      (role === "ac" || role === "ui") &&
      (designatedFinal ||
        answerOnce ||
        scenario === "missing" ||
        scenario === "absent" ||
        (scenario === "partial" && hasObservation) ||
        !events.some((event) => event.type === "TOOL_CALL_START"))
    ) {
      const text = answerOnce
        ? answeredOnce
          ? secondReplies[scenario]
          : firstFindings
        : scenario === "absent"
          ? ""
          : scenario === "status-only"
            ? findings.status
            : findings[role];
      events = scriptedEvents(options, { ordinary: true }).filter(
        (event) => !event.type.startsWith("TOOL_CALL"),
      );
      const identity = events[0];
      const messageId = `${identity.runId}-prose`;
      events = [
        identity,
        { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId, delta: text },
        { type: "TEXT_MESSAGE_END", messageId },
        events.at(-1),
      ];
      record({ boundary: "qa-prose", role, text, designatedFinal, answeredOnce });
      outcome = "prose";
    }
    record({
      boundary: "model",
      role,
      scenario,
      designatedFinal,
      hasObservation,
      outcome,
      messageRoles: messages.map((message) => message.role),
      tools: events
        .filter((event) => event.type === "TOOL_CALL_START")
        .map((event) => event.toolCallName),
    });
    for (const event of events) yield event;
  });
  record({
    boundary: "installed",
    argv: process.argv,
    nodeOptions: process.env.NODE_OPTIONS,
    network: "loopback-and-fixture-only",
    browserChecks: "normal-production-executor-on-owned-loopback-only",
    credentials: "fake-only",
  });
}
