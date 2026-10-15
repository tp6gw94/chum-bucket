import assert from "node:assert/strict";
import { test } from "node:test";
import { JevError, selectCandidate } from "../../../server/harness/jev-client";
import { fakeJev } from "../../fixtures/fake-jev";

const candidates = [
  { id: "c0", description: '{"tag":"button","text":"Add"}' },
  { id: "c1", description: '{"tag":"button","text":"Remove"}' },
];
const signal = new AbortController().signal;

function respond(answer: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(answer), { status: 200 });
}

test("a confident unique choice is accepted and the none option is offered", async () => {
  const requests: { intent: string; keys: string[] }[] = [];
  const jev = fakeJev(() => "c0", requests);
  const selection = await selectCandidate("the add button", candidates, signal, jev);

  assert.equal(selection.choice, "c0");
  assert.deepEqual(requests[0]!.keys, ["c0", "c1", "none"]);
});

test("none, low confidence, a weak choice or a bad distribution are uncertain", async () => {
  const cases = [
    { choice: "none", confidence: 0.99, probabilities: { c0: 0.01, c1: 0.0, none: 0.99 } },
    { choice: "c0", confidence: 0.5, probabilities: { c0: 0.9, c1: 0.05, none: 0.05 } },
    { choice: "c0", confidence: 0.9, probabilities: { c0: 0.8, c1: 0.15, none: 0.05 } },
    { choice: "c0", confidence: 0.9, probabilities: { c0: 0.05, c1: 0.9, none: 0.05 } },
    { choice: "c0", confidence: 0.9, probabilities: { c0: 0.86, c1: 0.0, none: 0.0 } },
    { choice: "c0", confidence: 0.9, probabilities: { c0: 0.9, c1: 0.1 } },
  ];

  for (const target of cases) {
    const fetchImpl = respond({ model: "jev", answers: { target: { type: "choice", ...target } } });
    await assert.rejects(
      selectCandidate("the add button", candidates, signal, { apiKey: "k", fetch: fetchImpl }),
      (error: unknown) => error instanceof JevError && error.uncertain,
    );
  }
});

test("a missing key fails before any request and HTTP errors are not uncertain", async () => {
  let calls = 0;
  const counting: typeof fetch = async () => {
    calls++;

    return new Response("nope", { status: 401 });
  };
  const previous = process.env.JEV_API_KEY;
  delete process.env.JEV_API_KEY;

  try {
    await assert.rejects(selectCandidate("x", candidates, signal, { fetch: counting }), /missing/);
    assert.equal(calls, 0);
  } finally {
    if (previous !== undefined) {
      process.env.JEV_API_KEY = previous;
    }
  }

  await assert.rejects(
    selectCandidate("x", candidates, signal, { apiKey: "k", fetch: counting }),
    (error: unknown) => error instanceof JevError && error.code === "http_401" && !error.uncertain,
  );
});
