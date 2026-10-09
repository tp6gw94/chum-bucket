import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { SIDE_SCOPE_HEADER, SideChatOperationError } from "@/shared/side-chat";

const openedSchema = z.object({ id: z.uuid(), parentRevision: z.number().int().nonnegative() });
export type SideChatEntry = Readonly<{ id: string; title: string; parentRevision: number }>;

export async function sideRequest(path: string, scope: string, init?: RequestInit) {
  const response = await fetch(`/api/side-chat${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", [SIDE_SCOPE_HEADER]: scope, ...init?.headers },
  });
  if (!response.ok) {
    throw new SideChatOperationError(
      [400, 404, 409].includes(response.status) ? "rejected" : "uncertain",
      response.status === 409
        ? "對話忙碌、已關閉或草稿已過期。草稿已保留，請確認對話狀態後重試。"
        : `附屬對話操作失敗（HTTP ${response.status}），草稿已保留。`,
    );
  }
  return response.json() as Promise<unknown>;
}

const sideDiscardRetryMessage = "捨棄附屬對話尚未完成，正在重試。失聯後服務端仍會清除。";

export function useSideChats(parentThreadId: string) {
  const [scope] = useState(() => crypto.randomUUID());
  const [entries, setEntries] = useState<SideChatEntry[]>([]);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = useRef({
    mounted: true,
    opening: false,
    openKey: null as string | null,
    nextTitle: 1,
    ids: new Set<string>(),
    retrying: new Set<string>(),
    timers: new Set<ReturnType<typeof setTimeout>>(),
  }).current;
  useEffect(() => {
    owner.mounted = true;
    const heartbeat = () =>
      void sideRequest("/heartbeat", scope, { method: "POST" }).catch(() => undefined);
    const timer = setInterval(heartbeat, 10_000);
    const abandon = () => {
      for (const id of owner.ids) {
        void fetch(`/api/side-chat/${id}`, {
          method: "DELETE",
          headers: { [SIDE_SCOPE_HEADER]: scope },
          keepalive: true,
        }).catch(() => undefined);
      }
    };
    window.addEventListener("pagehide", abandon);
    return () => {
      owner.mounted = false;
      clearInterval(timer);
      for (const retry of owner.timers) {
        clearTimeout(retry);
      }
      window.removeEventListener("pagehide", abandon);
      abandon();
    };
  }, [parentThreadId, scope, owner]);

  async function open() {
    if (owner.opening) {
      return;
    }
    owner.opening = true;
    owner.openKey ??= crypto.randomUUID();
    setOpening(true);
    setError(null);
    try {
      const child = openedSchema.parse(
        await sideRequest(`/open/${parentThreadId}`, scope, {
          method: "POST",
          body: JSON.stringify({ openKey: owner.openKey }),
        }),
      );
      owner.openKey = null;
      owner.ids.add(child.id);
      if (owner.mounted) {
        const entry = { ...child, title: `附屬對話 ${owner.nextTitle++}` };
        setEntries((current) =>
          current.some((item) => item.id === entry.id) ? current : [...current, entry],
        );
      } else {
        await sideRequest(`/${child.id}`, scope, { method: "DELETE" });
      }
    } catch (cause) {
      if (owner.mounted) {
        setError(cause instanceof Error ? cause.message : "開啟附屬對話失敗");
      }
    } finally {
      owner.opening = false;
      if (owner.mounted) {
        setOpening(false);
      }
    }
  }

  function close(id: string) {
    setEntries((current) => current.filter((entry) => entry.id !== id));
    const discard = async () => {
      try {
        await sideRequest(`/${id}`, scope, { method: "DELETE" });
        owner.ids.delete(id);
        const wasRetrying = owner.retrying.delete(id);
        if (owner.mounted && wasRetrying && owner.retrying.size === 0) {
          setError((current) => (current === sideDiscardRetryMessage ? null : current));
        }
      } catch {
        if (owner.mounted) {
          owner.retrying.add(id);
          setError(sideDiscardRetryMessage);
          const timer = setTimeout(() => {
            owner.timers.delete(timer);
            void discard();
          }, 2_000);
          owner.timers.add(timer);
        }
      }
    };
    void discard();
  }
  return { scope, entries, opening, error, open, close };
}
