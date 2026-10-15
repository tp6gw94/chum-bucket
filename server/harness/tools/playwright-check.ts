import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Locator, type Page } from "playwright";
import {
  browserAdapterVersion,
  browserFixture,
  type Action,
  type Check,
  type CheckOutcome,
  type Evidence,
  type FunctionalCheck,
  type Handoff,
  type HandoffDecision,
  type PlanCase,
  type SelectionRecord,
  type StyleCheck,
} from "../../../shared/testing";
import { compareStyle, isStyleProperty, type DesignCapture } from "../testing-domain";
import { writeHandoffImage, type OverlayBox } from "./handoff-image";
import { MAX_JEV_CANDIDATES, selectWithJev, type JevSelection } from "./jev-client";

const MAX_SELECTION_HANDOFFS = 3;
const VIEWPORT = { width: 1280, height: 900 };
const ACTION_TIMEOUT_MS = 10_000;
const MAX_LINKS = 100;

type Operation = "click" | "fill" | "observe";
export type HandoffDraft =
  | Omit<Extract<Handoff, { kind: "selection" }>, "id" | "expiresAt">
  | Omit<Extract<Handoff, { kind: "fill_value" }>, "id" | "expiresAt">;
export type Selector = (input: {
  intent: string;
  candidates: readonly { id: string; description: string }[];
  signal: AbortSignal;
}) => Promise<JevSelection>;

export type CaseContext = Readonly<{
  role: "ac" | "ui";
  targetUrl: string;
  planCase: PlanCase;
  checks: readonly Check[];
  attemptKey: string;
  artifactDirectory: string;
  capture: DesignCapture | undefined;
  signal: AbortSignal;
  pause: (handoff: HandoffDraft) => Promise<HandoffDecision>;
  select?: Selector;
}>;

export type CaseReport = Readonly<{
  outcomes: readonly CheckOutcome[];
  selections: readonly SelectionRecord[];
  skippedActions: readonly { actionIndex: number; reason: string }[];
  screenshot: { path: string; digest: string } | null;
}>;

class CaseBlocked extends Error {
  constructor(
    message: string,
    readonly actionIndex: number | null = null,
  ) {
    super(message);
  }
}

function failureReason(signal: AbortSignal, error: unknown): string {
  if (signal.aborted) {
    return String(signal.reason ?? "Case aborted");
  }

  return error instanceof Error ? error.message : String(error);
}

const HELPERS = String.raw`
const cbVisible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
const cbOperable = (el) => cbVisible(el) && !el.disabled && !el.closest("fieldset:disabled") && !el.closest("[aria-disabled=true]") && !el.closest("[inert]");
const cbText = (el) => (el.innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
const cbDescribe = (el) => JSON.stringify({ tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), type: el.getAttribute("type"), name: el.getAttribute("name"), placeholder: el.getAttribute("placeholder"), text: cbText(el).slice(0, 240), ariaLabel: el.getAttribute("aria-label"), visible: cbVisible(el), operable: cbOperable(el), parentText: el.parentElement ? cbText(el.parentElement).slice(0, 120) : "" });
`;

const selectors: Record<Operation, string> = {
  click:
    "button, a[href], input:not([type=hidden]), select, textarea, summary, label, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=option], [role=switch], [onclick]",
  fill: "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]):not([type=file]), textarea, [contenteditable=''], [contenteditable=true], [role=textbox]",
  observe:
    "button, a[href], input:not([type=hidden]), select, textarea, summary, label, h1, h2, h3, h4, h5, h6, p, span, li, td, th, dt, dd, output, strong, em, small, b, img[alt], div, [role], [aria-label], [data-testid]",
};

const COLLECT = String.raw`(args) => {
${HELPERS}
for (const el of document.querySelectorAll("[data-cb-candidate],[data-cb-link]")) { el.removeAttribute("data-cb-candidate"); el.removeAttribute("data-cb-link"); }
const interactive = (el) => el.matches("button, a[href], input, select, textarea, summary, [role], [aria-label], img[alt], [data-testid]");
const ownText = (el) => [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; };
const elements = [...document.querySelectorAll(args.selector)].filter((el) => !(el.matches("input[type=password]")) && (args.operation !== "observe" || interactive(el) || ownText(el)));
const candidates = elements.map((el, index) => { el.setAttribute("data-cb-candidate", "c" + index); return { id: "c" + index, description: cbDescribe(el), box: box(el) }; });
const links = [...document.querySelectorAll("a[href]")].filter((a) => { try { const url = new URL(a.href); return url.origin === location.origin; } catch { return false; } }).slice(0, ${MAX_LINKS}).map((a, index) => { a.setAttribute("data-cb-link", "l" + index); return { id: "l" + index, description: JSON.stringify({ text: cbText(a).slice(0, 240), ariaLabel: a.getAttribute("aria-label") }), url: a.href, box: box(a) }; });
return { candidates, links };
}`;

