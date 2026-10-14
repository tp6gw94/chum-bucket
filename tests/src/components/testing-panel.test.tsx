import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  artifactRefSchema,
  testRunIdSchema,
  type ProgressRow,
  type PublicEvidence,
  type PublicPlan,
  type PublicRequirements,
  type PublicTestReport,
  type RoleId,
  type TestView,
} from "../../../shared/testing";
import { TestingPanel } from "../../../src/components/testing-panel";
import { parseTestView } from "../../../shared/testing-event";

test("QA prose remains escaped and unassessed with missing evidence independent of completed lifecycle", () => {
  const view: TestView = {
    runId: testRunIdSchema.parse("qa-v3"),
    state: "finished",
    report: null,
    reuse: [],
    availableArtifacts: [],
    progress: { version: 1, rows: completedRows },
    task: {
      version: 3,
      role: "ac",
      summary: "Check",
      findings: "<script>alert('private')</script> Assembling output.",
      missingChecks: ["check-1"],
      conflictingChecks: [],
      result: null,
    },
  };
  const markup = renderToStaticMarkup(<TestingPanel view={view} />);
  assert.match(markup, /模型文字，未評定完整性/);
  assert.match(markup, /缺少工具證據的檢查/);
  assert.match(markup, /check-1/);
  assert.match(markup, /&lt;script&gt;/);
  assert.doesNotMatch(markup, /<script>/);
  assert.match(markup, /不代表檢查通過或報告完整/);
});

test("QA v3 renders every contradictory observation and explicitly flags the check", () => {
  const view: TestView = {
    runId: testRunIdSchema.parse("qa-conflict"),
    state: "finished",
    report: null,
    reuse: [],
    availableArtifacts: [],
    progress: { version: 1, rows: completedRows },
    task: {
      version: 3,
      role: "ac",
      summary: "Observe checkout",
      findings: "The observations disagree.",
      missingChecks: [],
      conflictingChecks: ["check-1"],
      result: {
        ref: artifact,
        kind: "ac-result",
        payload: [
          {
            caseId: "case-1",
            checkId: "check-1",
            judgment: "simulated_pass",
            evidence: [functionalEvidence],
          },
          {
            caseId: "case-1",
            checkId: "check-1",
            judgment: "simulated_fail",
            evidence: [
              { ...functionalEvidence, outcome: "fail", observed: "Contradictory observation" },
            ],
          },
        ],
      },
    },
  };
  const markup = renderToStaticMarkup(<TestingPanel view={view} />);
  assert.equal(markup.split('data-check-id="check-1"').length - 1, 2);
  assert.match(markup, /data-judgment="simulated_pass"/);
  assert.match(markup, /data-judgment="simulated_fail"/);
  assert.match(markup, /Contradictory observation/);
  assert.match(markup, /工具觀察互相矛盾，須逐筆判讀/);
  assert.match(markup, /工具觀察（非 QA 整體判定）/);
  assert.match(markup, /不構成整體網站或發布驗收/);
  assert.deepEqual(parseTestView(view), view);
});

const runId = testRunIdSchema.parse("run-1");
const originalRunId = testRunIdSchema.parse("run-0");
const artifact = artifactRefSchema.parse("artifact:requirements:1");
const availableArtifact = artifactRefSchema.parse("artifact:plan:1");

const completedRows: Record<RoleId, ProgressRow> = {
  atlassian: { status: "terminal", outcome: "completed", reasonCode: "ok" },
  planner: { status: "terminal", outcome: "completed", reasonCode: "ok" },
  ac: { status: "terminal", outcome: "completed", reasonCode: "ok" },
  ui: { status: "not_required", reason: "no_style_checks" },
};

const requirements: PublicRequirements = {
  goal: "驗證結帳流程與樣式",
  sources: [
    {
      reference: { kind: "jira", issueKey: "CHUM-42" },
      text: "CHUM-42 結帳\n\n## 驗收條件\n1. AC-1 送出後顯示訂單成立\n2. AC-2 按鈕使用品牌色",
      links: [],
      digest: "digest-1",
      capturedAt: "2026-10-09T00:00:00.000Z",
    },
  ],
};

