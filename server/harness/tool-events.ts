import { EventType, type StreamChunk } from "@tanstack/ai";

export type ToolEventBudget = Readonly<{ maxEvents: number; maxBytes: number }>;

const defaultToolEventBudget: ToolEventBudget = { maxEvents: 192, maxBytes: 65_536 };

export type ToolEventBuffer = Readonly<{
  emit: (name: string, value: Record<string, unknown>) => void;
  close: () => StreamChunk[];
}>;

export function createToolEventBuffer(
  parentToolCallId: string,
  budget: ToolEventBudget = defaultToolEventBudget,
): ToolEventBuffer {
  const events: StreamChunk[] = [];
  let bytes = 0;
  let open = true;

  return {
    emit(name, value) {
      if (!open || events.length >= budget.maxEvents) {
        return;
      }

      const event: StreamChunk = {
        type: EventType.CUSTOM,
        name,
        value: { ...value, parentToolCallId, sequence: events.length },
        timestamp: Date.now(),
      };
      const size = Buffer.byteLength(JSON.stringify(event) ?? "", "utf8");

      if (bytes + size > budget.maxBytes) {
        open = false;

        return;
      }

      bytes += size;
      events.push(event);
    },
    close() {
      open = false;

      return events.splice(0);
    },
  };
}

export async function persistToolEvents(
  events: readonly StreamChunk[],
  save: (event: StreamChunk) => Promise<void>,
): Promise<void> {
  for (const event of events) {
    await save(event);
  }
}
