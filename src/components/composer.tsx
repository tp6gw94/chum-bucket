import { useEffect, useId, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { SendIcon } from "lucide-react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { SendResult } from "../hooks/use-threads";
import { commandSuggestions, composerKeyAction } from "../composer-commands";

const EDITOR_CLASS = cn(
  "min-h-14 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
  "data-disabled:cursor-not-allowed data-disabled:bg-input/50 data-disabled:opacity-50",
  "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
  "dark:bg-input/30 dark:data-disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
  "md:text-sm",
);

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" size="sm" className="ml-auto" disabled={disabled || pending}>
      <SendIcon data-icon="inline-start" />
      {pending ? "送出中" : "送出"}
    </Button>
  );
}

type Suggestion = ReturnType<typeof commandSuggestions>[number];

function CommandMenu({
  suggestions,
  activeIndex,
  listId,
  onSelect,
}: {
  suggestions: Suggestion[];
  activeIndex: number;
  listId: string;
  onSelect: (text: string) => void;
}) {
  if (suggestions.length === 0) {
    return null;
  }

  return (
    <Card size="sm" className="absolute bottom-full mb-2 w-full">
      <CardHeader>
        <CardTitle>對話命令</CardTitle>
      </CardHeader>
      <CardContent id={listId} role="listbox" aria-label="對話命令" className="flex flex-col gap-1">
        {suggestions.map((command, index) => (
          <Button
            key={command.name}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            variant={index === activeIndex ? "secondary" : "ghost"}
            tabIndex={-1}
            className="h-auto justify-start"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => onSelect(`/${command.name}`)}
          >
            <span className="flex flex-col items-start gap-1">
              <span>/{command.name}</span>
              <span>{command.description}</span>
            </span>
          </Button>
        ))}
      </CardContent>
    </Card>
  );
}

function useCommandMenu(text: string) {
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();
  const suggestions = commandSuggestions({ text, focused, composing, dismissed });
  const current = useRef({ suggestions, activeIndex });
  current.current = { suggestions, activeIndex };

  return {
    suggestions,
    activeIndex,
    listId,
    current,
    setFocused,
    setComposing,
    dismiss: () => setDismissed(true),
    reset: () => {
      setDismissed(false);
      setActiveIndex(0);
    },
    move: (step: number) => {
      const count = current.current.suggestions.length;
      setActiveIndex((index) => (index + step + count) % count);
    },
  };
}

type CommandMenuState = ReturnType<typeof useCommandMenu>;

function handleCommandKey(
  menu: CommandMenuState,
  event: KeyboardEvent,
  composing: boolean,
  actions: { choose: (command: string) => void; submit: () => void },
) {
  const { suggestions, activeIndex } = menu.current.current;
  const action = composerKeyAction({
    key: event.key,
    shiftKey: event.shiftKey,
    isComposing: event.isComposing || composing,
    keyCode: event.keyCode,
    hasSuggestions: suggestions.length > 0,
  });

  if (action === "none") {
    return false;
  }

  event.preventDefault();

  if (action === "dismiss") {
    menu.dismiss();
  } else if (action === "previous" || action === "next") {
    menu.move(action === "next" ? 1 : -1);
  } else if (action === "select") {
    actions.choose(`/${suggestions[activeIndex]!.name}`);
  } else {
    actions.submit();
  }

  return true;
}

function resultError(result: SendResult) {
  if (result === "succeeded") {
    return null;
  }

  return result === "failed"
    ? "執行失敗，原文已保留。"
    : "結果尚未確認，請重新載入對話，原文已保留。";
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
  const menu = useCommandMenu(text);
  const canSubmit = text.trim().length > 0 && !disabled && !busy && Boolean(onSend);
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
      handleDOMEvents: {
        compositionstart: () => {
          menu.setComposing(true);

          return false;
        },
        compositionend: () => {
          menu.setComposing(false);

          return false;
        },
      },
      handleKeyDown: (view, event) =>
        handleCommandKey(menu, event, view.composing, {
          choose,
          submit: () => formRef.current?.requestSubmit(),
        }),
    },
    onFocus: () => menu.setFocused(true),
    onBlur: () => menu.setFocused(false),
    onUpdate: ({ editor }) => {
      setText(editor.getText({ blockSeparator: "\n" }));
      menu.reset();
    },
  });

  function choose(command: string) {
    editor.commands.setContent(command);
    setText(command);
    menu.dismiss();
    queueMicrotask(() => formRef.current?.requestSubmit());
  }

  useEffect(() => {
    editor.setEditable(!disabled);
    editor.view.dom.toggleAttribute("data-disabled", disabled);
  }, [editor, disabled]);

  async function submit() {
    const value = editor.getText({ blockSeparator: "\n" }).trim();

    if (!value || disabled || busy || !onSend) {
      return;
    }

    setError(null);

    try {
      const result = await onSend(value);
      setError(resultError(result));

      if (result === "succeeded") {
        editor.commands.clearContent();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "送出失敗，請稍後再試");
    }
  }

  return (
    <form
      ref={formRef}
      action={submit}
      className={cn("flex shrink-0 flex-col gap-2 bg-card px-4 py-3", className)}
    >
      <div className="relative">
        <CommandMenu
          suggestions={menu.suggestions}
          activeIndex={menu.activeIndex}
          listId={menu.listId}
          onSelect={choose}
        />
        <span
          aria-hidden="true"
          hidden={text.length > 0}
          className="pointer-events-none absolute top-2 left-2.5 text-base text-muted-foreground md:text-sm"
        >
          {placeholder}
        </span>
        <EditorContent editor={editor} />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{hint}</span>
        <SubmitButton disabled={!canSubmit} />
      </div>
      <p id={errorId} role="alert" hidden={!error} className="text-xs text-destructive">
        {error}
      </p>
    </form>
  );
}
