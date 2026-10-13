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

function readTool(source) {
  return source.kind === "jira" ? "jira_get_issue" : "confluence_get_page";
}

function readInput(source) {
  return source.kind === "jira" ? { issue_key: source.issueKey } : { page_id: source.pageId };
}

function plannedCriteria(task) {
  const lines = (task.requirements?.sources ?? []).flatMap((source) => source.text.split("\n"));
  const labelled = new Map();

  for (const line of lines) {
    const match = line.match(/\b(AC-\d+)\b[:：]?\s*(.*)$/);

    if (match && !labelled.has(match[1])) {
      labelled.set(match[1], { id: match[1], statement: match[2] || line.trim() });
    }
  }

  const scoped = new Set((task.summary ?? "").match(/\bAC-\d+\b/g) ?? []);
  const criteria =
    labelled.size > 0
      ? [...labelled.values()]
      : [{ id: "AC-1", statement: lines[0]?.trim() || "Checkout succeeds" }];

  return scoped.size > 0 ? criteria.filter((criterion) => scoped.has(criterion.id)) : criteria;
}

export const planningMixedPrompt =
  "Plan CHUM-42 functional checks only. No execution URL or UI validation is needed.";
export const planningMixedIntent = {
  goal: "Verify checkout",
  sources: [{ kind: "jira", issueKey: "CHUM-42" }],
  executionRoles: [],
};

