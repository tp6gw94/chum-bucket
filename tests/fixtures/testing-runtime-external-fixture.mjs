import { createHash } from "node:crypto";

const HOST_OBSERVED = "host-fixture-observed";
const HISTORY_ID_KEYS = new Set([
  "id",
  "messageid",
  "parentmessageid",
  "toolcallid",
  "tool_call_id",
  "threadid",
  "runid",
  "entityid",
]);

function leaves(value, limit = 24) {
  const found = [];

  const visit = (item) => {
    if (found.length >= limit) {
      return;
    }

    if (typeof item === "string") {
      const text = item.trim();

      if (text.length > 0 && text.length <= 512) {
        found.push(text);
      }

      return;
    }

    if (Array.isArray(item)) {
      item.forEach(visit);

      return;
    }

    if (item && typeof item === "object") {
      for (const key of Object.keys(item).sort()) {
        visit(item[key]);
      }
    }
  };

  visit(value);

  return [...new Set(found)];
}

function textOf(message) {
  if (!message) {
    return "";
  }

  if (typeof message.content === "string") {
    return message.content;
  }

  if (Array.isArray(message.content)) {
    return message.content.map((part) => part.text ?? part.content ?? "").join("");
  }

  return "";
}

function parseTask(prompts) {
  const text = prompts.join("\n");
  const role = text.match(/testing-role:([a-z]+)/)?.[1] ?? "main";
  const raw = text.split("testing-task:\n")[1]?.split("\n")[0];
  let task = {};

  try {
    task = raw ? JSON.parse(raw) : {};
  } catch {
    task = {};
  }

  return { role, task, text };
}

function eventIdentity(options, role) {
  const messages = options.messages ?? [];
  const used = new Set();

  const collect = (value) => {
    if (Array.isArray(value)) {
      value.forEach(collect);

      return;
    }

    if (!value || typeof value !== "object") {
      return;
    }

    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string" && HISTORY_ID_KEYS.has(key.toLowerCase())) {
        used.add(item);
      }

      collect(item);
    }
  };

  collect(messages);
  const historyDigest = createHash("sha256")
    .update(JSON.stringify(messages))
    .digest("hex")
    .slice(0, 16);
  const prefix = `provider-${role}-${historyDigest}`;
  let sequence = 0;

  const next = (kind) => {
    let candidate = `${prefix}-${kind}-${sequence++}`;

    while (used.has(candidate)) {
      candidate = `${prefix}-${kind}-${sequence++}`;
    }

    used.add(candidate);

    return candidate;
  };

  return {
    threadId: next("thread"),
    runId: next("run"),
    messageId: next("message"),
    toolCallId: next("tool"),
  };
}

