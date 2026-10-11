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
