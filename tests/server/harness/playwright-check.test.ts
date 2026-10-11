import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createPlaywrightFixture } from "../../../server/harness/playwright-check";
import { createUseBrowserTool } from "../../../server/harness/tools/use-browser";
import {
  browserOutputSchema,
  type FunctionalCheck,
  type PlanCase,
  type StyleCheck,
} from "../../../shared/testing";

const check: FunctionalCheck = {
  id: "count",
  criterionId: "counter",
  kind: "functional",
  expectedObservation: "1",
  observation: { kind: "text", target: "heading", comparison: "equals" },
};
const planCase: PlanCase = {
  id: "case",
  title: "Counter",
  preconditions: [],
  actions: [{ kind: "click", target: "button" }],
  checks: [check, { ...check, id: "sibling" }],
};

test("real Chromium with a mocked Jev transport isolates sessions, memoizes actions, blocks replay and rejects stale targets", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "chum-browser-test-"));
  let mutations = 0;
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (request.url === "/increment") {
      mutations++;
      response.end("ok");
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<h1>0</h1><span id="hidden-status" hidden>Hidden status</span><span>Visible status</span><input aria-label="note"><button onclick="localStorage.n=String(Number(localStorage.n||0)+1);document.querySelector('h1').textContent=localStorage.n;fetch('/increment')">Add</button>${request.url === "/stale" ? "<script>setTimeout(()=>{document.querySelector('button').outerHTML='<button>Replacement</button>'},200)</script>" : request.url === "/visibility-stale" ? "<script>setTimeout(()=>{document.querySelector('#hidden-status').hidden=false},200)</script>" : ""}`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const target = `http://127.0.0.1:${address.port}/`;
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.JEV_API_KEY;
  process.env.JEV_API_KEY = "test-transport-only";
  let lag = 0;
  const submittedIntents: string[] = [];
  globalThis.fetch = async (_url, init) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, lag);
      init?.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("cancelled"));
        },
        { once: true },
      );
    });
    const body = JSON.parse(String(init?.body));
    submittedIntents.push(body.state.intent);
    const criteria = body.questions.target.criteria as Record<string, string>;
    const choice =
      Object.entries(criteria).find(([, description]) =>
        description.includes(
          body.state.intent === "button"
            ? '"tag":"BUTTON"'
            : body.state.intent === "hidden status"
              ? '"id":"hidden-status"'
              : body.state.intent === "missing status"
                ? '"id":"absent-status"'
                : '"tag":"H1"',
        ),
      )?.[0] ?? "none";
    return Response.json({
      model: "jev-transport-mock",
      answers: {
        target: {
          type: "choice",
          choice,
          confidence: 0.99,
          probabilities: Object.fromEntries(
            Object.keys(criteria).map((key) => [key, key === choice ? 1 : 0]),
          ),
        },
      },
    });
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.JEV_API_KEY;
    else process.env.JEV_API_KEY = originalKey;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await t.test(
    "hidden visibility yields false, true fails, and absent targets stay blocked without fake observations",
    async () => {
      const hidden: FunctionalCheck = {
        ...check,
        id: "hidden-false",
        expectedObservation: "false",
        observation: { kind: "visible", target: "hidden status", comparison: "equals" },
      };
      const expectedTrue: FunctionalCheck = {
        ...hidden,
        id: "hidden-true",
        expectedObservation: "true",
      };
      const absent: FunctionalCheck = {
        ...hidden,
        id: "absent",
        observation: { kind: "visible", target: "missing status", comparison: "equals" },
      };
      const visibilityCase: PlanCase = {
        ...planCase,
        id: "visibility",
        actions: [{ kind: "navigate", path: "/" }],
        checks: [hidden, expectedTrue, absent],
      };
      const tool = createUseBrowserTool({
        role: "ac",
        cases: [visibilityCase],
        checks: visibilityCase.checks,
        fixture: createPlaywrightFixture(target, "ac", undefined, directory),
        figmaProperties: null,
        designCapture: null,
      });
      const outputs = await Promise.all(
        visibilityCase.checks.map(async (item) =>
          browserOutputSchema.parse(await tool.execute!({ checkId: item.id })),
        ),
      );
      assert.deepEqual(
        outputs.map((item) => item.evidence.outcome),
        ["pass", "fail", "blocked"],
      );
      assert.deepEqual(
        outputs
          .slice(0, 2)
          .map((item) => ("observed" in item.evidence ? item.evidence.observed : undefined)),
        ["false", "false"],
      );
      assert.equal("observed" in outputs[2]!.evidence, false);
      assert.equal(
        outputs[0]!.evidence.browser?.selections[0]?.choice,
        outputs[1]!.evidence.browser?.selections[1]?.choice,
      );
    },
  );
  await t.test(
    "UI rejects mixed stateful cases before model, browser, or mutation effects",
    async () => {
      const style: StyleCheck = {
        id: "style",
        criterionId: "counter",
        kind: "style",
        design: { fileKey: "test", nodeId: "button" },
        target: "button",
        property: "width",
        tolerance: { kind: "exact" },
      };
      const mixedCase: PlanCase = {
        ...planCase,
        checks: [check, style],
      };
      const priorRequests = requests;
      const priorIntents = [...submittedIntents];
      const result = await createPlaywrightFixture(target, "ui", undefined, directory).run!(
        mixedCase,
        style,
      );
      assert.equal(result.state, "blocked");
      assert.match(result.state === "blocked" ? result.reason : "", /ui_navigation_only/);
      assert.equal("observed" in result, false);
      assert.deepEqual(result.browser, { selections: [] });
      assert.equal(mutations, 0);
      assert.equal(requests, priorRequests);
      assert.deepEqual(submittedIntents, priorIntents);
      const fillCase: PlanCase = {
        ...mixedCase,
        id: "fill-ui",
        actions: [{ kind: "fill", target: "note", value: "unsafe" }],
      };
      delete process.env.JEV_API_KEY;
      try {
        const fillResult = await createPlaywrightFixture(target, "ui", undefined, directory).run!(
          fillCase,
          style,
        );
        assert.equal(fillResult.state, "blocked");
        assert.match(fillResult.state === "blocked" ? fillResult.reason : "", /ui_navigation_only/);
      } finally {
        process.env.JEV_API_KEY = "test-transport-only";
      }
    },
  );
  const key = randomUUID();
  const first = createPlaywrightFixture(target, "ac", undefined, directory, key);
  const second = createPlaywrightFixture(target, "ac", undefined, directory);
  const observations = await Promise.all([
    first.run!(planCase, check),
    first.run!(planCase, planCase.checks[1]!),
    second.run!(planCase, check),
  ]);
  assert.deepEqual(
    observations.map((item) => (item.state === "observed" ? item.observed : item.reason)),
    ["1", "1", "1"],
  );
  assert.equal(mutations, 2);
  const replay = await createPlaywrightFixture(target, "ac", undefined, directory, key).run!(
    planCase,
    check,
  );
  assert.equal(replay.state, "blocked");
  assert.equal(mutations, 2);
  lag = 500;
  const visibilityCheck: FunctionalCheck = {
    ...check,
    id: "visibility-stale",
    expectedObservation: "false",
    observation: { kind: "visible", target: "hidden status", comparison: "equals" },
  };
  const visibilityStale = await createPlaywrightFixture(
    `${target}visibility-stale`,
    "ac",
    undefined,
    directory,
  ).run!(
    { ...planCase, id: "visibility-stale", actions: [], checks: [visibilityCheck] },
    visibilityCheck,
  );
  assert.equal(visibilityStale.state, "blocked");
  assert.match(
    visibilityStale.state === "blocked" ? visibilityStale.reason : "",
    /DOM target changed/,
  );
  assert.equal("observed" in visibilityStale, false);
  const stale = await createPlaywrightFixture(`${target}stale`, "ac", undefined, directory).run!(
    planCase,
    check,
  );
  assert.equal(stale.state, "blocked");
  assert.equal(mutations, 2);
  const controller = new AbortController();
  const pending = createPlaywrightFixture(target, "ac", controller.signal, directory).run!(
    planCase,
    check,
  );
  setTimeout(() => controller.abort(), 300);
  assert.equal((await pending).state, "blocked");
  assert.equal(mutations, 2);
});

