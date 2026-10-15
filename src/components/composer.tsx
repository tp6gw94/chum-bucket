import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { SendIcon } from "lucide-react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";
import {
  causeMessage,
  parseComposerCommand,
  resultError,
  type ComposerCommand,
} from "../composer-commands";
import { useCommandMenu } from "../hooks/use-command-menu";
import type { SendResult } from "../hooks/use-threads";
import { CommandMenu } from "./command-menu";

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

export function Composer({
  label,
  placeholder,
  hint,
  onSend,
  onCommand,
  disabled = false,
  busy = false,
  className,
}: {
  label: string;
  placeholder: string;
  hint: string;
  onSend?: (text: string) => Promise<SendResult>;
  onCommand?: (command: ComposerCommand) => Promise<SendResult>;
  disabled?: boolean;
  busy?: boolean;
  className?: string;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const ready = !disabled && !busy && Boolean(onSend);
  const canSubmit = text.trim().length > 0 && ready;
  const errorId = `${label}-error`;
  const menu = useCommandMenu({
    text,
    enabled: ready,
    available: Boolean(onCommand),
    onSelect: (command) => void runCommand(command),
    onSubmit: () => formRef.current?.requestSubmit(),
  });

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
        ...(error
          ? {
              "aria-invalid": "true",
              "aria-describedby": errorId,
            }
          : {}),
        ...menu.attributes,
      },
      handleKeyDown: (view, event) => menu.handleKey(event, view.composing),
      handleDOMEvents: menu.domEvents,
    },
    onFocus: menu.onFocus,
    onBlur: menu.onBlur,
    onUpdate: ({ editor }) => {
      setText(editor.getText({ blockSeparator: "\n" }));
      menu.setActive(0);
    },
  });

  useEffect(() => {
    editor.setEditable(!disabled);
    editor.view.dom.toggleAttribute("data-disabled", disabled);
  }, [editor, disabled]);

  async function runCommand(command: ComposerCommand) {
    if (!onCommand) {
      return;
    }

    setError(null);

    try {
      const result = await onCommand(command);

      if (result === "uncertain") {
        setError(resultError(result));
      } else {
        editor.commands.clearContent();
      }
    } catch (cause) {
      setError(causeMessage(cause));
    }
  }

  async function submit() {
    if (!canSubmit || !onSend) {
      return;
    }

    const command = parseComposerCommand(text);

    if (command && onCommand) {
      await runCommand(command);

      return;
    }

    setError(null);

    try {
      const failure = resultError(await onSend(text.trim()));

      if (failure) {
        setError(failure);
      } else {
        editor.commands.clearContent();
      }
    } catch (cause) {
      setError(causeMessage(cause));
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
          id={menu.listId}
          commands={menu.suggestions}
          highlighted={menu.highlighted}
          onHighlight={menu.setActive}
          onSelect={(command) => void runCommand(command)}
        />
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
