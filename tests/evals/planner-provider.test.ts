import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { roleTaskPrompt } from "../../server/harness/prompts";

process.env.MODEL_API_KEY = "offline";

const s01 = parse(
  readFileSync(
    new URL("../../evals/planner/cases/S01-login-wrong-password.yaml", import.meta.url),
    "utf8",
  ),
);

test("maps S01 eval vars to the exact planner task prompt", async () => {
  const { plannerTaskFromVars } = await import("../../evals/planner/provider");
  const prompt = roleTaskPrompt("planner", plannerTaskFromVars(s01.vars));
  const [, , payload] = prompt.split("\n");

  assert.equal(
    payload,
    JSON.stringify({
      summary: "依 EVAL-101 規劃登入頁錯誤提示的測試",
      goal: "驗證登入頁的錯誤提示",
      sources: [{ kind: "jira", issueKey: "EVAL-101" }],
      requirements: {
        goal: "驗證登入頁的錯誤提示",
        sources: [
          {
            reference: { kind: "jira", issueKey: "EVAL-101" },
            text: s01.vars.sources[0].text,
            links: [],
            digest: "257403f2d9d4d13af0b90b4e5c03b1b2ce3774df3ea0225fb70737e7dd0b8282",
            capturedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
      targetUrl: null,
      design: null,
      plan: null,
      checks: [],
    }),
  );
});
