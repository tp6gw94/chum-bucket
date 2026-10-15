import { toolDefinition } from "@tanstack/ai";
import { delegationInputSchema } from "../../../shared/testing";

export const delegateTaskTool = toolDefinition({
  name: "delegate_task",
  description: `Delegate one role to a durable child workflow. Each role accepts only these fields:
- atlassian: summary, goal, sources. For PROJ-123 use sources:[{kind:"jira",issueKey:"PROJ-123"}]. Confluence uses {kind:"confluence",pageId:"..."}.
- planner: summary, requirementsRef, optional design:{fileKey,nodeId}.
- ac or ui: summary, planRef, targetUrl.
Predecessors are never run automatically. Use artifact refs returned in this thread. Findings are unvalidated text; tool observations and missing checks must be reported separately.`,
  inputSchema: delegationInputSchema,
  metadata: { direct: true },
});
