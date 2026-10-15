import { BuiltinActionType, type ActionEvent } from "@openuidev/react-lang";

export type ActionHandlers = {
  open: (url: string) => void;
  send?: (text: string) => void;
};

function formStateBlock(formState: ActionEvent["formState"]) {
  const state = formState ?? {};

  return Object.keys(state).length > 0
    ? ["", "```json", JSON.stringify(state, null, 2), "```"]
    : [];
}

export function actionMessage(event: ActionEvent): string | null {
  if (event.type !== BuiltinActionType.ContinueConversation) {
    return null;
  }

  return [event.humanFriendlyMessage, ...formStateBlock(event.formState)].join("\n").trim() || null;
}

export function runAction(event: ActionEvent, handlers: ActionHandlers) {
  if (event.type === BuiltinActionType.OpenUrl) {
    const url = event.params.url;

    if (typeof url === "string") {
      handlers.open(url);
    }

    return;
  }

  const text = actionMessage(event);

  if (text && handlers.send) {
    handlers.send(text);
  }
}
