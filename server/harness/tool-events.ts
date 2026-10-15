const MAX_EVENTS = 192;
const MAX_BYTES = 65_536;

export type ToolEvent = Readonly<{
  sequence: number;
  name: string;
  value: Record<string, unknown>;
}>;

export type ToolEventBuffer = Readonly<{
  push: (name: string, value?: Record<string, unknown>) => void;
  close: () => ToolEvent[];
}>;

export function createToolEventBuffer(
  limits: Readonly<{ maxEvents: number; maxBytes: number }> = {
    maxEvents: MAX_EVENTS,
    maxBytes: MAX_BYTES,
  },
): ToolEventBuffer {
  const events: ToolEvent[] = [];
  let bytes = 0;
  let closed = false;

  return {
    push(name, value = {}) {
      if (closed || events.length >= limits.maxEvents) {
        return;
      }

      const size = Buffer.byteLength(JSON.stringify({ name, value }));

      if (bytes + size > limits.maxBytes) {
        return;
      }

      bytes += size;
      events.push({ sequence: events.length, name, value });
    },
    close() {
      closed = true;

      return events;
    },
  };
}
