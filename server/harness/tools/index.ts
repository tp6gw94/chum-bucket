import { createAtlassianTools } from "@server/harness/tools/atlassian";
import { loadAtlassianPolicy } from "@server/harness/tools/atlassian-policy";
import { createFsTools } from "@server/harness/tools/fs";
import { getFigma } from "@server/harness/tools/get-figma";

const localTools = [getFigma, ...createFsTools(process.env.AGENT_WORKSPACE ?? ".workspace")];
const atlassianTools = createAtlassianTools(loadAtlassianPolicy());

export async function resolveTools() {
  return [...localTools, ...(await atlassianTools())];
}
