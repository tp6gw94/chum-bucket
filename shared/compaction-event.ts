import { EventType, type StreamChunk } from "@tanstack/ai";
import { z } from "zod";

const COMPACTION_EVENT_NAME = "context-compaction";

const compactionEventSchema = z.object({
  type: z.literal(EventType.CUSTOM),
  name: z.literal(COMPACTION_EVENT_NAME),
  value: z.object({
    runId: z.string().min(1).max(200),
    operationId: z.string().min(1).max(400),
    state: z.enum(["started", "done", "failed", "skipped"]),
  }),
});

export type CompactionEvent = z.infer<typeof compactionEventSchema>["value"];

export function parseCompactionEvent(chunk: unknown): CompactionEvent | null {
  const parsed = compactionEventSchema.safeParse(chunk);

  return parsed.success ? parsed.data.value : null;
}

export function compactionEvent(event: CompactionEvent): StreamChunk {
  return {
    type: EventType.CUSTOM,
    name: COMPACTION_EVENT_NAME,
    value: event,
    timestamp: Date.now(),
  };
}
