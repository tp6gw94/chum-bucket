import { toolDefinition } from "@tanstack/ai";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { z } from "zod";

const API = "https://api.figma.com/v1";
const IMAGE_DIR = "public/figma";

const nodeId = z.string().regex(/^\d+[:-]\d+$/);

async function figmaFetch(path: string): Promise<Response> {
  const response = await fetch(`${API}${path}`, {
    headers: { "X-Figma-Token": process.env.FIGMA_API_KEY! },
  });

  if (!response.ok) {
    throw new Error(`Figma API ${response.status}: ${await response.text()}`);
  }

  return response;
}

type FigmaNode = {
  id: string;
  name: string;
  type: string;
  characters?: string;
  absoluteBoundingBox?: { width: number; height: number };
  children?: FigmaNode[];
};

type SimplifiedNode = {
  id: string;
  name: string;
  type: string;
  text?: string;
  size?: { width: number; height: number };
  children?: SimplifiedNode[];
};

function simplify(node: FigmaNode): SimplifiedNode {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    ...(node.characters ? { text: node.characters } : {}),
    ...(node.absoluteBoundingBox
      ? { size: { width: node.absoluteBoundingBox.width, height: node.absoluteBoundingBox.height } }
      : {}),
    ...(node.children ? { children: node.children.map(simplify) } : {}),
  };
}

export const getFigmaData = toolDefinition({
  name: "get_figma_data",
  description:
    "Read the structure of a Figma file or node: names, types, sizes and text content. Pass nodeId from a Figma URL (node-id=1-80 becomes 1:80) to read one frame.",
  inputSchema: z.object({
    fileKey: z.string().regex(/^[a-zA-Z0-9]+$/),
    nodeId: nodeId.optional(),
    depth: z.number().int().min(1).max(6).default(3),
  }),
}).server(async ({ fileKey, nodeId, depth }) => {
  if (nodeId) {
    const id = nodeId.replace("-", ":");
    const body = (await (
      await figmaFetch(`/files/${fileKey}/nodes?ids=${encodeURIComponent(id)}&depth=${depth}`)
    ).json()) as { name: string; nodes: Record<string, { document: FigmaNode } | null> };

    return {
      name: body.name,
      nodes: Object.values(body.nodes).flatMap((entry) => (entry ? [simplify(entry.document)] : [])),
    };
  }

  const body = (await (await figmaFetch(`/files/${fileKey}?depth=${depth}`)).json()) as {
    name: string;
    document: FigmaNode;
  };

  return { name: body.name, nodes: [simplify(body.document)] };
});

export const downloadFigmaImage = toolDefinition({
  name: "download_figma_image",
  description: `Export a Figma node as SVG or PNG into ${IMAGE_DIR}. Returns the saved file path.`,
  inputSchema: z.object({
    fileKey: z.string().regex(/^[a-zA-Z0-9]+$/),
    nodeId,
    format: z.enum(["svg", "png"]).default("png"),
    scale: z.number().min(0.01).max(4).default(2),
  }),
}).server(async ({ fileKey, nodeId, format, scale }) => {
  const id = nodeId.replace("-", ":");
  const body = (await (
    await figmaFetch(
      `/images/${fileKey}?ids=${encodeURIComponent(id)}&format=${format}&scale=${scale}`,
    )
  ).json()) as { images: Record<string, string | null> };
  const url = body.images[id];

  if (!url) {
    throw new Error(`Figma could not render node ${id}`);
  }

  const download = await fetch(url);

  if (!download.ok) {
    throw new Error(`Image download failed: ${download.status}`);
  }

  await mkdir(IMAGE_DIR, { recursive: true });
  const path = join(IMAGE_DIR, `${id.replace(":", "-")}.${format}`);
  await writeFile(path, Buffer.from(await download.arrayBuffer()));

  return { path };
});

export const figmaTools = [getFigmaData, downloadFigmaImage];
