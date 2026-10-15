import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";
import { designSchema, roleSchema, sourceSchema } from "../../../shared/testing";
import { delegateTaskDescription } from "../prompts";

export const delegateTaskToolName = "delegate_task";

export const delegateTaskTool = toolDefinition({
  name: delegateTaskToolName,
  description: delegateTaskDescription,
  inputSchema: z.object({
    role: roleSchema,
    summary: z.string().describe("What the role should do, including user constraints."),
    goal: z.string().optional().describe("atlassian only: the testing goal."),
    sources: z.array(sourceSchema).optional().describe("atlassian only."),
    requirementsRef: z.string().optional().describe("planner only."),
    design: designSchema.optional().describe("planner only, optional."),
    planRef: z.string().optional().describe("ac and ui only."),
    targetUrl: z.string().optional().describe("ac and ui only."),
  }),
  metadata: { direct: true },
});
