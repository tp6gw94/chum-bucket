import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCompactBody } from "../../server/chat";

const body = {
  kind: "compact",
  threadId: "d08035f1-07df-49f3-b2d0-5cf5cb2b1e74",
  runId: "compact-run",
  baseRevision: 3,
};

test("compact runs require a matching run header and carry no message", () => {
  assert.deepEqual(parseCompactBody(body, "compact-run"), body);
  assert.throws(() => parseCompactBody(body, "other"), /header mismatch/);
  assert.throws(() => parseCompactBody(body), /header mismatch/);
  assert.throws(
    () => parseCompactBody({ ...body, message: { id: "m", text: "/compact" } }, "compact-run"),
    /Invalid compact input/,
  );
  assert.throws(() => parseCompactBody({ ...body, kind: "chat" }, "compact-run"), /Invalid/);
  assert.throws(() => parseCompactBody({ ...body, baseRevision: -1 }, "compact-run"), /Invalid/);
});
