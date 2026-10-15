import { mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { chromium, type Browser, type ElementHandle, type Page, type Route } from "playwright";
import {
  JevError,
  MAX_JEV_CANDIDATES,
  jevConfigured,
  selectCandidate,
  type JevCandidate,
  type JevTransport,
} from "./jev-client";

type BrowserAction =
  | { action: "navigate"; path: string }
  | { action: "click"; target: string; candidateId?: string; offset?: number }
  | { action: "fill"; target: string; value: string; candidateId?: string; offset?: number }
  | {
      action: "read";
      observation: "url" | "text" | "value" | "visible" | "operable";
      target?: string;
      candidateId?: string;
      offset?: number;
    };

type Operation = "click" | "fill" | "observe" | "state";

type Selection = { by: "jev"; confidence: number } | { by: "agent" };

type HandoffReason = "uncertain" | "too_many_candidates" | "no_candidates";

type BrowserObservation = Readonly<{
  id: string;
  action: BrowserAction["action"];
  target?: string;
  observation?: string;
  selection?: Selection;
  url: string;
  outcome: "done" | "not_operable";
  observed?: string;
  truncated?: boolean;
  reason?: string;
  screenshot: string;
}>;

type BrowserStepResult =
  | { state: "observed"; observation: BrowserObservation }
  | {
      state: "selection_required";
      target: string;
      reason: HandoffReason;
      url: string;
      candidates: JevCandidate[];
      total: number;
      nextOffset?: number;
    };

export type BrowserSessionOptions = Readonly<{
  targetUrl: string;
  evidenceDir: string;
  jev?: JevTransport;
}>;

type Candidate = JevCandidate & Readonly<{ element: ElementHandle<Element> }>;

type Resolved =
  | { state: "resolved"; element: ElementHandle<Element>; selection: Selection }
  | Extract<BrowserStepResult, { state: "selection_required" }>;

type Listing = Readonly<{ url: string; descriptions: ReadonlyMap<string, string> }>;

const MAX_AGENT_PICKS = 3;
const MAX_LISTED_CANDIDATES = 60;
const MAX_OBSERVED_CHARS = 2000;
const EDITABLE = '[contenteditable]:not([contenteditable="false"])';
const FOCUSABLE = '[tabindex]:not([tabindex="-1"])';
const CLICK_SELECTOR = [
  "button",
  "a[href]",
  "input:not([type=hidden]):not([type=password])",
  "select",
  "textarea",
  "label",
  "summary",
  EDITABLE,
  "[onclick]",
  FOCUSABLE,
  "[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab]",
  "[role=menuitem],[role=option],[role=combobox],[role=spinbutton]",
].join(",");
const FILL_SELECTOR = [
  "input:not([type=password]):not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=reset]):not([type=file]):not([type=image]):not([type=color]):not([type=range])",
  "textarea",
  EDITABLE,
  "[role=textbox],[role=searchbox],[role=combobox]",
].join(",");
const OBSERVE_SELECTOR =
  "h1,h2,h3,h4,p,span,li,td,th,button,a,input:not([type=password]):not([type=hidden]),textarea,select,label,[role],strong,small,output,dd,dt,div";
const SELECTORS: Readonly<Record<Operation, string>> = {
  click: CLICK_SELECTOR,
  fill: FILL_SELECTOR,
  observe: OBSERVE_SELECTOR,
  state: `${OBSERVE_SELECTOR},${CLICK_SELECTOR},${FILL_SELECTOR}`,
};

function permittedUrl(url: URL, target: URL): boolean {
  return (
    ["http:", "https:"].includes(url.protocol) &&
    url.origin === target.origin &&
    !url.username &&
    !url.password
  );
}

function allowedUrl(raw: string, target: URL): string {
  const url = new URL(raw, target);

  if (!permittedUrl(url, target)) {
    throw new Error("Navigation outside the target origin or with URL credentials is blocked");
  }

  return url.href;
}

function originPath(raw: string): string {
  const url = new URL(raw);

  return `${url.origin}${url.pathname}`;
}

async function guardRoute(route: Route, target: URL): Promise<void> {
  const request = route.request();

  if (!permittedUrl(new URL(request.url()), target)) {
    await route.abort("blockedbyclient");

    return;
  }

  const response = await route.fetch({ maxRedirects: 0 }).catch(() => undefined);

  if (!response) {
    await route.abort();

    return;
  }

  const location = response.headers().location;

  if (location && !permittedUrl(new URL(location, request.url()), target)) {
    await route.abort("blockedbyclient");

    return;
  }

  await route.fulfill({ response });
}

async function elementState(element: ElementHandle<Element>) {
  const visible = await element.isVisible();
  const blocked = await element.evaluate(
    (node) =>
      node.hasAttribute("disabled") ||
      node.closest("fieldset[disabled]") !== null ||
      node.getAttribute("aria-disabled") === "true" ||
      node.closest("[inert]") !== null,
  );

  return { visible, operable: visible && !blocked };
}

async function describe(element: ElementHandle<Element>): Promise<string> {
  const state = await elementState(element);

  return element.evaluate(
    (node, facts) =>
      JSON.stringify({
        tag: node.tagName.toLowerCase(),
        role: node.getAttribute("role") ?? undefined,
        type: node.getAttribute("type") ?? undefined,
        name: node.getAttribute("name") ?? undefined,
        label: node.getAttribute("aria-label") ?? undefined,
        placeholder: node.getAttribute("placeholder") ?? undefined,
        text:
          (node instanceof HTMLElement ? node.innerText : node.textContent)?.trim().slice(0, 240) ||
          undefined,
        visible: facts.visible,
        operable: facts.operable,
        context: node.parentElement?.innerText?.trim().slice(0, 200) || undefined,
      }),
    state,
  );
}

async function excluded(element: ElementHandle<Element>): Promise<boolean> {
  return element.evaluate(
    (node, interactive) =>
      node.matches("input[type=password]") ||
      (node.childElementCount > 0 &&
        node.matches("div:not([role]):not([aria-label])") &&
        !node.matches(interactive)),
    `[onclick],${FOCUSABLE},${EDITABLE}`,
  );
}

async function listCandidates(page: Page, operation: Operation): Promise<Candidate[]> {
  const candidates: Candidate[] = [];

  for (const element of await page.$$(SELECTORS[operation])) {
    if (await excluded(element)) {
      await element.dispose();
      continue;
    }

    if (operation === "observe" && !(await element.isVisible())) {
      await element.dispose();
      continue;
    }

    candidates.push({ id: `c${candidates.length}`, description: await describe(element), element });
  }

  return candidates;
}

function operationOf(action: Exclude<BrowserAction, { action: "navigate" }>): Operation {
  if (action.action === "read") {
    return action.observation === "visible" || action.observation === "operable"
      ? "state"
      : "observe";
  }

  return action.action;
}

export class BrowserSession {
  private observations = 0;

  private lost = false;

  private readonly pending = new Map<string, Listing>();

  private readonly picks = new Map<string, number>();

  private constructor(
    private readonly browser: Browser,
    private readonly page: Page,
    private readonly target: URL,
    private readonly options: BrowserSessionOptions,
  ) {}

  static async open(options: BrowserSessionOptions): Promise<BrowserSession> {
    if (!jevConfigured(options.jev)) {
      throw new Error("JEV_API_KEY is not configured; the browser was not opened");
    }

    const target = new URL(allowedUrl(options.targetUrl, new URL(options.targetUrl)));
    const browser = await chromium.launch({ headless: true, timeout: 15_000 });

    try {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        serviceWorkers: "block",
        reducedMotion: "reduce",
        acceptDownloads: false,
      });
      await context.routeWebSocket("**/*", (socket) => socket.close());
      await context.route("**/*", (route) => guardRoute(route, target));
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      await page.goto(target.href, { waitUntil: "domcontentloaded" });
      await mkdir(options.evidenceDir, { recursive: true });

      return new BrowserSession(browser, page, target, options);
    } catch (error) {
      await browser.close();
      throw error;
    }
  }

  async perform(action: BrowserAction, signal: AbortSignal): Promise<BrowserStepResult> {
    await this.assertOnTarget();

    if (action.action === "navigate") {
      const url = allowedUrl(action.path, this.target);
      const loaded = await this.page
        .goto(url, { waitUntil: "domcontentloaded" })
        .then(() => true)
        .catch(() => false);

      if (!loaded) {
        await this.loseSession();
      }

      return this.observed({ action: "navigate", outcome: "done" });
    }

    if (action.action === "read" && action.observation === "url") {
      return this.observed({
        action: "read",
        observation: "url",
        outcome: "done",
        observed: originPath(this.page.url()),
      });
    }

    if (!action.target) {
      throw new Error("This read needs a target");
    }

    const resolved = await this.resolve(operationOf(action), action.target, action, signal);

    if (resolved.state !== "resolved") {
      return resolved;
    }

    return this.apply(action, action.target, resolved.element, resolved.selection);
  }

  async close(): Promise<void> {
    await this.browser.close().catch(() => undefined);
  }

  private async assertOnTarget(): Promise<void> {
    if (!this.lost && permittedUrl(new URL(this.page.url()), this.target)) {
      return;
    }

    await this.loseSession();
  }

  private async loseSession(): Promise<never> {
    this.lost = true;
    await this.close();

    throw new Error(
      "The page left the target origin or failed to load; the browser session is closed",
    );
  }

  private async apply(
    action: Exclude<BrowserAction, { action: "navigate" }>,
    target: string,
    element: ElementHandle<Element>,
    selection: Selection,
  ): Promise<BrowserStepResult> {
    const base = { action: action.action, target, selection };

    if (action.action === "read") {
      return this.observed({
        ...base,
        observation: action.observation,
        outcome: "done",
        ...(await this.measure(action.observation, element)),
      });
    }

    const state = await elementState(element);

    if (!state.operable) {
      return this.observed({
        ...base,
        outcome: "not_operable",
        reason: state.visible ? "disabled" : "hidden",
      });
    }

    await (action.action === "click" ? element.click() : element.fill(action.value));
    await this.settle();

    return this.observed({ ...base, outcome: "done" });
  }

  private async measure(
    observation: string,
    element: ElementHandle<Element>,
  ): Promise<{ observed: string; truncated?: true }> {
    const state = await elementState(element);
    const observed =
      observation === "text"
        ? (await element.innerText()).trim()
        : observation === "value"
          ? await element.inputValue()
          : String(observation === "visible" ? state.visible : state.operable);

    return observed.length > MAX_OBSERVED_CHARS
      ? { observed: observed.slice(0, MAX_OBSERVED_CHARS), truncated: true }
      : { observed };
  }

  private async resolve(
    operation: Operation,
    target: string,
    { candidateId, offset }: Exclude<BrowserAction, { action: "navigate" }>,
    signal: AbortSignal,
  ): Promise<Resolved> {
    const key = `${operation}\0${target}`;
    const candidates = await listCandidates(this.page, operation);

    if (candidateId !== undefined) {
      return this.agentPick(key, candidates, candidateId);
    }

    if (candidates.length === 0) {
      return this.handoff(key, target, candidates, "no_candidates", 0);
    }

    if (candidates.length > MAX_JEV_CANDIDATES) {
      return this.handoff(key, target, candidates, "too_many_candidates", offset ?? 0);
    }

    if (offset !== undefined) {
      return this.handoff(key, target, candidates, "uncertain", offset);
    }

    return this.jevPick(key, target, candidates, signal);
  }

  private async jevPick(
    key: string,
    target: string,
    candidates: readonly Candidate[],
    signal: AbortSignal,
  ): Promise<Resolved> {
    try {
      const selection = await selectCandidate(target, candidates, signal, this.options.jev);
      const chosen = candidates.find((candidate) => candidate.id === selection.choice)!;

      if ((await describe(chosen.element)) !== chosen.description) {
        throw new Error("The page changed while Jev was selecting the target");
      }

      return {
        state: "resolved",
        element: chosen.element,
        selection: { by: "jev", confidence: selection.confidence },
      };
    } catch (error) {
      if (error instanceof JevError && error.uncertain) {
        return this.handoff(key, target, candidates, "uncertain", 0);
      }

      throw error;
    }
  }

  private agentPick(key: string, candidates: readonly Candidate[], candidateId: string): Resolved {
    const listed = this.pending.get(key);
    const chosen = candidates.find((candidate) => candidate.id === candidateId);

    if (
      !listed ||
      !chosen ||
      listed.url !== originPath(this.page.url()) ||
      listed.descriptions.get(candidateId) !== chosen.description
    ) {
      throw new Error(
        "candidateId is unknown or the page changed; call again without candidateId to get a fresh list",
      );
    }

    const picks = (this.picks.get(key) ?? 0) + 1;

    if (picks > MAX_AGENT_PICKS) {
      throw new Error("Too many manual selections for this target; report it as blocked");
    }

    this.picks.set(key, picks);
    this.pending.delete(key);

    return { state: "resolved", element: chosen.element, selection: { by: "agent" } };
  }

  private handoff(
    key: string,
    target: string,
    candidates: readonly Candidate[],
    reason: HandoffReason,
    offset: number,
  ): Resolved {
    const url = originPath(this.page.url());
    const listed = candidates.slice(offset, offset + MAX_LISTED_CANDIDATES);
    const next = offset + listed.length;
    this.pending.set(key, {
      url,
      descriptions: new Map(candidates.map((candidate) => [candidate.id, candidate.description])),
    });

    return {
      state: "selection_required",
      target,
      reason,
      url,
      candidates: listed.map(({ id, description }) => ({ id, description })),
      total: candidates.length,
      ...(next < candidates.length ? { nextOffset: next } : {}),
    };
  }

  private async settle(): Promise<void> {
    await this.page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await this.page.waitForTimeout(250);
  }

  private async observed(
    fields: Omit<BrowserObservation, "id" | "url" | "screenshot">,
  ): Promise<BrowserStepResult> {
    await this.assertOnTarget();
    const id = `o${++this.observations}`;
    const screenshot = join(this.options.evidenceDir, `${id}.png`);
    await this.page.screenshot({ path: screenshot });

    return {
      state: "observed",
      observation: {
        id,
        ...fields,
        url: originPath(this.page.url()),
        screenshot: relative(process.cwd(), screenshot),
      },
    };
  }
}
