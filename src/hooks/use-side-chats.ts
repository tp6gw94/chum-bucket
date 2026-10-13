import { useEffect, useRef, useState } from "react";
import { sideOpenedSchema } from "@/shared/side-chat";

export type SideChatEntry = Readonly<{ id: string; title: string }>;

export async function sideRequest(path: string, init?: RequestInit) {
  const response = await fetch(`/api/side-chat${path}`, {
    ...init,
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    throw new Error(
      response.status === 409
        ? "對話忙碌或已關閉，草稿已保留。"
        : `附屬對話操作失敗（HTTP ${response.status}），草稿已保留。`,
    );
  }

  return response.json() as Promise<unknown>;
}

function discard(id: string) {
  void fetch(`/api/side-chat/${id}`, { method: "DELETE", keepalive: true }).catch(() => undefined);
}

export function useSideChats(parentThreadId: string) {
  const [entries, setEntries] = useState<SideChatEntry[]>([]);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = useRef(new Set<string>()).current;
  const nextTitle = useRef(1);

  useEffect(() => {
    const discardAll = () => {
      for (const id of ids) {
        discard(id);
      }

      ids.clear();
    };

    window.addEventListener("pagehide", discardAll);

    return () => {
      window.removeEventListener("pagehide", discardAll);
      discardAll();
    };
  }, [parentThreadId, ids]);

  async function open() {
    if (opening) {
      return;
    }

    setOpening(true);
    setError(null);

    try {
      const { id } = sideOpenedSchema.parse(
        await sideRequest(`/open/${parentThreadId}`, { method: "POST" }),
      );
      ids.add(id);
      setEntries((current) => [...current, { id, title: `附屬對話 ${nextTitle.current++}` }]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "開啟附屬對話失敗");
    } finally {
      setOpening(false);
    }
  }

  function close(id: string) {
    ids.delete(id);
    setEntries((current) => current.filter((entry) => entry.id !== id));
    discard(id);
  }

  return { entries, opening, error, open, close };
}
