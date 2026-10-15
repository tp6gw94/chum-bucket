import assert from "node:assert/strict";
import { test } from "node:test";
import {
  JEV_ENDPOINT,
  MAX_JEV_CANDIDATES,
  judgeSelection,
  selectWithJev,
} from "../../../../server/harness/tools/jev-client";

const candidates = [
  { id: "c0", description: "button Submit" },
  { id: "c1", description: "button Cancel" },
];

function answer(probabilities: Record<string, number>, choice = "c0", confidence = 0.95) {
  return { type: "choice" as const, choice, probabilities, confidence };
}

test("decisive selections are accepted", () => {
  assert.deepEqual(judgeSelection(answer({ c0: 0.9, c1: 0.05, none: 0.05 }), candidates), {
    state: "accepted",
    candidateId: "c0",
    probability: 0.9,
    confidence: 0.95,
  });
});

test("indecisive or malformed selections are rejected", () => {
  const cases = [
    answer({ c0: 0.9, c1: 0.1 }),
    answer({ c0: 0.9, c1: 0.05, none: 0.05, c9: 0 }),
    answer({ c0: 0.7, c1: 0.1, none: 0.1 }),
    answer({ c0: 0.84, c1: 0.1, none: 0.06 }),
    answer({ c0: 0.9, c1: 0.05, none: 0.05 }, "c0", 0.79),
    answer({ c0: 0.05, c1: 0.9, none: 0.05 }),
    answer({ c0: 0.05, c1: 0.05, none: 0.9 }, "none"),
  ];

  for (const selection of cases) {
    assert.equal(
      judgeSelection(selection, candidates).state,
      "rejected",
      JSON.stringify(selection),
    );
  }
});

test("selectWithJev posts candidates with none and judges the response", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });

    return Response.json({
      answers: { target: answer({ c0: 0.92, c1: 0.04, none: 0.04 }) },
    });
  }) as typeof fetch;

  const selection = await selectWithJev({
    intent: "Submit the order",
    candidates,
    signal: new AbortController().signal,
    apiKey: "test-key",
    fetchImpl,
  });

  assert.equal(selection.state, "accepted");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, JEV_ENDPOINT);
  assert.equal(
    (requests[0]!.init.headers as Record<string, string>).Authorization,
    "Bearer test-key",
  );
  const body = JSON.parse(String(requests[0]!.init.body));
  assert.deepEqual(Object.keys(body.questions.target.criteria), ["c0", "c1", "none"]);
  assert.deepEqual(body.state, { intent: "Submit the order" });
});

test("selectWithJev rejects without calling the network when it cannot ask", async () => {
  const fetchImpl = (async () => {
    throw new Error("network");
  }) as typeof fetch;
  const signal = new AbortController().signal;
  const previous = process.env.JEV_API_KEY;
  delete process.env.JEV_API_KEY;

  try {
    assert.equal(
      (await selectWithJev({ intent: "x", candidates, signal, fetchImpl })).state,
      "rejected",
    );
  } finally {
    if (previous !== undefined) {
      process.env.JEV_API_KEY = previous;
    }
  }

  assert.equal(
    (await selectWithJev({ intent: "x", candidates: [], signal, apiKey: "k", fetchImpl })).state,
    "rejected",
  );
  const many = Array.from({ length: MAX_JEV_CANDIDATES + 1 }, (_, index) => ({
    id: `c${index}`,
    description: "x",
  }));
  assert.equal(
    (await selectWithJev({ intent: "x", candidates: many, signal, apiKey: "k", fetchImpl })).state,
    "rejected",
  );
});

test("selectWithJev rejects failed and unexpected responses", async () => {
  const signal = new AbortController().signal;
  const failing = (async () => new Response("nope", { status: 500 })) as typeof fetch;
  const odd = (async () => Response.json({ answers: {} })) as typeof fetch;

  assert.deepEqual(
    await selectWithJev({ intent: "x", candidates, signal, apiKey: "k", fetchImpl: failing }),
    {
      state: "rejected",
      reason: "Jev request failed (HTTP 500)",
    },
  );
  assert.equal(
    (await selectWithJev({ intent: "x", candidates, signal, apiKey: "k", fetchImpl: odd })).state,
    "rejected",
  );
});
