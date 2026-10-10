import { z } from "zod";
import type { UIMessage } from "@tanstack/ai";

export const SIDE_SCOPE_HEADER = "X-Side-Chat-Scope";
export const SIDE_LEASE_MS = 45_000;
export const sideScopeSchema = z.uuid();
export const sideOpenSchema = z.strictObject({ openKey: z.uuid() });
export const summaryDraftSchema = z.strictObject({
  id: z.uuid(),
  sideRevision: z.number().int().nonnegative(),
  through: z.number().int().nonnegative(),
  text: z.string().min(1).max(8_000),
});
export const sideTransferSchema = z.strictObject({
  draftId: z.uuid(),
  transferKey: z.uuid(),
  text: z.string().trim().min(1).max(8_000),
});
export const transferReceiptSchema = z.strictObject({
  transferKey: z.uuid(),
  parentThreadId: z.uuid(),
  sideChatId: z.uuid(),
  messageId: z.string(),
  mainRunId: z.string(),
});
export type SideChatSeed = Readonly<{
  parentRevision: number;
  display: UIMessage[];
  context: UIMessage[];
}>;
export type SummaryDraft = Readonly<z.infer<typeof summaryDraftSchema>>;
export type TransferReceipt = Readonly<z.infer<typeof transferReceiptSchema>>;
export type SummaryTransfer = Readonly<{
  kind: "draft" | "unresolved";
  draft: SummaryDraft;
  text: string;
  key: string;
}>;
export class SideChatOperationError extends Error {
  constructor(
    readonly outcome: "rejected" | "uncertain" | "blocked",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function isDefinitiveTransferRejection(cause: unknown): cause is SideChatOperationError {
  return cause instanceof SideChatOperationError && cause.outcome === "rejected";
}

export function summaryTransferFailure(transfer: SummaryTransfer, cause: unknown): SummaryTransfer {
  if (cause instanceof SideChatOperationError && cause.outcome === "blocked") {
    return transfer;
  }

  return { ...transfer, kind: isDefinitiveTransferRejection(cause) ? "draft" : "unresolved" };
}

export type SideAccess = Readonly<{ scope: string }>;
export type SideFence = Readonly<{ epoch: number; scope: string }>;
export type SideLifecycle =
  | { state: "open"; epoch: number; scope: string; leaseUntil: Date }
  | { state: "closing" | "closed"; epoch: number; scope: string };
export type SideChatOrigin = Readonly<{ sideChatId: string; ordinal: number }>;

export function originalSideTranscript(display: readonly UIMessage[], sideChatId: string) {
  return display.filter((message) => {
    const origin = message.metadata?.sideChatOrigin as SideChatOrigin | undefined;

    return origin?.sideChatId === sideChatId && message.metadata?.fromSummary !== true;
  });
}

export function classifySideConversation(
  messages: readonly UIMessage[],
  seed: SideChatSeed,
  sideChatId: string,
): UIMessage[] {
  const inherited = new Set([...seed.display, ...seed.context].map((message) => message.id));
  let ordinal = 0;

  return messages.map((message) => {
    if (inherited.has(message.id) || message.metadata?.fromSummary === true) {
      return message;
    }

    return {
      ...message,
      metadata: { ...message.metadata, sideChatOrigin: { sideChatId, ordinal: ++ordinal } },
    };
  });
}
