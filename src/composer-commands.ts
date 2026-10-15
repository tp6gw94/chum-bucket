const COMPOSER_COMMANDS = [
  { name: "compact", description: "整理對話上下文，保留原文與完整摘要" },
] as const;

type CommandOption = (typeof COMPOSER_COMMANDS)[number];
export type ComposerCommand = CommandOption["name"];

export type ComposerKeyAction =
  | { type: "move"; index: number }
  | { type: "select"; index: number }
  | { type: "dismiss" }
  | { type: "submit" }
  | { type: "default" };

export function parseComposerCommand(text: string): ComposerCommand | null {
  const trimmed = text.trim();

  return COMPOSER_COMMANDS.find((command) => trimmed === `/${command.name}`)?.name ?? null;
}

export function commandSuggestions(input: {
  text: string;
  focused: boolean;
  composing: boolean;
}): readonly CommandOption[] {
  if (!input.focused || input.composing || !/^\/[a-z]*$/.test(input.text)) {
    return [];
  }

  const prefix = input.text.slice(1);

  return COMPOSER_COMMANDS.filter((command) => command.name.startsWith(prefix));
}

export function composerKeyAction(input: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode: number;
  menuSize: number;
  active: number;
}): ComposerKeyAction {
  const { key, menuSize, active } = input;

  if (input.isComposing || input.keyCode === 229) {
    return { type: "default" };
  }

  if (menuSize > 0) {
    if (key === "ArrowDown") {
      return { type: "move", index: (active + 1) % menuSize };
    }

    if (key === "ArrowUp") {
      return { type: "move", index: (active - 1 + menuSize) % menuSize };
    }

    if (key === "Escape") {
      return { type: "dismiss" };
    }

    if (key === "Enter" && !input.shiftKey) {
      return { type: "select", index: active };
    }
  }

  return key === "Enter" && !input.shiftKey ? { type: "submit" } : { type: "default" };
}

export function commandMenu(input: {
  text: string;
  focused: boolean;
  composing: boolean;
  enabled: boolean;
  available: boolean;
  dismissed: string | null;
  active: number;
}) {
  const open = input.enabled && input.available && input.dismissed !== input.text;
  const suggestions = open ? commandSuggestions(input) : [];

  return { suggestions, highlighted: Math.min(input.active, Math.max(suggestions.length - 1, 0)) };
}

export function menuAttributes(
  listId: string,
  menu: { suggestions: readonly unknown[]; highlighted: number },
): Record<string, string> {
  return menu.suggestions.length > 0
    ? { "aria-controls": listId, "aria-activedescendant": `${listId}-${menu.highlighted}` }
    : {};
}

const RESULT_ERRORS = {
  succeeded: null,
  failed: "執行失敗，原文已保留。",
  uncertain: "結果尚未確認，請重新載入對話，原文已保留。",
} as const;

export function resultError(result: keyof typeof RESULT_ERRORS): string | null {
  return RESULT_ERRORS[result];
}

export function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "送出失敗，請稍後再試";
}
