import { useEffect, useState } from "react";
import type { ToolApproval } from "../../shared/tool-approval";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Submission = "idle" | "sending" | "sent" | "failed";

function useNow(until: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (now >= until) {
      return;
    }

    const timer = setTimeout(() => setNow(Date.now()), Math.min(until - now, 60_000));

    return () => clearTimeout(timer);
  }, [now, until]);

  return now;
}

function ApprovalCard({
  approval,
  onDecide,
}: {
  approval: ToolApproval;
  onDecide: (approval: ToolApproval, approved: boolean) => Promise<void>;
}) {
  const [submission, setSubmission] = useState<Submission>("idle");
  const expiresAt = Date.parse(approval.expiresAt);
  const expired = useNow(expiresAt) >= expiresAt;

  async function decide(approved: boolean) {
    setSubmission("sending");

    try {
      await onDecide(approval, approved);
      setSubmission("sent");
    } catch {
      setSubmission("failed");
    }
  }

  return (
    <Card size="sm" aria-label={approval.presentation.title}>
      <CardHeader>
        <CardTitle>{approval.presentation.title}</CardTitle>
        <CardDescription>{approval.context.site} · Jira 預設可見性，並非私人留言</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">Issue</dt>
          <dd className="font-mono">{approval.arguments.issue_key}</dd>
          <dt className="text-muted-foreground">期限</dt>
          <dd>{new Date(expiresAt).toLocaleString()}</dd>
        </dl>
        <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 font-sans text-sm whitespace-pre-wrap">
          {approval.arguments.body}
        </pre>
        {submission === "sent" ? (
          <p role="status" className="text-muted-foreground">
            決策已送出，等待系統確認
          </p>
        ) : (
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={expired || submission !== "idle"}
              onClick={() => void decide(true)}
            >
              核准送出
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={expired || submission !== "idle"}
              onClick={() => void decide(false)}
            >
              拒絕
            </Button>
          </div>
        )}
        {submission === "failed" ? (
          <p role="alert" className="text-destructive">
            決策未確認或狀態已變更。請重新整理確認，勿重複送出。
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function ToolApprovals({
  approvals,
  onDecide,
}: {
  approvals: readonly ToolApproval[];
  onDecide: (approval: ToolApproval, approved: boolean) => Promise<void>;
}) {
  const pending = approvals.filter((approval) => approval.state === "pending");

  if (pending.length === 0) {
    return null;
  }

  return (
    <section aria-label="待批准的工具呼叫" className="flex flex-col gap-3">
      {pending.map((approval) => (
        <ApprovalCard key={approval.approvalId} approval={approval} onDecide={onDecide} />
      ))}
    </section>
  );
}
