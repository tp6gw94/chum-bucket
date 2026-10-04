import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { SendIcon } from "lucide-react";
import { cn } from "cn";

import { Button } from "@/components/ui/button";
import type { SendResult } from "../hooks/use-threads";

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

  const canSubmit = text.trim().length > 0 && !disabled && !busy && Boolean(onSend);
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
        ...(error
          ? {
              "aria-invalid": "true",
              "aria-describedby": errorId,
            }
          : {}),
      },
      handleKeyDown: (view, event) => {
        if (event.key !== "Enter" || event.shiftKey) {
          return false;
        }
        if (event.isComposing || view.composing) {
          return false;
        }
        event.preventDefault();
        formRef.current?.requestSubmit();
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      setText(editor.getText({ blockSeparator: "\n" }));
    },
  });

  useEffect(() => {
    editor.setEditable(!disabled);
    editor.view.dom.toggleAttribute("data-disabled", disabled);
  }, [editor, disabled]);

  async function submit() {
    if (!canSubmit || !onSend) {
      return;
    }
    setError(null);
    try {
      const result = await onSend(text.trim());
      if (result === "succeeded") {
        editor.commands.clearContent();
      } else {
        setError(
          result === "failed"
            ? "執行失敗，原文已保留。"
            : "結果尚未確認，請重新載入對話，原文已保留。",
        );
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
