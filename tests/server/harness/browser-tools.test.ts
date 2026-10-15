import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ToolExecutionContext, UIMessage } from "@tanstack/ai";
import { createBrowserTools } from "../../../server/harness/tools/browser";
import { fakeJev, pickByText, type JevPick } from "../../fixtures/fake-jev";

const page = `<!doctype html><html><body>
<h1>Scone shop</h1>
<p id="count">Quantity: 1</p>
<button onclick="document.getElementById('count').textContent='Quantity: '+(++window.q)">Increase</button>
<button>Decrease</button>
<label>Note <input name="note"></label>
<button disabled>Pay now</button>
<a href="/cart.html">Cart</a>
<a href="https://example.com/">Elsewhere</a>
<script>window.q=1</script>
</body></html>`;
const cart = `<!doctype html><html><body><h1>Your cart</h1></body></html>`;
const long = `<!doctype html><html><body><div role="main">${"jam ".repeat(5000)}</div></body></html>`;
const many = `<!doctype html><html><body><ul>${Array.from(
  { length: 300 },
  (_, index) => `<li>Item ${index}</li>`,
).join("")}</ul></body></html>`;

let server: Server;
let origin: string;
let foreign: string;
let evidence: string;
let markers: string;

const pages: Record<string, () => string> = {
  "/cart.html": () => cart,
  "/long": () => long,
  "/many": () => many,
  "/foreign": () => "<!doctype html><html><body><h1>FOREIGN</h1></body></html>",
};

