import path from "node:path";
import { toolDefinition } from "@tanstack/ai";
import {
  verifyInputSchema,
  type Evidence,
  type Handoff,
  type HandoffDecision,
  type PlanArtifact,
  type VerifyInput,
} from "../../../shared/testing";
import { caseOfCheck, digestOf, type DesignCapture } from "../testing-domain";
import {
  blockedCaseReport,
  evidenceFor,
  runBrowserCase,
  type CaseContext,
  type CaseReport,
  type HandoffDraft,
  type Selector,
} from "./playwright-check";

const CASE_ACTIVE_MS = 90_000;
const HANDOFF_TTL_MS = 180_000;

export const verifyAcTool = toolDefinition({
  name: "verify_ac",
  description:
    "Run one functional check of the delegated plan in a real browser. Pass only checkId, plus resolution when answering a handoff.",
  inputSchema: verifyInputSchema,
  metadata: { direct: true },
});

export const verifyUiTool = toolDefinition({
  name: "verify_ui",
  description:
    "Measure one style check of the delegated plan in a real browser against the captured Figma design. Pass only checkId, plus resolution when answering a handoff.",
  inputSchema: verifyInputSchema,
  metadata: { direct: true },
});

export type VerifyStep =
  | { state: "finished"; checkId: string; evidence: Evidence }
  | { state: "selection_required" | "fill_value_required"; checkId: string; handoff: Handoff };

type SessionEvent = { kind: "paused"; handoff: Handoff } | { kind: "done"; report: CaseReport };

type Pending = {
  handoff: Handoff;
  resolve: (decision: HandoffDecision) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

function compatible(handoff: Handoff, decision: HandoffDecision): boolean {
  return handoff.kind === "fill_value"
    ? decision.kind === "fill_value" || decision.kind === "abandon"
    : decision.kind !== "fill_value";
}

type SessionOptions = Omit<CaseContext, "signal" | "pause">;

class CaseSession {
  private events = deferred<SessionEvent>();

  private pending: Pending | undefined;

  private report: CaseReport | undefined;

  private readonly history = new Map<string, { digest: string; event: Promise<SessionEvent> }>();

  private readonly controller = new AbortController();

  private remaining = CASE_ACTIVE_MS;

  private startedAt: number | undefined;

  private clock: NodeJS.Timeout | undefined;

  private handoffs = 0;

  constructor(options: SessionOptions) {
    const context: CaseContext = {
      ...options,
      signal: this.controller.signal,
      pause: (draft) => this.pause(draft),
    };
    this.startClock();
    void runBrowserCase(context)
      .catch((error: unknown) =>
        blockedCaseReport(context, error instanceof Error ? error.message : String(error)),
      )
      .then((report) => this.finish(report));
  }

  private startClock() {
    this.startedAt = Date.now();
    this.clock = setTimeout(
      () => this.controller.abort("Case exceeded 90s of active browser time"),
      Math.max(this.remaining, 0),
    );
  }

  private stopClock() {
    clearTimeout(this.clock);

    if (this.startedAt !== undefined) {
      this.remaining -= Date.now() - this.startedAt;
      this.startedAt = undefined;
    }
  }

  private emit(event: SessionEvent) {
    const current = this.events;
    this.events = deferred();
    current.resolve(event);
  }

  private finish(report: CaseReport) {
    this.stopClock();
    this.report = report;
    this.emit({ kind: "done", report });
  }

  private pause(draft: HandoffDraft): Promise<HandoffDecision> {
    this.stopClock();
    this.handoffs += 1;
    const handoff = {
      ...draft,
      id: `h${this.handoffs}`,
      expiresAt: new Date(Date.now() + HANDOFF_TTL_MS).toISOString(),
    } as Handoff;
    const decision = new Promise<HandoffDecision>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.handoff.id === handoff.id) {
          this.pending = undefined;
          reject(new Error("Handoff expired"));
        }
      }, HANDOFF_TTL_MS);
      this.pending = { handoff, resolve, reject, timer };
    });
    this.emit({ kind: "paused", handoff });

    return decision.then((value) => {
      this.startClock();

      return value;
    });
  }

  private current(): Promise<SessionEvent> {
    if (this.report) {
      return Promise.resolve({ kind: "done", report: this.report });
    }

    return this.pending
      ? Promise.resolve({ kind: "paused", handoff: this.pending.handoff })
      : this.events.promise;
  }

  step(resolution: VerifyInput["resolution"]): Promise<SessionEvent> {
    if (!resolution) {
      return this.current();
    }

    const digest = digestOf(resolution.decision);
    const prior = this.history.get(resolution.handoffId);

    if (prior) {
      if (prior.digest !== digest) {
        throw new Error(
          `Handoff ${resolution.handoffId} was already resolved with a different decision`,
        );
      }

      return prior.event;
    }

    const pending = this.pending;

    if (!pending || pending.handoff.id !== resolution.handoffId) {
      return this.current();
    }

    if (!compatible(pending.handoff, resolution.decision)) {
      throw new Error(
        `Decision ${resolution.decision.kind} does not answer a ${pending.handoff.kind} handoff`,
      );
    }

    const event = this.events.promise;
    this.history.set(resolution.handoffId, { digest, event });
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.resolve(resolution.decision);

    return event;
  }

  dispose() {
    this.stopClock();

    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error("Browser session closed"));
      this.pending = undefined;
    }

    this.controller.abort("Browser session closed");
  }
}

