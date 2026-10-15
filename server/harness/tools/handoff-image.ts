import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

export type OverlayBox = Readonly<{
  id: string;
  kind: "candidate" | "link";
  x: number;
  y: number;
  width: number;
  height: number;
}>;

const colors = { candidate: "#e11d48", link: "#2563eb" } as const;

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function overlaySvg(width: number, height: number, boxes: readonly OverlayBox[]): string {
  const shapes = boxes
    .filter((box) => box.width > 0 && box.height > 0 && box.x < width && box.y < height)
    .map((box) => {
      const color = colors[box.kind];
      const labelY = Math.max(box.y - 2, 12);

      return [
        `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="none" stroke="${color}" stroke-width="2"/>`,
        `<rect x="${box.x}" y="${labelY - 12}" width="${box.id.length * 8 + 6}" height="14" fill="${color}"/>`,
        `<text x="${box.x + 3}" y="${labelY - 1}" font-family="monospace" font-size="12" fill="#fff">${escapeXml(box.id)}</text>`,
      ].join("");
    });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${shapes.join("")}</svg>`;
}

export async function writeHandoffImage(input: {
  screenshot: Buffer;
  boxes: readonly OverlayBox[];
  directory: string;
  name: string;
}): Promise<{ path: string; digest: string }> {
  const image = sharp(input.screenshot);
  const { width = 0, height = 0 } = await image.metadata();
  const png = await image
    .composite([{ input: Buffer.from(overlaySvg(width, height, input.boxes)), top: 0, left: 0 }])
    .png()
    .toBuffer();
  await mkdir(input.directory, { recursive: true });
  const file = path.join(input.directory, `${input.name}.png`);
  await writeFile(file, png);

  return { path: file, digest: createHash("sha256").update(png).digest("hex") };
}
