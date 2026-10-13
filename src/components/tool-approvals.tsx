import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MessageScrollerItem } from "@/components/ui/message-scroller";
import type { ToolApprovalView } from "../../shared/tool-approval";

function argumentText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function ApprovalArguments({ args }: { args: ToolApprovalView["arguments"] }) {
  return (
    <dl className="flex flex-col gap-2">
      {Object.entries(args).map(([name, value]) => (
        <div key={name} className="flex flex-col gap-1">
          <dt className="text-muted-foreground text-sm">{name}</dt>
          <dd>
            <pre className="whitespace-pre-wrap break-words font-sans">{argumentText(value)}</pre>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function DecisionControls({
  approval,
  submitted,
  busy,
  expired,
  onDecide,
}: {
  approval: ToolApprovalView;
  submitted: boolean;
  busy: boolean;
  expired: boolean;
  onDecide: (approval: ToolApprovalView, approved: boolean) => void;
}) {
  if (submitted) {
    return <p>決策已送出，等待系統確認</p>;
  }

  return (
    <div className="flex gap-2">
      <Button disabled={busy || expired} onClick={() => onDecide(approval, true)}>
        核准送出
      </Button>
      <Button
        variant="outline"
        disabled={busy || expired}
        onClick={() => onDecide(approval, false)}
      >
        拒絕
      </Button>
    </div>
  );
}

export function ToolApprovals({
  approvals,
  onDecide,
}: {
  approvals: readonly ToolApprovalView[];
  onDecide: (approval: ToolApprovalView, approved: boolean) => Promise<void>;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<{ approvalId: string; message: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const submitting = useRef(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);

    return () => clearInterval(timer);
  }, []);

  async function decide(approval: ToolApprovalView, approved: boolean) {
    if (submitting.current) {
      return;
    }

    submitting.current = true;
    setPending(approval.approvalId);
    setError(null);

    try {
      await onDecide(approval, approved);
      setSubmitted((current) => new Set(current).add(approval.approvalId));
    } catch {
      setError({
        approvalId: approval.approvalId,
        message: "決策未確認或狀態已變更。請重新整理確認，勿重複送出。",
      });
    } finally {
      submitting.current = false;
      setPending(null);
    }
  }

  const pendingApprovals = approvals.filter((approval) => approval.state === "pending");

  return (
    <>
      {pendingApprovals.map((approval) => (
        <MessageScrollerItem
          key={approval.approvalId}
          messageId={`tool-approval-${approval.approvalId}`}
        >
          <Card aria-label="工具核准" data-approval-id={approval.approvalId}>
            <CardHeader>
              <CardTitle>{approval.presentation.title}</CardTitle>
              <p>{approval.presentation.destination}</p>
              {approval.presentation.warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <ApprovalArguments args={approval.arguments} />
              <p role="status">等待核准</p>
              <p>核准期限：{new Date(approval.expiresAt).toLocaleString()}</p>
              <DecisionControls
                approval={approval}
                submitted={submitted.has(approval.approvalId)}
                busy={pending !== null || error?.approvalId === approval.approvalId}
                expired={Date.parse(approval.expiresAt) <= now}
                onDecide={(target, approved) => void decide(target, approved)}
              />
              {error?.approvalId === approval.approvalId ? (
                <p role="alert">{error.message}</p>
              ) : null}
            </CardContent>
          </Card>
        </MessageScrollerItem>
      ))}
    </>
  );
}
