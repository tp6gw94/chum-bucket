import assert from "node:assert/strict";
import { test } from "node:test";
import type { FunctionalCheck, PlanCase, StyleCheck } from "../../shared/testing";
import { checksForRole } from "./testing-domain";

const design = { fileKey: "abc", nodeId: "1:2" };

function functional(id: string): FunctionalCheck {
  return { id, criterionId: "crit:1", kind: "functional", expectedObservation: id };
}

function style(id: string): StyleCheck {
  return {
    id,
    criterionId: "crit:1",
    kind: "style",
    design,
    property: "gap",
    tolerance: { kind: "exact" },
  };
}

function planCase(id: string, checks: PlanCase["checks"]): PlanCase {
  return { id, title: id, preconditions: [], actions: [{ kind: "navigate", path: "/" }], checks };
}

const cases = [
  planCase("case-1", [style("s-1"), functional("f-1"), style("s-2")]),
  planCase("case-2", [functional("f-2")]),
  planCase("case-3", []),
];

test("checksForRole returns each browser role its own kind in case then check order", () => {
  const ac: readonly FunctionalCheck[] = checksForRole(cases, "ac");
  const ui: readonly StyleCheck[] = checksForRole(cases, "ui");
  assert.deepEqual(
    ac.map((check) => check.id),
    ["f-1", "f-2"],
  );
  assert.deepEqual(
    ui.map((check) => check.id),
    ["s-1", "s-2"],
  );
});

test("checksForRole is empty when no case holds a check of the role's kind", () => {
  assert.deepEqual(checksForRole([planCase("case-1", [functional("f-1")])], "ui"), []);
  assert.deepEqual(checksForRole([planCase("case-1", [style("s-1")])], "ac"), []);
  assert.deepEqual(checksForRole([], "ac"), []);
});
