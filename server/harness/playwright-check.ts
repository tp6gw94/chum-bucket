import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type ElementHandle,
  type Page,
} from "playwright";
import type {
  FunctionalCheck,
  PlanCase,
  PlanCheck,
  PublicEvidence,
  StyleCheck,
} from "../../shared/testing";
import { JevError, selectCandidate } from "./jev-client";
import type { BrowserAdapter, BrowserOutcome } from "./tools/use-browser";

const LIVE_BROWSER = {
  identity: { id: "playwright-chromium", version: "v1" },
  adapterVersion: "playwright-jev-v1",
} as const;
type BrowserDetails = NonNullable<PublicEvidence["browser"]>;
type Observation = BrowserOutcome & { browser?: BrowserDetails };
class BrowserBlocked extends Error {}

function failureReason(stage: string, error: unknown, signal: AbortSignal): string {
  const code = signal.aborted
    ? "cancelled_or_timed_out"
    : error instanceof JevError
      ? error.code
      : error instanceof BrowserBlocked
        ? error.message
        : "browser_or_storage_error";

  return JSON.stringify({
    stage,
    code,
    replay: "forbidden",
    ...(error instanceof JevError && error.diagnostics ? { diagnostics: error.diagnostics } : {}),
  });
}

const styleProperties: Record<string, string> = {
  color: "color",
  backgroundColor: "backgroundColor",
  fontSize: "fontSize",
  fontWeight: "fontWeight",
  opacity: "opacity",
  cornerRadius: "borderRadius",
  borderRadius: "borderRadius",
  letterSpacing: "letterSpacing",
  lineHeight: "lineHeight",
};

function allowedUrl(raw: string, target: URL): string {
  const url = new URL(raw, target);

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.origin !== target.origin ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "Navigation outside the authorized origin or containing URL credentials is blocked",
    );
  }

  return url.href;
}

async function fingerprint(element: ElementHandle<Element>): Promise<string> {
  return element.evaluate(
    (node, visible) =>
      JSON.stringify({
        visible,
        tag: node.tagName,
        id: node.id,
        role: node.getAttribute("role"),
        markers: node
          .getAttributeNames()
          .filter((name) => name.startsWith("data-"))
          .slice(0, 10),
        children: node.childElementCount,
        text: (node instanceof HTMLElement ? node.innerText : node.textContent)
          ?.trim()
          .slice(0, 240),
        label: node.getAttribute("aria-label"),
        type: node.getAttribute("type"),
        context: node.parentElement?.innerText?.trim().slice(0, 300),
        connected: node.isConnected,
      }),
    await element.isVisible(),
  );
}

async function targetElement(
  page: Page,
  intent: string,
  action: "click" | "fill" | "observe" | "visible",
  signal: AbortSignal,
  details: BrowserDetails,
): Promise<ElementHandle<Element>> {
  const selector =
    action === "fill"
      ? "input:not([type=password]):not([type=hidden]),textarea"
      : action === "click"
        ? "button,a,[role=button],input[type=submit]"
        : "h1,h2,h3,p,span,button,a,input:not([type=password]):not([type=hidden]),textarea,label,[role],strong,small,output,dd,dt,div";
  const all = await page.$$(selector);
  const candidates: { id: string; description: string; element: ElementHandle<Element> }[] = [];

  for (const element of all) {
    const layoutContainer = await element.evaluate(
      (node) =>
        node.tagName === "DIV" &&
        node.childElementCount > 0 &&
        !node.hasAttribute("role") &&
        !node.hasAttribute("aria-label"),
    );

    if (!layoutContainer && (action === "visible" || (await element.isVisible()))) {
      candidates.push({
        id: `c${candidates.length}`,
        description: await fingerprint(element),
        element,
      });

      if (candidates.length > 80) {
        throw new BrowserBlocked("DOM candidate limit exceeded; narrow the page");
      }
    }
  }

  const selection = await selectCandidate(
    intent,
    candidates.map(({ id, description }) => ({ id, description })),
    signal,
  );
  details.selections.push(selection);
  signal.throwIfAborted();
  const candidate = candidates.find((item) => item.id === selection.choice)!;

  if ((await fingerprint(candidate.element)) !== candidate.description) {
    throw new BrowserBlocked("DOM target changed during selection");
  }

  return candidate.element;
}

const supportedStyleProperties = new Set(["width", "height", ...Object.keys(styleProperties)]);

function normalizeColor(value: string): string {
  const match = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(value);

  return match
    ? `#${match
        .slice(1)
        .map((part) => Number(part).toString(16).padStart(2, "0"))
        .join("")}`
    : value;
}

function observedUrl(page: Page): string {
  const url = new URL(page.url());

  return `${url.origin}${url.pathname}`;
}

async function ensureFontsReady(page: Page): Promise<void> {
  const ready = await page.evaluate(async () =>
    Promise.race([
      document.fonts.ready.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
    ]),
  );

  if (!ready) {
    throw new BrowserBlocked("font_readiness_timeout");
  }
}

