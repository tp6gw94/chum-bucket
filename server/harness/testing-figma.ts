import type { RoleTask } from "../../shared/testing";
import type { ModelCall } from "./model-turn";
import { getFigma } from "./tools/get-figma";

type FigmaNode = {
  id: string;
  type: string;
  style?: Record<string, number>;
  absoluteBoundingBox?: Record<string, number>;
  cornerRadius?: number;
  opacity?: number;
  fills?: {
    type: string;
    visible?: boolean;
    opacity?: number;
    color?: { r: number; g: number; b: number; a?: number };
  }[];
};

function figmaTarget(target: string, nodeId?: string) {
  if (!target.startsWith("https://")) {
    return { fileKey: target, nodeId };
  }

  const url = new URL(target);

  if (!["figma.com", "www.figma.com"].includes(url.hostname)) {
    throw new Error("Figma target is outside delegated scope");
  }

  return {
    fileKey: url.pathname.match(/\/(?:file|design)\/([a-zA-Z0-9]+)/)?.[1],
    nodeId: nodeId ?? url.searchParams.get("node-id") ?? undefined,
  };
}

export function scopedFigmaCall(call: ModelCall, task: RoleTask): ModelCall {
  const input = getFigma.inputSchema.parse(call.input);
  const target = figmaTarget(input.target, input.nodeId);

  if (
    !task.design ||
    target.fileKey !== task.design.fileKey ||
    target.nodeId?.replace(/-/g, ":") !== task.design.nodeId.replace(/-/g, ":")
  ) {
    throw new Error("Figma target is outside delegated scope");
  }

  const next = {
    ...input,
    target: task.design.fileKey,
    nodeId: task.design.nodeId.replace(/-/g, ":"),
  };

  return { ...call, input: next, arguments: JSON.stringify(next) };
}

function colorValue(node: FigmaNode): Record<string, string> {
  const fill = node.fills?.find((item) => item.type === "SOLID" && item.visible !== false);

  if (!fill?.color) {
    return {};
  }

  const { r, g, b, a = 1 } = fill.color;
  const alpha = a * (fill.opacity ?? 1);
  const rgb = [r, g, b].map((value) => Math.round(value * 255)).join(", ");

  return {
    [node.type === "TEXT" ? "color" : "backgroundColor"]:
      alpha === 1 ? `rgb(${rgb})` : `rgba(${rgb}, ${alpha})`,
  };
}

function numericValues(node: FigmaNode): Record<string, string> {
  const box = node.absoluteBoundingBox ?? {};
  const style = node.style ?? {};
  const entries: [string, number | undefined, string][] = [
    ["width", box.width, "px"],
    ["height", box.height, "px"],
    ["fontSize", style.fontSize, "px"],
    ["fontWeight", style.fontWeight, ""],
    ["lineHeight", style.lineHeightPx, "px"],
    ["letterSpacing", style.letterSpacing, "px"],
    ["borderRadius", node.cornerRadius, "px"],
    ["opacity", node.opacity ?? 1, ""],
  ];

  return Object.fromEntries(
    entries
      .filter(([, value]) => typeof value === "number" && Number.isFinite(value))
      .map(([name, value, unit]) => [name, `${value}${unit}`]),
  );
}

export function designValues(output: unknown, task: RoleTask): Record<string, string> | null {
  const data = output as { truncated?: boolean; nodes?: FigmaNode[] };
  const nodeId = task.design?.nodeId.replace(/-/g, ":");
  const node = data?.nodes?.find((item) => item.id === nodeId);

  if (!node || data.truncated) {
    return null;
  }

  return { ...numericValues(node), ...colorValue(node) };
}
