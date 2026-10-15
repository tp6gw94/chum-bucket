import { CheckIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import { useState } from "react";
import type {
  ToolApproval,
  ToolApprovalDecision,
  ToolApprovals,
  ToolApprovalState,
} from "../../shared/tool-approval";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export type DecideToolApproval = (
  approvalId: string,
  decision: ToolApprovalDecision,
) => Promise<void>;

const stateLabels: Record<ToolApprovalState, string> = {
  pending: "等待批准",
  posted: "已送出",
  rejected: "已拒絕",
  failed: "送出失敗",
  cancelled: "已取消",
};

function stateVariant(state: ToolApprovalState) {
  if (state === "failed") {
    return "destructive" as const;
  }

  return state === "pending" ? ("default" as const) : ("secondary" as const);
}

function ApprovalActions({
  approval,
  onDecide,
}: {
  approval: ToolApproval;
  onDecide: DecideToolApproval;
}) {
  const [pending, setPending] = useState<ToolApprovalDecision["decision"] | null>(null);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: ToolApprovalDecision) {
    setPending(decision.decision);
    setError(null);

    try {
      await onDecide(approval.id, decision);
      setSent(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "送出決定失敗");
    } finally {
      setPending(null);
    }
  }

  if (sent) {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        已送出決定，等待處理…
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        disabled={pending !== null}
        onClick={() => void decide({ decision: "approve" })}
      >
        {pending === "approve" ? (
          <LoaderCircleIcon data-icon="inline-start" className="motion-safe:animate-spin" />
        ) : (
          <CheckIcon data-icon="inline-start" />
        )}
        批准並送出
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={pending !== null}
        onClick={() => void decide({ decision: "reject" })}
      >
        {pending === "reject" ? (
          <LoaderCircleIcon data-icon="inline-start" className="motion-safe:animate-spin" />
        ) : (
          <XIcon data-icon="inline-start" />
        )}
        拒絕
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function ToolApprovalCard({
  approval,
  onDecide,
}: {
  approval: ToolApproval;
  onDecide?: DecideToolApproval;
}) {
  return (
    <section
      aria-label={`Jira 留言批准：${approval.params.issue_key}`}
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Jira 留言</span>
        <span className="font-mono text-xs">{approval.params.issue_key}</span>
        <Badge variant={stateVariant(approval.state)}>{stateLabels[approval.state]}</Badge>
      </div>
      <p className="max-h-60 overflow-y-auto rounded-md bg-muted/50 px-3 py-2 text-sm break-words whitespace-pre-wrap">
        {approval.params.body}
      </p>
      {approval.commentId ? (
        <p className="text-xs text-muted-foreground">
          留言 ID <span className="font-mono">{approval.commentId}</span>
        </p>
      ) : null}
      {approval.reason ? (
        <p
          className={
            approval.state === "failed"
              ? "text-xs break-words text-destructive"
              : "text-xs break-words text-muted-foreground"
          }
        >
          {approval.reason}
        </p>
      ) : null}
      {approval.state === "pending" && onDecide ? (
        <ApprovalActions approval={approval} onDecide={onDecide} />
      ) : null}
    </section>
  );
}

export function ToolApprovalList({
  approvals,
  requestKey,
  onDecide,
}: {
  approvals: ToolApprovals;
  requestKey: string;
  onDecide?: DecideToolApproval;
}) {
  return Object.values(approvals)
    .filter((approval) => approval.requestKey === requestKey)
    .map((approval) => (
      <ToolApprovalCard key={approval.id} approval={approval} onDecide={onDecide} />
    ));
}
