import { z } from "zod";

export const COMPACTION_EVENT = "context-compaction";

const compactionValueSchema = z.object({
  runId: z.string().min(1),
  operationId: z.string().min(1),
  state: z.enum(["started", "done", "skipped", "failed"]),
});

export type CompactionEventValue = z.infer<typeof compactionValueSchema>;
export type CompactionState = CompactionEventValue["state"];

export function parseCompactionEvent(name: string, value: unknown): CompactionEventValue | null {
  if (name !== COMPACTION_EVENT) {
    return null;
  }

  const parsed = compactionValueSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
}
