import { useEffect, useRef, useState } from "react";
import {
  sideChatListSchema,
  sideChatPath,
  sideChatSchema,
  type SideChat,
} from "../../shared/side-chat";

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

async function expectOk(response: Response, action: string) {
  if (!response.ok) {
    throw new Error(`${action}失敗（HTTP ${response.status}）`);
  }

  return response;
}

export function useSideChats(parentThreadId: string) {
  const [chats, setChats] = useState<SideChat[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const claim = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ parentThreadId });

    void fetch(`${sideChatPath}?${query}`, { signal: controller.signal })
      .then((response) => expectOk(response, "載入附屬對話"))
      .then(async (response) => {
        const list = sideChatListSchema.parse(await response.json());

        if (!controller.signal.aborted) {
          setChats(list);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(cause, "載入附屬對話失敗"));
        }
      });

    return () => controller.abort();
  }, [parentThreadId]);

  async function open() {
    if (claim.current) {
      return;
    }

    claim.current = true;
    setOpening(true);
    setError(null);

    try {
      const response = await fetch(sideChatPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentThreadId }),
      }).then((result) => expectOk(result, "開啟附屬對話"));
      const created = sideChatSchema.parse(await response.json());
      setChats((current) => [...current, created]);
    } catch (cause) {
      setError(errorMessage(cause, "開啟附屬對話失敗"));
    } finally {
      claim.current = false;
      setOpening(false);
    }
  }

  async function close(id: string) {
    setError(null);

    try {
      await fetch(`${sideChatPath}/${encodeURIComponent(id)}`, { method: "DELETE" }).then(
        (response) => expectOk(response, "關閉附屬對話"),
      );
      setChats((current) => current.filter((chat) => chat.id !== id));
    } catch (cause) {
      setError(errorMessage(cause, "關閉附屬對話失敗"));
    }
  }

  return { chats, error, opening, open, close };
}
