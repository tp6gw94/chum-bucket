import type { SideChat } from "../../shared/side-chat";
import { useThread } from "../hooks/use-threads";
import { Pane } from "./pane";
import type { Pane as PaneModel } from "./types";

export function SideChatPane({
  chat,
  index,
  onOpenAgentPane,
  onClose,
}: {
  chat: SideChat;
  index: number;
  onOpenAgentPane: () => void;
  onClose: () => void;
}) {
  const thread = useThread(chat.id);
  const pane: PaneModel = {
    id: chat.id,
    title: `${chat.title} ${index + 1}`,
    agent: "附屬",
    status: thread.phase === "busy" ? "running" : "idle",
    progress: thread.progress,
    messages: thread.messages,
    kind: "agent",
  };

  return (
    <Pane
      pane={pane}
      onOpenAgentPane={onOpenAgentPane}
      onClose={thread.phase === "busy" || thread.phase === "loading" ? undefined : onClose}
      onSend={thread.send}
      sendDisabled={thread.phase !== "ready"}
      isHydrating={thread.phase === "loading"}
      hydrationError={thread.error}
    />
  );
}