const plan: PublicPlan = {
  criteria: [
    { id: "AC-1", statement: "送出後顯示訂單成立" },
    { id: "AC-2", statement: "按鈕使用品牌色" },
  ],
  unresolved: ["來源中有 1 條敘述無法解析"],
  cases: [
    {
      id: "case-1",
      title: "結帳成功",
      preconditions: ["購物車已有一件商品"],
      actions: [
        { kind: "navigate", path: "/checkout" },
        { kind: "click", target: "送出訂單" },
      ],
      checks: [
        {
          id: "check-1",
          criterionId: "AC-1",
          kind: "functional",
          expectedObservation: "顯示訂單編號",
        },
        {
          id: "check-2",
          criterionId: "AC-2",
          kind: "style",
          design: { fileKey: "CheckoutDemo", nodeId: "12:34" },
          property: "background-color",
          tolerance: { kind: "numeric", unit: "ratio", maxDelta: 0.05 },
        },
      ],
    },
  ],
  assignments: { ac: ["check-1"], ui: ["check-2"] },
};

const functionalEvidence: Extract<
  PublicEvidence,
  { kind: "functional"; outcome: "pass" | "fail" }
> = {
  kind: "functional",
  outcome: "pass",
  expected: "顯示訂單編號",
  observed: "訂單編號 A-123",
  actionIndex: 1,
  caseId: "case-1",
  checkId: "check-1",
  origin: "mock",
  fixture: { id: "checkout-pass", version: "3" },
  adapterVersion: "mock-1",
};

const blockedEvidence: PublicEvidence = {
  kind: "functional",
  outcome: "blocked",
  reason: "找不到符合的按鈕",
  actionIndex: 0,
  caseId: "case-1",
  checkId: "check-3",
  origin: "mock",
  fixture: { id: "checkout-blocked", version: "1" },
  adapterVersion: "mock-1",
};

const styleEvidence: PublicEvidence = {
  kind: "style",
  outcome: "outside_tolerance",
  property: "background-color",
  expected: "rgb(12, 34, 56)",
  observed: "rgb(200, 10, 10)",
  tolerance: { kind: "numeric", unit: "ratio", maxDelta: 0.05 },
  capturedDesign: {
    reference: { fileKey: "CheckoutDemo", nodeId: "12:34" },
    propertiesDigest: "digest-abc",
    complete: true,
    capturedAt: "2026-10-09T00:00:00.000Z",
  },
  caseId: "case-1",
  checkId: "check-2",
  origin: "mock",
  fixture: { id: "checkout-style", version: "2" },
  adapterVersion: "mock-2",
};

function report(overrides: Partial<PublicTestReport> = {}): PublicTestReport {
  return {
    runId,
    requirements,
    plan,
    results: {
      ac: [
        {
          caseId: "case-1",
          checkId: "check-1",
          judgment: "simulated_pass",
          evidence: [functionalEvidence],
        },
        {
          caseId: "case-1",
          checkId: "check-3",
          judgment: "simulated_blocked",
          evidence: [blockedEvidence],
        },
      ],
      ui: [
        {
          caseId: "case-1",
          checkId: "check-2",
          judgment: "simulated_fail",
          evidence: [styleEvidence],
        },
      ],
    },
    coverage: [
      {
        criterionId: "AC-1",
        caseId: "case-1",
        checkId: "check-1",
        state: "simulated_pass",
      },
      {
        criterionId: "AC-2",
        caseId: null,
        checkId: null,
        state: "uncovered",
      },
    ],
    unresolvedSources: [{ kind: "jira", issueKey: "CHUM-42" }],
    artifacts: [artifact],
    roleOutcomes: completedRows,
    acceptance: { verdict: "not_verified", reason: "mock_only" },
    ...overrides,
  };
}

function activeView(rows: Record<RoleId, ProgressRow>, version = 1): TestView {
  return {
    runId,
    state: "active",
    report: null,
    progress: { version, rows },
    reuse: [],
    availableArtifacts: [],
  };
}

function cancellingView(rows: Record<RoleId, ProgressRow>): TestView {
  return {
    runId,
    state: "cancelling",
    report: null,
    progress: { version: 3, rows },
    reuse: [],
    availableArtifacts: [],
  };
}

function finishedView(
  finishedReport: PublicTestReport,
  rows: Record<RoleId, ProgressRow> = completedRows,
): TestView {
  return {
    runId,
    state: "finished",
    report: finishedReport,
    progress: { version: 9, rows },
    reuse: [],
    availableArtifacts: [availableArtifact],
  };
}

function renderRows(overrides: Partial<Record<RoleId, ProgressRow>>): string {
  return renderToStaticMarkup(
    <TestingPanel view={activeView({ ...completedRows, ...overrides })} />,
  );
}

function plainText(html: string): string {
  return html.replaceAll("<!-- -->", "");
}

