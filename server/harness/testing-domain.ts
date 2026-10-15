import { createHash } from "node:crypto";
import { z } from "zod";
import {
  planProposalSchema,
  type DelegationInput,
  type Requirements,
  type Receipt,
  type Plan,
  type RoleTask,
  type Evidence,
  type ArtifactPayload,
  type Role,
} from "../../shared/testing";

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sorted);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sorted(item)]),
    );
  }

  return value;
}

export function digestOf(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(sorted(value)))
    .digest("hex");
}

export type Validation =
  | { valid: true; payload: ArtifactPayload }
  | { valid: false; issues: string[] };

function remoteData(output: unknown): unknown {
  if (typeof output === "string") {
    try {
      return remoteData(JSON.parse(output));
    } catch {
      return undefined;
    }
  }

  if (!output || typeof output !== "object") {
    return undefined;
  }

  const value = output as Record<string, unknown>;

  if (value.isError === true) {
    return undefined;
  }

  if ("result" in value) {
    return remoteData(value.result);
  }

  if (value.structuredContent) {
    return remoteData(value.structuredContent);
  }

  if (Array.isArray(value.content)) {
    return contentData(value.content);
  }

  return value;
}

function contentData(content: { type?: string; text?: string }[]): unknown {
  const values = content
    .filter((item) => item.type === "text")
    .map((item) => remoteData(item.text));

  return values.find((value) => value !== undefined);
}

export function assembleRequirements(
  intent: Extract<DelegationInput, { role: "atlassian" }>,
  receipts: Receipt[],
): Validation {
  const sources: Requirements["sources"] = [];
  const issues: string[] = [];

  for (const [index, reference] of intent.sources.entries()) {
    const jira = reference.kind === "jira";
    const receipt = receipts.find((entry) => {
      const input = entry.input as Record<string, unknown>;

      return (
        entry.outputDigest === digestOf(entry.output) &&
        entry.name === (jira ? "jira_get_issue" : "confluence_get_page") &&
        input?.[jira ? "issue_key" : "page_id"] ===
          (jira ? reference.issueKey : reference.pageId) &&
        sourceText(entry.output, jira) !== undefined
      );
    });
    const text = receipt && sourceText(receipt.output, jira);

    if (text === undefined) {
      issues.push(
        `task.sources[${index}]: ${jira ? reference.issueKey : reference.pageId} has no successful read`,
      );
    } else {
      sources.push({ reference, text, digest: digestOf(text), capturedAt: receipt!.capturedAt });
    }
  }

  return issues.length
    ? { valid: false, issues }
    : { valid: true, payload: { goal: intent.goal, sources } };
}

function jiraText(record: Record<string, unknown>): string | undefined {
  const fields = (record.fields ?? record) as Record<string, unknown>;

  if (typeof fields.summary !== "string") {
    return undefined;
  }

  const description = fields.description ?? "";
  const raw = typeof description === "string" ? description : JSON.stringify(description);
  const key = typeof record.key === "string" ? `${record.key} ` : "";

  return `${key}${fields.summary}\n${raw}`;
}

function confluenceText(record: Record<string, unknown>): string | undefined {
  const body = record.body as { storage?: { value?: unknown } } | undefined;
  const content = record.content as { value?: unknown } | string | undefined;
  const raw = typeof content === "string" ? content : (content?.value ?? body?.storage?.value);

  return typeof record.title === "string" && typeof raw === "string"
    ? `${record.title}\n${raw}`
    : undefined;
}

function sourceText(output: unknown, jira: boolean): string | undefined {
  const data = remoteData(output) as Record<string, unknown> | undefined;

  if (!data) {
    return undefined;
  }

  const record = (data[jira ? "issue" : "page"] ?? data) as Record<string, unknown>;

  return jira ? jiraText(record) : confluenceText(record);
}

export function canonicalizePlan(raw: unknown, task: RoleTask): Validation {
  const parsed = planProposalSchema.safeParse(raw);

  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues
        .slice(0, 20)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    };
  }

  const plan = parsed.data;
  const issues: string[] = [];

  const unique = (ids: string[], kind: string) => {
    if (new Set(ids).size !== ids.length) {
      issues.push(`Duplicate ${kind} ID`);
    }
  };

  unique(
    plan.criteria.map((criterion) => criterion.id),
    "criterion",
  );
  unique(
    [...plan.cases, ...(plan.deferredCases ?? [])].map((entry) => entry.id),
    "case",
  );
  const checks = plan.cases.flatMap((entry) => entry.checks);
  unique(
    checks.map((check) => check.id),
    "check",
  );
  const criteria = new Set(plan.criteria.map((criterion) => criterion.id));

  for (const check of checks) {
    if (!criteria.has(check.criterionId)) {
      issues.push(`Unknown criterion ${check.criterionId}`);
    }

    if (check.kind === "style" && digestOf(check.design) !== digestOf(task.design)) {
      issues.push(`Design mismatch for ${check.id}`);
    }
  }

  for (const entry of plan.deferredCases ?? []) {
    if (entry.expectations.some((item) => !criteria.has(item.criterionId))) {
      issues.push(`Unknown deferred criterion in ${entry.id}`);
    }
  }

  return issues.length
    ? { valid: false, issues }
    : {
        valid: true,
        payload: {
          ...plan,
          goal: task.goal,
          targetUrl: null,
          design: task.design,
          requirementsDigest: digestOf(task.requirements),
          assignments: {
            ac: checks.filter((check) => check.kind === "functional").map((check) => check.id),
            ui: checks.filter((check) => check.kind === "style").map((check) => check.id),
          },
        } satisfies Plan,
      };
}

const evidenceSchema = z.object({
  origin: z.literal("browser"),
  fixture: z.object({ id: z.literal("playwright-chromium"), version: z.literal("v1") }),
  caseId: z.string(),
  checkId: z.string(),
  outcome: z.enum(["pass", "fail", "blocked"]),
  expected: z.string().optional(),
  observed: z.string().optional(),
  reason: z.string().optional(),
  screenshot: z.string().optional(),
});

export function assembleToolResults(role: "ac" | "ui", task: RoleTask, receipts: Receipt[]) {
  const checks: Evidence[] = [];

  for (const receipt of receipts) {
    const parsed = evidenceSchema.safeParse(receipt.output);
    const check = parsed.success
      ? task.plan?.cases.find((entry) =>
          entry.checks.some((item) => item.id === parsed.data.checkId),
        )
      : undefined;

    if (
      parsed.success &&
      check?.id === parsed.data.caseId &&
      receipt.name === `verify_${role}` &&
      receipt.checkId === parsed.data.checkId &&
      task.checks.includes(parsed.data.checkId) &&
      receipt.outputDigest === digestOf(receipt.output)
    ) {
      checks.push(parsed.data);
    }
  }

  return {
    payload: { checks },
    missingChecks: task.checks.filter((id) => !checks.some((check) => check.checkId === id)),
    conflictingChecks: task.checks.filter(
      (id) =>
        new Set(checks.filter((check) => check.checkId === id).map((check) => check.outcome)).size >
        1,
    ),
  };
}

export function validateCandidate(
  role: Role,
  candidate: unknown,
  intent: DelegationInput,
  task: RoleTask,
  receipts: Receipt[],
): Validation {
  if (role === "atlassian" && intent.role === "atlassian") {
    return assembleRequirements(intent, receipts);
  }

  if (role === "planner") {
    return canonicalizePlan(candidate, task);
  }

  if (role === "ac" || role === "ui") {
    return { valid: true, payload: assembleToolResults(role, task, receipts).payload };
  }

  return { valid: false, issues: ["Role mismatch"] };
}
