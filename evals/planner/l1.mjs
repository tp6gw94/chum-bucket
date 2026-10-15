const component = (name, failures) => {
  const pass = failures.length === 0;

  return {
    pass,
    score: pass ? 1 : 0,
    reason: pass ? `${name} ok` : `${name}: ${failures.join("; ")}`,
  };
};

const rejectedResult = (output) => {
  const detail = output.issues.length > 0 ? output.issues.join("; ") : output.reason;

  return { pass: false, score: 0, reason: `Planner rejected the proposal: ${detail}` };
};

function planParts(output) {
  const criteria = output.criteria;
  const cases = output.cases;
  const deferredCases = output.deferredCases ?? [];
  const checks = cases.flatMap((planCase) => planCase.checks);
  const expectations = deferredCases.flatMap((deferred) =>
    deferred.expectations.map((expectation) => ({ ...expectation, caseId: deferred.id })),
  );

  return {
    plan: output,
    criteria,
    cases,
    deferredCases,
    checks,
    expectations,
    definedIds: new Set(criteria.map((criterion) => criterion.id)),
    executableIds: new Set(checks.map((check) => check.criterionId)),
    deferredIds: new Set(expectations.map((expectation) => expectation.criterionId)),
  };
}

function executableFailures(parts, id) {
  if (!parts.definedIds.has(id)) {
    return [`criterion ${id} is not defined in criteria`];
  }

  if (!parts.executableIds.has(id)) {
    return [`criterion ${id} has no executable check`];
  }

  return [];
}

function deferredFailures(parts, id) {
  if (!parts.definedIds.has(id)) {
    return [`criterion ${id} is not defined in criteria`];
  }

  if (parts.executableIds.has(id)) {
    return [`criterion ${id} has an executable check`];
  }

  if (!parts.deferredIds.has(id)) {
    return [`criterion ${id} has no deferred expectation`];
  }

  return [];
}

function eitherFailures(parts, id) {
  if (!parts.definedIds.has(id)) {
    return [`criterion ${id} is not defined in criteria`];
  }

  if (!parts.executableIds.has(id) && !parts.deferredIds.has(id)) {
    return [`criterion ${id} has no check or deferred expectation`];
  }

  return [];
}

function excludedFailures(parts, id) {
  const failures = [];

  if (parts.definedIds.has(id)) {
    failures.push(`excluded criterion ${id} is defined in criteria`);
  }

  for (const check of parts.checks) {
    if (check.criterionId === id) {
      failures.push(`excluded criterion ${id} is referenced by check ${check.id}`);
    }
  }

  for (const expectation of parts.expectations) {
    if (expectation.criterionId === id) {
      failures.push(
        `excluded criterion ${id} is referenced by deferred case ${expectation.caseId}`,
      );
    }
  }

  return failures;
}

function perIdComponents(name, ids, evaluate) {
  return (ids ?? []).map((id) => component(`${name} ${id}`, evaluate(id)));
}

function literalComponents(config, parts) {
  return Object.entries(config.literals ?? {}).map(([id, literals]) => {
    const observations = [...parts.checks, ...parts.expectations]
      .filter((entry) => entry.criterionId === id)
      .map((entry) => entry.expectedObservation)
      .filter((text) => typeof text === "string");
    const failures = literals
      .filter((literal) => !observations.some((text) => text.includes(literal)))
      .map(
        (literal) =>
          `literal ${JSON.stringify(literal)} is missing from every expectedObservation of ${id}`,
      );

    return component(`literals ${id}`, failures);
  });
}

