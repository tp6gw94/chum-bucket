import assert from "node:assert/strict";
import { test } from "node:test";
import {
  browserAdapterVersion,
  browserFixture,
  type DelegationInput,
  type Evidence,
  type FunctionalCheck,
  type PlanArtifact,
  type PlanProposal,
  type StyleCheck,
} from "../../../shared/testing";
import {
  assembleRequirements,
  assembleToolResults,
  authorizedRead,
  canonicalizePlan,
  childWorkflowIdFor,
  compareStyle,
  designCaptureOf,
  digestOf,
  figmaLinkOf,
  operationIdFor,
  parseRoleJson,
  type Receipt,
} from "../../../server/harness/testing-domain";

type AtlassianIntent = Extract<DelegationInput, { role: "atlassian" }>;

const intent: AtlassianIntent = {
  role: "atlassian",
  summary: "Read requirements",
  goal: "Checkout works",
  sources: [
    { kind: "jira", issueKey: "PROJ-1" },
    { kind: "confluence", pageId: "42" },
  ],
};

const design = { fileKey: "abc123", nodeId: "1:2" };

function receipt(overrides: Partial<Receipt>): Receipt {
  return {
    id: "receipt",
    slot: "slot",
    nativeName: "jira_get_issue",
    route: "direct",
    input: {},
    output: {},
    inputDigest: digestOf({}),
    outputDigest: digestOf({}),
    bindings: {},
    createdAt: "2026-10-15T00:00:00.000Z",
    ...overrides,
  };
}

const functional: FunctionalCheck = {
  id: "check-1",
  criterionId: "AC-1",
  kind: "functional",
  expectedObservation: "Thanks",
  observation: { kind: "text", target: "confirmation", comparison: "contains" },
};

const style: StyleCheck = {
  id: "check-2",
  criterionId: "AC-1",
  kind: "style",
  design,
  property: "color",
  target: "submit button",
  tolerance: { kind: "exact" },
};

const proposal: PlanProposal = {
  criteria: [{ id: "AC-1", statement: "Submit shows a confirmation" }],
  unresolved: [],
  cases: [
    {
      id: "case-1",
      title: "Submit order",
      preconditions: [],
      actions: [{ kind: "navigate", path: "/" }],
      checks: [functional, style],
    },
  ],
};

test("digests are stable across key order and ignore undefined", () => {
  assert.equal(
    digestOf({ a: 1, b: [1, { c: 2, d: undefined }] }),
    digestOf({ b: [1, { c: 2 }], a: 1 }),
  );
  assert.notEqual(digestOf({ a: 1 }), digestOf({ a: 2 }));
  assert.match(digestOf(undefined), /^[0-9a-f]{64}$/);
});

test("operation and workflow ids are deterministic", () => {
  const operationId = operationIdFor("run-1", "call-1");

  assert.match(operationId, /^testing-[0-9a-f]{32}$/);
  assert.equal(operationId, operationIdFor("run-1", "call-1"));
  assert.notEqual(operationId, operationIdFor("run-1", "call-2"));
  assert.equal(childWorkflowIdFor(operationId, "ac"), childWorkflowIdFor(operationId, "ac"));
  assert.notEqual(childWorkflowIdFor(operationId, "ac"), childWorkflowIdFor(operationId, "ui"));
});

test("authorized reads are limited to delegated sources", () => {
  assert.equal(authorizedRead("jira_get_issue", { issue_key: "proj-1" }, intent), "jira:PROJ-1");
  assert.equal(authorizedRead("confluence_get_page", { page_id: "42" }, intent), "confluence:42");
  assert.throws(
    () => authorizedRead("jira_get_issue", { issue_key: "PROJ-2" }, intent),
    /task\.sources/,
  );
  assert.throws(
    () => authorizedRead("confluence_get_page", { issue_key: "PROJ-1" }, intent),
    /task\.sources/,
  );
});

test("requirements need a successful read of every source", () => {
  const jira = receipt({
    nativeName: "jira_get_issue",
    bindings: { source: "jira:PROJ-1" },
    output: {
      key: "PROJ-1",
      summary: "Checkout",
      description: "See https://www.figma.com/design/abc123/App?node-id=1-2 for the button",
      remote_links: [{ object: { url: "https://figma.com/file/zzz999/Old", title: "Old" } }],
    },
  });
  const failedPage = receipt({
    nativeName: "confluence_get_page",
    bindings: { source: "confluence:42" },
    output: { error: "not found" },
  });

  const missing = assembleRequirements(intent, [jira, failedPage]);
  assert.equal(missing.ok, false);
  assert.deepEqual(!missing.ok && missing.issues, [
    "task.sources[1]: confluence:42 has no successful read",
  ]);

  const page = receipt({
    nativeName: "confluence_get_page",
    bindings: { source: "confluence:42" },
    output: { metadata: { title: "Spec" }, content: { value: "Body" } },
  });
  const assembled = assembleRequirements(intent, [jira, page]);

  assert.equal(assembled.ok, true);
  if (assembled.ok) {
    assert.equal(assembled.value.goal, "Checkout works");
    assert.equal(assembled.value.sources[1]!.text, "Spec\n\nBody");
    assert.deepEqual(
      assembled.value.sources[0]!.links.map((link) => [link.fileKey, link.nodeId]),
      [
        ["zzz999", undefined],
        ["abc123", "1:2"],
      ],
    );
  }
});

test("figma links only accept https figma hosts", () => {
  assert.equal(figmaLinkOf("http://www.figma.com/design/abc/x"), undefined);
  assert.equal(figmaLinkOf("https://evil.example/design/abc/x"), undefined);
  assert.equal(figmaLinkOf("https://www.figma.com/design/abc/x?node-id=3-4")?.nodeId, "3:4");
});

