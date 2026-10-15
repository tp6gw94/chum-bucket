import { z } from "zod";

const compactionEventName = "context-compaction";

const compactionStates = ["started", "done", "skipped", "failed"] as const;
export type CompactionState = (typeof compactionStates)[number];

const compactionReasons = ["threshold", "overflow", "manual"] as const;
export type CompactionReason = (typeof compactionReasons)[number];

const compactionValueSchema = z.object({
  runId: z.string().min(1),
  operationId: z.string().min(1),
  state: z.enum(compactionStates),
  reason: z.enum(compactionReasons),
});
export type CompactionEventValue = z.infer<typeof compactionValueSchema>;

const compactionEventSchema = z.object({
  type: z.literal("CUSTOM"),
  name: z.literal(compactionEventName),
  value: compactionValueSchema,
});

export function compactionEvent(value: CompactionEventValue) {
  return {
    type: "CUSTOM" as const,
    name: compactionEventName,
    value: compactionValueSchema.parse(value),
    timestamp: Date.now(),
  };
}

export function parseCompactionEvent(event: unknown): CompactionEventValue | null {
  const parsed = compactionEventSchema.safeParse(event);

  return parsed.success ? parsed.data.value : null;
}