function statusAnnouncement(html: string): string {
  const match = html.match(
    /<p(?=[^>]*role="status")(?=[^>]*aria-live="polite")(?=[^>]*aria-atomic="true")(?=[^>]*aria-label="測試狀態摘要")[^>]*>([\s\S]*?)<\/p>/,
  );
  assert.ok(match, "expected a named polite atomic status region");

  return plainText(match[1] ?? "");
}

test("the progress section exposes stable selectors and four ordered role rows", () => {
  const html = renderRows({});
  assert.match(html, /aria-label="測試角色進度"/);
  assert.match(html, /data-testid="testing-progress"/);
  assert.match(html, /data-run-id="run-1"/);
  assert.match(html, /data-state="active"/);

  const positions = ["atlassian", "planner", "ac", "ui"].map((role) =>
    html.indexOf(`data-role="${role}"`),
  );
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(
    positions,
    [...positions].sort((left, right) => left - right),
  );
});

test("waiting rows separate dependency and dispatch reasons", () => {
  const dependency = renderRows({
    ac: { status: "waiting", reason: "dependency" },
  });
  assert.match(dependency, /data-status="waiting"/);
  assert.match(plainText(dependency), /等待相依條件完成/);

  const dispatch = renderRows({
    ac: { status: "waiting", reason: "dispatch" },
  });
  assert.match(plainText(dispatch), /等待派工/);
});

test("a reused row shows its frozen artifact, original run and issue time", () => {
  const html = renderRows({
    atlassian: {
      status: "reused",
      artifact,
      provenance: {
        originalRunId,
        role: "atlassian",
        issuedAt: "2026-10-08T10:00:00.000Z",
      },
    },
  });
  const text = plainText(html);
  assert.match(html, /data-status="reused"/);
  assert.match(text, /artifact:requirements:1/);
  assert.match(text, /原 run run-0/);
  assert.match(text, /2026-10-08T10:00:00.000Z/);
  assert.match(text, /凍結快照，非最新內容/);
});

test("running rows expose model or tool activity plus host check counts", () => {
  const model = renderRows({
    ac: { status: "running", activity: "model", checks: { completed: 3, total: 8 } },
  });
  assert.match(model, /data-status="running"/);
  assert.match(plainText(model), /模型推理中/);
  assert.match(plainText(model), /Host 檢查 3\/8/);

  const tool = renderRows({ ac: { status: "running", activity: "tool" } });
  assert.match(plainText(tool), /工具執行中/);

  const idle = renderRows({ ac: { status: "running", activity: null } });
  assert.match(plainText(idle), /準備中/);
});

test("tool activity rows expose the real tool name, route and start time", () => {
  const html = renderRows({
    ac: {
      status: "tool_activity",
      active: [
        { toolName: "use_browser", route: "direct", startedAt: "2026-10-09T01:00:00.000Z" },
        { toolName: "get_figma", route: "codemode", startedAt: "2026-10-09T01:01:00.000Z" },
      ],
      checks: { completed: 4, total: 8 },
    },
  });
  const text = plainText(html);
  assert.match(html, /data-status="tool_activity"/);
  assert.match(text, /use_browser/);
  assert.match(text, /直接呼叫/);
  assert.match(text, /get_figma/);
  assert.match(text, /Code Mode/);
  assert.match(text, /開始 2026-10-09T01:00:00.000Z/);
  assert.match(text, /Host 檢查 4\/8/);
});

test("a cancelling row is not presented as already stopped", () => {
  const html = renderRows({
    ac: {
      status: "cancelling",
      active: [{ toolName: "use_browser", route: "direct", startedAt: "2026-10-09T02:00:00.000Z" }],
    },
  });
  const text = plainText(html);
  assert.match(html, /data-status="cancelling"/);
  assert.match(text, /已接受取消，尚未確認停止/);
  assert.match(text, /use_browser/);
  assert.doesNotMatch(text, /已停止/);
});

test("not required and undispatched rows explain their reason", () => {
  const notRequired = renderRows({ ui: { status: "not_required", reason: "no_style_checks" } });
  assert.match(notRequired, /data-status="not_required"/);
  assert.match(plainText(notRequired), /無樣式檢查，不需要派工/);

  for (const [reason, label] of [
    ["cancelled", "已取消"],
    ["dependency_blocked", "相依未滿足"],
    ["incompatible", "不相容"],
    ["timed_out", "逾時"],
  ] as const) {
    const html = renderRows({ ac: { status: "undispatched", reason } });
    assert.match(html, /data-status="undispatched"/);
    assert.match(plainText(html), new RegExp(`未派工：${label}`));
  }
});