function boundaryMaterial(parts, id) {
  const coveringCases = parts.cases.filter((planCase) =>
    planCase.checks.some((check) => check.criterionId === id),
  );
  const coveringDeferred = parts.deferredCases.filter((deferred) =>
    deferred.expectations.some((expectation) => expectation.criterionId === id),
  );

  return [
    ...coveringCases.flatMap((planCase) =>
      planCase.actions.filter((action) => action.kind === "fill").map((action) => action.value),
    ),
    ...coveringCases.flatMap((planCase) =>
      planCase.checks
        .filter((check) => check.criterionId === id)
        .map((check) => check.expectedObservation),
    ),
    ...coveringDeferred.flatMap((deferred) =>
      deferred.expectations
        .filter((expectation) => expectation.criterionId === id)
        .map((expectation) => expectation.expectedObservation),
    ),
  ].filter((text) => typeof text === "string");
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const containsStandalone = (text, value) =>
  new RegExp(`(?<![\\d.])${escapeRegExp(value)}(?!\\d)(?!\\.\\d)`).test(text);

function boundaryComponents(config, parts) {
  return Object.entries(config.boundaries ?? {}).map(([id, values]) => {
    const material = boundaryMaterial(parts, id);
    const failures = values
      .filter((value) => !material.some((text) => containsStandalone(text, value)))
      .map(
        (value) =>
          `boundary ${JSON.stringify(value)} is missing from every fill value and expectedObservation of ${id}`,
      );

    return component(`boundaries ${id}`, failures);
  });
}

function criterionComponents(config, parts) {
  const { plan, criteria, checks, expectations } = parts;
  const components = [];

  if (config.minCriteria !== undefined) {
    const failures =
      criteria.length >= config.minCriteria
        ? []
        : [`criteria has ${criteria.length} entries, need at least ${config.minCriteria}`];

    components.push(component("minCriteria", failures));
  }

  if (config.observations !== undefined) {
    const observations = [...checks, ...expectations]
      .map((entry) => entry.expectedObservation)
      .filter((text) => typeof text === "string");
    const failures = config.observations
      .filter((observation) => !observations.some((text) => text.includes(observation)))
      .map(
        (observation) =>
          `observation ${JSON.stringify(observation)} is missing from every expectedObservation`,
      );

    components.push(component("observations", failures));
  }

  if (config.unresolved === "required") {
    const failures = plan.unresolved.length > 0 ? [] : ["unresolved is empty"];

    components.push(component("unresolved", failures));
  }

  return components;
}

function checkKindComponents(config, parts) {
  const components = [];

  if (config.functionalChecks === "forbidden") {
    const failures = parts.checks
      .filter((check) => check.kind === "functional")
      .map((check) => `functional check ${check.id} is forbidden`);

    components.push(component("functionalChecks", failures));
  }

  if (config.styleChecks === "required") {
    const styles = parts.checks.filter((check) => check.kind === "style");
    const failures = styles.length === 0 ? ["no executable style check exists"] : [];

    components.push(component("styleChecks", failures));
  }

  if (config.styleChecks === "forbidden") {
    const failures = parts.checks
      .filter((check) => check.kind === "style")
      .map((check) => `style check ${check.id} is forbidden`);

    components.push(component("styleChecks", failures));
  }

  return components;
}

function designComponents(config, parts) {
  if (config.design === undefined) {
    return [];
  }

  const failures = parts.checks
    .filter((check) => check.kind === "style")
    .filter(
      (check) =>
        check.design.fileKey !== config.design.fileKey ||
        check.design.nodeId !== config.design.nodeId,
    )
    .map(
      (check) =>
        `style check ${check.id} references ${JSON.stringify(check.design)} instead of ${config.design.fileKey} / ${config.design.nodeId}`,
    );

  return [component("design", failures)];
}

function planWideComponents(config, parts) {
  const components = [];

  if (config.allowedPaths !== undefined) {
    const allowed = new Set(config.allowedPaths);
    const failures = parts.cases
      .flatMap((planCase) => planCase.actions)
      .filter((action) => action.kind === "navigate" && !allowed.has(action.path))
      .map((action) => `navigate path ${JSON.stringify(action.path)} is not allowed`);

    components.push(component("allowedPaths", failures));
  }

  if (config.forbidden !== undefined) {
    const serialized = JSON.stringify(parts.plan);
    const failures = config.forbidden
      .filter((token) => serialized.includes(token))
      .map((token) => `forbidden string ${JSON.stringify(token)} appears in the plan`);

    components.push(component("forbidden", failures));
  }

  return components;
}

export default function l1(output, context) {
  if (output.state === "failed") {
    return rejectedResult(output);
  }

  const config = context?.config ?? {};
  const parts = planParts(output);
  const components = [
    ...perIdComponents("executable", config.executable, (id) => executableFailures(parts, id)),
    ...perIdComponents("deferred", config.deferred, (id) => deferredFailures(parts, id)),
    ...perIdComponents("either", config.either, (id) => eitherFailures(parts, id)),
    ...perIdComponents("excluded", config.excluded, (id) => excludedFailures(parts, id)),
    ...literalComponents(config, parts),
    ...boundaryComponents(config, parts),
    ...criterionComponents(config, parts),
    ...checkKindComponents(config, parts),
    ...designComponents(config, parts),
    ...planWideComponents(config, parts),
  ];
  const failed = components.filter((entry) => !entry.pass);
  const pass = failed.length === 0;
  const score =
    components.length === 0 ? 1 : (components.length - failed.length) / components.length;
  const reason = pass
    ? "All L1 rules passed"
    : `L1 rules failed: ${failed.map((entry) => entry.reason).join(" | ")}`;

  return { pass, score, reason, componentResults: components };
}
