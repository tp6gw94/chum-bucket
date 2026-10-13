const COMPOSER_COMMANDS = [
  { name: "compact", description: "整理對話上下文，保留原文與完整摘要" },
] as const;

export type ComposerCommand = (typeof COMPOSER_COMMANDS)[number]["name"];

export function parseComposerCommand(text: string): ComposerCommand | null {
  return COMPOSER_COMMANDS.find((command) => text.trim() === `/${command.name}`)?.name ?? null;
}

export function commandSuggestions(input: {
  text: string;
  focused: boolean;
  composing: boolean;
  dismissed: boolean;
}) {
  if (!input.focused || input.composing || input.dismissed || !/^\/[a-z]*$/.test(input.text)) {
    return [];
  }

  return COMPOSER_COMMANDS.filter((command) => command.name.startsWith(input.text.slice(1)));
}

export function composerKeyAction(input: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode: number;
  hasSuggestions: boolean;
}): "none" | "dismiss" | "previous" | "next" | "select" | "submit" {
  if (input.isComposing || input.keyCode === 229) {
    return "none";
  }

  if (input.hasSuggestions) {
    if (input.key === "Escape") {
      return "dismiss";
    }

    if (input.key === "ArrowUp") {
      return "previous";
    }

    if (input.key === "ArrowDown") {
      return "next";
    }
  }

  return input.key === "Enter" && !input.shiftKey
    ? input.hasSuggestions
      ? "select"
      : "submit"
    : "none";
}