test("every terminal outcome renders its label, outcome attribute and reason code", () => {
  for (const [outcome, label] of [
    ["completed", "已完成"],
    ["failed", "失敗"],
    ["cancelled", "已取消"],
    ["missing", "缺漏"],
    ["incompatible", "不相容"],
    ["timed_out", "逾時"],
  ] as const) {
    const html = renderRows({
      ac: { status: "terminal", outcome, reasonCode: `reason-${outcome}` },
    });
    assert.match(
      html,
      new RegExp(`data-role="ac" data-status="terminal" data-outcome="${outcome}"`),
    );
    assert.match(plainText(html), new RegExp(label));
    assert.match(plainText(html), new RegExp(`原因：reason-${outcome}`));
  }
});

test("private child fields are never rendered or stringified", () => {
  const row = {
    status: "running" as const,
    activity: "model" as const,
    checks: { completed: 1, total: 2 },
    childToken: "tok_child_secret",
    prompt: "private child prompt",
  };
  const view = {
    ...activeView(completedRows),
    progress: { version: 2, rows: { ...completedRows, ac: row } },
  };
  const html = renderToStaticMarkup(<TestingPanel view={view} />);
  assert.doesNotMatch(html, /tok_child_secret/);
  assert.doesNotMatch(html, /private child prompt/);
  assert.doesNotMatch(html, /childToken/);
  assert.doesNotMatch(html, /&quot;status&quot;:&quot;running&quot;/);
});

test("the cancel control only exists with a callback and follows the server state", () => {
  const withoutCallback = renderToStaticMarkup(<TestingPanel view={activeView(completedRows)} />);
  assert.doesNotMatch(withoutCallback, /取消/);
  assert.doesNotMatch(withoutCallback, /<button/);

  const active = renderToStaticMarkup(
    <TestingPanel view={activeView(completedRows)} onCancel={async () => {}} />,
  );
  assert.match(active, /aria-label="取消"/);
  assert.match(plainText(active), />取消</);
  assert.doesNotMatch(active, /disabled=""/);

  const cancelling = renderToStaticMarkup(
    <TestingPanel view={cancellingView(completedRows)} onCancel={async () => {}} />,
  );
  assert.match(cancelling, /data-state="cancelling"/);
  assert.match(cancelling, /aria-label="取消"/);
  assert.match(plainText(cancelling), /取消中…/);
  assert.match(cancelling, /disabled=""/);

  const finished = renderToStaticMarkup(
    <TestingPanel view={finishedView(report())} onCancel={async () => {}} />,
  );
  assert.match(finished, /aria-label="取消"/);
  assert.match(finished, /disabled=""/);
  assert.doesNotMatch(finished, /<details|<summary/);
});

test("live browser judgments survive hydration and are not labeled simulated", () => {
  const base = report();
  const evidence: PublicEvidence = {
    kind: "functional",
    outcome: "pass",
    expected: "1",
    observed: "1",
    actionIndex: 0,
    caseId: "case-1",
    checkId: "live",
    origin: "browser",
    fixture: { id: "playwright-chromium", version: "v1" },
    adapterVersion: "playwright-jev-v1",
    browser: { selections: [] },
  };
  const view = finishedView({
    ...base,
    results: {
      ac: [{ caseId: "case-1", checkId: "live", judgment: "pass", evidence: [evidence] }],
      ui: [],
    },
    coverage: [],
    acceptance: { verdict: "not_verified", reason: "release_not_assessed" },
  });
  const hydrated = parseTestView(JSON.parse(JSON.stringify(view)));
  assert.ok(hydrated);
  const text = plainText(renderToStaticMarkup(<TestingPanel view={hydrated} />));
  assert.match(text, /瀏覽器符合/);
  assert.match(text, /來源：真實瀏覽器/);
  assert.match(text, /未完成發布驗收/);
  assert.doesNotMatch(text, /模擬符合|來源：模擬/);
});

