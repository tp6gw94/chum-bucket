import { convertSchemaToJsonSchema } from "@tanstack/ai";
import { z } from "zod";
import { delegationSystemPrompt } from "../prompts";
import type { ModelTool } from "./atlassian";
import type { RunTools } from ".";

export const DELEGATE_TASK_TOOL = "delegate_task";

const DEFAULT_TARGET_ORIGINS = "http://127.0.0.1:8080";

function allowedTargetOrigins(): string[] {
  return (process.env.BROWSER_TARGET_ORIGINS ?? DEFAULT_TARGET_ORIGINS)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export const delegationInputSchema = z.strictObject({
  summary: z.string().trim().min(1).max(4000),
  targetUrl: z
    .url({ protocol: /^https?$/ })
    .max(2000)
    .refine((value) => {
      const url = new URL(value);

      return !url.username && !url.password;
    }, "targetUrl must not contain credentials")
    .refine(
      (value) => allowedTargetOrigins().includes(new URL(value).origin),
      "targetUrl origin is not listed in BROWSER_TARGET_ORIGINS",
    ),
});

export type DelegationInput = z.infer<typeof delegationInputSchema>;

const inputSchema = convertSchemaToJsonSchema(delegationInputSchema);

if (!inputSchema) {
  throw new Error("delegate_task schema is unavailable");
}

const definition: ModelTool = {
  name: DELEGATE_TASK_TOOL,
  description:
    "Delegate one browser verification task to the browser sub-agent, which drives a real browser on targetUrl and uses Jev to map element descriptions to the page. summary states exactly what to check and the expected behaviour. targetUrl must be on an origin listed in BROWSER_TARGET_ORIGINS, and only pages on that origin are reachable. Returns the sub-agent's report plus host-recorded observations; the report is a claim, the observations are the evidence.",
  inputSchema,
};

export function withDelegation(tools: RunTools): RunTools {
  return {
    async getModelTools(messages) {
      const base = await tools.getModelTools(messages);

      return {
        definitions: [...base.definitions, definition],
        systemPrompt: [base.systemPrompt, delegationSystemPrompt].join("\n\n"),
      };
    },
    executeTool(messages, call, context) {
      if (call.name === DELEGATE_TASK_TOOL) {
        throw new Error("delegate_task only runs through orchestration");
      }

      return tools.executeTool(messages, call, context);
    },
  };
}
