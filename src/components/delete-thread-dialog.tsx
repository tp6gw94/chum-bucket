import { useState } from "react";
import { Trash2Icon } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { type ThreadSummary } from "./types";

export function DeleteThreadDialog({
  thread,
  open,
  onOpenChange,
  onConfirm,
}: {
  thread: ThreadSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (thread: ThreadSummary) => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);

  async function confirm() {
    setDeleting(true);

    try {
      await onConfirm(thread);
    } finally {
      setDeleting(false);
      onOpenChange(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !deleting && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <Trash2Icon />
          </AlertDialogMedia>
          <AlertDialogTitle>刪除這個對話？</AlertDialogTitle>
          <AlertDialogDescription>
            「{thread.title}」的所有訊息會一併刪除，刪除後無法復原。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleting}
            onClick={() => void confirm()}
          >
            {deleting ? "刪除中…" : "刪除"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
