import assert from "node:assert/strict";
import { test } from "node:test";
import l1 from "../../evals/planner/l1.mjs";

type L1Result = {
  pass: boolean;
  score: number;
  reason: string;
  componentResults: { pass: boolean; score: number; reason: string }[];
};

const grade = (plan: unknown, config: Record<string, unknown>): L1Result =>
  l1(plan, { config }) as L1Result;

const loginPlan = {
  criteria: [
    { id: "AC-1", statement: "以錯誤密碼登入時顯示帳號或密碼錯誤" },
    { id: "AC-2", statement: "Email 空白時顯示請輸入 Email" },
  ],
  unresolved: [],
  cases: [
    {
      id: "case-1",
      title: "錯誤密碼",
      preconditions: [],
      actions: [
        { kind: "navigate", path: "/login" },
        { kind: "fill", target: "Email 欄位", value: "user@example.com" },
        { kind: "fill", target: "密碼欄位", value: "wrong-password" },
        { kind: "click", target: "登入按鈕" },
      ],
      checks: [
        {
          id: "check-1",
          criterionId: "AC-1",
          kind: "functional",
          expectedObservation: "表單上方顯示「帳號或密碼錯誤」",
          observation: { kind: "text", target: "表單上方錯誤訊息", comparison: "equals" },
        },
      ],
    },
    {
      id: "case-2",
      title: "空白 Email",
      preconditions: [],
      actions: [
        { kind: "navigate", path: "/login" },
        { kind: "click", target: "登入按鈕" },
      ],
      checks: [
        {
          id: "check-2",
          criterionId: "AC-2",
          kind: "functional",
          expectedObservation: "Email 欄位下方顯示「請輸入 Email」",
          observation: { kind: "text", target: "Email 欄位下方提示", comparison: "equals" },
        },
      ],
    },
  ],
};

const loginConfig = {
  executable: ["AC-1", "AC-2"],
  literals: { "AC-1": ["帳號或密碼錯誤"], "AC-2": ["請輸入 Email"] },
  allowedPaths: ["/login"],
};

const richPlan = {
  criteria: [
    { id: "AC-1", statement: "點擊確認付款後顯示付款處理中" },
    { id: "UI-1", statement: "確認付款主按鈕符合綁定設計稿" },
    { id: "UI-2", statement: "停用狀態不透明度符合設計稿" },
  ],
  unresolved: ["UI-2 需要 45:121 節點的設計稿"],
  cases: [
    {
      id: "case-1",
      title: "付款處理中",
      preconditions: [],
      actions: [
        { kind: "navigate", path: "/checkout" },
        { kind: "fill", target: "優惠碼欄位", value: "SAVE10" },
        { kind: "click", target: "確認付款" },
      ],
      checks: [
        {
          id: "check-1",
          criterionId: "AC-1",
          kind: "functional",
          expectedObservation: "按鈕下方顯示「付款處理中…」",
          observation: { kind: "text", target: "按鈕下方提示", comparison: "equals" },
        },
        {
          id: "check-2",
          criterionId: "AC-1",
          kind: "functional",
          expectedObservation: "停留在 /checkout",
          observation: { kind: "url", comparison: "contains" },
        },
      ],
    },
    {
      id: "case-2",
      title: "確認付款主按鈕寬度",
      preconditions: [],
      actions: [{ kind: "navigate", path: "/checkout" }],
      checks: [
        {
          id: "check-3",
          criterionId: "UI-1",
          kind: "style",
          design: { fileKey: "EVALfig0001", nodeId: "45:120" },
          target: "確認付款主按鈕",
          property: "width",
          tolerance: { kind: "exact" },
        },
      ],
    },
  ],
  deferredCases: [
    {
      id: "deferred-1",
      title: "停用狀態不透明度",
      steps: ["將確認付款按鈕設為停用", "讀取整體不透明度"],
      reason: "45:121 未綁定設計稿，且不透明度需要信任的 Figma 擷取",
      expectations: [
        {
          criterionId: "UI-2",
          expectedObservation: "整體不透明度符合 #173c29 設計稿的停用狀態規格",
        },
      ],
    },
  ],
};

