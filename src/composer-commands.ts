export type ComposerCommand =
  | { kind: "message"; text: string }
  | { kind: "compact"; instructions?: string };

export type CommandOption = { name: string; usage: string; description: string };

type CommandMenuAction = "next" | "previous" | "pick" | "dismiss";

const COMPACT_COMMAND = /^\/compact(?:\s+([\s\S]*))?$/;
const COMMAND_PREFIX = /^\/\S*$/;

const COMMAND_OPTIONS: CommandOption[] = [
  {
    name: "/compact",
    usage: "/compact [保留重點]",
    description: "把先前的對話壓縮成摘要，釋出上下文空間",
  },
];

const MENU_ACTIONS: Partial<Record<string, CommandMenuAction>> = {
  ArrowDown: "next",
  ArrowUp: "previous",
  Enter: "pick",
  Tab: "pick",
  Escape: "dismiss",
};

export function suggestCommands(input: string): CommandOption[] {
  const typed = input.trimStart();

  if (!COMMAND_PREFIX.test(typed)) {
    return [];
  }

  return COMMAND_OPTIONS.filter((option) => option.name.startsWith(typed) && option.name !== typed);
}

export function commandMenuAction(event: { key: string; shiftKey: boolean }) {
  return event.shiftKey ? undefined : MENU_ACTIONS[event.key];
}

export function parseComposerCommand(input: string): ComposerCommand {
  const text = input.trim();
  const match = COMPACT_COMMAND.exec(text);

  if (!match) {
    return { kind: "message", text };
  }

  const instructions = match[1]?.trim();

  return instructions ? { kind: "compact", instructions } : { kind: "compact" };
}

export function commandRunBody(command: ComposerCommand, baseRevision: number) {
  if (command.kind === "message") {
    return { baseRevision };
  }

  return command.instructions
    ? { baseRevision, kind: command.kind, instructions: command.instructions }
    : { baseRevision, kind: command.kind };
}
