import type {
  ApiProvider,
  CallApiContextParams,
  CallApiOptionsParams,
  ProviderResponse,
} from "promptfoo";
import { roleRegistry } from "../../server/harness/agents";
import { runPlanner } from "../../server/harness/planner";
import { deepinfra } from "../../server/harness/provider";
import type { RoleTaskInput } from "../../server/harness/prompts";
import {
  digestOf,
  requirementsPayloadSchema,
  type Requirements,
} from "../../server/harness/testing-domain";
import {
  testingIntentSchema,
  type DesignReference,
  type RequirementSource,
} from "../../shared/testing";

export type EvalVars = {
  summary: string;
  goal: string;
  sources: Pick<RequirementSource, "reference" | "text" | "links">[];
  design?: DesignReference;
};

export function plannerTaskFromVars(
  vars: EvalVars,
): RoleTaskInput & { requirements: Requirements } {
  const requirements = requirementsPayloadSchema.parse({
    goal: vars.goal,
    sources: vars.sources.map((source) => ({
      ...source,
      digest: digestOf(source),
      capturedAt: "2026-01-01T00:00:00.000Z",
    })),
  });
  const intent = testingIntentSchema.parse({
    goal: vars.goal,
    sources: vars.sources.map((source) => source.reference),
    targetUrl: null,
    design: vars.design,
    task: {
      version: 2,
      input: {
        role: "planner",
        summary: vars.summary,
        requirementsRef: "eval-requirements",
        design: vars.design,
      },
    },
  });

  return { intent, requirements, plan: null };
}

export default class ChumPlannerProvider implements ApiProvider {
  id(): string {
    return "chum-planner";
  }

  async callApi(
    _prompt: string,
    context?: CallApiContextParams,
    options?: CallApiOptionsParams,
  ): Promise<ProviderResponse> {
    const result = await runPlanner({
      task: plannerTaskFromVars((context?.vars ?? {}) as EvalVars),
      session: {
        runId: "planner-eval",
        assertExecution: async () => {},
        emit: async () => {},
        chatStream: async (chat) => deepinfra(roleRegistry.planner.model).chatStream(chat),
      },
      signal: options?.abortSignal ?? new AbortController().signal,
    });

    if (result.state === "ready") {
      return { output: result.completion.proposal };
    }

    return { output: { state: result.state, reason: result.reason, issues: result.issues } };
  }
}
