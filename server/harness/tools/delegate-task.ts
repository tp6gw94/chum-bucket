import { toolDefinition } from "@tanstack/ai";
import { delegationInputSchema } from "../../../shared/testing";

export const DELEGATE_TASK_TOOL = "delegate_task";

export const delegateTaskTool = toolDefinition({
  name: DELEGATE_TASK_TOOL,
  description:
    "Delegate exactly one durable task. Choose atlassian to read the requested Jira issues or Confluence pages, from which the host assembles a raw-text requirements artifact; planner with an explicit requirementsRef to define criteria, unresolved notes and cases without a URL, keeping any requested subset given in its summary; or ac/ui with an explicit planRef and targetUrl for the checks the plan assigns to that role; a plan with deferred cases or an empty ac/ui assignment cannot be executed for those items. Every check result states its evidence.origin, browser for the live adapter or mock for simulated, and neither proves release acceptance. Returns validated results, immutable artifact references, and for a failed role its reason code with bounded validator issues. Never launches prerequisites. Use exactly the fields for the selected role. atlassian accepts role, summary, goal and sources. planner accepts only role, summary, requirementsRef and optional design; do not send goal, sources or targetUrl to planner. ac and ui accept only role, summary, planRef and targetUrl. For the PROJ-123 issue use sources:[{kind:'jira',issueKey:'PROJ-123'}].",
  inputSchema: delegationInputSchema,
  metadata: { direct: true },
});
