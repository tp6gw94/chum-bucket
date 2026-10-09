import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { SendIcon } from "lucide-react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
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

const SEND_ERROR: Record<Exclude<SendResult, "succeeded">, string> = {
  failed: "執行失敗，原文已保留。",
  uncertain: "結果尚未確認，請重新載入對話，原文已保留。",
};

function thrownMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function composerAvailable(disabled: boolean, busy: boolean, hasSend: boolean): boolean {
  return !disabled && !busy && hasSend;
}

function composerCanSubmit(
  text: string,
  disabled: boolean,
  busy: boolean,
  hasSend: boolean,
): boolean {
  return text.trim().length > 0 && composerAvailable(disabled, busy, hasSend);
}

function errorAria(
  error: string | null,
  errorId: string,
): { "aria-invalid": "true"; "aria-describedby": string } | Record<string, never> {
  if (!error) {
    return {};
  }
  return {
    "aria-invalid": "true",
    "aria-describedby": errorId,
  };
}

type CommandInteraction = {
  suggestions: ReturnType<typeof commandSuggestions>;
  activeIndex: number;
  submitText(value: string): Promise<void>;
};

function handleCommandKeyDown(
  composing: boolean,
  event: KeyboardEvent,
  control: {
    interaction: CommandInteraction;
    form: HTMLFormElement | null;
    dismiss(): void;
    move(update: (index: number) => number): void;
  },
): boolean {
  const current = control.interaction;
  const action = composerKeyAction({
    key: event.key,
    shiftKey: event.shiftKey,
    isComposing: event.isComposing,
    keyCode: event.keyCode,
    composing,
    hasSuggestions: current.suggestions.length > 0,
  });
  if (action === "none") {
    return false;
  }
  event.preventDefault();
  const move = (offset: number) =>
    control.move(
      (index) => (index + offset + current.suggestions.length) % current.suggestions.length,
    );
  const handlers = {
    dismiss: control.dismiss,
    previous: () => move(-1),
    next: () => move(1),
    select: () =>
      void current.submitText(
        `/${current.suggestions[current.activeIndex % current.suggestions.length]!.name}`,
      ),
    submit: () => control.form?.requestSubmit(),
  };
  handlers[action]();
  return true;
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

function commandAria(
  suggestions: CommandInteraction["suggestions"],
  activeIndex: number,
  listId: string,
): Record<string, string> {
  if (suggestions.length === 0) {
    return {};
  }
  return {
    "aria-controls": listId,
    "aria-haspopup": "listbox",
    "aria-activedescendant": `${listId}-${suggestions[activeIndex % suggestions.length]!.name}`,
  };
}

async function submitComposerText(
  value: string,
  control: {
    send?: (text: string) => Promise<SendResult>;
    disabled: boolean;
    busy: boolean;
    clear(): void;
    dismiss(): void;
    error(message: string | null): void;
  },
) {
  if (!control.send || !value.trim() || control.disabled || control.busy) {
    return;
  }
  control.error(null);
  control.dismiss();
  try {
    const result = await control.send(value.trim());
    if (result === "succeeded") {
      control.clear();
      return;
    }
    control.error(SEND_ERROR[result]);
  } catch (cause) {
    control.error(thrownMessage(cause, "送出失敗，請稍後再試"));
  }
}

function CommandMenu({
  suggestions,
  activeIndex,
  listId,
  onSelect,
}: {
  suggestions: CommandInteraction["suggestions"];
  activeIndex: number;
  listId: string;
  onSelect(text: string): void;
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
            id={`${listId}-${command.name}`}
            type="button"
            role="option"
            aria-selected={index === activeIndex % suggestions.length}
            variant={index === activeIndex % suggestions.length ? "secondary" : "ghost"}
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

function ComposerError({ message, id }: { message: string | null; id: string }) {
  if (!message) {
    return null;
  }
  return (
    <p id={id} role="alert" className="text-xs text-destructive">
      {message}
    </p>
  );
}

function ComposerPlaceholder({ visible, placeholder }: { visible: boolean; placeholder: string }) {
  if (!visible) {
    return null;
  }
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute top-2 left-2.5 text-base text-muted-foreground md:text-sm"
    >
      {placeholder}
    </span>
  );
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
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [selection, setSelection] = useState({ cursor: 0, selected: false });
  const [activeIndex, setActiveIndex] = useState(0);
  const suggestions = commandSuggestions({
    text,
    ...selection,
    focused: focused && composerAvailable(disabled, busy, Boolean(onSend)),
    composing,
    dismissed,
  });
  const listId = `${label}-commands`;
  const interaction = useRef({ suggestions, activeIndex, submitText: async (_text: string) => {} });

  const canSubmit = composerCanSubmit(text, disabled, busy, Boolean(onSend));
  const errorId = `${label}-error`;

  const editor = useEditor({
    extensions: [StarterKit.configure({ link: false })],
    content: "",
    editable: !disabled,
    editorProps: {
      attributes: {
        class: EDITOR_CLASS,
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": label,
        ...errorAria(error, errorId),
        ...commandAria(suggestions, activeIndex, listId),
      },
      handleDOMEvents: {
        compositionstart: () => {
          setComposing(true);
          return false;
        },
        compositionend: () => {
          setComposing(false);
          return false;
        },
      },
      handleKeyDown: (view, event) =>
        handleCommandKeyDown(view.composing, event, {
          interaction: interaction.current,
          form: formRef.current,
          dismiss: () => setDismissed(true),
          move: setActiveIndex,
        }),
    },
    onUpdate: ({ editor }) => {
      setText(editor.getText({ blockSeparator: "\n" }));
      setSelection({
        cursor: editor.state.doc.textBetween(0, editor.state.selection.from, "\n").length,
        selected: !editor.state.selection.empty,
      });
      setDismissed(false);
      setActiveIndex(0);
    },
    onSelectionUpdate: ({ editor }) => {
      setSelection({
        cursor: editor.state.doc.textBetween(0, editor.state.selection.from, "\n").length,
        selected: !editor.state.selection.empty,
      });
    },
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
  });

  useEffect(() => {
    editor.setEditable(!disabled);
    editor.view.dom.toggleAttribute("data-disabled", disabled);
  }, [editor, disabled]);

  const submitText = (value: string) =>
    submitComposerText(value, {
      send: onSend,
      disabled,
      busy,
      clear: () => editor.commands.clearContent(),
      dismiss: () => setDismissed(true),
      error: setError,
    });

  interaction.current = { suggestions, activeIndex, submitText };

  return (
    <form
      ref={formRef}
      action={() => submitText(text)}
      className={cn("flex shrink-0 flex-col gap-2 bg-card px-4 py-3", className)}
    >
      <div className="relative">
        <CommandMenu
          suggestions={suggestions}
          activeIndex={activeIndex}
          listId={listId}
          onSelect={(value) => void submitText(value)}
        />
        <ComposerPlaceholder visible={text.length === 0} placeholder={placeholder} />
        <EditorContent editor={editor} />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{hint}</span>
        <SubmitButton disabled={!canSubmit} />
      </div>
      <ComposerError message={error} id={errorId} />
    </form>
  );
}
