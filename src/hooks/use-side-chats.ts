import { useEffect, useRef, useState } from "react";
import {
  sideChatOpenedSchema,
  sideChatSummarySchema,
  sideChatTransferSchema,
} from "../../shared/side-chat";

export type SideChat = { id: string; title: string };

async function failure(response: Response, action: string) {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;

  return new Error(`${action}（HTTP ${response.status}${body?.error ? `：${body.error}` : ""}）`);
}

function discardSideChat(id: string, keepalive = false) {
  return fetch(`/api/side-chat/${encodeURIComponent(id)}`, { method: "DELETE", keepalive });
}

export async function previewSideChatSummary(id: string): Promise<string> {
  const response = await fetch(`/api/side-chat/${encodeURIComponent(id)}/summary`, {
    method: "POST",
  });

  if (!response.ok) {
    throw await failure(response, "產生摘要失敗");
  }

  return sideChatSummarySchema.parse(await response.json()).text;
}

export async function transferSideChat(id: string, text: string): Promise<string> {
  const response = await fetch(`/api/side-chat/${encodeURIComponent(id)}/transfer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    throw await failure(response, "回填摘要失敗");
  }

  return sideChatTransferSchema.parse(await response.json()).runId;
}

export function useSideChats(parentId: string) {
  const [chats, setChats] = useState<SideChat[]>([]);
  const [error, setError] = useState<string | null>(null);
  const opened = useRef(new Set<string>());
  const count = useRef(0);

  useEffect(() => {
    const ids = opened.current;

    const discardAll = () => {
      for (const id of ids) {
        void discardSideChat(id, true);
      }
    };

    window.addEventListener("pagehide", discardAll);

    return () => window.removeEventListener("pagehide", discardAll);
  }, []);

  async function open() {
    setError(null);

    try {
      const response = await fetch(`/api/side-chat/open/${encodeURIComponent(parentId)}`, {
        method: "POST",
      });

      if (!response.ok) {
        throw await failure(response, "開啟附屬對話失敗");
      }

      const { id } = sideChatOpenedSchema.parse(await response.json());
      opened.current.add(id);
      count.current += 1;
      setChats((current) => [...current, { id, title: `附屬對話 ${count.current}` }]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "開啟附屬對話失敗");
    }
  }

  function forget(id: string) {
    opened.current.delete(id);
    setChats((current) => current.filter((chat) => chat.id !== id));
  }

  async function close(id: string) {
    forget(id);
    await discardSideChat(id);
  }

  return { chats, error, open, close, forget };
}
