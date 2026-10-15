import { useEffect, useId, useState } from "react";
import type { Editor } from "@tiptap/react";
import { cn } from "cn";

import { commandMenuAction, suggestCommands, type CommandOption } from "../composer-commands";

export function useCommandMenu(editor: Editor, text: string) {
  const id = useId();
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const options = dismissed === text ? [] : suggestCommands(text);
  const activeIndex = Math.min(active, Math.max(options.length - 1, 0));
  const activeId = options.length > 0 ? `${id}-${activeIndex}` : null;

  useEffect(() => {
    const dom = editor.view.dom;
    dom.setAttribute("aria-autocomplete", "list");

    if (activeId) {
      dom.setAttribute("aria-controls", id);
      dom.setAttribute("aria-activedescendant", activeId);
    } else {
      dom.removeAttribute("aria-controls");
      dom.removeAttribute("aria-activedescendant");
    }
  }, [editor, id, activeId]);

  function pick(option: CommandOption) {
    editor
      .chain()
      .focus()
      .setContent({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: `${option.name} ` }] }],
      })
      .focus("end")
      .run();
  }

  const actions = {
    next: () => setActive((activeIndex + 1) % options.length),
    previous: () => setActive((activeIndex + options.length - 1) % options.length),
    pick: () => options.slice(activeIndex, activeIndex + 1).forEach(pick),
    dismiss: () => setDismissed(text),
  };

  function handleKey(event: KeyboardEvent) {
    const action = options.length > 0 ? commandMenuAction(event) : undefined;

    if (!action) {
      return false;
    }

    actions[action]();

    return true;
  }

  return { id, options, activeIndex, pick, handleKey };
}

export function CommandMenu({
  menu,
}: {
  menu: Pick<ReturnType<typeof useCommandMenu>, "id" | "options" | "activeIndex" | "pick">;
}) {
  if (menu.options.length === 0) {
    return null;
  }

  return (
    <ul
      id={menu.id}
      role="listbox"
      aria-label="指令"
      className="absolute bottom-full left-0 z-10 mb-2 flex w-full max-w-sm flex-col gap-0.5 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
    >
      {menu.options.map((option, index) => (
        <li
          key={option.name}
          id={`${menu.id}-${index}`}
          role="option"
          aria-selected={index === menu.activeIndex}
          className={cn(
            "flex cursor-pointer flex-col gap-0.5 rounded-md px-2.5 py-1.5",
            index === menu.activeIndex && "bg-accent text-accent-foreground",
          )}
          onMouseDown={(event) => {
            event.preventDefault();
            menu.pick(option);
          }}
        >
          <span className="font-mono text-sm">{option.usage}</span>
          <span className="text-xs text-muted-foreground">{option.description}</span>
        </li>
      ))}
    </ul>
  );
}
