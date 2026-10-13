import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ToolApprovals } from "../../../src/components/tool-approvals";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import type { ApprovalState, ToolApprovalView } from "../../../shared/tool-approval";

const THREAD_ID = "6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const FAR_FUTURE = "2099-01-01T00:00:00.000Z";

function approval(
  approvalId: string,
  state: ApprovalState,
  body: string,
  receipt: ToolApprovalView["receipt"] = null,
): ToolApprovalView {
  return {
    approvalId,
    threadId: THREAD_ID,
    toolCallId: `call-${approvalId}`,
    tool: "jira_add_comment",
    arguments: { issue_key: "ABC-1", body },
    presentation: { title: "新增 Jira 留言", destination: "ABC-1", warnings: [] },
    digest: "d".repeat(64),
    state,
    expiresAt: FAR_FUTURE,
    receipt,
  };
}

function renderApprovals(approvals: readonly ToolApprovalView[]): string {
  return renderToStaticMarkup(
    <MessageScrollerProvider>
      <MessageScroller>
        <MessageScrollerViewport>
          <MessageScrollerContent>
            <ToolApprovals approvals={approvals} onDecide={async () => {}} />
          </MessageScrollerContent>
        </MessageScrollerViewport>
      </MessageScroller>
    </MessageScrollerProvider>,
  );
}

test("only the pending approval renders", () => {
  const html = renderApprovals([
    approval("00000000-0000-4000-8000-000000000001", "pending", "待核准的留言內容"),
    approval("00000000-0000-4000-8000-000000000002", "approved", "已核准的留言內容"),
    approval("00000000-0000-4000-8000-000000000003", "rejected", "已拒絕的留言內容"),
    approval("00000000-0000-4000-8000-000000000004", "succeeded", "已送出的留言內容", {
      externalId: "JIRA-COMMENT-77",
    }),
  ]);

  assert.equal(html.match(/aria-label="工具核准"/g)?.length, 1);
  assert.match(html, /data-approval-id="00000000-0000-4000-8000-000000000001"/);
  assert.match(html, /待核准的留言內容/);
  assert.match(html, /核准送出<\/button>/);
  assert.match(html, /拒絕<\/button>/);
  assert.doesNotMatch(html, /已核准的留言內容/);
  assert.doesNotMatch(html, /已拒絕的留言內容/);
  assert.doesNotMatch(html, /已送出的留言內容/);
  assert.doesNotMatch(html, /JIRA-COMMENT-77/);
});