test("a finished view renders the public report with mock-only acceptance", () => {
  const html = renderToStaticMarkup(<TestingPanel view={finishedView(report())} />);
  const text = plainText(html);

  assert.match(html, /aria-label="測試報告"/);
  assert.match(html, /<section(?=[^>]*aria-live="off")(?=[^>]*data-testid="testing-report")[^>]*>/);
  assert.match(html, /data-testid="testing-report"/);
  assert.match(html, /data-verdict="not_verified"/);
  assert.match(text, /未驗證真實網站/);
  assert.match(text, /模擬資料/);
  assert.match(text, /檢查結果只描述已驗證範圍，不構成整體網站或發布驗收。/);

  assert.match(text, /目標：驗證結帳流程與樣式/);
  assert.match(text, /Jira CHUM-42 · 讀取於 2026-10-09T00:00:00.000Z · 內容摘要 digest-1/);
  assert.match(
    text,
    /<pre[^>]*>CHUM-42 結帳\n\n## 驗收條件\n1\. AC-1 送出後顯示訂單成立\n2\. AC-2 按鈕使用品牌色<\/pre>/,
  );
  assert.match(
    text,
    /data-criterion-id="AC-1"[^>]*><span class="font-mono">AC-1<\/span> · 送出後顯示訂單成立<\/li>/,
  );
  assert.match(text, /AC-2<\/span> · 按鈕使用品牌色<\/li>/);
  assert.doesNotMatch(html, /data-selected/);
  assert.doesNotMatch(text, /選取範圍|已選|未選/);
  assert.match(text, /待解決：來源中有 1 條敘述無法解析/);

  assert.match(text, /結帳成功（案例 case-1）/);
  assert.match(text, /前置條件：購物車已有一件商品/);
  assert.match(text, /預定動作 1：前往 \/checkout/);
  assert.match(text, /預定動作 2：點擊 送出訂單/);
  assert.match(text, /不是實際瀏覽器操作紀錄/);
  assert.match(text, /功能檢查 check-1（準則 AC-1）：預期 顯示訂單編號/);
  assert.match(text, /樣式檢查 check-2（準則 AC-2）：background-color/);
  assert.match(text, /設計 Figma 檔案 CheckoutDemo，節點 12:34/);

  assert.match(text, /模擬符合/);
  assert.match(text, /模擬差異/);
  assert.match(text, /模擬受阻/);
  assert.match(text, /案例 case-1 · 檢查 check-1/);
  assert.match(text, /預期：顯示訂單編號/);
  assert.match(text, /觀察：訂單編號 A-123/);
  assert.match(text, /動作索引：1/);
  assert.match(text, /受阻原因：找不到符合的按鈕/);
  assert.match(text, /屬性：background-color/);
  assert.match(text, /預期：rgb\(12, 34, 56\)/);
  assert.match(text, /觀察：rgb\(200, 10, 10\)/);
  assert.match(text, /屬性摘要：digest-abc/);
  assert.match(text, /擷取時間：2026-10-09T00:00:00.000Z/);
  assert.match(text, /來源：模擬（mock）/);
  assert.match(text, /Fixture：checkout-pass@3/);
  assert.match(text, /Adapter：mock-1/);

  assert.match(text, /AC-2/);
  assert.match(text, /未指定/);
  assert.match(text, /未覆蓋/);
  assert.match(text, /Jira CHUM-42/);
  assert.match(text, /角色結果/);
  assert.match(text, /報告產物/);
  assert.match(text, /artifact:requirements:1/);
  assert.match(text, /可用既有參照/);
  assert.match(text, /artifact:plan:1/);
  assert.match(text, /重用與相容性由伺服器判定/);

  assert.doesNotMatch(html, /通過/);
  assert.doesNotMatch(html, /PASS/);
  assert.doesNotMatch(html, /green|emerald/);
  assert.doesNotMatch(html, /附屬對話|side-chat|SideChatPane/);
});

