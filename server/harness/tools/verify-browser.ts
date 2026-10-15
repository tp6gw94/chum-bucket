import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Locator, type Page } from "playwright";
import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";
import type { Check, Evidence, PlanCase, RoleTask } from "../../../shared/testing";
import { digestOf } from "../testing-domain";

const inputSchema = z.strictObject({ checkId: z.string().min(1).max(128) });
export const verifyAc = toolDefinition({
  name: "verify_ac",
  description:
    "Execute an assigned functional check in the host's plan and target. Only checkId is accepted.",
  inputSchema,
  metadata: { direct: true },
});
export const verifyUi = toolDefinition({
  name: "verify_ui",
  description:
    "Measure an assigned style check against the captured Figma node. Only checkId is accepted.",
  inputSchema,
  metadata: { direct: true },
});

async function targetFor(page: Page, target: string): Promise<Locator> {
  const named = page
    .getByRole("button", { name: target, exact: true })
    .or(page.getByRole("link", { name: target, exact: true }))
    .or(page.getByLabel(target, { exact: true }));

  if ((await named.count()) === 1) {
    return named;
  }

  const text = page.getByText(target, { exact: true });

  if ((await text.count()) !== 1) {
    throw new Error(`Target is missing or ambiguous: ${target}`);
  }

  return text;
}

async function functional(
  page: Page,
  check: Extract<Check, { kind: "functional" }>,
): Promise<Pick<Evidence, "outcome" | "observed" | "expected">> {
  const observation = check.observation;
  let observed: string;

  if (observation.kind === "url") {
    const url = new URL(page.url());
    observed = `${url.origin}${url.pathname}`;
  } else {
    const element = await targetFor(page, observation.target);
    const readers = {
      text: () => element.innerText(),
      value: () => element.inputValue(),
      visible: async () => String(await element.isVisible()),
      operable: async () =>
        String(
          (await element.isVisible()) &&
            (await element.isEnabled()) &&
            !(await element.evaluate((node) => !!node.closest('[inert], [aria-disabled="true"]'))),
        ),
    };
    observed = (await readers[observation.kind]()).trim();
  }

  const expected = check.expectedObservation;
  const passed =
    observation.comparison === "contains" ? observed.includes(expected) : observed === expected;

  return { observed, expected, outcome: passed ? "pass" : "fail" };
}

async function style(
  page: Page,
  check: Extract<Check, { kind: "style" }>,
  designValues: Record<string, string>,
): Promise<Pick<Evidence, "outcome" | "observed" | "expected">> {
  const expected = designValues[check.property];

  if (expected === undefined) {
    throw new Error(`Unsupported or missing design property: ${check.property}`);
  }

  await page.evaluate(() => document.fonts.ready);
  const element = await targetFor(page, check.target);
  const observed = await element.evaluate((node, property) => {
    const box = node.getBoundingClientRect();

    return property === "width" || property === "height"
      ? `${box[property]}px`
      : getComputedStyle(node).getPropertyValue(
          property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
        );
  }, check.property);
  const passed =
    check.tolerance.kind === "exact"
      ? observed === expected
      : numericMatch(observed, expected, check.tolerance.unit, check.tolerance.maxDelta);

  return { expected, observed, outcome: passed ? "pass" : "fail" };
}

function numericMatch(observed: string, expected: string, unit: string, maxDelta: number) {
  const suffix = unit === "px" ? "px" : "";
  const pattern = new RegExp(`^-?\\d+(?:\\.\\d+)?${suffix}$`);

  return (
    pattern.test(observed) &&
    pattern.test(expected) &&
    Math.abs(parseFloat(observed) - parseFloat(expected)) <= maxDelta
  );
}

async function actionOn(page: Page, action: PlanCase["actions"][number], origin: string) {
  if (action.kind === "navigate") {
    const url = new URL(action.path, origin);

    if (url.origin !== origin || url.username || url.password) {
      throw new Error("Navigation outside target origin is forbidden");
    }

    await page.goto(url.href);

    return;
  }

  const target = await targetFor(page, action.target);

  if (!(await target.isVisible()) || !(await target.isEnabled())) {
    throw new Error("Action target is not operable");
  }

  if (action.kind === "click") {
    await target.click();

    return;
  }

  if (action.value === undefined) {
    throw new Error("Fill value is missing from plan");
  }

  await target.fill(action.value);
}

async function actions(page: Page, entry: PlanCase, origin: string) {
  for (const action of entry.actions) {
    await actionOn(page, action, origin);
  }
}

