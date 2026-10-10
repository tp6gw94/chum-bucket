import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";

const MAX_BYTES = 30_000;
const fields = new Set([
  "id",
  "name",
  "type",
  "characters",
  "style",
  "absoluteBoundingBox",
  "layoutMode",
  "layoutWrap",
  "layoutSizingHorizontal",
  "layoutSizingVertical",
  "layoutAlign",
  "layoutGrow",
  "layoutPositioning",
  "primaryAxisAlignItems",
  "counterAxisAlignItems",
  "primaryAxisSizingMode",
  "counterAxisSizingMode",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "itemSpacing",
  "counterAxisSpacing",
  "fills",
  "strokes",
  "strokeWeight",
  "effects",
  "cornerRadius",
  "rectangleCornerRadii",
  "opacity",
  "clipsContent",
  "componentId",
]);

const nodeSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  visible: z.boolean().optional(),
  get children() {
    return z.array(nodeSchema).optional();
  },
});
type FigmaNode = z.infer<typeof nodeSchema>;

function compact(node: FigmaNode): Record<string, unknown> {
  const result = Object.fromEntries(Object.entries(node).filter(([key]) => fields.has(key)));

  if (node.children) {
    result.children = node.children.filter((child) => child.visible !== false).map(compact);
  }

  return result;
}

const FIGMA_HOSTS = new Set(["figma.com", "www.figma.com"]);

function parseFigmaUrl(value: string): { fileKey: string; nodeId: string | undefined } {
  const url = new URL(value);

  if (!FIGMA_HOSTS.has(url.hostname)) {
    throw new Error("Expected a Figma URL.");
  }

  const match = url.pathname.match(/^\/(?:file|design)\/([a-zA-Z0-9]+)(?:\/|$)/);

  if (!match) {
    throw new Error("Expected a Figma file or design URL.");
  }

  return {
    fileKey: url.pathname.match(/\/branch\/([a-zA-Z0-9]+)(?:\/|$)/)?.[1] ?? match[1],
    nodeId: url.searchParams.get("node-id") ?? undefined,
  };
}

function parseTarget(target: string, override?: string) {
  let fileKey = target.trim();
  let nodeId = override;

  if (/^https?:\/\//i.test(fileKey)) {
    const parsed = parseFigmaUrl(fileKey);
    fileKey = parsed.fileKey;
    nodeId ??= parsed.nodeId;
  }

  if (!/^[a-zA-Z0-9]+$/.test(fileKey)) {
    throw new Error("Invalid Figma file key.");
  }

  nodeId = nodeId?.replace(/-/g, ":");

  if (nodeId && !/^\d+:\d+$/.test(nodeId)) {
    throw new Error("Invalid Figma node ID.");
  }

  return { fileKey, nodeId };
}

function collectSummaries(root: FigmaNode): { id: string; name: string; type: string }[] {
  const summaries: { id: string; name: string; type: string }[] = [];

  function visit(node: FigmaNode) {
    if (node.visible === false) {
      return;
    }

    summaries.push({ id: node.id, name: node.name.slice(0, 200), type: node.type });
    node.children?.forEach(visit);
  }

  visit(root);

  return summaries;
}

function figmaResult(root: FigmaNode, fileKey: string, depth: number, offset: number) {
  const nodes = root.visible === false ? [] : [compact(root)];
  const result = { fileKey, depth, depthLimited: true, truncated: false, nodes };

  if (Buffer.byteLength(JSON.stringify(result)) <= MAX_BYTES) {
    return result;
  }

  const summaries = collectSummaries(root);

  return {
    fileKey,
    depth,
    depthLimited: true,
    truncated: true,
    nodes: summaries.slice(offset, offset + 20),
    nextOffset: offset + 20 < summaries.length ? offset + 20 : null,
    totalNodes: summaries.length,
    nextAction:
      "Request a specific nodeId with a smaller depth, or use nextOffset to browse more nodes.",
  };
}

function figmaApiUrl(fileKey: string, nodeId: string | undefined, depth: number): string {
  const query = new URLSearchParams({ depth: String(depth) });

  if (nodeId) {
    query.set("ids", nodeId);
  }

  const path = nodeId ? "/nodes" : "";

  return `https://api.figma.com/v1/files/${fileKey}${path}?${query}`;
}

function figmaSignals(context?: { abortSignal?: AbortSignal }): AbortSignal {
  return AbortSignal.any([
    AbortSignal.timeout(30_000),
    ...(context?.abortSignal ? [context.abortSignal] : []),
  ]);
}

function figmaDocument(
  data: {
    nodes?: Record<string, { document?: unknown } | null | undefined>;
    document?: unknown;
  },
  nodeId: string | undefined,
): unknown {
  return nodeId ? data.nodes?.[nodeId]?.document : data.document;
}

export const getFigma = toolDefinition({
  name: "get_figma",
  description:
    "Read Figma design data by URL or file key. Start without a node ID to discover frames, then request a specific node. Oversized results return a paginated node summary instead of design details.",
  inputSchema: z.object({
    target: z.string().trim().min(1).max(2048),
    nodeId: z.string().trim().min(1).optional(),
    depth: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(2)
      .describe(
        "API depth limit; returned children may be incomplete. Request a node directly for more detail.",
      ),
    offset: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .describe("Pagination offset for oversized result summaries."),
  }),
}).server(async ({ target, nodeId, depth = 2, offset = 0 }, context) => {
  const apiKey = process.env.FIGMA_API_KEY;

  if (!apiKey) {
    throw new Error("Missing FIGMA_API_KEY environment variable.");
  }

  const parsed = parseTarget(target, nodeId);
  const response = await fetch(figmaApiUrl(parsed.fileKey, parsed.nodeId, depth), {
    headers: { "X-Figma-Token": apiKey },
    signal: figmaSignals(context),
  });

  if (!response.ok) {
    throw new Error(`Figma request failed (${response.status} ${response.statusText}).`);
  }

  if (!response.headers.get("content-type")?.includes("json")) {
    throw new Error("Figma returned a non-JSON response.");
  }

  const document = figmaDocument(await response.json(), parsed.nodeId);

  if (!document) {
    throw new Error("Figma node was not found.");
  }

  return figmaResult(nodeSchema.parse(document), parsed.fileKey, depth, offset);
});
