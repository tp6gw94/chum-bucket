import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function verifyThreads({ taskSpace, evidenceDir, existingSpaceId }) {
  const directory = resolve(evidenceDir);
  const state = JSON.parse(await readFile(resolve(directory, "instance.json"), "utf8"));
  assert.equal(state.status, "ready");
  const task = await taskSpace(existingSpaceId ?? "Verify Chum Bucket");
  console.log({ spaceId: task.spaceId, page: "p1", origin: state.origin });
  await writeFile(
    resolve(directory, "browser.json"),
    JSON.stringify({ spaceId: task.spaceId, page: "p1" }),
  );
  const page = task.page("p1");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const editable = 'loc=css:section[aria-label="主對話"] [role="textbox"][contenteditable="true"]';
  const threadId = async () => new URL(await page.url()).searchParams.get("threadId");
  const get = async (path) => {
    const response = await page.fetch(path);
    assert.equal(response.status, 200);
    return typeof response.body === "string" ? JSON.parse(response.body) : response.body;
  };
  async function capture(name) {
    await writeFile(
      resolve(directory, `${name}.aria.txt`),
      String(await page.snapshot({ scope: "full_page" })),
    );
    await page.screenshot({ path: resolve(directory, `${name}.png`) });
  }
  async function step(id, command, act, verify) {
    await appendFile(
      resolve(directory, "actions.jsonl"),
      JSON.stringify({ id, phase: "action", command, at: new Date().toISOString() }) + "\n",
    );
    await act();
    await verify();
    await capture(id);
    await appendFile(
      resolve(directory, "actions.jsonl"),
      JSON.stringify({ id, phase: "pass", url: await page.url(), at: new Date().toISOString() }) +
        "\n",
    );
  }
  async function ready() {
    await page.waitForSelector(editable, { state: "visible", timeout: 20_000 });
    assert(uuid.test(await threadId()));
    assert.equal(
      await page.evaluate(
        () => document.querySelector('section[aria-label="主對話"] button[type="submit"]').disabled,
      ),
      true,
    );
  }
  async function persisted(id, count) {
    const detail = await get(`/api/thread/${id}`);
    assert.equal(detail.id, id);
    assert.equal(detail.revision, 0);
    assert.deepEqual(detail.messages, []);
    assert.equal((await get("/api/thread")).length, count);
    await writeFile(resolve(directory, `thread-${count}.json`), JSON.stringify(detail, null, 2));
  }
  try {
    await page.goto(state.origin);
    await page.waitForSelector("loc=role:button[name='建立新對話']", { state: "visible" });
    assert.deepEqual(await get("/api/thread"), []);
    assert.equal(
      await page.evaluate(() => document.querySelectorAll('[role="textbox"]').length),
      0,
    );
    await capture("threads-empty-entry");
    await step(
      "threads-create-entry",
      "click 建立新對話",
      () => page.click("loc=role:button[name='建立新對話']"),
      ready,
    );
    const first = await threadId();
    await persisted(first, 1);
    await step(
      "threads-direct-reload",
      `goto /?threadId=${first}`,
      () => page.goto(`${state.origin}/?threadId=${first}`),
      ready,
    );
    await persisted(first, 1);
    await page.goto(state.origin);
    await page.waitForSelector("loc=role:button[name='新對話']", { state: "visible" });
    await step(
      "threads-choose-existing",
      "click 新對話 on 選擇對話",
      () => page.click("loc=role:button[name='新對話']"),
      async () => {
        await ready();
        assert.equal(await threadId(), first);
      },
    );
    await step(
      "threads-sidebar-entry",
      "click 新 thread",
      () => page.click("loc=role:button[name='新 thread']"),
      async () => {
        await page.waitForSelector("loc=role:button[name='建立新對話']", { state: "visible" });
        assert.equal(await threadId(), null);
        assert.equal((await get("/api/thread")).length, 1);
      },
    );
    await step(
      "threads-create-sidebar",
      "click 建立新對話 after 新 thread",
      () => page.click("loc=role:button[name='建立新對話']"),
      ready,
    );
    const second = await threadId();
    assert.notEqual(second, first);
    await persisted(second, 2);
    const rows = await get("/api/thread");
    const firstIndex = rows.findIndex((row) => row.id === first);
    const selector = `loc=css:#thread-sidebar [role="list"] button >> nth=${firstIndex}`;
    await step(
      "threads-select-sidebar",
      `click ${selector}`,
      () => page.click(selector),
      async () => {
        await ready();
        assert.equal(await threadId(), first);
      },
    );
    await page.cdp("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await step(
      "threads-mobile-collapse",
      "click 收合 thread 清單",
      () => page.click("loc=role:button[name='收合 thread 清單']"),
      async () => {
        await page.waitForSelector('loc=css:#thread-sidebar[aria-hidden="true"][inert]', {
          state: "attached",
        });
      },
    );
    await step(
      "threads-mobile-expand",
      "click 展開 thread 清單",
      () => page.click("loc=role:button[name='展開 thread 清單']"),
      async () => {
        await page.waitForSelector('loc=css:#thread-sidebar[aria-hidden="false"]', {
          state: "visible",
        });
      },
    );
    await step(
      "threads-mobile-entry",
      "click 新 thread at 390px",
      () => page.click("loc=role:button[name='新 thread']"),
      async () => {
        await page.waitForSelector("loc=role:button[name='建立新對話']", { state: "visible" });
        assert.equal(await threadId(), null);
        assert.equal((await get("/api/thread")).length, 2);
      },
    );
    await step(
      "threads-mobile-new",
      "click 建立新對話 at 390px",
      () => page.click("loc=role:button[name='建立新對話']"),
      ready,
    );
    const third = await threadId();
    assert(![first, second].includes(third));
    await persisted(third, 3);
    await page.cdp("Emulation.clearDeviceMetricsOverride");
    await step(
      "threads-invalid-url",
      "goto /?threadId=invalid",
      () => page.goto(`${state.origin}/?threadId=invalid`),
      async () => {
        await page.waitForSelector("text=對話網址無效，請確認 threadId。", { state: "visible" });
        assert.equal(
          await page.evaluate(() => document.querySelectorAll('[role="textbox"]').length),
          0,
        );
      },
    );
    await page.goto(`${state.origin}/?threadId=${first}`);
    await ready();
    const list = await get("/api/thread");
    assert.equal(list.length, 3);
    await writeFile(resolve(directory, "threads-after.json"), JSON.stringify(list, null, 2));
    await capture("threads-final");
    await writeFile(
      resolve(directory, "threads-result.json"),
      JSON.stringify(
        {
          status: "pass",
          feature: "threads",
          first,
          second,
          third,
          spaceId: task.spaceId,
          externalModelCalls: "not exercised; confirm zero runs and events with control inspect",
        },
        null,
        2,
      ),
    );
    console.log(await page.snapshot());
    await task.finish({ keep: [] });
    console.log({ status: "pass", evidence: directory });
  } catch (error) {
    await writeFile(resolve(directory, "threads-failure.txt"), String(error.stack ?? error));
    console.error({ status: "fail", spaceId: task.spaceId, page: "p1", evidence: directory });
    throw error;
  }
}