function baseEvidence(entry: PlanCase, check: Check): Evidence {
  return {
    origin: "browser",
    fixture: { id: "playwright-chromium", version: "v1" },
    caseId: entry.id,
    checkId: check.id,
    outcome: "blocked",
  };
}

async function markExecution(executionKey: string): Promise<boolean> {
  const directory = resolve(".data/browser-executions");
  await mkdir(directory, { recursive: true });

  try {
    await writeFile(resolve(directory, executionKey), "started", { flag: "wx" });

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }

    throw error;
  }
}

async function observe(
  page: Page,
  entry: PlanCase,
  check: Check,
  designValues: Record<string, string>,
): Promise<Evidence> {
  try {
    const observation =
      check.kind === "functional"
        ? await functional(page, check)
        : await style(page, check, designValues);

    return { ...baseEvidence(entry, check), ...observation };
  } catch (error) {
    return {
      ...baseEvidence(entry, check),
      reason: error instanceof Error ? error.message : "Observation failed",
    };
  }
}

async function runCase(
  taskId: string,
  role: "ac" | "ui",
  task: RoleTask,
  entry: PlanCase,
  signal: AbortSignal,
  designValues: Record<string, string>,
): Promise<Evidence[]> {
  const checks = entry.checks.filter((check) => task.checks.includes(check.id));
  const blocked = (reason: string) =>
    checks.map((check) => ({ ...baseEvidence(entry, check), reason }));

  if (
    entry.preconditions.length ||
    (role === "ui" && entry.actions.some((action) => action.kind !== "navigate"))
  ) {
    return blocked("Unsupported preconditions or UI actions");
  }

  const executionKey = digestOf([taskId, role, entry.id]);

  if (!(await markExecution(executionKey))) {
    return blocked("Prior browser execution may have produced effects; replay is forbidden");
  }

  signal.throwIfAborted();
  const browser = await chromium
    .launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE })
    .catch(() => null);

  if (!browser) {
    return blocked(
      "Chromium could not start; configure CHROMIUM_EXECUTABLE or install the Playwright browser",
    );
  }

  const close = () => {
    void browser.close().catch(() => undefined);
  };

  signal.addEventListener("abort", close, { once: true });

  try {
    signal.throwIfAborted();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      serviceWorkers: "block",
      acceptDownloads: false,
      reducedMotion: "reduce",
    });
    const origin = new URL(task.targetUrl!).origin;
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());

      return ["http:", "https:"].includes(url.protocol) && url.origin === origin
        ? route.continue()
        : route.abort();
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    await page.goto(task.targetUrl!);
    await actions(page, entry, origin);
    await page.addStyleTag({
      content: "*,*::before,*::after{animation:none!important;transition:none!important}",
    });
    const evidence: Evidence[] = [];

    for (const check of checks) {
      signal.throwIfAborted();

      evidence.push(await observe(page, entry, check, designValues));
    }

    const screenshot = resolve(".data/browser-evidence", `${executionKey}.png`);
    await mkdir(resolve(".data/browser-evidence"), { recursive: true });
    await page.screenshot({ path: screenshot, fullPage: true, animations: "disabled" });

    return evidence.map((item) => ({ ...item, screenshot }));
  } catch (error) {
    return blocked(error instanceof Error ? error.message : "Browser execution failed");
  } finally {
    signal.removeEventListener("abort", close);
    await browser.close();
  }
}

export function browserVerifier(
  taskId: string,
  role: "ac" | "ui",
  task: RoleTask,
  cache: {
    load: (caseId: string) => Evidence[] | undefined;
    save: (caseId: string, evidence: Evidence[]) => Promise<void>;
  },
) {
  const cases = new Map<string, Promise<Evidence[]>>();

  return async (
    input: unknown,
    signal: AbortSignal,
    designValues: Record<string, string>,
  ): Promise<Evidence> => {
    const { checkId } = inputSchema.parse(input);
    const entry = task.plan?.cases.find((item) =>
      item.checks.some((check) => check.id === checkId),
    );

    if (!entry || !task.checks.includes(checkId)) {
      throw new Error("Unknown scoped check");
    }

    const persisted = cache.load(entry.id);

    if (persisted) {
      return persisted.find((check) => check.checkId === checkId)!;
    }

    let result = cases.get(entry.id);

    if (!result) {
      result = runCase(
        taskId,
        role,
        task,
        entry,
        AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
        designValues,
      ).then(async (evidence) => {
        await cache.save(entry.id, evidence);

        return evidence;
      });
      cases.set(entry.id, result);
    }

    return (await result).find((check) => check.checkId === checkId)!;
  };
}
