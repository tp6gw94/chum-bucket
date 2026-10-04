import { EventType, type StreamChunk } from "@tanstack/ai";

export const maxToolEvents = 192;
const maxToolEventBytes = 65_536;

export type ToolEventBuffer = Readonly<{
  emit: (name: string, value: Record<string, unknown>) => void;
  close: () => void;
  drain: () => StreamChunk[];
}>;

export async function drainToolEvents(
  buffer: ToolEventBuffer,
  persist: (event: StreamChunk) => Promise<void>,
): Promise<void> {
  buffer.close();
  for (const event of buffer.drain()) {
    await persist(event);
  }
}

export function createToolEventBuffer(parentToolCallId: string): ToolEventBuffer {
  const buffered: StreamChunk[] = [];
  let bytes = 0;
  let closed = false;
  return {
    emit(name, value) {
      if (closed) {
        return;
      }
      const event: StreamChunk = {
        type: EventType.CUSTOM,
        name,
        value: structuredClone(value),
        timestamp: Date.now(),
        metadata: { tanstack: { toolCallId: parentToolCallId, toolEvent: buffered.length } },
      };
      const size = Buffer.byteLength(JSON.stringify(event));
      if (buffered.length >= maxToolEvents || bytes + size > maxToolEventBytes) {
        closed = true;
        throw new Error("Tool events exceeded their bound");
      }
      bytes += size;
      buffered.push(event);
    },
    close() {
      closed = true;
    },
    drain() {
      return buffered.splice(0, buffered.length);
    },
  };
}
