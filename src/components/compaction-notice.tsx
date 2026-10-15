import { cn } from "cn";

import type { CompactionNotice as Notice } from "../hooks/use-threads";

export function CompactionNotice({ notice }: { notice: Notice | null | undefined }) {
  if (!notice) {
    return null;
  }

  const failed = notice.state === "failed";

  return (
    <p
      role={failed ? "alert" : "status"}
      className={cn("px-4 py-2 text-sm", failed ? "text-destructive" : "text-muted-foreground")}
    >
      {notice.text}
    </p>
  );
}