function pageFunction<T>(source: string): T {
  return new Function(`return ${source}`)() as T;
}

const DESCRIBE = pageFunction<(element: Element) => string>(String.raw`(el) => {
${HELPERS}
return cbDescribe(el);
}`);

const OPERABLE = pageFunction<(element: Element) => boolean>(String.raw`(el) => {
${HELPERS}
return cbOperable(el);
}`);

const COMPUTED_STYLE = pageFunction<
  (element: Element, property: string) => string
>(String.raw`(el, property) => {
const style = getComputedStyle(el);
const map = { color: "color", backgroundColor: "background-color", fontSize: "font-size", fontWeight: "font-weight", opacity: "opacity", cornerRadius: "border-top-left-radius", borderRadius: "border-top-left-radius", letterSpacing: "letter-spacing", lineHeight: "line-height" };
const value = style.getPropertyValue(map[property]);
return property === "letterSpacing" && value === "normal" ? "0px" : value;
}`);

const NO_MOTION =
  "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; scroll-behavior: auto !important; }";

type Collected = {
  candidates: { id: string; description: string; box: Omit<OverlayBox, "id" | "kind"> }[];
  links: { id: string; description: string; url: string; box: Omit<OverlayBox, "id" | "kind"> }[];
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function markerPath(artifactDirectory: string, attemptKey: string, role: string, caseId: string) {
  return path.join(
    artifactDirectory,
    "browser-executions",
    sha256(`${attemptKey}:${role}:${caseId}`),
  );
}

function sameOrigin(url: string, targetUrl: string): boolean {
  const parsed = URL.parse(url);

  return (
    !!parsed &&
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.origin === new URL(targetUrl).origin
  );
}

function urlObservation(url: string): string {
  const parsed = new URL(url);

  return `${parsed.origin}${parsed.pathname}`;
}

function matches(observed: string, expected: string, comparison: "equals" | "contains") {
  return comparison === "contains" ? observed.includes(expected) : observed === expected;
}

function blockedOutcome(
  caseId: string,
  check: Check,
  reason: string,
  capture: DesignCapture | undefined,
  actionIndex: number | null = null,
): CheckOutcome {
  return check.kind === "functional"
    ? {
        kind: "functional",
        caseId,
        checkId: check.id,
        actionIndex,
        outcome: "blocked",
        expected: check.expectedObservation,
        observed: null,
        reason,
      }
    : {
        kind: "style",
        caseId,
        checkId: check.id,
        outcome: "blocked",
        property: check.property,
        expected: capture?.properties[check.property as never] ?? null,
        observed: null,
        tolerance: check.tolerance,
        capturedDesign: capture ? { fileKey: capture.fileKey, nodeId: capture.nodeId } : null,
        reason,
      };
}

function preflightReason(context: Pick<CaseContext, "role" | "planCase">): string | undefined {
  if (context.planCase.preconditions.length) {
    return "Preconditions cannot be verified by the browser";
  }

  if (!process.env.JEV_API_KEY) {
    return "JEV_API_KEY is not configured";
  }

  if (
    context.role === "ui" &&
    context.planCase.actions.some((action) => action.kind !== "navigate")
  ) {
    return "verify_ui only runs navigate-only cases";
  }

  return undefined;
}

async function claimMarker(context: CaseContext): Promise<boolean> {
  const marker = markerPath(
    context.artifactDirectory,
    context.attemptKey,
    context.role,
    context.planCase.id,
  );
  await mkdir(path.dirname(marker), { recursive: true });

  try {
    await writeFile(marker, new Date().toISOString(), { flag: "wx" });

    return true;
  } catch {
    return false;
  }
}

class CaseRun {
  private readonly selections: SelectionRecord[] = [];

  private readonly skipped: { actionIndex: number; reason: string }[] = [];

  private handoffs = 0;

  private handoffImages = 0;

  constructor(
    private readonly context: CaseContext,
    private readonly page: Page,
  ) {}

  private get select(): Selector {
    return this.context.select ?? selectWithJev;
  }

  private alive() {
    if (this.context.signal.aborted) {
      throw new CaseBlocked(String(this.context.signal.reason ?? "Case aborted"));
    }
  }

  private async collect(operation: Operation): Promise<Collected> {
    return (await this.page.evaluate(
      `(${COLLECT})(${JSON.stringify({ selector: selectors[operation], operation })})`,
    )) as Collected;
  }

  private async handoffImage(collected: Collected) {
    const screenshot = await this.page.screenshot({ type: "png" });
    this.handoffImages += 1;

    return writeHandoffImage({
      screenshot,
      boxes: [
        ...collected.candidates.map((entry) => ({
          ...entry.box,
          id: entry.id,
          kind: "candidate" as const,
        })),
        ...collected.links.map((entry) => ({ ...entry.box, id: entry.id, kind: "link" as const })),
      ],
      directory: path.join(this.context.artifactDirectory, "browser-evidence", "handoffs"),
      name: sha256(`${this.context.attemptKey}:${this.context.planCase.id}:${this.handoffImages}`),
    });
  }

  private async askJev(intent: string, collected: Collected): Promise<JevSelection> {
    if (collected.candidates.length > MAX_JEV_CANDIDATES) {
      return {
        state: "rejected",
        reason: `Too many candidates for Jev (${collected.candidates.length})`,
      };
    }

    return this.select({
      intent,
      candidates: collected.candidates.map(({ id, description }) => ({ id, description })),
      signal: this.context.signal,
    });
  }

  private async stable(candidateId: string, description: string): Promise<Locator> {
    const locator = this.page.locator(`[data-cb-candidate="${candidateId}"]`);
    const current = await locator.evaluate(DESCRIBE).catch(() => null);

    if (current !== description) {
      throw new CaseBlocked("Page changed while selecting the target");
    }

    return locator;
  }

  private async handOff(
    intent: string,
    operation: Operation,
    at: number,
    collected: Collected,
    reason: string,
  ) {
    if (this.handoffs >= MAX_SELECTION_HANDOFFS) {
      throw new CaseBlocked(
        `Selection handoff limit reached: ${reason}`,
        operation === "observe" ? null : at,
      );
    }

    this.handoffs += 1;

    return this.context.pause({
      kind: "selection",
      caseId: this.context.planCase.id,
      ordinal: this.handoffs,
      laterHandoffsAllowed: this.handoffs < MAX_SELECTION_HANDOFFS,
      url: this.page.url(),
      target: { intent, operation, at },
      candidates: collected.candidates.map(({ id, description }) => ({ id, description })),
      links: collected.links.map(({ id, description, url }) => ({ id, description, url })),
      diagnostics: [reason],
      image: await this.handoffImage(collected).catch(() => null),
    });
  }

  async resolve(intent: string, operation: Operation, at: number): Promise<Locator> {
    for (;;) {
      this.alive();
      const collected = await this.collect(operation);
      const selection = await this.askJev(intent, collected);

      if (selection.state === "accepted") {
        const candidate = collected.candidates.find((entry) => entry.id === selection.candidateId)!;
        const locator = await this.stable(candidate.id, candidate.description);
        this.selections.push({
          actionIndex: at,
          target: intent,
          by: "jev",
          candidateId: candidate.id,
          probability: selection.probability,
          confidence: selection.confidence,
        });

        return locator;
      }

      const decision = await this.handOff(intent, operation, at, collected, selection.reason);
      const chosen = await this.applyDecision(decision, collected, intent, at);

      if (chosen) {
        return chosen;
      }
    }
  }

  private async applyDecision(
    decision: HandoffDecision,
    collected: Collected,
    intent: string,
    at: number,
  ) {
    if (decision.kind === "abandon") {
      throw new CaseBlocked(`Abandoned by role: ${decision.reason}`);
    }

    if (decision.kind === "navigate") {
      const link = collected.links.find((entry) => entry.id === decision.linkId);

      if (!link || !sameOrigin(link.url, this.context.targetUrl)) {
        throw new CaseBlocked(`Unknown link ${decision.linkId}`);
      }

      await this.page.goto(link.url, { waitUntil: "load", timeout: ACTION_TIMEOUT_MS });

      return undefined;
    }

    if (decision.kind !== "choose") {
      throw new CaseBlocked("Selection handoff needs choose, navigate, or abandon");
    }

    const candidate = collected.candidates.find((entry) => entry.id === decision.candidateId);

    if (!candidate) {
      throw new CaseBlocked(`Unknown candidate ${decision.candidateId}`);
    }

    const locator = await this.stable(candidate.id, candidate.description);
    this.selections.push({
      actionIndex: at,
      target: intent,
      by: "agent_choose",
      candidateId: candidate.id,
    });

    return locator;
  }

  private async settle() {
    await this.page.waitForLoadState("load", { timeout: ACTION_TIMEOUT_MS }).catch(() => undefined);
    await this.page.waitForTimeout(250);
  }

  private async fillValue(action: Extract<Action, { kind: "fill" }>, index: number) {
    if (action.value !== undefined) {
      return action.value;
    }

    const decision = await this.context.pause({
      kind: "fill_value",
      caseId: this.context.planCase.id,
      url: this.page.url(),
      target: { intent: action.target, operation: "fill", at: index },
    });

    if (decision.kind !== "fill_value") {
      throw new CaseBlocked(
        decision.kind === "abandon"
          ? `Abandoned by role: ${decision.reason}`
          : "Fill handoff needs fill_value",
        index,
      );
    }

    return decision.value;
  }

  private async act(action: Action, index: number) {
    this.alive();

    if (action.kind === "navigate") {
      const url = new URL(action.path, this.context.targetUrl).href;

      if (!sameOrigin(url, this.context.targetUrl)) {
        throw new CaseBlocked("Navigation leaves the target origin", index);
      }

      await this.page.goto(url, { waitUntil: "load", timeout: ACTION_TIMEOUT_MS });

      return;
    }

    const locator = await this.resolve(action.target, action.kind, index);

    if (!(await locator.evaluate(OPERABLE).catch(() => false))) {
      this.skipped.push({ actionIndex: index, reason: "Target is hidden or disabled" });

      return;
    }

    if (action.kind === "click") {
      await locator.click({ timeout: ACTION_TIMEOUT_MS });
    } else {
      await locator.fill(await this.fillValue(action, index), { timeout: ACTION_TIMEOUT_MS });
    }

    await this.settle();
  }

  async perform() {
    await this.page.goto(this.context.targetUrl, { waitUntil: "load", timeout: ACTION_TIMEOUT_MS });

    for (const [index, action] of this.context.planCase.actions.entries()) {
      await this.act(action, index);
    }

    await this.page.addStyleTag({ content: NO_MOTION });
    await this.page.evaluate("document.fonts.ready.then(() => true)");
  }

  private async observe(check: FunctionalCheck): Promise<string> {
    const observation = check.observation;

    if (!observation) {
      throw new CaseBlocked("Functional check has no observation");
    }

    if (observation.kind === "url") {
      return urlObservation(this.page.url());
    }

    const locator = await this.resolve(
      observation.target,
      "observe",
      this.context.planCase.actions.length,
    );

    switch (observation.kind) {
      case "text":
        return ((await locator.innerText()) ?? "").trim();
      case "value":
        return locator.inputValue();
      case "visible":
        return String(await locator.isVisible());
      case "operable":
        return String(await locator.evaluate(OPERABLE));
    }
  }

  private async functional(check: FunctionalCheck): Promise<CheckOutcome> {
    const observed = await this.observe(check);
    const comparison = check.observation?.comparison ?? "equals";

    return {
      kind: "functional",
      caseId: this.context.planCase.id,
      checkId: check.id,
      actionIndex: null,
      outcome: matches(observed, check.expectedObservation, comparison) ? "pass" : "fail",
      expected: check.expectedObservation,
      observed,
      reason: null,
    };
  }

  private async stableBox(locator: Locator) {
    let previous = await locator.boundingBox();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await this.page.waitForTimeout(100);
      const next = await locator.boundingBox();

      if (next && previous && next.width === previous.width && next.height === previous.height) {
        return next;
      }

      previous = next;
    }

    return previous;
  }

  private async measureStyle(locator: Locator, property: string): Promise<string> {
    if (property === "width" || property === "height") {
      const box = await this.stableBox(locator);

      if (!box) {
        throw new CaseBlocked("Target has no layout box");
      }

      return String(Math.round(box[property] * 100) / 100);
    }

    return locator.evaluate(COMPUTED_STYLE, property);
  }

  private async style(check: StyleCheck): Promise<CheckOutcome> {
    const capture = this.context.capture;
    const blocked = (reason: string) =>
      blockedOutcome(this.context.planCase.id, check, reason, capture);

    if (!isStyleProperty(check.property)) {
      return blocked(`Unsupported style property ${check.property}`);
    }

    if (
      !capture ||
      capture.fileKey !== check.design.fileKey ||
      capture.nodeId !== check.design.nodeId
    ) {
      return blocked("No design capture for this check");
    }

    const expected = capture.properties[check.property];

    if (expected === undefined || !check.target) {
      return blocked(
        expected === undefined ? `Design has no ${check.property}` : "Style check has no target",
      );
    }

    const locator = await this.resolve(
      check.target,
      "observe",
      this.context.planCase.actions.length,
    );
    const observed = await this.measureStyle(locator, check.property);
    const comparison = compareStyle(check.property, expected, observed, check.tolerance);

    return {
      kind: "style",
      caseId: this.context.planCase.id,
      checkId: check.id,
      outcome: comparison.outcome,
      property: check.property,
      expected,
      observed,
      tolerance: check.tolerance,
      capturedDesign: { fileKey: capture.fileKey, nodeId: capture.nodeId },
      reason: comparison.outcome === "blocked" ? comparison.reason : null,
    };
  }

  async measure(): Promise<CheckOutcome[]> {
    const outcomes: CheckOutcome[] = [];

    for (const check of this.context.checks) {
      try {
        this.alive();
        outcomes.push(
          check.kind === "functional" ? await this.functional(check) : await this.style(check),
        );
      } catch (error) {
        const reason = failureReason(this.context.signal, error);

        return [
          ...outcomes,
          ...this.context.checks
            .slice(outcomes.length)
            .map((rest) =>
              blockedOutcome(this.context.planCase.id, rest, reason, this.context.capture),
            ),
        ];
      }
    }

    return outcomes;
  }

  async screenshot() {
    const png = await this.page.screenshot({ type: "png", fullPage: true });
    const directory = path.join(this.context.artifactDirectory, "browser-evidence");
    await mkdir(directory, { recursive: true });
    const file = path.join(
      directory,
      `${sha256(`${this.context.attemptKey}:${this.context.role}:${this.context.planCase.id}`)}.png`,
    );
    await writeFile(file, png);

    return { path: file, digest: sha256(png) };
  }

  report(outcomes: CheckOutcome[], screenshot: CaseReport["screenshot"]): CaseReport {
    return { outcomes, selections: this.selections, skippedActions: this.skipped, screenshot };
  }
}