before(async () => {
  server = createServer((request, response) => {
    const redirect = { "/hop": "/cart.html", "/go": `${foreign}/foreign` }[request.url ?? ""];

    if (redirect) {
      response.writeHead(302, { Location: redirect }).end();

      return;
    }

    response.setHeader("Content-Type", "text/html");
    response.end((pages[request.url ?? ""] ?? (() => page))());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
  foreign = `http://localhost:${address.port}`;
  evidence = await mkdtemp(join(tmpdir(), "browser-evidence-"));
  markers = await mkdtemp(join(tmpdir(), "browser-markers-"));
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(evidence, { recursive: true, force: true });
  await rm(markers, { recursive: true, force: true });
});

function context(): ToolExecutionContext {
  return {
    toolCallId: "call",
    abortSignal: AbortSignal.timeout(30_000),
    emitCustomEvent: () => {},
  };
}

function browserFor(
  pick: JevPick,
  requests?: { intent: string; keys: string[] }[],
  executionId = randomUUID(),
) {
  const browser = createBrowserTools({
    targetUrl: `${origin}/`,
    evidenceDir: evidence,
    executionId,
    markerDir: markers,
    jev: fakeJev(pick, requests),
  });
  let sequence = 0;

  return {
    close: browser.close,
    call: (input: Record<string, unknown>, messages: UIMessage[] = []) =>
      browser.tools.executeTool(
        messages,
        { id: `call-${++sequence}`, name: "browser", arguments: JSON.stringify(input), input },
        context(),
      ) as Promise<Record<string, any>>,
  };
}

const pickers: JevPick[] = [
  pickByText(/increase/i, '"text":"Increase"'),
  pickByText(/quantity/i, '"text":"Quantity'),
  pickByText(/note/i, '"name":"note"'),
  pickByText(/pay/i, '"text":"Pay now"'),
];
const confident: JevPick = (intent, criteria) =>
  pickers.map((pick) => pick(intent, criteria)).find(Boolean);

test("Jev resolves semantic targets and every result is a recorded observation", async () => {
  const browser = browserFor(confident);

  try {
    const clicked = await browser.call({ action: "click", target: "the increase button" });
    assert.equal(clicked.state, "observed");
    assert.deepEqual(clicked.observation.selection, { by: "jev", confidence: 0.95 });
    assert.equal((await stat(clicked.observation.screenshot)).isFile(), true);

    const read = await browser.call({
      action: "read",
      observation: "text",
      target: "the quantity text",
    });
    assert.equal(read.observation.observed, "Quantity: 2");

    await browser.call({ action: "fill", target: "the note field", value: "extra jam" });
    const value = await browser.call({ action: "read", observation: "value", target: "note" });
    assert.equal(value.observation.observed, "extra jam");

    const pay = await browser.call({ action: "click", target: "the pay button" });
    assert.equal(pay.observation.outcome, "not_operable");
    assert.equal(pay.observation.reason, "disabled");

    await browser.call({ action: "navigate", path: "/cart.html" });
    const url = await browser.call({ action: "read", observation: "url" });
    assert.equal(url.observation.observed, `${origin}/cart.html`);
    assert.deepEqual(
      [clicked, read, pay, url].map((result) => result.observation.id),
      ["o1", "o2", "o5", "o7"],
    );
  } finally {
    await browser.close();
  }
});

test("an uncertain Jev answer hands candidates to the agent, who picks by id", async () => {
  const requests: { intent: string; keys: string[] }[] = [];
  const browser = browserFor(() => undefined, requests);

  try {
    const handoff = await browser.call({ action: "click", target: "the plus button" });
    assert.equal(handoff.state, "selection_required");
    assert.equal(handoff.reason, "uncertain");
    const increase = handoff.candidates.find((candidate: { description: string }) =>
      candidate.description.includes('"text":"Increase"'),
    );
    assert.ok(increase);

    await assert.rejects(
      browser.call({ action: "click", target: "something else", candidateId: increase.id }),
      /candidateId is unknown/,
    );

    const picked = await browser.call({
      action: "click",
      target: "the plus button",
      candidateId: increase.id,
    });
    assert.deepEqual(picked.observation.selection, { by: "agent" });
    assert.equal(requests.length, 1);
  } finally {
    await browser.close();
  }
});

test("navigation off the target origin is refused", async () => {
  const browser = browserFor(confident);

  try {
    await assert.rejects(
      browser.call({ action: "navigate", path: "https://example.com/" }),
      /outside the target origin/,
    );
  } finally {
    await browser.close();
  }
});

test("a session lost after a restart is reported instead of replaying actions", async () => {
  const browser = browserFor(confident);
  const history: UIMessage[] = [
    {
      id: "earlier",
      role: "assistant",
      parts: [
        {
          type: "tool-result",
          toolCallId: "earlier",
          content: JSON.stringify({ state: "observed", observation: { id: "o1" } }),
          state: "complete",
        },
      ],
    },
  ];

  await assert.rejects(
    browser.call({ action: "read", observation: "url" }, history),
    /lost after a restart/,
  );
  await browser.close();
});

test("without a Jev key the browser is never opened", async () => {
  const previous = process.env.JEV_API_KEY;
  delete process.env.JEV_API_KEY;
  const browser = createBrowserTools({
    targetUrl: `${origin}/`,
    evidenceDir: evidence,
    executionId: randomUUID(),
    markerDir: markers,
  });

  try {
    await assert.rejects(
      browser.tools.executeTool(
        [],
        {
          id: "c",
          name: "browser",
          arguments: "{}",
          input: { action: "read", observation: "url" },
        },
        context(),
      ),
      /JEV_API_KEY is not configured/,
    );
  } finally {
    await browser.close();

    if (previous !== undefined) {
      process.env.JEV_API_KEY = previous;
    }
  }
});

test("redirects are followed on the target origin and refused off it", async () => {
  const browser = browserFor(confident);

  try {
    const hop = await browser.call({ action: "navigate", path: "/hop" });
    assert.equal(hop.observation.url, `${origin}/cart.html`);

    await assert.rejects(browser.call({ action: "navigate", path: "/go" }));
    await assert.rejects(
      browser.call({ action: "read", observation: "text", target: "the heading" }),
      /session is closed/,
    );
  } finally {
    await browser.close();
  }
});

test("following a link off the target origin closes the session", async () => {
  const browser = browserFor(pickByText(/elsewhere/i, '"text":"Elsewhere"'));

  try {
    await assert.rejects(
      browser.call({ action: "click", target: "the elsewhere link" }),
      /session is closed/,
    );
  } finally {
    await browser.close();
  }
});

test("long text is truncated and large candidate lists are paged", async () => {
  const browser = browserFor(pickByText(/article/i, '"role":"main"'));

  try {
    await browser.call({ action: "navigate", path: "/long" });
    const read = await browser.call({ action: "read", observation: "text", target: "the article" });
    assert.equal(read.observation.observed.length, 2000);
    assert.equal(read.observation.truncated, true);

    await browser.call({ action: "navigate", path: "/many" });
    const first = await browser.call({ action: "read", observation: "text", target: "item 299" });
    assert.equal(first.state, "selection_required");
    assert.equal(first.reason, "too_many_candidates");
    assert.equal(first.candidates.length, 60);
    assert.equal(first.nextOffset, 60);

    let listing = first;
    const isLast = (candidate: { description: string }) =>
      candidate.description.includes('"text":"Item 299"');

    while (!listing.candidates.some(isLast)) {
      assert.ok(listing.nextOffset);
      listing = await browser.call({
        action: "read",
        observation: "text",
        target: "item 299",
        offset: listing.nextOffset,
      });
    }

    const picked = await browser.call({
      action: "read",
      observation: "text",
      target: "item 299",
      candidateId: listing.candidates.find(isLast).id,
    });
    assert.equal(picked.observation.observed, "Item 299");
  } finally {
    await browser.close();
  }
});

test("a page without candidates hands off, and a pick from another page is refused", async () => {
  const browser = browserFor(() => undefined);

  try {
    const handoff = await browser.call({ action: "click", target: "the increase button" });
    const increase = handoff.candidates.find((candidate: { description: string }) =>
      candidate.description.includes('"text":"Increase"'),
    );
    await browser.call({ action: "navigate", path: "/twin" });
    await assert.rejects(
      browser.call({ action: "click", target: "the increase button", candidateId: increase.id }),
      /candidateId is unknown/,
    );

    await browser.call({ action: "navigate", path: "/cart.html" });
    const empty = await browser.call({ action: "fill", target: "the note", value: "x" });
    assert.equal(empty.state, "selection_required");
    assert.equal(empty.reason, "no_candidates");
    assert.deepEqual(empty.candidates, []);
  } finally {
    await browser.close();
  }
});

test("a step interrupted mid-execution is not replayed", async () => {
  const executionId = randomUUID();
  const first = browserFor(confident, undefined, executionId);
  const second = browserFor(confident, undefined, executionId);

  try {
    await first.call({ action: "read", observation: "url" });
    await assert.rejects(
      second.call({ action: "read", observation: "url" }),
      /replay is forbidden/,
    );
  } finally {
    await first.close();
    await second.close();
  }
});
