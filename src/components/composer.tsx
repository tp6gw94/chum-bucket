import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { SendIcon } from "lucide-react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";
import {
  commandSuggestions,
  composerKeyAction,
  type ComposerCommand,
  type ComposerKeyAction,
} from "../composer-commands";
import type { SendResult } from "../hooks/use-threads";

const EDITOR_CLASS = cn(
  "min-h-14 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
  "data-disabled:cursor-not-allowed data-disabled:bg-input/50 data-disabled:opacity-50",
  "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
  "dark:bg-input/30 dark:data-disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
  "md:text-sm",
);

function CommandMenu({
  label,
  commands,
  active,
  onSelect,
}: {
  label: string;
  commands: readonly ComposerCommand[];
  active: number;
  onSelect: (command: ComposerCommand) => void;
}) {
  return (
    <ul
      role="listbox"
      aria-label="對話命令"
      id={`${label}-commands`}
      className="absolute bottom-full left-0 z-10 mb-1 flex w-full flex-col gap-0.5 rounded-lg border bg-popover p-1 text-sm shadow-md"
    >
      {commands.map((command, index) => (
        <li
          key={command.name}
          role="option"
          aria-selected={index === active}
          className="flex cursor-pointer flex-col rounded-md px-2 py-1.5 aria-selected:bg-accent"
          onMouseDown={(event) => {
            event.preventDefault();
            onSelect(command);
          }}
        >
          <span className="font-mono">/{command.name}</span>
          <span className="text-xs text-muted-foreground">{command.description}</span>
        </li>
      ))}
    </ul>
  );
}

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" size="sm" className="ml-auto" disabled={disabled || pending}>
      <SendIcon data-icon="inline-start" />
      {pending ? "送出中" : "送出"}
    </Button>
  );
}

type MenuState = {
  commands: ComposerCommand[];
  active: number;
  move: (active: number) => void;
  close: () => void;
  choose: (command: ComposerCommand) => void;
};

const RESULT_ERRORS: Record<Exclude<SendResult, "succeeded">, string> = {
  failed: "執行失敗，原文已保留。",
  uncertain: "結果尚未確認，請重新載入對話，原文已保留。",
};

function flag(setter: (value: boolean) => void, value: boolean) {
  return () => {
    setter(value);

    return false;
  };
}

function useCommandMenu(text: string) {
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const commands = dismissed ? [] : commandSuggestions({ text, focused, composing });
  const menu = useRef<MenuState>({
    commands,
    active,
    move: setActive,
    close: () => setDismissed(true),
    choose: () => {},
  });

  return {
    commands,
    menu,
    active: Math.min(active, Math.max(commands.length - 1, 0)),
    domEvents: {
      focus: flag(setFocused, true),
      blur: flag(setFocused, false),
      compositionstart: flag(setComposing, true),
      compositionend: flag(setComposing, false),
    },
    reset() {
      setDismissed(false);
      setActive(0);
    },
    dismiss: () => setDismissed(true),
  };
}

function runMenuAction(menu: MenuState, action: ComposerKeyAction) {
  if (action.type === "move") {
    menu.move(action.active);
  } else if (action.type === "close") {
    menu.close();
  } else if (action.type === "select") {
    menu.choose(menu.commands[action.index]!);
  }
}

function keyHandler(menu: { current: MenuState }, submit: () => void) {
  return (view: { composing: boolean }, event: KeyboardEvent) => {
    const action = composerKeyAction({
      key: event.key,
      shiftKey: event.shiftKey,
      isComposing: event.isComposing || view.composing,
      keyCode: event.keyCode,
      open: menu.current.commands.length > 0,
      active: menu.current.active,
      count: menu.current.commands.length,
    });

    if (action.type === "none") {
      return false;
    }

    event.preventDefault();

    if (action.type === "submit") {
      submit();
    } else {
      runMenuAction(menu.current, action);
    }

    return true;
  };
}

export function Composer({
  label,
  placeholder,
  hint,
  onSend,
  disabled = false,
  busy = false,
  className,
}: {
  label: string;
  placeholder: string;
  hint: string;
  onSend?: (text: string) => Promise<SendResult>;
  disabled?: boolean;
  busy?: boolean;
  className?: string;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const command = useCommandMenu(text);
  const ready = !disabled && !busy && Boolean(onSend);
  const canSubmit = ready && text.trim().length > 0;
  const errorId = `${label}-error`;

  const editor = useEditor({
    extensions: [StarterKit],
    content: "",
    editable: !disabled,
    editorProps: {
      attributes: {
        class: EDITOR_CLASS,
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": label,
        ...(error ? { "aria-invalid": "true", "aria-describedby": errorId } : {}),
      },
      handleDOMEvents: command.domEvents,
      handleKeyDown: keyHandler(command.menu, () => formRef.current?.requestSubmit()),
    },
    onUpdate: ({ editor }) => {
      setText(editor.getText({ blockSeparator: "\n" }));
      command.reset();
    },
  });

  useEffect(() => {
    editor.setEditable(!disabled);
    editor.view.dom.toggleAttribute("data-disabled", disabled);
  }, [editor, disabled]);

  async function send(value: string) {
    setError(null);

    try {
      const result = await onSend!(value);

      if (result === "succeeded") {
        editor.commands.clearContent();
      } else {
        setError(RESULT_ERRORS[result]);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "送出失敗，請稍後再試");
    }
  }

  async function submit() {
    if (canSubmit) {
      await send(text.trim());
    }
  }

  function choose(selected: ComposerCommand) {
    command.dismiss();

    if (ready) {
      void send(`/${selected.name}`);
    }
  }

  command.menu.current = {
    ...command.menu.current,
    commands: command.commands,
    active: command.active,
    choose,
  };

  return (
    <form
      ref={formRef}
      action={submit}
      className={cn("flex shrink-0 flex-col gap-2 bg-card px-4 py-3", className)}
    >
      <div className="relative">
        {command.commands.length > 0 ? (
          <CommandMenu
            label={label}
            commands={command.commands}
            active={command.active}
            onSelect={choose}
          />
        ) : null}
        {text.length === 0 ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-2 left-2.5 text-base text-muted-foreground md:text-sm"
          >
            {placeholder}
          </span>
        ) : null}
        <EditorContent editor={editor} />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{hint}</span>
        <SubmitButton disabled={!canSubmit} />
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
