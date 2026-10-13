import assert from "node:assert/strict";
import { test } from "node:test";
import { selectCandidate } from "../../../server/harness/jev-client";

const candidates = [
  { id: "c0", description: "加入購物車" },
  { id: "c1", description: "購物車" },
];
function transport(
  choice: string,
  confidence = 0.95,
  probabilities = { c0: 0.97, c1: 0.02, none: 0.01 },
): typeof fetch {
  return async () =>
    Response.json({
      model: "jev-test",
      answers: { target: { type: "choice", choice, confidence, probabilities } },
    });
}
test("Jev boundary selects a host candidate without losing Chinese labels", async () => {
  const result = await selectCandidate("加入購物車", candidates, new AbortController().signal, {
    apiKey: "test-only",
    fetch: transport("c0"),
  });
  assert.equal(result.choice, "c0");
  assert.equal(result.model, "jev-test");
});
test("Jev boundary blocks invented, uncertain, and no-match selections", async () => {
  for (const fetch of [
    transport("invented"),
    transport("c0", 0.2),
    transport("none"),
    transport("c0", 0.95, { c0: 0.4, c1: 0.4, none: 0.2 }),
  ]) {
    await assert.rejects(
      selectCandidate("加入購物車", candidates, new AbortController().signal, {
        apiKey: "test-only",
        fetch,
      }),
      /Jev/,
    );
  }
});
test("missing Jev credentials never falls back to a guessed target", async () => {
  await assert.rejects(
    selectCandidate("button", candidates, new AbortController().signal, { apiKey: "" }),
    /JEV_API_KEY/,
  );
});
test("Jev receives up to 254 candidates plus none, while an empty or larger set never reaches the API", async () => {
  const optionCounts: number[] = [];
  const counting: typeof fetch = async (_url, init) => {
    const criteria = JSON.parse(String(init?.body)).questions.target.criteria;
    optionCounts.push(Object.keys(criteria).length);

    return Response.json({
      model: "jev-test",
      answers: {
        target: {
          type: "choice",
          choice: "c253",
          confidence: 0.95,
          probabilities: Object.fromEntries(
            Object.keys(criteria).map((key) => [key, key === "c253" ? 1 : 0]),
          ),
        },
      },
    });
  };
  const many = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `c${index}`,
      description: `Item ${index}`,
    }));
  const select = (count: number) =>
    selectCandidate("item", many(count), new AbortController().signal, {
      apiKey: "test-only",
      fetch: counting,
    });

  assert.equal((await select(254)).choice, "c253");
  await assert.rejects(select(255), { message: "Jev candidate_limit" });
  await assert.rejects(select(0), { message: "Jev candidate_limit" });
  assert.deepEqual(optionCounts, [255]);
});
