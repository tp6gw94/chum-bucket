import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ElementHandle, Page } from "playwright";
import sharp from "sharp";
import { browserHandoffSchema, type ArtifactPng } from "../../shared/testing";
import { advanceConversation, isHandoffImage, type ConversationState } from "./conversation";
import type { ModelCall } from "./model-turn";

const IMAGE_DIRECTORY = join(process.cwd(), ".data", "browser-evidence");
const BROWSER_TOOLS = new Set(["verify_ac", "verify_ui"]);
const CANDIDATE_COLOR = "#d00000";
const LINK_COLOR = "#0050d0";
const LABEL_HEIGHT = 16;

type Box = Readonly<{ x: number; y: number; width: number; height: number }>;
type Mark = Readonly<{ id: string; element: ElementHandle<Element> }>;
type Located = Readonly<{ id: string; color: string; box: Box }>;
type Label = Readonly<{ id: string; color: string; x: number; y: number; width: number }>;

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function visibleBox(box: Box | null, width: number, height: number): Box | null {
  if (!box) {
    return null;
  }

  const left = Math.max(box.x, 0);
  const top = Math.max(box.y, 0);
  const right = Math.min(box.x + box.width, width);
  const bottom = Math.min(box.y + box.height, height);

  return right > left && bottom > top
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : null;
}

function overlaps(label: Label, x: number, y: number, width: number): boolean {
  return (
    x < label.x + label.width &&
    label.x < x + width &&
    y < label.y + LABEL_HEIGHT &&
    label.y < y + LABEL_HEIGHT
  );
}

function placeLabels(marks: readonly Located[], width: number): Label[] {
  const placed: Label[] = [];

  for (const { id, color, box } of marks) {
    const labelWidth = id.length * 7 + 6;
    const anchor = Math.min(box.x, width - labelWidth);
    let x = anchor;
    let y = box.y >= LABEL_HEIGHT ? box.y - LABEL_HEIGHT : box.y;

    for (;;) {
      const blocker = placed.find((label) => overlaps(label, x, y, labelWidth));

      if (!blocker) {
        break;
      }

      x = blocker.x + blocker.width + 1;

      if (x + labelWidth > width) {
        x = anchor;
        y += LABEL_HEIGHT;
      }
    }

    placed.push({ id, color, x, y, width: labelWidth });
  }

  return placed;
}

function overlay(width: number, height: number, marks: readonly Located[]): string {
  const boxes = marks.map(
    ({ color, box }) =>
      `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="none" stroke="${color}" stroke-width="2"/>`,
  );
  const labels = placeLabels(marks, width).map(
    ({ id, color, x, y, width: labelWidth }) =>
      `<rect x="${x}" y="${y}" width="${labelWidth}" height="${LABEL_HEIGHT}" fill="${color}"/><text x="${x + 3}" y="${y + 12}" font-family="monospace" font-size="12" fill="#ffffff">${id}</text>`,
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${boxes.join("")}${labels.join("")}</svg>`;
}

export async function captureHandoffImage(
  page: Page,
  marks: Readonly<{ candidates: readonly Mark[]; links: readonly Mark[] }>,
): Promise<Readonly<{ image: ArtifactPng; unmarked: ReadonlySet<string> }>> {
  const screenshot = await page.screenshot({ scale: "css", animations: "disabled" });
  const { width, height } = await sharp(screenshot).metadata();
  const colored = [
    ...marks.candidates.map((mark) => ({ mark, color: CANDIDATE_COLOR })),
    ...marks.links.map((mark) => ({ mark, color: LINK_COLOR })),
  ];
  const located = await Promise.all(
    colored.map(async ({ mark, color }) => ({
      id: mark.id,
      color,
      box: visibleBox(await mark.element.boundingBox(), width, height),
    })),
  );
  const visible = located.filter((item): item is Located => item.box !== null);
  const labeled = await sharp(screenshot)
    .composite([{ input: Buffer.from(overlay(width, height, visible)), top: 0, left: 0 }])
    .png()
    .toBuffer();
  const path = `${randomUUID()}.png`;
  await mkdir(IMAGE_DIRECTORY, { recursive: true });
  await writeFile(join(IMAGE_DIRECTORY, path), labeled);

  return {
    image: { path, digest: sha256(labeled) },
    unmarked: new Set(located.filter((item) => !item.box).map((item) => item.id)),
  };
}

export async function attachHandoffImage(
  conversation: ConversationState,
  call: ModelCall,
  output: unknown,
): Promise<ConversationState> {
  if (!BROWSER_TOOLS.has(call.name)) {
    return conversation;
  }

  const parsed = browserHandoffSchema.safeParse(output);

  if (!parsed.success) {
    return conversation;
  }

  const { caseId, id, image } = parsed.data.handoff;
  const messageId = `browser-handoff-image:${sha256(JSON.stringify([caseId, id, image.digest]))}`;
  const attached =
    conversation.context.some((message) => message.id === messageId) ||
    conversation.display.some((message) => message.id === messageId);

  if (attached) {
    return conversation;
  }

  const bytes = await readFile(join(IMAGE_DIRECTORY, image.path));

  if (sha256(bytes) !== image.digest) {
    throw new Error(`Handoff image ${image.path} does not match its digest`);
  }

  const owner = conversation.context.findIndex((message) =>
    message.parts.some((part) => part.type === "tool-call" && part.id === call.id),
  );
  const retained = conversation.context.filter(
    (message, index) => index > owner || !isHandoffImage(message),
  );

  return advanceConversation(conversation, [
    ...retained,
    {
      id: messageId,
      role: "user",
      metadata: { browserHandoffImage: { caseId, handoffId: id, image } },
      parts: [
        {
          type: "text",
          content: `Labeled screenshot for handoff ${id} of case ${caseId}. Each mark is labeled with its candidate or link id. It is a handoff aid, not evidence.`,
        },
        {
          type: "image",
          source: { type: "data", value: bytes.toString("base64"), mimeType: "image/png" },
        },
      ],
    },
  ]);
}
