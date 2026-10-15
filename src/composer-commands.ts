const COMPOSER_COMMANDS = [
  { name: "compact", description: "整理對話上下文，保留原文與完整摘要" },
] as const;

export type ComposerCommand = (typeof COMPOSER_COMMANDS)[number];
export type ComposerCommandName = ComposerCommand["name"];

export function parseComposerCommand(text: string): ComposerCommandName | null {
  return text.trim() === "/compact" ? "compact" : null;
}

export function commandSuggestions(input: {
  text: string;
  focused: boolean;
  composing: boolean;
}): ComposerCommand[] {
  if (!input.focused || input.composing || !/^\/[a-z]*$/.test(input.text)) {
    return [];
  }

  const prefix = input.text.slice(1);

  return COMPOSER_COMMANDS.filter((command) => command.name.startsWith(prefix));
}

export type ComposerKeyAction =
  | { type: "none" }
  | { type: "submit" }
  | { type: "move"; active: number }
  | { type: "select"; index: number }
  | { type: "close" };

const MENU_KEYS: Record<string, (active: number, count: number) => ComposerKeyAction> = {
  ArrowDown: (active, count) => ({ type: "move", active: (active + 1) % count }),
  ArrowUp: (active, count) => ({ type: "move", active: (active - 1 + count) % count }),
  Enter: (active) => ({ type: "select", index: active }),
  Escape: () => ({ type: "close" }),
};

type KeyInput = {
  key: string;
  shiftKey?: boolean;
  isComposing: boolean;
  keyCode: number;
  open: boolean;
  active: number;
  count: number;
};

function plainKeyAction(input: KeyInput): ComposerKeyAction {
  return input.key === "Enter" && !input.shiftKey ? { type: "submit" } : { type: "none" };
}

export function composerKeyAction(input: KeyInput): ComposerKeyAction {
  if (input.isComposing || input.keyCode === 229) {
    return { type: "none" };
  }

  if (!input.open || input.count === 0) {
    return plainKeyAction(input);
  }

  return MENU_KEYS[input.key]?.(input.active, input.count) ?? { type: "none" };
}