test("report metadata is escaped and a missing plan stays defensive", () => {
  const escaped = renderToStaticMarkup(
    <TestingPanel
      view={finishedView(
        report({
          requirements: {
            ...requirements,
            goal: '<script>alert(1)</script>"><img src=x>',
          },
          plan: null,
          coverage: [{ criterionId: "AC-9", caseId: null, checkId: null, state: "uncovered" }],
        }),
      )}
    />,
  );
  assert.match(escaped, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(escaped, /<script>/);
  assert.doesNotMatch(escaped, /<img/);
  assert.match(plainText(escaped), /需求缺失|計畫缺失/);
  assert.match(plainText(escaped), /AC-9/);
  assert.match(plainText(escaped), /未覆蓋/);
  assert.doesNotMatch(escaped, /data-criterion-id/);

  const missingBoth = renderToStaticMarkup(
    <TestingPanel view={finishedView(report({ requirements: null, plan: null, coverage: [] }))} />,
  );
  assert.match(plainText(missingBoth), /需求缺失，未取得來源內容/);
  assert.match(plainText(missingBoth), /計畫缺失，未產生案例與檢查/);
  assert.match(plainText(missingBoth), /沒有覆蓋資料。/);
  assert.doesNotMatch(missingBoth, /data-criterion-id|未覆蓋/);
});

test("a blocked acceptance labels root cancellation without touching completed rows", () => {
  const blocked = renderToStaticMarkup(
    <TestingPanel
      view={finishedView(
        report({
          acceptance: {
            verdict: "blocked",
            reasons: ["root_cancelled", "coverage_incomplete"],
          },
        }),
      )}
    />,
  );
  const text = plainText(blocked);
  assert.match(blocked, /data-verdict="blocked"/);
  assert.match(text, /受阻/);
  assert.match(text, /執行已取消/);
  assert.match(text, /root_cancelled/);
  assert.match(text, /覆蓋不完整/);
  assert.match(blocked, /data-role="ac" data-status="terminal" data-outcome="completed"/);
  assert.match(text, /已完成/);
  assert.match(text, /模擬符合/);
});

test("prototype-like acceptance reasons render as escaped fallback text", () => {
  const reasons = ["__proto__", "constructor", "toString", "role_ac___proto__"] as const;
  const unsafeText = '<img src=x onerror="alert(1)">';
  const html = renderToStaticMarkup(
    <TestingPanel
      view={finishedView(
        report({
          acceptance: { verdict: "blocked", reasons: [...reasons, unsafeText] },
        }),
      )}
    />,
  );
  const text = plainText(html);

  for (const reason of reasons.slice(0, 3)) {
    assert.ok(text.includes(`${reason}（${reason}）`));
  }

  assert.ok(text.includes("Test AC：__proto__（role_ac___proto__）"));
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(html, /<img\b/);
});

test("the polite status summary names all four roles and their waiting states", () => {
  const view = activeView({
    atlassian: { status: "waiting", reason: "dependency" },
    planner: { status: "waiting", reason: "dispatch" },
    ac: { status: "waiting", reason: "dependency" },
    ui: { status: "not_required", reason: "no_style_checks" },
  });
  const html = renderToStaticMarkup(<TestingPanel view={view} />);
  const announcement = statusAnnouncement(html);

  assert.match(announcement, /測試進行中/);
  assert.match(announcement, /Atlassian：等待相依/);
  assert.match(announcement, /Test Planner：等待派工/);
  assert.match(announcement, /Test AC：等待相依/);
  assert.match(announcement, /Test UI：不需要/);
});

test("the polite status summary distinguishes model and tool activity without raw tool details", () => {
  const view = activeView({
    atlassian: { status: "terminal", outcome: "completed", reasonCode: "ok" },
    planner: { status: "running", activity: "model" },
    ac: {
      status: "tool_activity",
      active: [{ toolName: "private_tool_name", route: "direct", startedAt: "secret-time" }],
    },
    ui: { status: "not_required", reason: "no_style_checks" },
  });
  const html = renderToStaticMarkup(<TestingPanel view={view} />);
  const announcement = statusAnnouncement(html);

  assert.match(announcement, /Test Planner：執行中（模型推理中）/);
  assert.match(announcement, /Test AC：工具活動（1 個工具）/);
  assert.doesNotMatch(announcement, /private_tool_name|secret-time/);
  assert.doesNotMatch(announcement, /目標：|測試報告/);
});

test("server cancellation and finished states receive concise live summaries", () => {
  const cancelling = cancellingView({
    atlassian: { status: "terminal", outcome: "completed", reasonCode: "ok" },
    planner: { status: "running", activity: "tool" },
    ac: {
      status: "cancelling",
      active: [{ toolName: "private_tool_name", route: "direct", startedAt: "secret-time" }],
    },
    ui: { status: "not_required", reason: "no_style_checks" },
  });
  const cancellingSummary = statusAnnouncement(
    renderToStaticMarkup(<TestingPanel view={cancelling} />),
  );
  assert.match(cancellingSummary, /伺服器已接受取消，尚未確認停止/);
  assert.match(cancellingSummary, /Test AC：取消中，尚未確認停止/);
  assert.doesNotMatch(cancellingSummary, /private_tool_name|secret-time/);

  const finishedSummary = statusAnnouncement(
    renderToStaticMarkup(<TestingPanel view={finishedView(report())} />),
  );
  assert.match(finishedSummary, /測試已結束/);
  assert.match(finishedSummary, /Atlassian：已完成/);
  assert.match(finishedSummary, /Test Planner：已完成/);
  assert.match(finishedSummary, /Test AC：已完成/);
  assert.match(finishedSummary, /Test UI：不需要/);
  assert.doesNotMatch(finishedSummary, /驗證結帳流程與樣式|模擬結果只描述/);
});

test("a planner card shows only its own result, summary, and artifact", () => {
  const view: TestView = {
    ...activeView(completedRows),
    state: "finished",
    task: {
      version: 2,
      role: "planner",
      summary: "Plan checkout only",
      result: { kind: "plan", ref: availableArtifact, payload: plan },
    },
    report: null,
  };
  const markup = renderToStaticMarkup(<TestingPanel view={view} />);
  assert.match(markup, /Plan checkout only/);
  assert.match(plainText(markup), /AC-1<\/span> · 送出後顯示訂單成立<\/li>/);
  assert.match(markup, /待解決：來源中有 1 條敘述無法解析/);
  assert.match(markup, /結帳成功/);
  assert.match(markup, /artifact:plan:1/);
  assert.doesNotMatch(markup, /測試報告|覆蓋不完整|AC 結果缺失|Test AC|Test UI/);
});

test("terminal delegated cards default to a collapsed summary while retaining every result", () => {
  for (const [outcome, label] of [
    ["completed", "已完成"],
    ["failed", "失敗"],
    ["cancelled", "已取消"],
  ] as const) {
    const view: TestView = {
      ...activeView({
        ...completedRows,
        planner: { status: "terminal", outcome, reasonCode: `reason-${outcome}` },
      }),
      state: "finished",
      task: {
        version: 2,
        role: "planner",
        summary: "Plan checkout only",
        result: { kind: "plan", ref: availableArtifact, payload: plan },
      },
      report: null,
    };
    const markup = renderToStaticMarkup(<TestingPanel view={view} onCancel={async () => {}} />);
    assert.match(markup, /<details(?![^>]*\bopen=)[^>]*>/);
    const summary = markup.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1] ?? "";
    assert.match(summary, /Plan checkout only/);
    assert.match(summary, new RegExp(label));
    assert.match(markup, /結帳成功/);
    assert.match(markup, /artifact:plan:1/);
    assert.match(markup, new RegExp(`reason-${outcome}`));
    assert.doesNotMatch(markup, /aria-label="取消"/);
  }
});

