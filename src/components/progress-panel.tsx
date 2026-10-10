import { CircleIcon, LoaderCircleIcon } from "lucide-react";
import { cn } from "cn";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RunStatus } from "./types";

export function ProgressPanel({
  status,
  label,
  lines,
}: {
  status: RunStatus;
  label: string;
  lines: string[];
}) {
  if (lines.length === 0) {
    return null;
  }

  const running = status === "running";

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {running ? <LoaderCircleIcon className="motion-safe:animate-spin" /> : <CircleIcon />}
          {`${label}（${running ? "持續執行中" : "已結束"}）`}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1 font-mono text-xs text-muted-foreground">
        {lines.map((line, index) => (
          <span
            key={line}
            className={cn("flex gap-2", index === lines.length - 1 && "text-foreground")}
          >
            <span aria-hidden="true">▸</span>
            <span>{line}</span>
          </span>
        ))}
      </CardContent>
    </Card>
  );
}