function parseJson(content) {
  try {
    return JSON.parse(content);
  } catch {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");

    if (start < 0 || end <= start) {
      return null;
    }

    try {
      return JSON.parse(content.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

export function scriptedEvents(options, control = {}) {
  const { role, task } = parseTask(options.systemPrompts ?? []);
  const messages = options.messages ?? [];
  const toolOutputs = (messages ?? []).filter((message) => message.role === "tool");
  const identity = eventIdentity(options, role);

  if (role === "main") {
    if (toolOutputs.length === 0) {
      return toolEvents(identity, "run_tests", control.intent);
    }

    return textEvents(identity, "測試已提交。");
  }

  if (role === "atlassian") {
    if (toolOutputs.length === 0) {
      return toolEvents(identity, "discover_atlassian_tools", {
        toolNames: ["jira_get_issue"],
      });
    }

    if (toolOutputs.length === 1) {
      return toolEvents(identity, "jira_get_issue", {
        issue_key: task.sources?.[0]?.issueKey,
      });
    }

    const sourceOutput = [...toolOutputs].reverse()[0];
    const sourceResponse = sourceOutput
      ? (parseJson(textOf(sourceOutput)) ?? textOf(sourceOutput))
      : null;
    const capturedOutput =
      sourceResponse && typeof sourceResponse === "object" && "output" in sourceResponse
        ? sourceResponse.output
        : sourceResponse;
    const anchor = leaves(capturedOutput)[0];

    return textEvents(
      identity,
      JSON.stringify({
        criteria: [
          {
            key: "AC-1",
            statement: "Checkout succeeds",
            source: task.sources[0],
            anchor,
          },
        ],
        unresolved: [],
      }),
    );
  }

  if (role === "planner") {
    const checks = [
      {
        id: "check-1",
        criterionId: task.requirements?.criteria?.[0]?.id ?? "crit:missing",
        kind: "functional",
        expectedObservation: "UNIQUE-EXPECTED",
      },
    ];

    if (task.design) {
      checks.push({
        id: "style-1",
        criterionId: "crit:AC-1",
        kind: "style",
        design: task.design,
        property: "width",
        tolerance: { kind: "exact" },
      });
    }

    return textEvents(
      identity,
      JSON.stringify({
        cases: [
          {
            id: "case-1",
            title: "Checkout",
            preconditions: [],
            actions: [{ kind: "navigate", path: "/checkout" }],
            checks,
          },
        ],
      }),
    );
  }

  if (role === "ui" && control.failUi) {
    return textEvents(identity, "not json");
  }

  if (role === "ui" && toolOutputs.length === 0) {
    return toolEvents(identity, "get_figma", {
      target: task.design.fileKey,
      nodeId: task.design.nodeId,
    });
  }

  const checks = (task.checks ?? []).filter((check) =>
    role === "ac" ? check.kind === "functional" : check.kind === "style",
  );
  const browserOutputs = toolOutputs.slice(role === "ui" ? 1 : 0);

  if (browserOutputs.length < checks.length) {
    const pending = checks[browserOutputs.length];

    return toolEvents(identity, "use_browser", { checkId: pending.id });
  }

  const evidence = browserOutputs.flatMap((message) => {
    const parsed = parseJson(textOf(message));

    if (!parsed?.checkId || !parsed.receiptId) {
      return [];
    }

    const judgment =
      parsed.evidence?.outcome === "pass" || parsed.evidence?.outcome === "inside_tolerance"
        ? "simulated_pass"
        : parsed.evidence?.outcome === "fail" || parsed.evidence?.outcome === "outside_tolerance"
          ? "simulated_fail"
          : "simulated_blocked";

    return [
      {
        caseId: checks.find((check) => check.id === parsed.checkId)?.caseId,
        checkId: parsed.checkId,
        judgment,
        evidence: [{ receiptId: parsed.receiptId, digest: parsed.outputDigest }],
      },
    ];
  });

  return textEvents(identity, JSON.stringify({ checks: evidence }));
}

function toolEvents(identity, name, input) {
  return [
    { type: "RUN_STARTED", threadId: identity.threadId, runId: identity.runId },
    { type: "TOOL_CALL_START", toolCallId: identity.toolCallId, toolCallName: name },
    { type: "TOOL_CALL_ARGS", toolCallId: identity.toolCallId, delta: JSON.stringify(input) },
    { type: "TOOL_CALL_END", toolCallId: identity.toolCallId, input },
    { type: "RUN_FINISHED", threadId: identity.threadId, runId: identity.runId },
  ];
}

function textEvents(identity, text) {
  return [
    { type: "RUN_STARTED", threadId: identity.threadId, runId: identity.runId },
    { type: "TEXT_MESSAGE_START", messageId: identity.messageId, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: identity.messageId, delta: text },
    { type: "TEXT_MESSAGE_END", messageId: identity.messageId },
    { type: "RUN_FINISHED", threadId: identity.threadId, runId: identity.runId },
  ];
}

export const scriptedSemantics = {
  mode: "scripted-provider-boundary",
  notLiveProvider: true,
  hostObservedConstant: HOST_OBSERVED,
};
