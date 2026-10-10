import { toolDefinition } from "@tanstack/ai";
import {
  designCaptureSchema,
  useBrowserInputSchema,
  type BrowserOutput,
  type DesignCapture,
  type FixtureIdentity,
  type PlanCase,
  type PlanCheck,
  type PublicEvidence,
} from "../../../shared/testing";
import { digestOf, withinTolerance } from "../testing-domain";

export type MockBrowserOutcome =
  | Readonly<{ state: "observed"; observed: string }>
  | Readonly<{ state: "blocked"; reason: string }>;

export type BrowserFixture = Readonly<{
  identity: FixtureIdentity;
  adapterVersion: string;
  outcomes: Readonly<Record<string, MockBrowserOutcome>>;
}>;

export type BrowserCheckScope = Readonly<{
  cases: readonly PlanCase[];
  checks: readonly PlanCheck[];
  fixture: BrowserFixture;
}> &
  (
    | Readonly<{ role: "ac"; figmaProperties: null; designCapture: null }>
    | Readonly<{
        role: "ui";
        figmaProperties: Readonly<Record<string, string>>;
        designCapture: DesignCapture;
      }>
  );

function assignedCases(cases: readonly PlanCase[]): ReadonlyMap<string, PlanCase> {
  const mapping = new Map<string, PlanCase>();
  for (const planCase of cases) {
    if (planCase.actions.length === 0) {
      throw new Error(`Case ${planCase.id} has no planned actions`);
    }
    for (const check of planCase.checks) {
      if (mapping.has(check.id)) {
        throw new Error(`Check ${check.id} is assigned to multiple cases`);
      }
      mapping.set(check.id, planCase);
    }
  }
  return mapping;
}

function evidenceFor(
  check: PlanCheck,
  planCase: PlanCase,
  outcome: MockBrowserOutcome,
  fixture: BrowserFixture,
  figmaProperties: Readonly<Record<string, string>> | null,
  designCapture: DesignCapture | null,
): PublicEvidence {
  const base = {
    caseId: planCase.id,
    checkId: check.id,
    origin: "mock",
    fixture: fixture.identity,
    adapterVersion: fixture.adapterVersion,
  } as const;
  if (check.kind === "functional") {
    const actionIndex = planCase.actions.length - 1;
    if (outcome.state === "blocked") {
      return {
        kind: "functional",
        outcome: "blocked",
        reason: outcome.reason,
        actionIndex,
        ...base,
      };
    }
    return outcome.observed === check.expectedObservation
      ? {
          kind: "functional",
          outcome: "pass",
          expected: check.expectedObservation,
          observed: outcome.observed,
          actionIndex,
          ...base,
        }
      : {
          kind: "functional",
          outcome: "fail",
          expected: check.expectedObservation,
          observed: outcome.observed,
          actionIndex,
          ...base,
        };
  }
  if (designCapture === null) {
    throw new Error(`Style check ${check.id} requires a trusted design capture`);
  }
  if (outcome.state === "blocked") {
    return {
      kind: "style",
      outcome: "blocked",
      reason: outcome.reason,
      property: check.property,
      tolerance: check.tolerance,
      capturedDesign: designCapture,
      ...base,
    };
  }
  const expected = figmaProperties?.[check.property];
  if (expected === undefined) {
    throw new Error(`Missing Figma property ${check.property}`);
  }
  return withinTolerance(check.tolerance, expected, outcome.observed)
    ? {
        kind: "style",
        outcome: "inside_tolerance",
        property: check.property,
        expected,
        observed: outcome.observed,
        tolerance: check.tolerance,
        capturedDesign: designCapture,
        ...base,
      }
    : {
        kind: "style",
        outcome: "outside_tolerance",
        property: check.property,
        expected,
        observed: outcome.observed,
        tolerance: check.tolerance,
        capturedDesign: designCapture,
        ...base,
      };
}

export function createUseBrowserTool(scope: BrowserCheckScope) {
  if (scope.checks.length === 0) {
    throw new Error("use_browser requires at least one scoped check");
  }
  const casesByCheck = assignedCases(scope.cases);
  const checkIds = new Set<string>();
  for (const check of scope.checks) {
    if (checkIds.has(check.id)) {
      throw new Error(`Duplicate scoped check ${check.id}`);
    }
    checkIds.add(check.id);
    if (!casesByCheck.has(check.id)) {
      throw new Error(`Scoped check ${check.id} is not assigned to a canonical case`);
    }
    const expectedKind = scope.role === "ac" ? "functional" : "style";
    if (check.kind !== expectedKind) {
      throw new Error(`Scoped check ${check.id} is not a ${expectedKind} check`);
    }
    if (!scope.fixture.outcomes[check.id]) {
      throw new Error(`Fixture has no outcome for ${check.id}`);
    }
    if (check.kind === "style") {
      const expected = scope.figmaProperties?.[check.property];
      if (expected === undefined) {
        throw new Error(`Figma capture has no property ${check.property}`);
      }
    }
  }
  for (const id of Object.keys(scope.fixture.outcomes)) {
    if (!checkIds.has(id)) {
      throw new Error(`Fixture has an outcome outside the scoped checks: ${id}`);
    }
  }
  let figmaProperties: Readonly<Record<string, string>> | null = null;
  let designCapture: DesignCapture | null = null;
  if (scope.role === "ui") {
    const capture = designCaptureSchema.safeParse(scope.designCapture);
    if (!capture.success) {
      throw new Error("UI scope requires a complete trusted Figma capture");
    }
    if (capture.data.propertiesDigest !== digestOf(scope.figmaProperties)) {
      throw new Error("Figma capture digest does not match the normalized properties");
    }
    for (const check of scope.checks) {
      if (
        check.kind === "style" &&
        (check.design.fileKey !== capture.data.reference.fileKey ||
          check.design.nodeId !== capture.data.reference.nodeId)
      ) {
        throw new Error(`Style check ${check.id} does not reference the captured design`);
      }
    }
    figmaProperties = scope.figmaProperties;
    designCapture = capture.data;
  }
  return toolDefinition({
    name: "use_browser",
    description:
      "Run one assigned browser check against the host-provided deterministic fixture. Pass the check ID from the canonical plan. The host fixture decides the observed result; it is never chosen by the caller.",
    inputSchema: useBrowserInputSchema,
  }).server(async (raw): Promise<BrowserOutput> => {
    const input = useBrowserInputSchema.parse(raw);
    const check = scope.checks.find((item) => item.id === input.checkId);
    if (!check) {
      throw new Error(`Unknown scoped check ${input.checkId}`);
    }
    const planCase = casesByCheck.get(input.checkId);
    if (!planCase) {
      throw new Error(`Scoped check ${input.checkId} is not assigned to a canonical case`);
    }
    const outcome = scope.fixture.outcomes[input.checkId];
    if (!outcome) {
      throw new Error(`Fixture has no outcome for ${input.checkId}`);
    }
    return {
      checkId: input.checkId,
      evidence: evidenceFor(
        check,
        planCase,
        outcome,
        scope.fixture,
        figmaProperties,
        designCapture,
      ),
    };
  });
}
