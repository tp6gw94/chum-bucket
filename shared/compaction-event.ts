import { z } from "zod";

export const compactionEventName = "context-compaction";

const triggerSchema = z.enum(["threshold", "overflow", "manual", "side-chat"]);
const tokensSchema = z.number().int().nonnegative();

const compactionEventSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("started"), trigger: triggerSchema, tokensBefore: tokensSchema }),
  z.object({
    phase: z.literal("done"),
    trigger: triggerSchema,
    tokensBefore: tokensSchema,
    tokensAfter: tokensSchema,
    summaryMessageId: z.string().min(1),
    compactedMessages: z.number().int().nonnegative(),
  }),
  z.object({
    phase: z.literal("skipped"),
    trigger: triggerSchema,
    tokensBefore: tokensSchema,
    reason: z.literal("nothing-to-compact"),
  }),
  z.object({
    phase: z.literal("failed"),
    trigger: triggerSchema,
    tokensBefore: tokensSchema,
    error: z.string(),
  }),
]);

export type CompactionTrigger = z.infer<typeof triggerSchema>;
export type CompactionEvent = z.infer<typeof compactionEventSchema>;

const customEventSchema = z.object({
  type: z.literal("CUSTOM"),
  name: z.literal(compactionEventName),
  value: compactionEventSchema,
});

export function readCompactionEvent(chunk: unknown): CompactionEvent | null {
  const parsed = customEventSchema.safeParse(chunk);

  return parsed.success ? parsed.data.value : null;
}