export function scriptedEvents(options, control = {}) {
  const messages = options.messages ?? [];
  const { role, task } = parseTask(
    messages.filter((message) => message.role === "user").map(textOf),
  );
  const toolOutputs = (messages ?? []).filter((message) => message.role === "tool");
  const identity = eventIdentity(options, role);

  if (role === "main") {
    if (control.ordinary) return textEvents(identity, "一般對話可用。");
    const lastUser = messages.findLastIndex((message) => message.role === "user");
    const results = messages.slice(lastUser + 1).filter((message) => message.role === "tool");
    const intent = control.intent ?? {};
    if (results.length === 0) {
      return toolEvents(
        identity,
        "delegate_task",
        intent.role
          ? intent
          : {
              role: "atlassian",
              summary: intent.summary ?? "Read checkout requirements",
              goal: intent.goal,
              sources: intent.sources,
            },
      );
    }
    if (intent.role) {
      return textEvents(identity, "委派任務已完成。");
    }
    const views = results.map((message) => parseJson(textOf(message)));
    if (views.some((view) => !view || view.error)) {
      return textEvents(identity, "委派任務遭拒。未啟動其他角色。");
    }
    const requirements = views.find((view) => view.task?.role === "atlassian")?.task?.result?.ref;
    const planned = views.find((view) => view.task?.role === "planner");
    const planRef = planned?.task?.result?.ref;
    if (!planned) {
      return toolEvents(identity, "delegate_task", {
        role: "planner",
        summary: intent.plannerSummary ?? "Plan checkout acceptance checks",
        requirementsRef: requirements,
        ...(intent.design ? { design: intent.design } : {}),
      });
    }
    const nextRole = (intent.executionRoles ?? []).find(
      (candidate) => !views.some((view) => view.task?.role === candidate),
    );
    if (nextRole) {
      return toolEvents(identity, "delegate_task", {
        role: nextRole,
        summary: `Run ${nextRole} checkout checks`,
        planRef,
        targetUrl: intent.targetUrl,
      });
    }
    if (control.planningMixed) {
      const reply = [
        "Here's the functional-only plan. Ordinary unresolved notes did not prevent planning.",
        "",
        "root = Stack([title, detail, continueButton])",
        'title = TextContent("Functional plan ready")',
        `detail = TextContent(${JSON.stringify(`Requirements ${requirements}; plan ${planRef}; no execution URL.`)})`,
        'continueButton = Button("Continue", Action([@ToAssistant("Continue")]), "primary")',
        "Middle prose. UI validation is not required.",
        'root = Stack([TextContent("No UI child was started")])',
        "Trailing prose. This was deterministic fixture replay, not live model or website validation.",
      ].join("\n");
      return textEvents(identity, reply, 24);
    }
    return textEvents(identity, "委派任務已完成。測試計畫與產物參照已保留，請依證據確認執行結果。");
  }

  if (role === "atlassian") {
    const sources = task.sources ?? [];
    const feedback = messages
      .filter((message) => message.role === "user")
      .map(textOf)
      .find((text) => text.startsWith("Private validation failed:"));
    const scenario = task.summary?.startsWith("source-") ? task.summary : undefined;

    if (toolOutputs.length === 0) {
      return toolEvents(identity, "discover_atlassian_tools", {
        toolNames: [...new Set(sources.map(readTool))],
      });
    }

    const requested =
      scenario === "source-missing" || (scenario === "source-retry" && !feedback)
        ? sources.slice(0, 1)
        : sources;
    const reads = toolOutputs.length - 1;

    if (reads < requested.length) {
      const source = requested[reads];

      return toolEvents(identity, readTool(source), readInput(source));
    }

    return textEvents(
      identity,
      scenario === "source-invented"
        ? JSON.stringify({
            criteria: [{ key: "AC-9", statement: "Invented by the source reader" }],
            unresolved: ["Invented ambiguity"],
            sources: [{ reference: sources[0], text: "Invented source text" }],
          })
        : "Requested sources were read.",
    );
  }

  if (role === "planner") {
    const criteria = plannedCriteria(task);
    const repair =
      control.plannerScenario === "planner-repair" &&
      !messages
        .filter((message) => message.role === "user")
        .map(textOf)
        .some((text) => text.startsWith("Private validation failed:"));
    const checks =
      criteria.length > 1
        ? criteria.map((criterion, index) => ({
            id: `check-${index + 1}`,
            criterionId: criterion.id,
            kind: "functional",
            expectedObservation: "UNIQUE-EXPECTED",
            observation: { kind: "text", target: "Order confirmation", comparison: "equals" },
          }))
        : [
            {
              id: "check-1",
              criterionId: criteria[0]?.id ?? "missing",
              kind: "functional",
              expectedObservation: "UNIQUE-EXPECTED",
              observation: { kind: "text", target: "Order confirmation", comparison: "equals" },
            },
          ];

    if (task.design) {
      checks.push({
        id: "style-1",
        criterionId: criteria[0]?.id ?? "missing",
        kind: "style",
        design: task.design,
        property: "width",
        target: "Checkout",
        tolerance: { kind: "exact" },
      });
    }

    return textEvents(
      identity,
      JSON.stringify({
        criteria: repair ? [...criteria, criteria[0]] : criteria,
        unresolved: control.planningMixed
          ? [
              "Price rule is not specified",
              "Execution URL is not supplied",
              "UI validation is not required",
            ]
          : [],
        cases: [
          {
            id: "case-1",
            title: "Checkout",
            preconditions: [],
            actions: [{ kind: "navigate", path: "/checkout" }],
            checks: repair
              ? [...checks, { ...checks[0], id: "check-unknown", criterionId: "AC-404" }]
              : checks,
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

    return toolEvents(identity, role === "ac" ? "verify_ac" : "verify_ui", {
      checkId: pending.id,
    });
  }

  const evidence = browserOutputs.flatMap((message) => {
    const parsed = parseJson(textOf(message));

    if (!parsed?.checkId || !parsed.receiptId) {
      return [];
    }

    const outcome =
      parsed.evidence?.outcome === "pass" || parsed.evidence?.outcome === "inside_tolerance"
        ? "pass"
        : parsed.evidence?.outcome === "fail" || parsed.evidence?.outcome === "outside_tolerance"
          ? "fail"
          : "blocked";
    const judgment = parsed.evidence?.origin === "mock" ? `simulated_${outcome}` : outcome;

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

function textEvents(identity, text, chunkSize = text.length || 1) {
  return [
    { type: "RUN_STARTED", threadId: identity.threadId, runId: identity.runId },
    { type: "TEXT_MESSAGE_START", messageId: identity.messageId, role: "assistant" },
    ...Array.from({ length: Math.ceil(text.length / chunkSize) }, (_, index) => ({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: identity.messageId,
      delta: text.slice(index * chunkSize, (index + 1) * chunkSize),
    })),
    { type: "TEXT_MESSAGE_END", messageId: identity.messageId },
    { type: "RUN_FINISHED", threadId: identity.threadId, runId: identity.runId },
  ];
}

export const scriptedSemantics = {
  mode: "scripted-provider-boundary",
  notLiveProvider: true,
  hostObservedConstant: HOST_OBSERVED,
};