const richConfig = {
  executable: ["AC-1", "UI-1"],
  deferred: ["UI-2"],
  either: ["AC-1", "UI-2"],
  excluded: ["AC-9"],
  literals: { "AC-1": ["付款處理中…"], "UI-2": ["#173c29"] },
  boundaries: { "AC-1": ["SAVE10"] },
  minCriteria: 3,
  observations: ["付款處理中…"],
  unresolved: "required",
  styleChecks: "required",
  design: { fileKey: "EVALfig0001", nodeId: "45:120" },
  allowedPaths: ["/checkout"],
  forbidden: ["hunter2", "evil.example"],
};

test("grades a fully passing labeled plan", () => {
  const result = grade(loginPlan, loginConfig);

  assert.deepEqual(result.componentResults, [
    { pass: true, score: 1, reason: "executable AC-1 ok" },
    { pass: true, score: 1, reason: "executable AC-2 ok" },
    { pass: true, score: 1, reason: "literals AC-1 ok" },
    { pass: true, score: 1, reason: "literals AC-2 ok" },
    { pass: true, score: 1, reason: "allowedPaths ok" },
  ]);
  assert.equal(result.pass, true);
  assert.equal(result.score, 1);
  assert.equal(result.reason, "All L1 rules passed");
});

test("fails an executable criterion with no executable check", () => {
  const plan = { ...loginPlan, cases: [loginPlan.cases[0]] };
  const result = grade(plan, { executable: ["AC-1", "AC-2"], allowedPaths: ["/login"] });

  assert.deepEqual(result.componentResults, [
    { pass: true, score: 1, reason: "executable AC-1 ok" },
    { pass: false, score: 0, reason: "executable AC-2: criterion AC-2 has no executable check" },
    { pass: true, score: 1, reason: "allowedPaths ok" },
  ]);
  assert.equal(result.pass, false);
  assert.equal(result.score, 2 / 3);
  assert.equal(
    result.reason,
    "L1 rules failed: executable AC-2: criterion AC-2 has no executable check",
  );
});

test("fails an excluded criterion that is defined and referenced", () => {
  const plan = {
    ...loginPlan,
    criteria: [...loginPlan.criteria, { id: "AC-3", statement: "範圍外條件" }],
    cases: [
      {
        ...loginPlan.cases[0],
        checks: [
          ...loginPlan.cases[0].checks,
          {
            id: "check-3",
            criterionId: "AC-3",
            kind: "functional",
            expectedObservation: "範圍外結果",
            observation: { kind: "text", target: "頁面", comparison: "equals" },
          },
        ],
      },
      loginPlan.cases[1],
    ],
  };
  const result = grade(plan, { excluded: ["AC-3"] });

  assert.deepEqual(result.componentResults, [
    {
      pass: false,
      score: 0,
      reason:
        "excluded AC-3: excluded criterion AC-3 is defined in criteria; excluded criterion AC-3 is referenced by check check-3",
    },
  ]);
  assert.equal(result.pass, false);
  assert.equal(result.score, 0);
});

test("fails a literal missing from every expected observation", () => {
  const config = { literals: { "AC-1": ["帳號或密碼錯誤", "再試一次"] } };
  const result = grade(loginPlan, config);

  assert.deepEqual(result.componentResults, [
    {
      pass: false,
      score: 0,
      reason: 'literals AC-1: literal "再試一次" is missing from every expectedObservation of AC-1',
    },
  ]);
  assert.equal(result.score, 0);
});

test("fails a navigate path outside allowedPaths", () => {
  const plan = {
    ...loginPlan,
    cases: [
      {
        ...loginPlan.cases[0],
        actions: [{ kind: "navigate", path: "/signup" }, ...loginPlan.cases[0].actions.slice(1)],
      },
      loginPlan.cases[1],
    ],
  };
  const result = grade(plan, { allowedPaths: ["/login"] });

  assert.deepEqual(result.componentResults, [
    { pass: false, score: 0, reason: 'allowedPaths: navigate path "/signup" is not allowed' },
  ]);
});