test("active and cancelling delegated cards keep their progress visible", () => {
  for (const state of ["active", "cancelling"] as const) {
    const view: TestView = {
      ...activeView(completedRows),
      state,
      task: { version: 2, role: "planner", summary: "Planning now", result: null },
      report: null,
    };
    const markup = renderToStaticMarkup(<TestingPanel view={view} />);
    assert.match(markup, /Planning now/);
    assert.doesNotMatch(markup, /<details/);
  }
});

test("a cancelling individual card retains its actual tool activity", () => {
  const view: TestView = {
    ...cancellingView({
      ...completedRows,
      atlassian: {
        status: "cancelling",
        active: [{ toolName: "jira_get_issue", route: "direct", startedAt: "now" }],
      },
    }),
    task: { version: 2, role: "atlassian", summary: "Read checkout", result: null },
    report: null,
  };
  const markup = renderToStaticMarkup(
    <TestingPanel view={view} onCancel={async () => undefined} />,
  );
  assert.match(markup, /jira_get_issue/);
  assert.match(markup, /取消中/);
  assert.doesNotMatch(markup, /Test Planner|Test AC|Test UI/);
});

const deferredPlan: PublicPlan = {
  criteria: [
    { id: "UI-AC-1", statement: "加入購物車按鈕使用品牌色" },
    { id: "UI-AC-2", statement: "停用按鈕維持原色" },
    { id: "UI-AC-3", statement: "按鈕圓角 8px" },
  ],
  unresolved: [],
  cases: [],
  deferredCases: [
    {
      id: "deferred-ui-1",
      title: "加入購物車按鈕樣式",
      steps: ["開啟商品頁", "檢查按鈕外觀"],
      expectations: [
        { criterionId: "UI-AC-1", expectedObservation: "背景色 #2D6A4F，文字白色 16px" },
        { criterionId: "UI-AC-2", expectedObservation: "停用按鈕維持原色且整體不透明度 45%" },
      ],
      reason: "Jira 描述的樣式值沒有綁定設計稿",
    },
  ],
  assignments: { ac: [], ui: [] },
};

function plannerView(
  result: NonNullable<TestView["task"]>["result"],
  planner: ProgressRow = { status: "terminal", outcome: "completed", reasonCode: "completed" },
): TestView {
  return {
    ...activeView({ ...completedRows, planner }),
    state: "finished",
    task: { version: 2, role: "planner", summary: "Plan FETM-78", result },
    report: null,
  };
}

