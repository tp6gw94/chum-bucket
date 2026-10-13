import test from "node:test";
import assert from "node:assert/strict";
import { cancel, problem, read } from "../../server/harness/testing-service";
import { artifactRefSchema, TestingRequestError, type ReuseDecision } from "../../shared/testing";
import { TestingPersistenceError } from "../../server/harness/testing-store";
import { RunRequestError } from "../../server/harness/run-store";

test("problem maps TestingRequestError to 400 with decisions", () => {
  const ref = artifactRefSchema.parse("ref-1");
  const decisions: readonly ReuseDecision[] = [
    {
      kind: "rejected",
      ref,
      reason: "not_accessible",
    },
  ];
  const err = new TestingRequestError(decisions as any);
  const result = problem(err);
  assert.deepEqual(result, {
    status: 400,
    message: "Testing request has invalid artifact references: ref-1 (not_accessible)",
    decisions,
  });
});

test("problem maps TestingPersistenceError to its status and message", () => {
  const err404 = new TestingPersistenceError(404, "Run not found");
  assert.deepEqual(problem(err404), {
    status: 404,
    message: "Run not found",
  });

  const err409 = new TestingPersistenceError(409, "Run is terminal");
  assert.deepEqual(problem(err409), {
    status: 409,
    message: "Run is terminal",
  });
});

test("problem maps RunRequestError to its status and message", () => {
  const err400 = new RunRequestError(400, "Invalid thread ID");
  assert.deepEqual(problem(err400), {
    status: 400,
    message: "Invalid thread ID",
  });

  const err404 = new RunRequestError(404, "Thread not found");
  assert.deepEqual(problem(err404), {
    status: 404,
    message: "Thread not found",
  });
});

test("problem returns null for unclassified or foreign errors", () => {
  assert.strictEqual(problem(new Error("unexpected crash")), null);
  assert.strictEqual(problem("string failure"), null);
  assert.strictEqual(problem(null), null);
  assert.strictEqual(problem(undefined), null);
});

test("read throws RunRequestError 400 for invalid threadId UUID", async () => {
  await assert.rejects(
    () => read("not-a-valid-uuid", "00000000-0000-0000-0000-000000000001"),
    (err: unknown) => {
      assert.ok(err instanceof RunRequestError);
      assert.strictEqual(err.status, 400);
      assert.strictEqual(err.message, "Invalid thread ID");
      const mapped = problem(err);
      assert.deepEqual(mapped, { status: 400, message: "Invalid thread ID" });

      return true;
    },
  );
});

test("cancel throws RunRequestError 400 for invalid threadId UUID", async () => {
  await assert.rejects(
    () => cancel("not-a-valid-uuid", "00000000-0000-0000-0000-000000000001"),
    (err: unknown) => {
      assert.ok(err instanceof RunRequestError);
      assert.strictEqual(err.status, 400);
      assert.strictEqual(err.message, "Invalid thread ID");
      const mapped = problem(err);
      assert.deepEqual(mapped, { status: 400, message: "Invalid thread ID" });

      return true;
    },
  );
});

test("delegation validation errors remain ordinary structured tool problems", () => {
  assert.deepEqual(
    problem(new TestingPersistenceError(400, "Explicit plan reference is missing")),
    {
      status: 400,
      message: "Explicit plan reference is missing",
    },
  );
});
