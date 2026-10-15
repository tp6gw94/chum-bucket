import { LoaderCircleIcon, SquareIcon } from "lucide-react";
import { useState } from "react";
import type { TestView } from "../../shared/testing";
import { cancelTesting } from "../lib/testing-api";
import { artifactLines, roleLabels, testingActivity, testingStatus } from "../lib/testing-views";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

function statusVariant(view: TestView) {
  if (view.outcome === "failed" || view.outcome === "deadline" || view.task?.status === "failed") {
    return "destructive" as const;
  }

  return view.state === "running" ? ("default" as const) : ("secondary" as const);
}

function CancelButton({ view, onUpdate }: { view: TestView; onUpdate: (view: TestView) => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    setPending(true);
    setError(null);

    try {
      const next = await cancelTesting(view.operationId, view.threadId);

      if (next) {
        onUpdate(next);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "取消失敗");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={pending || view.cancelRequested}
        onClick={() => void cancel()}
      >
        <SquareIcon data-icon="inline-start" />
        {view.cancelRequested ? "取消中" : "取消"}
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function TaskDetails({ view }: { view: TestView }) {
  const task = view.task;

  if (!task) {
    return null;
  }

  return (
    <>
      <p className="text-xs text-muted-foreground">
        模型 {task.modelSteps} 回合 · 工具 {task.toolCalls} 次
      </p>
      {task.reasonCode ? (
        <div role="alert" className="flex flex-col gap-1 text-xs text-destructive">
          <p className="font-mono">{task.reasonCode}</p>
          {task.issues.length ? (
            <ul className="list-disc pl-4">
              {task.issues.map((issue) => (
                <li key={issue} className="break-words">
                  {issue}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export function TestingPanel({
  view,
  onUpdate,
}: {
  view: TestView;
  onUpdate: (view: TestView) => void;
}) {
  const activity = testingActivity(view);
  const lines = artifactLines(view);

  return (
    <section
      aria-label={`${roleLabels[view.role]}進度`}
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{roleLabels[view.role]}</span>
        <Badge variant={statusVariant(view)}>
          {view.state === "running" ? (
            <LoaderCircleIcon data-icon="inline-start" className="motion-safe:animate-spin" />
          ) : null}
          {testingStatus(view)}
        </Badge>
        {activity ? <span className="text-xs text-muted-foreground">{activity}</span> : null}
      </div>
      <p className="line-clamp-2 text-xs text-muted-foreground">{view.summary}</p>
      <TaskDetails view={view} />
      {view.artifact ? (
        <div className="flex flex-col gap-1 text-xs">
          <p>
            產出 <span className="font-mono">{view.artifact.kind}</span> ·{" "}
            <span className="font-mono break-all">{view.artifact.ref}</span>
          </p>
          {lines.map((line) => (
            <p key={line} className="text-muted-foreground">
              {line}
            </p>
          ))}
        </div>
      ) : null}
      {view.state === "running" ? <CancelButton view={view} onUpdate={onUpdate} /> : null}
    </section>
  );
}
