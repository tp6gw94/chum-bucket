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
  criteria: [
    {
      id: "crit:AC-1",
      key: "AC-1",
      statement: "送出後顯示訂單成立",
      sourceDigest: "digest-1",
      anchor: "anchor-1",
    },
    {
      id: "crit:AC-2",
      key: "AC-2",
      statement: "按鈕使用品牌色",
      sourceDigest: "digest-2",
      anchor: "anchor-2",
    },
  ],
  selection: { kind: "selected", keys: ["AC-1"] },
  unresolved: ["來源中有 1 條敘述無法解析"],
};

const plan: PublicPlan = {
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
          criterionId: "crit:AC-1",
          kind: "functional",
          expectedObservation: "顯示訂單編號",
        },
        {
          id: "check-2",
          criterionId: "crit:AC-2",
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

const functionalEvidence: PublicEvidence = {
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
        criterionId: "crit:AC-1",
        caseId: "case-1",
        checkId: "check-1",
        state: "simulated_pass",
      },
      {
        criterionId: "crit:AC-2",
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
  assert.match(text, /選取範圍：已選 1 項/);
  assert.match(text, /AC-1/);
  assert.match(text, /AC-2/);
  assert.match(text, /（已選）/);
  assert.match(text, /（未選）/);
  assert.match(text, /待解決：來源中有 1 條敘述無法解析/);

  assert.match(text, /結帳成功（案例 case-1）/);
  assert.match(text, /前置條件：購物車已有一件商品/);
  assert.match(text, /預定動作 1：前往 \/checkout/);
  assert.match(text, /預定動作 2：點擊 送出訂單/);
  assert.match(text, /不是實際瀏覽器操作紀錄/);
  assert.match(text, /功能檢查 check-1（準則 crit:AC-1）：預期 顯示訂單編號/);
  assert.match(text, /樣式檢查 check-2（準則 crit:AC-2）：background-color/);
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

  assert.match(text, /crit:AC-2/);
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
          coverage: [{ criterionId: "crit:AC-9", caseId: null, checkId: null, state: "uncovered" }],
        }),
      )}
    />,
  );
  assert.match(escaped, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(escaped, /<script>/);
  assert.doesNotMatch(escaped, /<img/);
  assert.match(plainText(escaped), /需求缺失|計畫缺失/);
  assert.match(plainText(escaped), /crit:AC-9/);
  assert.match(plainText(escaped), /未覆蓋/);

  const missingBoth = renderToStaticMarkup(
    <TestingPanel view={finishedView(report({ requirements: null, plan: null }))} />,
  );
  assert.match(plainText(missingBoth), /需求缺失，未取得固定需求全集/);
  assert.match(plainText(missingBoth), /計畫缺失，未產生案例與檢查/);
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
