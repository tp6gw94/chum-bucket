import { cn } from "cn";

import type { ComposerCommand, commandSuggestions } from "../composer-commands";

export function CommandMenu({
  id,
  commands,
  highlighted,
  onHighlight,
  onSelect,
}: {
  id: string;
  commands: ReturnType<typeof commandSuggestions>;
  highlighted: number;
  onHighlight: (index: number) => void;
  onSelect: (command: ComposerCommand) => void;
}) {
  if (commands.length === 0) {
    return null;
  }

  return (
    <ul
      id={id}
      role="listbox"
      aria-label="對話命令"
      className="absolute bottom-full left-0 z-10 mb-1 flex w-full flex-col gap-0.5 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {commands.map((command, index) => (
        <li
          key={command.name}
          id={`${id}-${index}`}
          role="option"
          aria-selected={index === highlighted}
          className={cn(
            "flex cursor-pointer items-baseline gap-2 rounded-md px-2 py-1.5 text-sm",
            index === highlighted && "bg-accent text-accent-foreground",
          )}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onHighlight(index)}
          onClick={() => onSelect(command.name)}
        >
          <span className="font-mono">/{command.name}</span>
          <span className="text-xs text-muted-foreground">{command.description}</span>
        </li>
      ))}
    </ul>
  );
}
