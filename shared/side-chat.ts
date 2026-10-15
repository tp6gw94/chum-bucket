import { z } from "zod";

export const sideChatOpenedSchema = z.object({ id: z.uuid() });
export const sideChatSummarySchema = z.object({ text: z.string() });
export const sideChatTransferBodySchema = z
  .object({ text: z.string().trim().min(1).max(32_000) })
  .strict();
export const sideChatTransferSchema = z.object({ runId: z.string().min(1) });