export function blockedCaseReport(
  context: CaseContext,
  reason: string,
  actionIndex: number | null = null,
): CaseReport {
  return {
    outcomes: context.checks.map((check) =>
      blockedOutcome(context.planCase.id, check, reason, context.capture, actionIndex),
    ),
    selections: [],
    skippedActions: [],
    screenshot: null,
  };
}

async function launch(targetUrl: string) {
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const browserContext = await browser.newContext({
    viewport: VIEWPORT,
    serviceWorkers: "block",
    reducedMotion: "reduce",
    acceptDownloads: false,
  });
  await browserContext.route("**/*", (route) =>
    sameOrigin(route.request().url(), targetUrl)
      ? route.continue()
      : route.abort("blockedbyclient"),
  );

  return { browser, page: await browserContext.newPage() };
}

async function runInBrowser(context: CaseContext, page: Page): Promise<CaseReport> {
  const run = new CaseRun(context, page);

  try {
    await run.perform();
  } catch (error) {
    const actionIndex = error instanceof CaseBlocked ? error.actionIndex : null;
    const blocked = blockedCaseReport(context, failureReason(context.signal, error), actionIndex);

    return run.report([...blocked.outcomes], await run.screenshot().catch(() => null));
  }

  return run.report(await run.measure(), await run.screenshot().catch(() => null));
}

export async function runBrowserCase(context: CaseContext): Promise<CaseReport> {
  const preflight = preflightReason(context);

  if (preflight) {
    return blockedCaseReport(context, preflight);
  }

  if (!(await claimMarker(context))) {
    return blockedCaseReport(
      context,
      "Prior browser execution may have produced effects; replay is forbidden",
    );
  }

  const { browser, page } = await launch(context.targetUrl);
  const abort = () => void browser.close().catch(() => undefined);
  context.signal.addEventListener("abort", abort, { once: true });

  try {
    return await runInBrowser(context, page);
  } finally {
    context.signal.removeEventListener("abort", abort);
    await browser.close().catch(() => undefined);
  }
}

export function evidenceFor(report: CaseReport, outcome: CheckOutcome): Evidence {
  return {
    origin: "browser",
    fixture: browserFixture,
    adapterVersion: browserAdapterVersion,
    browser: { selections: [...report.selections], skippedActions: [...report.skippedActions] },
    screenshot: report.screenshot,
    check: outcome,
  };
}
