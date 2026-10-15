import { useEffect, useState } from "react";
import { CheckIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { ToolApproval } from "../../shared/tool-approval";

type Delivery = "idle" | "sending" | "sent" | "failed";

const DELIVERY_TEXT: Partial<Record<Delivery, string>> = {
  sent: "決策已送出，等待系統確認",
  failed: "決策未確認或狀態已變更。請重新整理確認，勿重複送出。",
};

function useExpired(expiresAt: string): boolean {
  const deadline = Date.parse(expiresAt);
  const [expired, setExpired] = useState(() => Date.now() >= deadline);

  useEffect(() => {
    if (expired) {
      return undefined;
    }

    const timer = setTimeout(() => setExpired(true), Math.max(0, deadline - Date.now()));

    return () => clearTimeout(timer);
  }, [deadline, expired]);

  return expired;
}

function ApprovalActions({
  delivery,
  disabled,
  onDecide,
}: {
  delivery: Delivery;
  disabled: boolean;
  onDecide: (approved: boolean) => void;
}) {
  const message = DELIVERY_TEXT[delivery];

  if (message) {
    return (
      <p role={delivery === "failed" ? "alert" : "status"} className="text-xs">
        {message}
      </p>
    );
  }

  return (
    <div className="flex justify-end gap-2">
      <Button variant="outline" size="sm" disabled={disabled} onClick={() => onDecide(false)}>
        <XIcon data-icon="inline-start" />
        拒絕
      </Button>
      <Button size="sm" disabled={disabled} onClick={() => onDecide(true)}>
        <CheckIcon data-icon="inline-start" />
        核准送出
      </Button>
    </div>
  );
}

function ApprovalCard({
  approval,
  onDecide,
}: {
  approval: ToolApproval;
  onDecide: (approval: ToolApproval, approved: boolean) => Promise<void>;
}) {
  const [delivery, setDelivery] = useState<Delivery>("idle");
  const expired = useExpired(approval.request.expiresAt);
  const { arguments: args, context, expiresAt } = approval.request;
  const headingId = `approval-${approval.request.approvalId}`;

  async function decide(approved: boolean) {
    setDelivery("sending");

    try {
      await onDecide(approval, approved);
      setDelivery("sent");
    } catch {
      setDelivery("failed");
    }
  }

  return (
    <Card className="flex flex-col gap-2 p-3" aria-labelledby={headingId}>
      <h3 id={headingId} className="text-sm font-semibold">
        Jira 留言核准 · {args.issue_key}
      </h3>
      <p className="text-xs text-muted-foreground">
        {context.site} · Jira 預設可見性，並非私人留言
      </p>
      <dl className="flex flex-col gap-1 text-sm">
        <dt className="text-xs text-muted-foreground">issue_key</dt>
        <dd className="font-mono">{args.issue_key}</dd>
        <dt className="text-xs text-muted-foreground">body</dt>
        <dd className="whitespace-pre-wrap rounded-md border bg-background p-2">{args.body}</dd>
      </dl>
      <p className="text-xs text-muted-foreground">
        期限：<time dateTime={expiresAt}>{new Date(expiresAt).toLocaleString()}</time>
        {expired ? "（已過期）" : null}
      </p>
      <ApprovalActions
        delivery={delivery}
        disabled={expired || delivery === "sending"}
        onDecide={(approved) => void decide(approved)}
      />
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
    <section aria-label="待核准的工具呼叫" className="flex flex-col gap-2">
      {pending.map((approval) => (
        <ApprovalCard key={approval.request.approvalId} approval={approval} onDecide={onDecide} />
      ))}
    </section>
  );
}
