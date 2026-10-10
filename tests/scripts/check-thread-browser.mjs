import assert from "node:assert/strict";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE,
});
const page = await browser.newPage();
const origin = process.env.THREAD_TEST_ORIGIN ?? "http://127.0.0.1:4187";
const id = "d08035f1-07df-49f3-b2d0-5cf5cb2b1e74";
const next = "7d8b4d7a-7a8f-4dac-a076-7f67a8f6c451";
const history = [{ id: "old", role: "user", parts: [{ type: "text", content: "舊訊息" }] }];
const requests = [];
let messages = history;
let hydrateStatus = 200;
let activeRun = null;
let mode = "success";
let probe = false;
const gates = new Map();
function hold(name) {
  const gate = Promise.withResolvers();
  gates.set(name, gate);
  return () => {
    gate.resolve();
    gates.delete(name);
  };
}
const posts = () =>
  requests.filter((request) => request.path === "/api/chat" && request.method === "POST");
const ready = () => page.waitForFunction(() => window.api?.phase === "ready");
function abortForeignOrigin(url, route) {
  if (url.origin !== origin) {
    return route.abort();
  }
}
function isProbeMain(url) {
  return probe && url.pathname === "/src/main.tsx";
}
function isStaticAsset(url) {
  return !url.pathname.startsWith("/api/");
}
async function fulfillProbe(route) {
  const response = await route.fetch();
  const source = await response.text();
  const react = source.match(/import __vite__cjsImport0_react from "([^"]+)"/)[1];
  const dom = source.match(/import __vite__cjsImport1_reactDom_client from "([^"]+)"/)[1];
  return route.fulfill({
    contentType: "text/javascript",
    body: `import React from '${react}'; import ReactDOM from '${dom}'; import {useThread} from '/src/hooks/use-threads.ts'; function Probe(){window.api=useThread('${id}');return React.createElement('pre',{},JSON.stringify({phase:window.api.phase,messages:window.api.messages}));} ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,{},React.createElement(Probe)));`,
  });
}
async function handleThreadCollection(route, method) {
  if (method === "POST") {
    await gates.get("create")?.promise;
  }
  return route.fulfill({
    json:
      method === "POST"
        ? { id: next, title: "新對話" }
        : [
            { id, title: "既有對話" },
            { id: next, title: "另一對話" },
          ],
  });
}
async function handleThreadRevision(route) {
  await gates.get("revision")?.promise;
  if (mode === "revision-fail") {
    return route.fulfill({ status: 503, json: { error: "fixture" } });
  }
  return route.fulfill({ json: { messages: [], revision: 7 } });
}
async function handleHydrate(route) {
  await gates.get("hydrate")?.promise;
  return route.fulfill({
    status: hydrateStatus,
    json: hydrateStatus === 200 ? { messages, activeRun } : { error: "fixture" },
  });
}
const httpErrorModes = new Map([
  ["409", 409],
  ["503", 503],
]);
async function applyChatTransport(route) {
  await gates.get("post")?.promise;
  const status = httpErrorModes.get(mode);
  if (status !== undefined) {
    await route.fulfill({ status, json: { error: "fixture" } });
    return true;
  }
  if (mode === "network") {
    await route.abort();
    return true;
  }
  return false;
}
const terminalByMode = new Map([
  ["success", (runId) => ({ type: "RUN_FINISHED", threadId: id, runId })],
  [
    "failed",
    (runId) => ({ type: "RUN_ERROR", message: "失敗", metadata: { tanstack: { runId } } }),
  ],
  [
    "tools",
    (runId) => ({
      type: "RUN_FINISHED",
      threadId: id,
      runId,
      metadata: { tanstack: { finishReason: "tool_calls" } },
    }),
  ],
  ["wrong", () => ({ type: "RUN_FINISHED", threadId: id, runId: "wrong-run" })],
]);
function chatEvents(runId) {
  const events = [
    { type: "RUN_STARTED", threadId: id, runId },
    { type: "TEXT_MESSAGE_START", messageId: "answer", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "answer", delta: "串流回答" },
    { type: "TEXT_MESSAGE_END", messageId: "answer" },
  ];
  const extra = terminalByMode.get(mode);
  if (extra !== undefined) {
    events.push(extra(runId));
  }
  return events;
}
function handleChatStream(route, body) {
  const runId = body?.runId ?? activeRun.runId;
  return route.fulfill({
    contentType: "text/event-stream",
    body: chatEvents(runId)
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
  });
}
const apiHandlers = [
  {
    matches: (url) => url.pathname === "/api/thread",
    handle: (route, _url, method) => handleThreadCollection(route, method),
  },
  {
    matches: (url) => url.pathname.startsWith("/api/thread/"),
    handle: (route) => handleThreadRevision(route),
  },
  {
    matches: (url, method) => method === "GET" && !url.searchParams.has("runId"),
    handle: (route) => handleHydrate(route),
  },
];
async function handleApi(route, url, method, body) {
  const handler = apiHandlers.find((entry) => entry.matches(url, method));
  if (handler) {
    return handler.handle(route, url, method, body);
  }
  if (await applyChatTransport(route)) {
    return;
  }
  return handleChatStream(route, body);
}
await page.route("**/*", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const foreign = abortForeignOrigin(url, route);
  if (foreign) {
    return foreign;
  }
  if (isProbeMain(url)) {
    return fulfillProbe(route);
  }
  if (isStaticAsset(url)) {
    return route.continue();
  }
  const method = request.method();
  const body = request.postDataJSON();
  requests.push({ path: url.pathname, method, body, url });
  return handleApi(route, url, method, body);
});
try {
  await page.goto(origin);
  await page.getByRole("button", { name: "既有對話", exact: true }).waitFor();
  assert.equal(await page.getByRole("textbox").count(), 0);
  assert.equal(requests.filter((request) => request.path === "/api/chat").length, 0);
  const releaseCreate = hold("create");
  await page.getByRole("button", { name: "建立新對話" }).click();
  assert.equal(
    await page.getByRole("button", { name: "既有對話", exact: true }).isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "建立新對話" }).evaluate((button) => button.click());
  const releaseHydrate = hold("hydrate");
  messages = [];
  releaseCreate();
  await page.waitForURL(`**/?threadId=${next}`);
  await page.getByText("正在載入對話…").waitFor();
  assert.equal(await page.getByRole("textbox").getAttribute("contenteditable"), "false");
  assert.equal(await page.getByRole("button", { name: "新 thread" }).isDisabled(), true);
  assert.equal(posts().length, 0);
  assert.deepEqual(
    requests
      .filter((request) => request.path === "/api/thread" && request.method === "POST")
      .map((request) => request.body),
    [{}],
  );
  releaseHydrate();
  await page.waitForFunction(
    () => document.querySelector('[role="textbox"]')?.getAttribute("contenteditable") === "true",
  );
  await page.getByRole("textbox").fill("第一則原文");
  const releasePost = hold("post");
  await page.getByRole("button", { name: "送出", exact: true }).click();
  assert.equal(await page.getByRole("textbox").textContent(), "第一則原文");
  assert.equal(await page.getByRole("textbox").getAttribute("contenteditable"), "false");
  releasePost();
  await page.getByText("串流回答", { exact: false }).waitFor();
  await page.waitForFunction(() => document.querySelector('[role="textbox"]')?.textContent === "");
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].body.messages.length, 1);
  assert.equal(posts()[0].body.forwardedProps?.baseRevision ?? 7, 7);
  mode = "failed";
  await page.getByRole("textbox").fill("失敗保留原文");
  await page.getByRole("button", { name: "送出", exact: true }).click();
  await page.getByText("執行失敗，原文已保留。", { exact: true }).waitFor();
  assert.equal(await page.getByRole("textbox").textContent(), "失敗保留原文");
  const beforeReload = posts().length;
  messages = history;
  await page.reload();
  await page.getByText("舊訊息", { exact: true }).waitFor();
  assert.equal(posts().length, beforeReload);
  const beforeRestore = requests.filter(
    (request) => request.path === "/api/chat" && request.method === "GET",
  ).length;
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
  );
  await page.waitForEvent("load");
  await page.getByText("舊訊息", { exact: true }).waitFor();
  assert.equal(
    requests.filter((request) => request.path === "/api/chat" && request.method === "GET").length,
    beforeRestore + 1,
  );
  assert.equal(posts().length, beforeReload);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.getByRole("button", { name: "新 thread" }).isVisible(), true);
  await page.goto(`${origin}/?threadId=invalid`);
  await page.getByRole("alert").filter({ hasText: "對話網址無效" }).waitFor();
  hydrateStatus = 404;
  await page.goto(`${origin}/?threadId=${id}`);
  await page.getByRole("alert").filter({ hasText: "載入對話失敗" }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("threadId"), id);
  hydrateStatus = 200;
  probe = true;
  const release = hold("hydrate");
  const beforeHydrate = requests.filter(
    (request) => request.path === "/api/chat" && request.method === "GET",
  ).length;
  await page.goto(`${origin}/?threadId=${id}`);
  await page.waitForFunction(() => window.api?.phase === "loading");
  assert.equal(await page.evaluate((next) => window.api.navigate(next), next), false);
  assert.equal(
    await page.evaluate(() =>
      window.api.send("blocked").then(
        () => false,
        () => true,
      ),
    ),
    true,
  );
  assert.equal(
    requests.filter((request) => request.path === "/api/chat" && request.method === "GET").length,
    beforeHydrate + 1,
  );
  release();
  await ready();
  assert.equal(await page.evaluate(() => window.api.messages[0].id), "old");
  mode = "success";
  const releaseRevision = hold("revision");
  const releaseBusy = hold("post");
  const before = posts().length;
  const outcomes = await page.evaluate((next) => {
    window.sent = window.api.send("one");
    return Promise.all([
      window.api.send("two").then(
        () => false,
        () => true,
      ),
      window.api.navigate(next),
    ]);
  }, next);
  assert.deepEqual(outcomes, [true, false]);
  releaseRevision();
  await page.waitForFunction(() => window.api.phase === "busy");
  assert.equal(await page.evaluate((next) => window.api.navigate(next), next), false);
  releaseBusy();
  assert.equal(await page.evaluate(() => window.sent), "succeeded");
  await ready();
  assert.equal(posts().length, before + 1);
  assert.equal(posts().at(-1).body.messages[0].id, "old");
  for (mode of ["failed", "eof", "tools", "wrong", "409", "503", "network"]) {
    await page.reload();
    await ready();
    const result = await page.evaluate(() => window.api.send("result check"));
    assert.equal(result, mode === "failed" ? "failed" : "uncertain", mode);
    assert.equal(
      await page.evaluate(() => window.api.phase),
      mode === "failed" ? "ready" : "uncertain",
      mode,
    );
    if (mode !== "failed") {
      assert.equal(await page.evaluate((next) => window.api.navigate(next), next), false);
    }
  }
  mode = "revision-fail";
  await page.reload();
  await ready();
  const beforeRevisionFailure = posts().length;
  assert.equal(
    await page.evaluate(() =>
      window.api.send("revision failure").then(
        () => false,
        () => true,
      ),
    ),
    true,
  );
  assert.equal(await page.evaluate(() => window.api.phase), "ready");
  assert.equal(posts().length, beforeRevisionFailure);
  mode = "success";
  activeRun = { runId: "durable-rejoin" };
  const releaseJoin = hold("post");
  const beforeJoin = posts().length;
  await page.reload();
  await page.waitForFunction(() => window.api?.phase === "busy");
  assert.equal(await page.evaluate((next) => window.api.navigate(next), next), false);
  releaseJoin();
  await ready();
  assert.equal(posts().length, beforeJoin);
  assert.equal(
    await page.evaluate(() => window.api.messages.some((message) => message.id === "answer")),
    true,
  );
  messages = [];
  await page.reload();
  await ready();
  await page.waitForTimeout(30);
  assert.equal(await page.evaluate(() => window.api.phase), "ready");
  assert.equal(
    await page.evaluate(() => window.api.messages.some((message) => message.id === "answer")),
    true,
  );
  assert.equal(posts().length, beforeJoin);
  activeRun = null;
  await page.reload();
  await ready();
  assert.deepEqual(
    await page.evaluate((next) => {
      const accepted = window.api.navigate(next);
      return window.api.send("after navigation").then(
        () => [accepted, false],
        () => [accepted, true],
      );
    }, next),
    [true, true],
  );
  await page.waitForURL(`**/?threadId=${next}`);
  console.log(
    "PASS：空入口、空建立、固定 URL、手機入口、草稿、StrictMode hydration、同 tick gate、terminal／未知結果、GET rejoin。",
  );
} finally {
  await browser.close();
}
