import { CircleIcon, LoaderCircleIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { RunStatus } from "./types";

export function StatusBadge({
  status,
  runningLabel,
  idleLabel,
}: {
  status: RunStatus;
  runningLabel: string;
  idleLabel: string;
}) {
  const running = status !== "idle";
  const Icon = running ? LoaderCircleIcon : CircleIcon;

  return (
    <Badge variant={running ? "default" : "secondary"}>
      <Icon data-icon="inline-start" className={running ? "motion-safe:animate-spin" : undefined} />
      {status === "compacting" ? "compact..." : running ? runningLabel : idleLabel}
    </Badge>
  );
}