async function functionalObservation(
  page: Page,
  check: FunctionalCheck,
  signal: AbortSignal,
  details: BrowserDetails,
): Promise<string> {
  const observation = check.observation;

  if (!observation) {
    throw new BrowserBlocked("Legacy check has no executable observation");
  }

  if (observation.kind === "url") {
    return observedUrl(page);
  }

  const element = await targetElement(
    page,
    observation.target,
    observation.kind === "visible" ? "visible" : "observe",
    signal,
    details,
  );

  if (observation.kind === "visible") {
    return String(await element.isVisible());
  }

  if (observation.kind === "value") {
    return element.inputValue();
  }

  return (await element.innerText()).trim();
}

async function styleObservation(
  page: Page,
  check: StyleCheck,
  signal: AbortSignal,
  details: BrowserDetails,
): Promise<string> {
  if (!check.target) {
    throw new BrowserBlocked("Legacy style check has no executable target");
  }

  if (!supportedStyleProperties.has(check.property)) {
    throw new BrowserBlocked("Unsupported deterministic style property");
  }

  await ensureFontsReady(page);
  const element = await targetElement(page, check.target, "observe", signal, details);
  const box = await stableBox(page, element, signal);

  if (check.property === "width" || check.property === "height") {
    return `${box[check.property]}px`;
  }

  const value = await element.evaluate(
    (node, property) => String(Reflect.get(getComputedStyle(node), property)),
    styleProperties[check.property]!,
  );

  return normalizeColor(value);
}

async function observeCheck(
  page: Page,
  check: PlanCheck,
  signal: AbortSignal,
  details: BrowserDetails,
): Promise<string> {
  return check.kind === "functional"
    ? functionalObservation(page, check, signal, details)
    : styleObservation(page, check, signal, details);
}

async function stableBox(page: Page, element: ElementHandle<Element>, signal: AbortSignal) {
  let previous = await element.boundingBox();
  let stableSamples = 0;

  for (let sample = 0; sample < 8; sample++) {
    signal.throwIfAborted();
    await page.waitForTimeout(100);
    const current = await element.boundingBox();

    if (!current || !previous) {
      throw new BrowserBlocked("target_has_no_border_box");
    }

    const stable = (["x", "y", "width", "height"] as const).every(
      (key) => Math.abs(current[key] - previous![key]) < 0.1,
    );
    stableSamples = stable ? stableSamples + 1 : 0;

    if (stableSamples >= 2) {
      return current;
    }

    previous = current;
  }

  throw new BrowserBlocked("layout_readiness_timeout");
}

async function guardContext(
  context: BrowserContext,
  target: URL,
  denyNavigation: () => void,
): Promise<void> {
  await context.routeWebSocket("**/*", (socket) => socket.close());
  await context.route("**/*", async (route) => {
    try {
      allowedUrl(route.request().url(), target);
      await route.continue();
    } catch {
      if (route.request().isNavigationRequest()) {
        denyNavigation();
      }

      await route.abort();
    }
  });
}

async function applyAction(
  page: Page,
  target: URL,
  action: PlanCase["actions"][number],
  signal: AbortSignal,
  details: BrowserDetails,
): Promise<void> {
  if (action.kind === "navigate") {
    await page.goto(allowedUrl(action.path, target), { waitUntil: "domcontentloaded" });

    return;
  }

  const element = await targetElement(page, action.target, action.kind, signal, details);

  if (action.kind === "fill") {
    await element.fill(action.value, { timeout: 5_000 });

    return;
  }

  const href = await element.getAttribute("href");

  if (href) {
    allowedUrl(href, new URL(page.url()));
  }

  await element.click({ timeout: 5_000 });
}

async function observeChecks(
  page: Page,
  checks: readonly PlanCheck[],
  signal: AbortSignal,
  details: BrowserDetails,
  results: Map<string, Observation>,
): Promise<void> {
  for (const check of checks) {
    signal.throwIfAborted();

    try {
      results.set(check.id, {
        state: "observed",
        observed: await observeCheck(page, check, signal, details),
        browser: details,
      });
    } catch (error) {
      results.set(check.id, {
        state: "blocked",
        reason: failureReason("observation", error, signal),
        browser: details,
      });
    }
  }
}

async function captureScreenshot(page: Page, artifactDirectory?: string) {
  const directory = artifactDirectory ?? join(process.cwd(), ".data", "browser-evidence");
  await mkdir(directory, { recursive: true });
  const filename = `${randomUUID()}.png`;
  const screenshot = await page.screenshot({ animations: "disabled" });
  await writeFile(join(directory, filename), screenshot);

  return { path: filename, digest: createHash("sha256").update(screenshot).digest("hex") };
}

type CaseSession = {
  browser?: Browser;
  context?: BrowserContext;
  closing?: Promise<void>;
};

function prepareCase(targetUrl: string, planCase: PlanCase): URL {
  const target = new URL(targetUrl);
  allowedUrl(targetUrl, target);

  if (!process.env.JEV_API_KEY) {
    throw new BrowserBlocked("JEV_API_KEY is required");
  }

  if (planCase.actions.length > 20) {
    throw new BrowserBlocked("Case exceeds the 20-action limit");
  }

  if (planCase.preconditions.length) {
    throw new BrowserBlocked(
      "External preconditions cannot be verified; encode setup as actions and use preconditions []",
    );
  }

  return target;
}

