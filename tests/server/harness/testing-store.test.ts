import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { artifactRefSchema, type TestingRequestInput } from "../../../shared/testing";
import {
  digestOf,
  requirementsScopeDigest,
  validateRequirements,
} from "../../../server/harness/testing-domain";
import { roleRegistry } from "../../../server/harness/agents";
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

test("old agent profile artifacts are incompatible even when their requirements remain valid", () => {
  const source = { kind: "jira" as const, issueKey: "CHUM-42" };
  const intent: TestingRequestInput = {
    goal: "Verify checkout",
    sources: [source],
    criteria: { kind: "all" },
    targetUrl: "https://preview.example.test/checkout",
  };
  const requirements = validateRequirements(
    {
      criteria: [{ key: "AC-1", statement: "Receipt appears", source, anchor: "AC-1" }],
      unresolved: [],
    },
    {
      goal: intent.goal,
      selection: intent.criteria,
      captures: [
        {
          reference: source,
          digest: "source",
          anchors: ["AC-1"],
          capturedAt: "2026-10-10T00:00:00Z",
        },
      ],
    },
  );
  assert.equal(requirements.kind, "accepted");

  if (requirements.kind !== "accepted") {
    return;
  }

  const ref = artifactRefSchema.parse("requirements-profile-artifact");
  const metadata = {
    dependencies: [],
    versions: host.versions,
    profiles: host.profiles,
    registration: host.registration,
    bounds: host.bounds,
    fixture: host.fixture,
    parentRunId: "run-1",
    producerTaskId: "task-1",
    attempt: 1,
    inputDigest: "input",
    outputDigest: digestOf(requirements.value),
    complete: true,
  };
  const artifact = row({
    ref,
    kind: "requirements",
    payload: requirements.value,
    payloadDigest: digestOf(requirements.value),
    metadata,
    scopeDigest: requirementsScopeDigest({
      goal: intent.goal,
      sources: intent.sources,
      selection: intent.criteria,
    }),
  });
  const decide = (value: StoredArtifactRow) =>
    closureDecisions({
      threadId: "thread-1",
      intent,
      refs: [ref],
      rows: new Map([[ref, value]]),
      host,
    });
  assert.equal(decide(artifact)[0]?.kind, "accepted");
  assert.deepEqual(
    decide({
      ...artifact,
      metadata: { ...metadata, profiles: { ...metadata.profiles, atlassian: "requirements-v1" } },
    }),
    [{ ref, kind: "rejected", reason: "incompatible_snapshot" }],
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
