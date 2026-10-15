import { EventType, type StreamChunk } from "@tanstack/ai";

export type ToolEventLimits = Readonly<{ maxEvents: number; maxEventBytes: number }>;

export type ToolEvents = Readonly<{
  emitCustomEvent: (name: string, value: Record<string, unknown>) => void;
  flush: () => Promise<void>;
}>;

export const droppedToolEventsName = "tool_events:dropped";

function boundedValue(value: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  let text: string | undefined;

  try {
    text = JSON.stringify(value);
  } catch {
    return { omitted: true, reason: "unserializable" };
  }

  if (text === undefined) {
    return { omitted: true, reason: "unserializable" };
  }

  const bytes = Buffer.byteLength(text);

  return bytes > maxBytes
    ? { omitted: true, reason: "too_large", bytes }
    : (JSON.parse(text) as Record<string, unknown>);
}

export function createToolEvents(
  append: (event: StreamChunk) => Promise<void>,
  limits: ToolEventLimits,
): ToolEvents {
  let queue = Promise.resolve();
  let failure: { error: unknown } | undefined;
  let accepted = 0;
  let dropped = 0;
  let closed = false;

  const enqueue = (name: string, value: Record<string, unknown>) => {
    const event: StreamChunk = {
      type: EventType.CUSTOM,
      name,
      value: boundedValue(value, limits.maxEventBytes),
      timestamp: Date.now(),
    };
    queue = queue
      .then(() => (failure ? undefined : append(event)))
      .catch((error: unknown) => {
        failure ??= { error };
      });
  };

  return {
    emitCustomEvent(name, value) {
      if (closed) {
        return;
      }

      if (accepted >= limits.maxEvents) {
        dropped++;

        return;
      }

      accepted++;
      enqueue(name, value);
    },
    async flush() {
      if (!closed) {
        closed = true;

        if (dropped > 0) {
          enqueue(droppedToolEventsName, { dropped });
        }
      }

      await queue;

      if (failure) {
        throw failure.error;
      }
    },
  };
}