test("fails a rejected planner output with its issues", () => {
  const rejected = {
    state: "failed",
    reason: "proposal_rejected",
    issues: ["Check check-1 requires a typed executable observation or style target"],
  };
  const result = grade(rejected, { executable: ["AC-1"] });

  assert.deepEqual(result, {
    pass: false,
    score: 0,
    reason:
      "Planner rejected the proposal: Check check-1 requires a typed executable observation or style target",
  });
});

test("grades a mixed plan against every rule family", () => {
  const result = grade(richPlan, richConfig);

  assert.deepEqual(
    result.componentResults.map((entry: { reason: string }) => entry.reason),
    [
      "executable AC-1 ok",
      "executable UI-1 ok",
      "deferred UI-2 ok",
      "either AC-1 ok",
      "either UI-2 ok",
      "excluded AC-9 ok",
      "literals AC-1 ok",
      "literals UI-2 ok",
      "boundaries AC-1 ok",
      "minCriteria ok",
      "observations ok",
      "unresolved ok",
      "styleChecks ok",
      "design ok",
      "allowedPaths ok",
      "forbidden ok",
    ],
  );
  assert.equal(result.pass, true);
  assert.equal(result.score, 1);
  assert.equal(result.reason, "All L1 rules passed");
});

test("passes boundary values that stand alone in fill values and expected observations", () => {
  const plan = {
    criteria: [
      { id: "AC-1", statement: "年齡邊界" },
      { id: "AC-2", statement: "金額" },
      { id: "AC-3", statement: "延後的折扣" },
    ],
    unresolved: [],
    cases: [
      {
        id: "case-1",
        title: "年齡下限",
        preconditions: [],
        actions: [
          { kind: "navigate", path: "/profile" },
          { kind: "fill", target: "年齡欄位", value: "18" },
        ],
        checks: [
          {
            id: "check-1",
            criterionId: "AC-1",
            kind: "functional",
            expectedObservation: "年齡須介於 18 到 65 歲",
            observation: { kind: "text", target: "年齡提示", comparison: "contains" },
          },
          {
            id: "check-2",
            criterionId: "AC-2",
            kind: "functional",
            expectedObservation: "應付金額顯示 NT$700。",
            observation: { kind: "text", target: "應付金額", comparison: "contains" },
          },
        ],
      },
    ],
    deferredCases: [
      {
        id: "deferred-1",
        title: "折扣",
        steps: ["購買三張票"],
        reason: "需要後台設定",
        expectations: [{ criterionId: "AC-3", expectedObservation: "折扣後單價 20.5 元" }],
      },
    ],
  };
  const result = grade(plan, {
    boundaries: { "AC-1": ["18", "65"], "AC-2": ["NT$700"], "AC-3": ["20.5"] },
  });

  assert.deepEqual(
    result.componentResults?.map((entry) => entry.reason),
    ["boundaries AC-1 ok", "boundaries AC-2 ok", "boundaries AC-3 ok"],
  );
  assert.equal(result.pass, true);
});

test("fails a boundary value preceded by a bare decimal point or found only in a case that does not cover the criterion", () => {
  const plan = {
    criteria: [
      { id: "AC-1", statement: "年齡邊界" },
      { id: "AC-2", statement: "其他" },
    ],
    unresolved: [],
    cases: [
      {
        id: "case-1",
        title: "小數",
        preconditions: [],
        actions: [
          { kind: "navigate", path: "/profile" },
          { kind: "fill", target: "年齡欄位", value: ".18" },
        ],
        checks: [
          {
            id: "check-1",
            criterionId: "AC-1",
            kind: "functional",
            expectedObservation: "結果正確",
            observation: { kind: "text", target: "年齡提示", comparison: "equals" },
          },
        ],
      },
      {
        id: "case-2",
        title: "其他",
        preconditions: [],
        actions: [
          { kind: "navigate", path: "/profile" },
          { kind: "fill", target: "年齡欄位", value: "65" },
        ],
        checks: [
          {
            id: "check-2",
            criterionId: "AC-2",
            kind: "functional",
            expectedObservation: "結果正確",
            observation: { kind: "text", target: "年齡提示", comparison: "equals" },
          },
        ],
      },
    ],
  };
  const result = grade(plan, { boundaries: { "AC-1": ["18", "65"] } });

  assert.deepEqual(result.componentResults, [
    {
      pass: false,
      score: 0,
      reason:
        'boundaries AC-1: boundary "18" is missing from every fill value and expectedObservation of AC-1; boundary "65" is missing from every fill value and expectedObservation of AC-1',
    },
  ]);
});