test("role json may be fenced", () => {
  assert.deepEqual(parseRoleJson('```json\n{"a":1}\n```'), { ok: true, value: { a: 1 } });
  assert.equal(parseRoleJson("nope").ok, false);
  assert.equal(parseRoleJson(null).ok, false);
});

test("plans are canonicalized with role assignments", () => {
  const plan = canonicalizePlan(proposal, { design, strict: true });

  assert.equal(plan.ok, true);
  assert.deepEqual(plan.ok && plan.value.assignments, { ac: ["check-1"], ui: ["check-2"] });
});

test("plans reject unknown criteria, foreign designs, duplicates, and preconditions", () => {
  const broken: PlanProposal = {
    ...proposal,
    cases: [
      {
        ...proposal.cases[0]!,
        preconditions: ["logged in"],
        checks: [
          { ...functional, criterionId: "AC-9" },
          functional,
          { ...style, design: { fileKey: "other", nodeId: "1:2" } },
        ],
      },
    ],
  };
  const plan = canonicalizePlan(broken, { design, strict: true });

  assert.equal(plan.ok, false);
  assert.deepEqual(!plan.ok && plan.issues.sort(), [
    "cases.case-1.checks.check-1: unknown criterionId AC-9",
    "cases.case-1.checks.check-2: style design must equal the delegated design",
    "cases.case-1.preconditions: must be []; express setup as actions",
    "checks: duplicate id check-1",
  ]);
  assert.equal(canonicalizePlan({ criteria: [] }, { design, strict: false }).ok, false);
});

function evidenceFor(checkId: string): Evidence {
  return {
    origin: "browser",
    fixture: { ...browserFixture },
    adapterVersion: browserAdapterVersion,
    browser: { selections: [], skippedActions: [] },
    screenshot: null,
    check: {
      kind: "functional",
      caseId: "case-1",
      checkId,
      actionIndex: null,
      outcome: "pass",
      expected: "Thanks",
      observed: "Thanks!",
      reason: null,
    },
  };
}

test("tool results need a finished receipt for each assigned check", () => {
  const canonical = canonicalizePlan(proposal, { design, strict: true });
  assert.equal(canonical.ok, true);
  const plan: PlanArtifact = {
    ...(canonical.ok ? canonical.value : ({} as never)),
    requirementsRef: "art-1",
    requirementsDigest: digestOf("requirements"),
    goal: "Checkout works",
    targetUrl: null,
    design,
  };
  const input = {
    role: "ac" as const,
    plan,
    planRef: "art-2",
    targetUrl: "http://localhost:4173/",
  };

  const missing = assembleToolResults({ ...input, receipts: [] });
  assert.deepEqual(!missing.ok && missing.issues, [
    "task.checks[0]: check-1 has no finished verify_ac result",
  ]);

  const forged = receipt({
    nativeName: "verify_ac",
    bindings: { checkId: "check-1" },
    output: { evidence: evidenceFor("check-9") },
  });
  assert.equal(assembleToolResults({ ...input, receipts: [forged] }).ok, false);

  const finished = receipt({
    id: "r-1",
    nativeName: "verify_ac",
    bindings: { checkId: "check-1" },
    output: { evidence: evidenceFor("check-1") },
  });
  const result = assembleToolResults({ ...input, receipts: [finished] });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.ok &&
      result.value.checks.map((check) => [
        check.caseId,
        check.checkId,
        check.outcome,
        check.receiptId,
      ]),
    [["case-1", "check-1", "pass", "r-1"]],
  );
});

test("design captures require the exact node and an untruncated response", () => {
  const node = {
    id: "1:2",
    type: "FRAME",
    opacity: 1,
    cornerRadius: 8,
    absoluteBoundingBox: { width: 120, height: 40.004 },
    fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }],
    children: [
      {
        id: "1:3",
        type: "TEXT",
        style: { fontSize: 16, fontWeight: 600, lineHeightPx: 24 },
        fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 0.5 } }],
      },
    ],
  };

  assert.deepEqual(designCaptureOf({ nodes: [node] }, design), {
    fileKey: "abc123",
    nodeId: "1:2",
    properties: {
      width: "120",
      height: "40",
      cornerRadius: "8",
      borderRadius: "8",
      opacity: "1",
      backgroundColor: "rgb(255, 0, 0)",
      color: "rgba(0, 0, 0, 0.5)",
      fontSize: "16",
      fontWeight: "600",
      lineHeight: "24",
    },
  });
  assert.equal(designCaptureOf({ nodes: [node], truncated: true }, design), undefined);
  assert.equal(designCaptureOf({ nodes: [{ ...node, id: "9:9" }] }, design), undefined);
  assert.equal(designCaptureOf({}, design), undefined);
});

test("style comparison honors tolerance", () => {
  const exact = { kind: "exact" } as const;
  const loose = { kind: "numeric", unit: "px", maxDelta: 2 } as const;

  assert.equal(
    compareStyle("color", "rgb(255, 0, 0)", "rgba(255, 0, 0, 1)", exact).outcome,
    "inside_tolerance",
  );
  assert.equal(
    compareStyle("color", "rgb(255, 0, 0)", "rgb(250, 0, 0)", exact).outcome,
    "outside_tolerance",
  );
  assert.equal(compareStyle("fontSize", "16", "17px", exact).outcome, "outside_tolerance");
  assert.equal(compareStyle("fontSize", "16", "17.5px", loose).outcome, "inside_tolerance");
  assert.equal(compareStyle("width", "auto", "10px", loose).outcome, "blocked");
  assert.equal(compareStyle("backgroundColor", "red", "rgb(255, 0, 0)", exact).outcome, "blocked");
});