test("browser evidence cannot claim live provenance without the live adapter and observation metadata", () => {
  const evidence = {
    kind: "functional",
    outcome: "pass",
    expected: "1",
    observed: "1",
    actionIndex: 0,
    caseId: "case",
    checkId: "count",
    origin: "browser",
    fixture: { id: "playwright-chromium", version: "v1" },
    adapterVersion: "playwright-jev-v1",
    browser: { selections: [] },
  };
  assert.equal(browserOutputSchema.safeParse({ checkId: "count", evidence }).success, true);
  for (const invalid of [
    { ...evidence, browser: undefined },
    { ...evidence, adapterVersion: "mock-adapter-v1" },
    { ...evidence, origin: "mock" },
  ])
    assert.equal(
      browserOutputSchema.safeParse({ checkId: "count", evidence: invalid }).success,
      false,
    );
});

test("live tools reject foreign scope before any browser or model effect and retain deterministic discrepancy", async () => {
  const tool = createUseBrowserTool({
    role: "ac",
    cases: [planCase],
    checks: [check],
    fixture: {
      identity: { id: "playwright-chromium", version: "v1" },
      adapterVersion: "playwright-jev-v1",
      run: async () => ({ state: "observed", observed: "2", browser: { selections: [] } }),
    },
    figmaProperties: null,
    designCapture: null,
  });
  await assert.rejects(async () => tool.execute!({ checkId: "foreign" }), /Unknown scoped check/);
  const output = browserOutputSchema.parse(await tool.execute!({ checkId: "count" }));
  assert.equal(output.evidence.outcome, "fail");
  assert.equal(output.evidence.origin, "browser");
});
