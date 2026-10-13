import { z } from "zod";
import type { UIMessage } from "@tanstack/ai";

const sideSummaryText = z.string().trim().min(1).max(8_000);
export const sideSummarySchema = z.strictObject({ text: sideSummaryText });
export const sideTransferSchema = z.strictObject({ text: sideSummaryText });
export const sideOpenedSchema = z.strictObject({ id: z.uuid() });
export const sideTransferredSchema = z.strictObject({ runId: z.string() });

export type SideChatSeed = Readonly<{
  display: UIMessage[];
  context: UIMessage[];
}>;

export function sideTransferRunId(sideChatId: string) {
  return `side-${sideChatId}`;
}

export function sideTranscript(display: readonly UIMessage[], seed: SideChatSeed) {
  const inherited = new Set(seed.display.map((message) => message.id));

  return display.filter(
    (message) => !inherited.has(message.id) && message.metadata?.fromSummary !== true,
  );
}