test("deferred cases render separately from executable cases and are never shown as results", () => {
  const markup = plainText(
    renderToStaticMarkup(
      <TestingPanel
        view={plannerView({ kind: "plan", ref: availableArtifact, payload: deferredPlan })}
      />,
    ),
  );
  assert.match(markup, /延後案例/);
  assert.match(markup, /加入購物車按鈕樣式/);
  assert.match(markup, /UI-AC-1/);
  assert.match(markup, /開啟商品頁/);
  assert.match(markup, /背景色 #2D6A4F，文字白色 16px/);
  assert.match(markup, /準則 UI-AC-2，預期：停用按鈕維持原色且整體不透明度 45%/);
  assert.match(markup, /Jira 描述的樣式值沒有綁定設計稿/);
  assert.match(markup, /未自動執行/);
  assert.match(markup, /data-deferred-case-id="deferred-ui-1"/);
  assert.doesNotMatch(markup, /瀏覽器符合|模擬符合/);
  const parsed = parseTestView(
    plannerView({ kind: "plan", ref: availableArtifact, payload: deferredPlan }),
  );
  assert.ok(parsed);
  const reloaded = plainText(renderToStaticMarkup(<TestingPanel view={parsed} />));
  assert.match(reloaded, /準則 UI-AC-1，預期：背景色 #2D6A4F，文字白色 16px/);
  assert.match(reloaded, /準則 UI-AC-2，預期：停用按鈕維持原色且整體不透明度 45%/);
});

test("requirements list host-derived Figma links with source, label, file and node", () => {
  const markup = plainText(
    renderToStaticMarkup(
      <TestingPanel
        view={plannerView({
          kind: "requirements",
          ref: artifact,
          payload: {
            goal: "驗證 <b>連結</b>",
            sources: [
              {
                reference: { kind: "jira", issueKey: "FETM-78" },
                text: "FETM-78 <script>alert(1)</script>",
                links: [],
                digest: "digest-links",
                capturedAt: "2026-10-13T00:00:00.000Z",
              },
            ],
            links: [
              {
                source: { kind: "jira", issueKey: "FETM-78" },
                url: "https://www.figma.com/design/DiPISvcpFmaPsK9QonpeDf?node-id=1-81",
                label: "商品頁 桌面",
                fileKey: "DiPISvcpFmaPsK9QonpeDf",
                nodeId: "1:81",
              },
              {
                source: { kind: "jira", issueKey: "FETM-78" },
                url: "https://www.figma.com/design/DiPISvcpFmaPsK9QonpeDf",
                fileKey: "DiPISvcpFmaPsK9QonpeDf",
              },
            ],
          },
        })}
      />,
    ),
  );
  assert.match(markup, /Figma 連結/);
  assert.match(markup, /商品頁 桌面/);
  assert.match(markup, /Jira FETM-78/);
  assert.match(markup, /節點 1:81/);
  assert.match(markup, /整份檔案/);
  assert.match(markup, /data-figma-file="DiPISvcpFmaPsK9QonpeDf"/);
  assert.match(markup, /FETM-78 &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(markup, /目標：驗證 &lt;b&gt;連結&lt;\/b&gt;/);
  assert.doesNotMatch(markup, /<script>|<b>/);
});

test("deferred coverage and not-required execution roles are labeled truthfully", () => {
  const view = finishedView(
    report({
      plan: deferredPlan,
      results: { ac: [], ui: [] },
      coverage: [
        { criterionId: "UI-AC-1", caseId: "deferred-ui-1", checkId: null, state: "deferred" },
        { criterionId: "UI-AC-3", caseId: null, checkId: null, state: "uncovered" },
      ],
      roleOutcomes: {
        ...completedRows,
        ac: { status: "not_required", reason: "no_functional_checks" },
      },
    }),
    { ...completedRows, ac: { status: "not_required", reason: "no_functional_checks" } },
  );
  const markup = plainText(renderToStaticMarkup(<TestingPanel view={view} />));
  assert.match(markup, /data-coverage-state="deferred"/);
  assert.match(markup, /延後，未自動執行/);
  assert.match(markup, /UI-AC-3<\/span> · 案例 未指定 · 檢查 未指定 · 未覆蓋/);
  assert.match(markup, /無功能檢查，不需要派工/);
});

test("a failed role shows its bounded validator issues next to the reason code", () => {
  const markup = plainText(
    renderToStaticMarkup(
      <TestingPanel
        view={plannerView(null, {
          status: "terminal",
          outcome: "failed",
          reasonCode: "proposal_rejected",
          issues: [
            "criteria[1].id: duplicate criterion id UI-AC-2",
            "deferredCases[0].steps: Too small",
          ],
        })}
      />,
    ),
  );
  assert.match(markup, /proposal_rejected/);
  assert.match(markup, /驗證問題/);
  assert.match(markup, /criteria\[1\]\.id: duplicate criterion id UI-AC-2/);
  assert.match(markup, /deferredCases\[0\]\.steps: Too small/);
});
