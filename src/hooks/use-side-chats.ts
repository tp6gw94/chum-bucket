import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
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

type SideOwner = {
  mounted: boolean;
  opening: boolean;
  openKey: string | null;
  nextTitle: number;
  ids: Set<string>;
  retrying: Set<string>;
  timers: Set<ReturnType<typeof setTimeout>>;
};

type SideChats = Readonly<{
  owner: SideOwner;
  scope: string;
  parentThreadId: string;
  setEntries: Dispatch<SetStateAction<SideChatEntry[]>>;
  setOpening: (opening: boolean) => void;
  setError: Dispatch<SetStateAction<string | null>>;
}>;

function createSideOwner(): SideOwner {
  return {
    mounted: true,
    opening: false,
    openKey: null,
    nextTitle: 1,
    ids: new Set(),
    retrying: new Set(),
    timers: new Set(),
  };
}

function abandonSideChats(owner: SideOwner, scope: string) {
  for (const id of owner.ids) {
    void fetch(`/api/side-chat/${id}`, {
      method: "DELETE",
      headers: { [SIDE_SCOPE_HEADER]: scope },
      keepalive: true,
    }).catch(() => undefined);
  }
}

function useSideChatLifecycle(parentThreadId: string, scope: string, owner: SideOwner) {
  useEffect(() => {
    owner.mounted = true;
    const heartbeat = () =>
      void sideRequest("/heartbeat", scope, { method: "POST" }).catch(() => undefined);
    const timer = setInterval(heartbeat, 10_000);
    const abandon = () => abandonSideChats(owner, scope);
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
}

async function adoptOpened(chats: SideChats, child: z.infer<typeof openedSchema>) {
  const { owner } = chats;
  owner.openKey = null;
  owner.ids.add(child.id);

  if (!owner.mounted) {
    await sideRequest(`/${child.id}`, chats.scope, { method: "DELETE" });

    return;
  }

  const entry = { ...child, title: `附屬對話 ${owner.nextTitle++}` };
  chats.setEntries((current) =>
    current.some((item) => item.id === entry.id) ? current : [...current, entry],
  );
}

async function openSideChat(chats: SideChats) {
  const { owner } = chats;

  if (owner.opening) {
    return;
  }

  owner.opening = true;
  owner.openKey ??= crypto.randomUUID();
  chats.setOpening(true);
  chats.setError(null);

  try {
    const child = openedSchema.parse(
      await sideRequest(`/open/${chats.parentThreadId}`, chats.scope, {
        method: "POST",
        body: JSON.stringify({ openKey: owner.openKey }),
      }),
    );
    await adoptOpened(chats, child);
  } catch (cause) {
    if (owner.mounted) {
      chats.setError(cause instanceof Error ? cause.message : "開啟附屬對話失敗");
    }
  } finally {
    owner.opening = false;

    if (owner.mounted) {
      chats.setOpening(false);
    }
  }
}

function retryDiscard(chats: SideChats, id: string) {
  const { owner } = chats;

  if (!owner.mounted) {
    return;
  }

  owner.retrying.add(id);
  chats.setError(sideDiscardRetryMessage);
  const timer = setTimeout(() => {
    owner.timers.delete(timer);
    void discardSideChat(chats, id);
  }, 2_000);
  owner.timers.add(timer);
}

async function discardSideChat(chats: SideChats, id: string) {
  const { owner } = chats;

  try {
    await sideRequest(`/${id}`, chats.scope, { method: "DELETE" });
    owner.ids.delete(id);
    const wasRetrying = owner.retrying.delete(id);

    if (owner.mounted && wasRetrying && owner.retrying.size === 0) {
      chats.setError((current) => (current === sideDiscardRetryMessage ? null : current));
    }
  } catch {
    retryDiscard(chats, id);
  }
}

export function useSideChats(parentThreadId: string) {
  const [scope] = useState(() => crypto.randomUUID());
  const [entries, setEntries] = useState<SideChatEntry[]>([]);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = useRef(createSideOwner()).current;
  useSideChatLifecycle(parentThreadId, scope, owner);
  const chats: SideChats = { owner, scope, parentThreadId, setEntries, setOpening, setError };

  function close(id: string) {
    setEntries((current) => current.filter((entry) => entry.id !== id));
    void discardSideChat(chats, id);
  }

  return { scope, entries, opening, error, open: () => openSideChat(chats), close };
}
