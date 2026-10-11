import "dotenv/config";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  browserOutputSchema,
  type FunctionalCheck,
  type PlanCase,
  type StyleCheck,
} from "../shared/testing";
import { createPlaywrightFixture } from "../server/harness/playwright-check";
import { createUseBrowserTool } from "../server/harness/tools/use-browser";
import { digestOf } from "../server/harness/testing-domain";

const directory = process.env.BROWSER_ARTIFACT_DIRECTORY ?? "/tmp/chum-jev-playwright/runtime";
await mkdir(directory, { recursive: true });
const target = process.env.BROWSER_TARGET_URL ?? "http://localhost:55598/product.html";
const check: FunctionalCheck = {
  id: "heading",
  criterionId: "demo",
  kind: "functional",
  expectedObservation: "原味司康",
  observation: {
    kind: "text",
    target: "商品區的 h1 主標題，文字是原味司康，不是導覽連結或麵包屑",
    comparison: "equals",
  },
};
const fail: FunctionalCheck = {
  ...check,
  id: "intentional-failure",
  expectedObservation: "This is deliberately not the product name",
};
const blocked: FunctionalCheck = {
  id: "legacy-blocked",
  criterionId: "demo",
  kind: "functional",
  expectedObservation: "No executable observation",
};
const hidden: FunctionalCheck = {
  ...check,
  id: "hidden-storage-alert",
  expectedObservation: "false",
  observation: {
    kind: "visible",
    target:
      "既有 DOM 中 data-storage-error 標記且 role 為 alert 的 P 儲存錯誤訊息節點，即使隱藏且沒有文字仍選此節點",
    comparison: "equals",
  },
};
const hiddenTrue: FunctionalCheck = {
  ...hidden,
  id: "hidden-storage-alert-expected-true",
  expectedObservation: "true",
};
const absent: FunctionalCheck = {
  ...hidden,
  id: "absent-target",
  observation: {
    kind: "visible",
    target:
      "data-nonexistent-browser-proof 標記的獨角獸錯誤訊息節點，頁面不存在此節點時選 none，不可選其他錯誤訊息",
    comparison: "equals",
  },
};
const planCase: PlanCase = {
  id: "demo-case",
  title: "Chinese heading and action",
  preconditions: [],
  actions: [
    { kind: "navigate", path: "/product.html" },
    { kind: "click", target: "加入購物車 · NT$100 的按鈕" },
  ],
  checks: [check, fail, blocked, hidden, hiddenTrue, absent],
};
const attempt = randomUUID();
const fixture = createPlaywrightFixture(target, "ac", undefined, directory, attempt);
const ac = createUseBrowserTool({
  role: "ac",
  cases: [planCase],
  checks: planCase.checks,
  fixture,
  figmaProperties: null,
  designCapture: null,
});
const acOutputs = await Promise.all(
  planCase.checks.map(async (item) =>
    browserOutputSchema.parse(await ac.execute!({ checkId: item.id })),
  ),
);
const design = { fileKey: "independent-demo-css-fixture-not-figma", nodeId: "primary-button" };
const style: StyleCheck = {
  id: "button-color",
  criterionId: "demo-css",
  kind: "style",
  design,
  target: "加入購物車 · NT$100 的 button 按鈕",
  property: "backgroundColor",
  tolerance: { kind: "exact" },
};
const width: StyleCheck = {
  ...style,
  id: "cart-count-width",
  target: "導覽列購物車連結內，文字只有 0 的 span 數量徽章",
  property: "width",
};
const height: StyleCheck = { ...width, id: "cart-count-height", property: "height" };
const styleCase: PlanCase = {
  id: "demo-ui",
  title: "Independent CSS expectation",
  preconditions: [],
  actions: [{ kind: "navigate", path: "/product.html" }],
  checks: [style, width, height],
};
const properties = { backgroundColor: "rgba(40, 77, 59, 1)", width: "28px", height: "28px" };
const ui = createUseBrowserTool({
  role: "ui",
  cases: [styleCase],
  checks: styleCase.checks,
  fixture: createPlaywrightFixture(target, "ui", undefined, directory),
  figmaProperties: properties,
  designCapture: {
    reference: design,
    propertiesDigest: digestOf(properties),
    complete: true,
    capturedAt: new Date().toISOString(),
  },
});
const mixedUi = await createPlaywrightFixture(target, "ui", undefined, directory).run!(
  { ...planCase, id: "mixed-ui-blocked", checks: [...planCase.checks, style] },
  style,
);
const uiOutputs = await Promise.all(
  styleCase.checks.map(async (item) =>
    browserOutputSchema.parse(await ui.execute!({ checkId: item.id })),
  ),
);
const orderCheck: FunctionalCheck = {
  ...check,
  id: "order-note",
  expectedObservation: "Browser verification note",
  observation: {
    kind: "text",
    target: "訂單明細內的訂單備註段落，文字 Browser verification note",
    comparison: "equals",
  },
};
const orderUrl: FunctionalCheck = {
  ...check,
  id: "order-url",
  expectedObservation: new URL("/order.html", target).href,
  observation: { kind: "url", comparison: "equals" },
};
const orderQuantity: FunctionalCheck = {
  ...check,
  id: "order-quantity",
  expectedObservation: "1",
  observation: {
    kind: "text",
    target: "訂單明細原味司康 × 後面的訂購數量 SPAN，帶有 data-order-quantity 標記，不是購物車徽章",
    comparison: "equals",
  },
};
const checkout: PlanCase = {
  id: "checkout",
  title: "Isolated complete checkout",
  preconditions: [],
  actions: [
    { kind: "navigate", path: "/product.html" },
    { kind: "click", target: "加入購物車 · NT$100 的按鈕" },
    { kind: "navigate", path: "/cart.html" },
    { kind: "navigate", path: "/checkout.html" },
    { kind: "fill", target: "訂單備註的 textarea 輸入欄位", value: "Browser verification note" },
    { kind: "click", target: "確認並送出訂單 的提交按鈕" },
  ],
  checks: [orderCheck, orderUrl, orderQuantity],
};
const checkoutTool = createUseBrowserTool({
  role: "ac",
  cases: [checkout],
  checks: checkout.checks,
  fixture: createPlaywrightFixture(target, "ac", undefined, directory),
  figmaProperties: null,
  designCapture: null,
});
const checkoutOutputs = await Promise.all(
  checkout.checks.map(async (item) =>
    browserOutputSchema.parse(await checkoutTool.execute!({ checkId: item.id })),
  ),
);
const cartCheck: FunctionalCheck = {
  ...check,
  id: "cart-quantity",
  expectedObservation: "1",
  observation: {
    kind: "text",
    target: "商品數量調整器中的 OUTPUT 元素，aria-label 是原味司康數量，位於減少與增加按鈕之間",
    comparison: "equals",
  },
};
const cart: PlanCase = {
  ...checkout,
  id: "parallel-cart",
  title: "Parallel isolated carts",
  actions: checkout.actions.slice(0, 3),
  checks: [cartCheck],
};
const parallel = await Promise.all(
  [0, 1].map(async () => {
    const tool = createUseBrowserTool({
      role: "ac",
      cases: [cart],
      checks: cart.checks,
      fixture: createPlaywrightFixture(target, "ac", undefined, directory),
      figmaProperties: null,
      designCapture: null,
    });

    return Promise.all(
      cart.checks.map(async (item) =>
        browserOutputSchema.parse(await tool.execute!({ checkId: item.id })),
      ),
    );
  }),
);
const controller = new AbortController();
const cancelledFixture = createPlaywrightFixture(target, "ac", controller.signal, directory);
const pending = cancelledFixture.run!(planCase, check);
setTimeout(() => controller.abort(), 250);
const cancelled = await pending;
const replay = await createPlaywrightFixture(target, "ac", undefined, directory, attempt).run!(
  planCase,
  check,
);
const output = {
  sourceBoundary:
    "UI expectations are independent demo-site/styles.css fixtures, not Figma. No Jira source claimed. Two own browser contexts; no main app proof.",
  ac: acOutputs,
  ui: uiOutputs,
  mixedUi,
  parallel,
  checkout: checkoutOutputs,
  cancelled,
  replay,
};
await writeFile(`${directory}/live-results.json`, JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
assert.deepEqual(
  acOutputs.map((item) => item.evidence.outcome),
  ["pass", "fail", "blocked", "pass", "fail", "blocked"],
);
assert.deepEqual(
  uiOutputs.map((item) => item.evidence.outcome),
  ["inside_tolerance", "inside_tolerance", "inside_tolerance"],
);
assert.deepEqual(
  parallel.map((items) => items.map((item) => item.evidence.outcome)),
  [["pass"], ["pass"]],
);

if (process.env.BROWSER_REQUIRE_CHECKOUT === "1") {
  assert.deepEqual(
    checkoutOutputs.map((item) => item.evidence.outcome),
    ["pass", "pass", "pass"],
  );
}

assert.deepEqual(
  acOutputs
    .slice(3, 5)
    .map((item) => ("observed" in item.evidence ? item.evidence.observed : undefined)),
  ["false", "false"],
);
assert.equal("observed" in acOutputs[5]!.evidence, false);
assert.equal(mixedUi.state, "blocked");
assert.match(mixedUi.state === "blocked" ? mixedUi.reason : "", /ui_navigation_only/);
assert.deepEqual(mixedUi.browser, { selections: [] });
assert.equal("observed" in mixedUi, false);
assert.equal(cancelled.state, "blocked");
assert.equal(replay.state, "blocked");
console.log(
  `Checkout outcomes: ${checkoutOutputs.map((item) => item.evidence.outcome).join(", ")}. ${checkoutOutputs.every((item) => item.evidence.outcome === "pass") ? "Complete checkout verified on this target." : "Checkout is not verified; inspect the retained outcomes and redirect evidence."}`,
);
console.log(
  "PASS: real Jev and Chromium AC/UI, hidden visibility false and true failure, absent target blocked, read-only UI rejection, case memoization, cancellation, durable replay refusal",
);
