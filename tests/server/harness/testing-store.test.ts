import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { artifactRefSchema } from "../../../shared/testing";
import { roleRegistry } from "../../../server/harness/testing-domain";
import {
  closureDecisions,
  hostTestingRuntime,
  missingSourceCaptures,
  testingFinishOutcome,
  type StoredArtifactRow,
} from "../../../server/harness/testing-store";

const host = hostTestingRuntime({ model: "owner-model", build: "owner-build" });

function row(
  overrides: Partial<StoredArtifactRow> & Pick<StoredArtifactRow, "ref" | "kind">,
): StoredArtifactRow {
  return {
    threadId: "thread-1",
    scopeDigest: "scope",
    payloadDigest: "digest",
    payload: { goal: "Verify checkout" },
    metadata: {},
    dependencies: [],
    origin: {
      runId: "run-1",
      threadId: "thread-1",
      role: overrides.kind === "plan" ? "planner" : "atlassian",
      issuedAt: "2026-10-09T00:00:00.000Z",
    },
    ...overrides,
  };
}

test("owner snapshot versions are passed in and are not a second model constant", () => {
  assert.equal(host.model, "owner-model");
  assert.equal(host.build, "owner-build");
  assert.equal(host.versions.model, "owner-model");
  assert.equal(host.versions.build, "owner-build");
  assert.equal(host.profiles.atlassian, roleRegistry.atlassian.profile);
  assert.equal(host.registration.atlassian.includes(roleRegistry.atlassian.profile), true);
  assert.notEqual(host.registration.atlassian, host.profiles.atlassian);
});

test("explicit bad refs and cross-run results reject without dropping any ref", () => {
  const intent = {
    goal: "Verify checkout",
    sources: [{ kind: "jira" as const, issueKey: "CHUM-42" }],
    criteria: { kind: "all" as const },
    targetUrl: "https://preview.example.test/checkout",
  };
  const missing = artifactRefSchema.parse("missing-artifact");
  const result = artifactRefSchema.parse("ac-artifact");
  const decisions = closureDecisions({
    threadId: "thread-1",
    intent,
    refs: [missing, result],
    rows: new Map([
      [
        result,
        row({
          ref: result,
          kind: "ac-result",
          origin: {
            runId: "run-1",
            threadId: "thread-1",
            role: "ac",
            issuedAt: "2026-10-09T00:00:00.000Z",
          },
        }),
      ],
    ]),
    host,
  });
  assert.deepEqual(
    decisions.map((decision) => ({
      ref: decision.ref,
      kind: decision.kind,
      reason: decision.kind === "rejected" ? decision.reason : null,
    })),
    [
      { ref: missing, kind: "rejected", reason: "not_accessible" },
      { ref: result, kind: "rejected", reason: "cross_run_result_forbidden" },
    ],
  );
});

test("source capture coverage is the requested source set", () => {
  const requested = [{ kind: "jira" as const, issueKey: "CHUM-42" }];
  assert.deepEqual(
    missingSourceCaptures(requested, [
      {
        reference: { kind: "confluence", pageId: "99" },
        digest: "other",
        anchors: ["AC-1"],
        capturedAt: "2026-10-09T00:00:00.000Z",
      },
    ]),
    requested,
  );
  assert.deepEqual(
    missingSourceCaptures(requested, [
      {
        reference: { kind: "jira", issueKey: "CHUM-42" },
        digest: "capture",
        anchors: ["AC-1"],
        capturedAt: "2026-10-09T00:00:00.000Z",
      },
    ]),
    [],
  );
});

test("parent finish maps testing outcome without treating success as completed", () => {
  assert.equal(testingFinishOutcome("execution_failed", false), "failed");
  assert.equal(testingFinishOutcome("workflow_cancelled", true), "cancelled");
  assert.equal(testingFinishOutcome("provider_timed_out", false), "timed_out");
  assert.equal(testingFinishOutcome("ok", true), "missing");
});

test("supervised testing migration has no SQL comments", async () => {
  const sql = await readFile(
    new URL("../../../drizzle/0003_supervised_testing.sql", import.meta.url),
    "utf8",
  );
  const stripped = sql.replaceAll("--> statement-breakpoint", "");
  assert.equal(stripped.includes("--"), false);
  assert.equal(stripped.includes("/*"), false);
  assert.equal(sql.includes("testing_operations"), true);
  assert.equal(sql.includes("testing_publications"), true);
});

test("host runtime rejects an empty owner snapshot", () => {
  assert.throws(() => hostTestingRuntime({ model: " ", build: "owner-build" }), /host snapshot/);
});