test("fails boundary values that only appear inside larger numbers", () => {
  const plan = {
    criteria: [{ id: "AC-1", statement: "年齡邊界" }],
    unresolved: [],
    cases: [
      {
        id: "case-1",
        title: "年齡",
        preconditions: [],
        actions: [
          { kind: "navigate", path: "/profile" },
          { kind: "fill", target: "年齡欄位", value: "118165" },
        ],
        checks: [
          {
            id: "check-1",
            criterionId: "AC-1",
            kind: "functional",
            expectedObservation: "顯示 120.50 歲",
            observation: { kind: "text", target: "年齡欄位", comparison: "equals" },
          },
        ],
      },
    ],
  };
  const result = grade(plan, { boundaries: { "AC-1": ["18", "20.5"] } });

  assert.deepEqual(result.componentResults, [
    {
      pass: false,
      score: 0,
      reason:
        'boundaries AC-1: boundary "18" is missing from every fill value and expectedObservation of AC-1; boundary "20.5" is missing from every fill value and expectedObservation of AC-1',
    },
  ]);
});

test("fails a boundary value that appears only in deferred steps", () => {
  const plan = {
    criteria: [{ id: "AC-1", statement: "年齡邊界" }],
    unresolved: [],
    cases: [],
    deferredCases: [
      {
        id: "deferred-1",
        title: "停用年齡欄位",
        steps: ["輸入 18", "送出"],
        reason: "需要不可執行的設定",
        expectations: [{ criterionId: "AC-1", expectedObservation: "結果正確" }],
      },
    ],
  };
  const result = grade(plan, { boundaries: { "AC-1": ["18"] } });

  assert.deepEqual(result.componentResults, [
    {
      pass: false,
      score: 0,
      reason:
        'boundaries AC-1: boundary "18" is missing from every fill value and expectedObservation of AC-1',
    },
  ]);
});

test("fails a style check whose design does not match the case config", () => {
  const plan = {
    criteria: [{ id: "UI-1", statement: "按鈕寬度符合設計稿" }],
    unresolved: [],
    cases: [
      {
        id: "case-1",
        title: "按鈕寬度",
        preconditions: [],
        actions: [{ kind: "navigate", path: "/checkout" }],
        checks: [
          {
            id: "check-1",
            criterionId: "UI-1",
            kind: "style",
            design: { fileKey: "OTHER", nodeId: "9:9" },
            target: "確認付款主按鈕",
            property: "width",
            tolerance: { kind: "exact" },
          },
        ],
      },
    ],
  };
  const result = grade(plan, { design: { fileKey: "F", nodeId: "45:120" } });

  assert.deepEqual(result.componentResults, [
    {
      pass: false,
      score: 0,
      reason:
        'design: style check check-1 references {"fileKey":"OTHER","nodeId":"9:9"} instead of F / 45:120',
    },
  ]);
});

test("fails a deferred criterion that has an executable check", () => {
  const result = grade(loginPlan, { deferred: ["AC-1"] });

  assert.deepEqual(result.componentResults, [
    {
      pass: false,
      score: 0,
      reason: "deferred AC-1: criterion AC-1 has an executable check",
    },
  ]);
});

