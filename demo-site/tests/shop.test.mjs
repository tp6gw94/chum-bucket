import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import test from "node:test";

const require = createRequire(process.env.SCONE_TEST_TOOLS
  ? path.resolve(process.env.SCONE_TEST_TOOLS, "package.json") : import.meta.url);
const { JSDOM } = require("jsdom");
const handler = require("serve-handler");
const site = process.env.SCONE_TEST_SITE || fileURLToPath(new URL("../", import.meta.url));
const script = readFileSync(path.join(site, "shop.js"), "utf8");
const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const receipt = (id, quantity = 1, note = "") => ({ id, quantity, note });

function shop(initialState) {
  let raw = initialState === undefined ? null : JSON.stringify(initialState);
  let unavailable = false;
  const storage = {
    getItem: () => raw,
    setItem: (_, value) => {
      if (unavailable) throw new Error("Storage unavailable");
      raw = value;
    },
  };
  const pages = [];
  return {
    state: () => JSON.parse(raw),
    failWrites: () => { unavailable = true; },
    close: () => pages.forEach((dom) => dom.window.close()),
    open(name, suffix = "", prefix = "/") {
      const url = new URL(`http://localhost${prefix}${name}.html${suffix}`);
      const dom = new JSDOM(readFileSync(path.join(site, `${name}.html`), "utf8"), { url: url.href });
      pages.push(dom);
      const navigations = [];
      const location = {
        search: url.search,
        hash: url.hash,
        assign: (value) => navigations.push(new URL(value, url).href),
      };
      vm.runInNewContext(script, {
        document: dom.window.document, window: dom.window, localStorage: storage,
        URLSearchParams, crypto: webcrypto, location,
      });
      const find = (selector) => dom.window.document.querySelector(selector);
      return {
        find, navigations,
        click: (action) => find(`[data-action=${action}]`).click(),
        submit(note = "") {
          find("#order-note").value = note;
          find("#checkout-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
        },
        event: (type) => dom.window.dispatchEvent(new dom.window.Event(type)),
        hash(value, eventType = "hashchange") {
          location.hash = value;
          dom.window.dispatchEvent(new dom.window.Event(eventType));
        },
      };
    },
  };
}

function withShop(t, initialState) {
  const app = shop(initialState);
  t.after(app.close);
  return app;
}

function expectReceipt(page, order) {
  assert.equal(page.find("[data-order-complete]").hidden, false);
  assert.equal(page.find("[data-no-order]").hidden, true);
  assert.equal(page.find("[data-order-id]").textContent, order.id);
  assert.equal(page.find("[data-order-quantity]").textContent, String(order.quantity));
  assert.equal(page.find("[data-order-note]").textContent, order.note);
}

function expectMissing(page) {
  assert.equal(page.find("[data-order-complete]").hidden, true);
  assert.equal(page.find("[data-no-order]").hidden, false);
}

test("checkout creates a fragment-only receipt URL and clears the cart once", (t) => {
  const app = withShop(t);
  app.open("product").click("add");
  const cart = app.open("cart");
  cart.click("checkout");
  assert.equal(new URL(cart.navigations[0]).pathname, "/checkout.html");
  const checkout = app.open("checkout");
  checkout.submit("  測試備註 <img src=x>  ");
  const url = new URL(checkout.navigations[0]);
  assert.equal(url.pathname, "/order.html");
  assert.equal(url.search, "");
  assert.match(url.hash, /^#order=[0-9a-f-]{36}$/);
  assert.equal(app.state().quantity, 0);
  assert.equal(app.state().orders.length, 1);
  assert.equal(checkout.find("#order-note").value, "");
  assert.equal(checkout.find("[data-submit]").disabled, true);
  checkout.submit();
  assert.equal(checkout.navigations.length, 1);
  assert.equal(app.state().orders.length, 1);
  const order = app.state().orders[0];
  const complete = app.open("order", url.hash);
  expectReceipt(complete, order);
  assert.equal(complete.find("[data-order-total]").textContent, "NT$150");
  assert.equal(complete.find("[data-order-note]").children.length, 0);
  expectReceipt(app.open("order", url.hash), order);
});

test("cart keeps the 0–5 quantity limits, NT$100 price and NT$300 free shipping", (t) => {
  const app = withShop(t);
  const cart = app.open("cart");
  assert.equal(cart.find("[data-action=checkout]").disabled, true);
  assert.equal(cart.find("[data-total]").textContent, "NT$0");
  cart.click("add");
  for (const [quantity, shipping, total] of [[1, 50, 150], [2, 50, 250], [3, 0, 300], [4, 0, 400], [5, 0, 500]]) {
    assert.equal(cart.find("[data-quantity]").textContent, String(quantity));
    assert.equal(cart.find("[data-shipping]").textContent, `NT$${shipping}`);
    assert.equal(cart.find("[data-total]").textContent, `NT$${total}`);
    cart.click("increase");
  }
  assert.equal(app.state().quantity, 5);
  assert.equal(cart.find("[data-action=increase]").disabled, true);
  for (let count = 0; count < 6; count++) cart.click("decrease");
  assert.equal(app.state().quantity, 0);
  assert.equal(cart.find("[data-action=decrease]").disabled, true);
  assert.equal(cart.find("[data-action=checkout]").disabled, true);
});

test("empty checkout cannot create or navigate to an order", (t) => {
  const app = withShop(t, { quantity: 0, orders: [receipt(firstId)] });
  const checkout = app.open("checkout");
  checkout.submit();
  assert.equal(checkout.navigations.length, 0);
  assert.equal(app.state().orders.length, 1);
  assert.equal(checkout.find("[data-empty-checkout]").hidden, false);
});

test("a second purchase preserves the first receipt and restored checkout sees an empty cart", (t) => {
  const app = withShop(t, { quantity: 1 });
  const checkout = app.open("checkout");
  checkout.submit("first");
  const first = app.state().orders[0];
  const product = app.open("product");
  product.click("add");
  product.click("add");
  const secondCheckout = app.open("checkout");
  secondCheckout.submit("second");
  const second = app.state().orders[1];
  assert.notEqual(first.id, second.id);
  expectReceipt(app.open("order", `#order=${second.id}`), second);
  expectReceipt(app.open("order", `#order=${first.id}`), first);
  checkout.event("pageshow");
  assert.equal(checkout.find("[data-submit]").disabled, true);
  checkout.submit();
  assert.equal(app.state().orders.length, 2);
});

test("missing, malformed, unknown, duplicate and conflicting IDs never display another receipt", (t) => {
  const app = withShop(t, { quantity: 0, orders: [receipt(firstId)] });
  for (const suffix of ["", "#order=", "#order=garbage", "#order=%ZZ", `#order=${secondId}`, `#order=${firstId}&order=${firstId}`, `?order=${firstId}&order=${firstId}`, `?order=${firstId}#order=${secondId}`, `?order=${firstId}#order=${firstId}`]) {
    expectMissing(app.open("order", suffix));
  }
});

test("legacy query URLs and singleton storage still open the matching receipt", (t) => {
  const old = receipt(firstId, 3, "legacy");
  const app = withShop(t, { quantity: 2, order: old });
  const page = app.open("order", `?order=${firstId}`);
  expectReceipt(page, old);
  assert.equal(page.find("[data-order-total]").textContent, "NT$300");
  assert.equal(app.state().quantity, 2);
  assert.deepEqual(app.state().orders, [old]);
});

test("hash navigation and back/forward events update the visible receipt", (t) => {
  const first = receipt(firstId, 1, "first");
  const second = receipt(secondId, 3, "second");
  const app = withShop(t, { quantity: 0, orders: [first, second] });
  const page = app.open("order", `#order=${firstId}`);
  expectReceipt(page, first);
  page.hash(`#order=${secondId}`);
  expectReceipt(page, second);
  page.hash("#order=unknown");
  expectMissing(page);
  page.hash(`#order=${firstId}`, "popstate");
  expectReceipt(page, first);
});

test("receipt navigation stays within the served subdirectory", (t) => {
  const app = withShop(t, { quantity: 1 });
  const checkout = app.open("checkout", "", "/demo-site/");
  checkout.submit();
  assert.equal(new URL(checkout.navigations[0]).pathname, "/demo-site/order.html");
});

test("retention is bounded to 20 receipts and an expired link never opens a newer one", (t) => {
  const orders = Array.from({ length: 20 }, () => receipt(webcrypto.randomUUID()));
  const app = withShop(t, { quantity: 1, orders });
  app.open("checkout").submit("newest");
  assert.equal(app.state().orders.length, 20);
  assert.equal(app.state().orders[0].id, orders[1].id);
  expectMissing(app.open("order", `#order=${orders[0].id}`));
  expectReceipt(app.open("order", `#order=${orders[1].id}`), orders[1]);
});

test("failed order persistence leaves the cart and previous receipts unchanged", (t) => {
  const initial = { quantity: 2, orders: [receipt(firstId)] };
  const app = withShop(t, initial);
  const checkout = app.open("checkout");
  app.failWrites();
  checkout.submit("keep for retry");
  assert.deepEqual(app.state(), initial);
  assert.equal(checkout.navigations.length, 0);
  assert.equal(checkout.find("[data-storage-error]").hidden, false);
  assert.equal(checkout.find("[data-submit]").disabled, true);
  assert.equal(checkout.find("#order-note").value, "keep for retry");
});

test("invalid persisted quantities and receipts do not produce a success screen", (t) => {
  const app = withShop(t, { quantity: 99, orders: [receipt(firstId, 0), receipt(secondId, 6)] });
  expectMissing(app.open("order", `#order=${firstId}`));
  assert.equal(app.state().quantity, 0);
  assert.deepEqual(app.state().orders, []);
});

test("the real serve handler drops query on its HTML redirect and serves both root layouts", async () => {
  for (const [root, prefix] of [[site, ""], [path.dirname(site.replace(/\/$/, "")), "/demo-site"]]) {
    const server = http.createServer((request, response) => handler(request, response, { public: root }));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const redirect = await fetch(`${base}${prefix}/order.html?order=${firstId}`, { redirect: "manual" });
      assert.equal(redirect.status, 301);
      assert.equal(redirect.headers.get("location"), `${prefix}/order`);
      await redirect.text();
      const page = await fetch(`${base}${prefix}/order`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /data-order-complete/);
      const scriptResponse = await fetch(`${base}${prefix}/shop.js`);
      assert.equal(scriptResponse.status, 200);
      assert.match(await scriptResponse.text(), /order\.html#order=/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});
