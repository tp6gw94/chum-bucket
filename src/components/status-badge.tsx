import { CircleIcon, LoaderCircleIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { RunStatus } from "./types";

type StatusPresentation =
  | Readonly<{
      Icon: typeof CircleIcon;
      variant: "default" | "secondary";
      className: string | undefined;
      labelKey: "runningLabel" | "idleLabel";
    }>
  | Readonly<{
      Icon: typeof CircleIcon;
      variant: "default" | "secondary";
      className: string | undefined;
      label: string;
    }>;

const STATUS_PRESENTATION: Record<RunStatus, StatusPresentation> = {
  running: {
    Icon: LoaderCircleIcon,
    variant: "default",
    className: "motion-safe:animate-spin",
    labelKey: "runningLabel",
  },
  compacting: {
    Icon: LoaderCircleIcon,
    variant: "default",
    className: "motion-safe:animate-spin",
    label: "compact...",
  },
  idle: {
    Icon: CircleIcon,
    variant: "secondary",
    className: undefined,
    labelKey: "idleLabel",
  },
};

export function StatusBadge({
  status,
  runningLabel,
  idleLabel,
}: {
  status: RunStatus;
  runningLabel: string;
  idleLabel: string;
}) {
  const presentation = STATUS_PRESENTATION[status];
  const Icon = presentation.Icon;
  const label =
    "label" in presentation
      ? presentation.label
      : { runningLabel, idleLabel }[presentation.labelKey];

  return (
    <Badge variant={presentation.variant}>
      <Icon data-icon="inline-start" className={presentation.className} />
      {label}
    </Badge>
  );
}