test("fails an either criterion with no check or deferred expectation", () => {
  const plan = { ...loginPlan, cases: [loginPlan.cases[0]] };
  const result = grade(plan, { either: ["AC-2"] });

  assert.deepEqual(result.componentResults, [
    {
      pass: false,
      score: 0,
      reason: "either AC-2: criterion AC-2 has no check or deferred expectation",
    },
  ]);
});

test("fails a forbidden style check", () => {
  const plan = {
    ...loginPlan,
    cases: [
      {
        ...loginPlan.cases[0],
        checks: [
          {
            id: "check-1",
            criterionId: "AC-1",
            kind: "style",
            design: { fileKey: "F", nodeId: "n" },
            target: "登入按鈕",
            property: "width",
            tolerance: { kind: "exact" },
          },
        ],
      },
    ],
  };
  const result = grade(plan, { styleChecks: "forbidden" });

  assert.deepEqual(result.componentResults, [
    { pass: false, score: 0, reason: "styleChecks: style check check-1 is forbidden" },
  ]);
});

test("fails a required observation that no expectedObservation contains", () => {
  const result = grade(loginPlan, { observations: ["付款處理中…"] });

  assert.deepEqual(result.componentResults, [
    {
      pass: false,
      score: 0,
      reason: 'observations: observation "付款處理中…" is missing from every expectedObservation',
    },
  ]);
});

test("fails an excluded criterion referenced only by a deferred expectation", () => {
  const plan = {
    ...loginPlan,
    deferredCases: [
      {
        id: "deferred-1",
        title: "範圍外條件",
        steps: ["執行範圍外步驟"],
        reason: "不可執行",
        expectations: [{ criterionId: "AC-9", expectedObservation: "不該被引用" }],
      },
    ],
  };
  const result = grade(plan, { excluded: ["AC-9"] });

  assert.deepEqual(result.componentResults, [
    {
      pass: false,
      score: 0,
      reason: "excluded AC-9: excluded criterion AC-9 is referenced by deferred case deferred-1",
    },
  ]);
});

test("reports each violated scalar rule with a literal reason", () => {
  const plan = {
    criteria: [{ id: "AC-1", statement: "送出表單顯示結果" }],
    unresolved: [],
    cases: [
      {
        id: "c1",
        title: "送出表單",
        preconditions: [],
        actions: [{ kind: "navigate", path: "/b" }],
        checks: [
          {
            id: "k1",
            criterionId: "AC-1",
            kind: "functional",
            expectedObservation: "hunter2 不應出現",
            observation: { kind: "text", target: "頁面", comparison: "equals" },
          },
        ],
      },
    ],
  };
  const config = {
    deferred: ["UI-1"],
    minCriteria: 2,
    functionalChecks: "forbidden",
    unresolved: "required",
    styleChecks: "required",
    design: { fileKey: "F", nodeId: "n" },
    allowedPaths: ["/a"],
    forbidden: ["hunter2"],
  };
  const result = grade(plan, config);

  assert.deepEqual(
    result.componentResults.map((entry: { reason: string }) => entry.reason),
    [
      "deferred UI-1: criterion UI-1 is not defined in criteria",
      "minCriteria: criteria has 1 entries, need at least 2",
      "unresolved: unresolved is empty",
      "functionalChecks: functional check k1 is forbidden",
      "styleChecks: no executable style check exists",
      "design ok",
      'allowedPaths: navigate path "/b" is not allowed',
      'forbidden: forbidden string "hunter2" appears in the plan',
    ],
  );
  assert.equal(result.pass, false);
  assert.equal(result.score, 1 / 8);
  assert.equal(
    result.reason,
    'L1 rules failed: deferred UI-1: criterion UI-1 is not defined in criteria | minCriteria: criteria has 1 entries, need at least 2 | unresolved: unresolved is empty | functionalChecks: functional check k1 is forbidden | styleChecks: no executable style check exists | allowedPaths: navigate path "/b" is not allowed | forbidden: forbidden string "hunter2" appears in the plan',
  );
});
