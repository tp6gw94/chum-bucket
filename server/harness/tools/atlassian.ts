import { createMCPClient, type MCPClient } from "@tanstack/ai-mcp";
import { pickAtlassianTools, type AtlassianPolicy } from "@server/harness/tools/atlassian-policy";

type Client = Pick<MCPClient, "tools" | "close">;
type EnabledPolicy = Extract<AtlassianPolicy, { enabled: true }>;

const connectHttp = (policy: EnabledPolicy): Promise<Client> =>
  createMCPClient({
    transport: {
      type: "http",
      url: policy.endpoint,
      headers: {
        Authorization: `Basic ${Buffer.from(`${policy.email}:${policy.apiToken}`).toString("base64")}`,
      },
    },
    name: "chum-bucket",
  });

export function createAtlassianTools(policy: AtlassianPolicy, connect = connectHttp) {
  let client: Promise<Client> | undefined;

  return async () => {
    if (!policy.enabled) {
      return [];
    }

    const current = (client ??= connect(policy));

    try {
      return pickAtlassianTools(await (await current).tools());
    } catch (error) {
      if (client === current) {
        client = undefined;
      }

      current.then((stale) => stale.close()).catch(() => {});
      console.warn(
        `Atlassian MCP 無法使用，改用 local tools：${error instanceof Error ? error.message : error}`,
      );

      return [];
    }
  };
}