async function openCasePage(
  target: URL,
  session: CaseSession,
  signal: AbortSignal,
  denyNavigation: () => void,
): Promise<Page> {
  session.browser = await chromium.launch({ headless: true, timeout: 15_000 });
  signal.throwIfAborted();
  session.context = await session.browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: "block",
    reducedMotion: "reduce",
    acceptDownloads: false,
  });
  signal.throwIfAborted();
  await guardContext(session.context, target, denyNavigation);
  const page = await session.context.newPage();
  page.setDefaultTimeout(5_000);
  page.setDefaultNavigationTimeout(10_000);
  session.context.on("page", (popup) => {
    if (popup !== page) {
      void popup.close();
    }
  });

  return page;
}

async function executeCase(
  targetUrl: string,
  planCase: PlanCase,
  checks: readonly PlanCheck[],
  parentSignal?: AbortSignal,
  artifactDirectory?: string,
): Promise<Map<string, Observation>> {
  const results = new Map<string, Observation>();
  const details: BrowserDetails = { selections: [] };
  const signal = AbortSignal.any([
    ...(parentSignal ? [parentSignal] : []),
    AbortSignal.timeout(90_000),
  ]);
  const session: CaseSession = {};
  let stage = "scope";
  let navigationDenied = false;

  const close = () => {
    session.closing ??= (async () => {
      await session.context?.close().catch(() => undefined);
      await session.browser?.close().catch(() => undefined);
    })();

    return session.closing;
  };

  const abort = () => {
    void close();
  };

  signal.addEventListener("abort", abort, { once: true });

  try {
    signal.throwIfAborted();
    const target = prepareCase(targetUrl, planCase);
    stage = "launch";
    const page = await openCasePage(target, session, signal, () => {
      navigationDenied = true;
    });
    stage = "initial_navigation";
    await page.goto(target.href, { waitUntil: "domcontentloaded" });

    for (const [index, action] of planCase.actions.entries()) {
      stage = `action_${index}_${action.kind}`;
      signal.throwIfAborted();
      allowedUrl(page.url(), target);
      await applyAction(page, target, action, signal, details);
      await page.waitForLoadState("domcontentloaded");
      allowedUrl(page.url(), target);

      if (navigationDenied) {
        throw new BrowserBlocked("navigation_denied");
      }
    }

    await page.addStyleTag({
      content:
        "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}",
    });
    await observeChecks(page, checks, signal, details, results);

    signal.throwIfAborted();
    stage = "screenshot";
    details.screenshot = await captureScreenshot(page, artifactDirectory);
  } catch (error) {
    const reason = failureReason(
      stage,
      navigationDenied ? new BrowserBlocked("navigation_denied") : error,
      signal,
    );

    for (const check of checks) {
      results.set(check.id, {
        state: "blocked",
        reason,
        browser: details,
      });
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await session.closing;
    await session.context?.close().catch(() => undefined);
    await session.browser?.close().catch(() => undefined);
  }

  return results;
}

export function createPlaywrightFixture(
  targetUrl: string,
  role: "ac" | "ui",
  signal?: AbortSignal,
  artifactDirectory?: string,
  attemptKey: string = randomUUID(),
): BrowserAdapter {
  const cases = new Map<string, Promise<Map<string, Observation>>>();

  return {
    ...LIVE_BROWSER,
    run: async (planCase, check) => {
      if (role === "ui" && planCase.actions.some((action) => action.kind !== "navigate")) {
        return {
          state: "blocked",
          reason: JSON.stringify({
            stage: "scope",
            code: "ui_navigation_only",
            detail:
              "UI v1 is read-only navigation and measurement; stateful case actions belong to AC",
          }),
          browser: { selections: [] },
        };
      }

      let pending = cases.get(planCase.id);

      if (!pending) {
        pending = (async () => {
          const directory = join(process.cwd(), ".data", "browser-executions");
          await mkdir(directory, { recursive: true });
          const key = createHash("sha256")
            .update(`${attemptKey}:${role}:${planCase.id}`)
            .digest("hex");

          try {
            await writeFile(join(directory, key), "started", { flag: "wx" });
          } catch {
            return new Map(
              planCase.checks.map((item) => [
                item.id,
                {
                  state: "blocked" as const,
                  reason: "Prior browser execution may have produced effects; replay is forbidden",
                  browser: { selections: [] },
                },
              ]),
            );
          }

          return executeCase(
            targetUrl,
            planCase,
            planCase.checks.filter(
              (item) => item.kind === (role === "ac" ? "functional" : "style"),
            ),
            signal,
            artifactDirectory,
          );
        })();
        cases.set(planCase.id, pending);
      }

      return (
        (await pending).get(check.id) ?? {
          state: "blocked",
          reason: "Check is outside the role scope",
        }
      );
    },
  };
}