function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (signal?.aborted) {
      reject(new Error("Verification was interrupted"));
    }

    signal?.addEventListener("abort", () => reject(new Error("Verification was interrupted")), {
      once: true,
    });
  });
}

export type BrowserVerifier = Readonly<{
  verify: (input: VerifyInput, signal?: AbortSignal) => Promise<VerifyStep>;
  dispose: () => void;
}>;

export function createBrowserVerifier(options: {
  role: "ac" | "ui";
  taskId: string;
  plan: PlanArtifact;
  targetUrl: string;
  capture: () => Promise<DesignCapture | undefined>;
  artifactDirectory?: string;
  select?: Selector;
}): BrowserVerifier {
  const sessions = new Map<string, CaseSession>();
  const assigned = new Set(options.plan.assignments[options.role]);

  async function sessionFor(checkId: string) {
    const located = assigned.has(checkId) ? caseOfCheck(options.plan, checkId) : undefined;

    if (!located) {
      throw new Error("Unknown scoped check");
    }

    const existing = sessions.get(located.planCase.id);

    if (existing) {
      return existing;
    }

    const session = new CaseSession({
      role: options.role,
      targetUrl: options.targetUrl,
      planCase: located.planCase,
      checks: located.planCase.checks.filter((check) => assigned.has(check.id)),
      attemptKey: options.taskId,
      artifactDirectory: options.artifactDirectory ?? path.resolve(".data"),
      capture: options.role === "ui" ? await options.capture() : undefined,
      select: options.select,
    });
    sessions.set(located.planCase.id, session);

    return session;
  }

  async function verify(input: VerifyInput, signal?: AbortSignal): Promise<VerifyStep> {
    const session = await sessionFor(input.checkId);
    const event = await Promise.race([session.step(input.resolution), untilAborted(signal)]);

    if (event.kind === "paused") {
      return {
        state: event.handoff.kind === "selection" ? "selection_required" : "fill_value_required",
        checkId: input.checkId,
        handoff: event.handoff,
      };
    }

    const outcome = event.report.outcomes.find((entry) => entry.checkId === input.checkId);

    if (!outcome) {
      throw new Error("Unknown scoped check");
    }

    return {
      state: "finished",
      checkId: input.checkId,
      evidence: evidenceFor(event.report, outcome),
    };
  }

  return {
    verify,
    dispose: () => {
      for (const session of sessions.values()) {
        session.dispose();
      }

      sessions.clear();
    },
  };
}
