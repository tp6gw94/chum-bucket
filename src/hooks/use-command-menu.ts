import { useId, useRef, useState } from "react";

import {
  commandMenu,
  composerKeyAction,
  menuAttributes,
  type ComposerCommand,
  type ComposerKeyAction,
} from "../composer-commands";

type MenuInput = {
  text: string;
  enabled: boolean;
  available: boolean;
  onSelect: (command: ComposerCommand) => void;
  onSubmit: () => void;
};

export function useCommandMenu(input: MenuInput) {
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const listId = useId();
  const menu = commandMenu({ ...input, focused, composing, dismissed, active });
  const latest = useRef({ menu, input });
  latest.current = { menu, input };

  function apply(action: Exclude<ComposerKeyAction, { type: "default" }>) {
    const current = latest.current;

    if (action.type === "move") {
      setActive(action.index);
    } else if (action.type === "dismiss") {
      setDismissed(current.input.text);
    } else if (action.type === "select") {
      current.input.onSelect(current.menu.suggestions[action.index]!.name);
    } else {
      current.input.onSubmit();
    }
  }

  function handleKey(event: KeyboardEvent, composingNow: boolean): boolean {
    const action = composerKeyAction({
      key: event.key,
      shiftKey: event.shiftKey,
      isComposing: event.isComposing || composingNow,
      keyCode: event.keyCode,
      menuSize: latest.current.menu.suggestions.length,
      active: latest.current.menu.highlighted,
    });

    if (action.type === "default") {
      return false;
    }

    event.preventDefault();
    apply(action);

    return true;
  }

  return {
    listId,
    ...menu,
    attributes: menuAttributes(listId, menu),
    setActive,
    handleKey,
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
    domEvents: {
      compositionstart: () => {
        setComposing(true);

        return false;
      },
      compositionend: () => {
        setComposing(false);

        return false;
      },
    },
  };
}
