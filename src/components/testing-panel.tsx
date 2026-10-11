import { useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  Acceptance,
  Action,
  ArtifactRef,
  Coverage,
  DesignReference,
  Judgment,
  PlanCheck,
  ProgressRow,
  PublicCheckResult,
  PublicEvidence,
  PublicPlan,
  PublicRequirements,
  PublicTestReport,
  RoleId,
  Source,
  TaskOutcome,
  TestRunId,
  TestView,
  Tolerance,
  ToolActivityView,
} from "../../shared/testing";
import {
  ROLE_ORDER,
  beginCancelRequest,
  cancelButtonDisabled,
  cancelRequestFor,
  cancelRequestMessage,
  orderedRows,
  settleCancelRequest,
  type CancelRequest,
  type CancelTracker,
} from "../lib/testing-view";

const ROLE_LABELS: Record<RoleId, string> = {
  atlassian: "Atlassian",
  planner: "Test Planner",
  ac: "Test AC",
  ui: "Test UI",
};

const OUTCOME_LABELS: Record<TaskOutcome, string> = {
  completed: "已完成",
  failed: "失敗",
  cancelled: "已取消",
  missing: "缺漏",
  incompatible: "不相容",
  timed_out: "逾時",
};

const JUDGMENT_LABELS: Record<Judgment, string> = {
  simulated_pass: "模擬符合",
  simulated_fail: "模擬差異",
  simulated_blocked: "模擬受阻",
};

const REASON_LABELS: Record<string, string> = {
  mock_only: "模擬資料",
  requirements_missing: "需求缺失",
  plan_missing: "計畫缺失",
  coverage_incomplete: "覆蓋不完整",
  requirements_unresolved: "需求尚未解決",
  sources_unresolved: "來源尚未解決",
  ac_results_missing: "AC 結果缺失",
  ui_results_missing: "UI 結果缺失",
  blocked_evidence: "證據受阻",
  root_completed: "執行完成",
  root_failed: "執行失敗",
  root_cancelled: "執行已取消",
  root_missing: "執行缺漏",
  root_incompatible: "執行不相容",
  root_timed_out: "執行逾時",
};

const ROLE_ISSUE_LABELS: Record<string, string> = {
  failed: "失敗",
  cancelled: "已取消",
  missing: "缺漏",
  incompatible: "不相容",
  timed_out: "逾時",
  waiting: "等待中",
  running: "執行中",
  tool_activity: "工具活動",
  cancelling: "取消中",
  unexpected_not_required: "不應為不需要",
};

const ROW_STATUS_LABELS: Record<Exclude<ProgressRow["status"], "waiting" | "terminal">, string> = {
  reused: "已重用",
  not_required: "不需要",
  undispatched: "未派工",
  running: "執行中",
  tool_activity: "工具活動",
  cancelling: "取消中",
};

function rowStatusLabel(row: ProgressRow): string {
  if (row.status === "waiting") {
    return row.reason === "dependency" ? "等待相依" : "等待派工";
  }

  if (row.status === "terminal") {
    return OUTCOME_LABELS[row.outcome];
  }

  return ROW_STATUS_LABELS[row.status];
}

function rowBadgeVariant(row: ProgressRow): "default" | "secondary" | "outline" | "destructive" {
  switch (row.status) {
    case "running":
    case "tool_activity":
    case "cancelling":
      return "default";
    case "terminal":
      return row.outcome === "completed" ? "secondary" : "destructive";
    default:
      return "outline";
  }
}

function undispatchedReasonLabel(
  reason: Extract<ProgressRow, { status: "undispatched" }>["reason"],
): string {
  switch (reason) {
    case "cancelled":
      return "已取消";
    case "dependency_blocked":
      return "相依未滿足";
    case "incompatible":
      return "不相容";
    case "timed_out":
      return "逾時";
  }
}

function runningActivityLabel(activity: "model" | "tool" | null): string {
  if (activity === "model") {
    return "模型推理中。";
  }

  if (activity === "tool") {
    return "工具執行中。";
  }

  return "準備中。";
}

function roleStatusSummary(role: RoleId, row: ProgressRow): string {
  switch (row.status) {
    case "running": {
      const activity =
        row.activity === "model" ? "模型推理中" : row.activity === "tool" ? "工具執行中" : "準備中";

      return `${ROLE_LABELS[role]}：執行中（${activity}）`;
    }

    case "tool_activity":
      return `${ROLE_LABELS[role]}：工具活動${row.active.length ? `（${row.active.length} 個工具）` : ""}`;
    case "cancelling":
      return `${ROLE_LABELS[role]}：取消中，尚未確認停止`;
    default:
      return `${ROLE_LABELS[role]}：${rowStatusLabel(row)}`;
  }
}

function visibleRows(view: TestView): readonly (readonly [RoleId, ProgressRow])[] {
  return view.task
    ? [[view.task.role, view.progress.rows[view.task.role]]]
    : orderedRows(view.progress);
}

function progressStatusSummary(view: TestView, request: CancelRequest): string {
  const lifecycle =
    view.state === "finished"
      ? "測試已結束"
      : view.state === "cancelling"
        ? "伺服器已接受取消，尚未確認停止"
        : "測試進行中";
  const roleSummary = visibleRows(view)
    .map(([role, row]) => roleStatusSummary(role, row))
    .join("；");
  const parts = [lifecycle, roleSummary];
  const cancelMessage =
    request.status === "failed" ? "取消要求失敗" : cancelRequestMessage(request);

  if (cancelMessage) {
    parts.push(cancelMessage);
  }

  return parts.join("；");
}

function reasonLabel(reason: string): string {
  const known = Object.hasOwn(REASON_LABELS, reason) ? REASON_LABELS[reason] : undefined;

  if (known) {
    return known;
  }

  const roleMatch = /^role_([a-z]+)_(.+)$/.exec(reason);

  if (roleMatch) {
    const role = ROLE_ORDER.find((candidate) => candidate === roleMatch[1]);

    if (role) {
      const issue = Object.hasOwn(ROLE_ISSUE_LABELS, roleMatch[2])
        ? ROLE_ISSUE_LABELS[roleMatch[2]]
        : undefined;

      return `${ROLE_LABELS[role]}：${issue ?? roleMatch[2]}`;
    }
  }

  return reason;
}

function toleranceText(tolerance: Tolerance): string {
  return tolerance.kind === "exact"
    ? "精確"
    : `數值（${tolerance.unit}，最大差異 ${tolerance.maxDelta}）`;
}

function designReferenceText(reference: DesignReference): string {
  return `Figma 檔案 ${reference.fileKey}，節點 ${reference.nodeId}`;
}

function actionText(action: Action): string {
  switch (action.kind) {
    case "navigate":
      return `前往 ${action.path}`;
    case "click":
      return `點擊 ${action.target}`;
    case "fill":
      return `在 ${action.target} 填入 ${action.value}`;
  }
}

function checkText(check: PlanCheck): string {
  if (check.kind === "functional") {
    return `功能檢查 ${check.id}（準則 ${check.criterionId}）：預期 ${check.expectedObservation}`;
  }

  return `樣式檢查 ${check.id}（準則 ${check.criterionId}）：${check.property}，容差 ${toleranceText(check.tolerance)}，設計 ${designReferenceText(check.design)}`;
}

function coverageStateText(state: Coverage["state"]): string {
  return state === "uncovered" ? "未覆蓋" : JUDGMENT_LABELS[state];
}

function sourceKey(source: Source): string {
  return source.kind === "jira" ? `jira:${source.issueKey}` : `confluence:${source.pageId}`;
}

function sourceText(source: Source): string {
  return source.kind === "jira" ? `Jira ${source.issueKey}` : `Confluence ${source.pageId}`;
}

function CheckProgressLine({
  checks,
}: {
  checks?: Readonly<{ completed: number; total: number }>;
}) {
  if (!checks) {
    return null;
  }

  return (
    <p>
      Host 檢查 {checks.completed}/{checks.total}
    </p>
  );
}

function ToolActivityList({ active }: { active: readonly ToolActivityView[] }) {
  if (active.length === 0) {
    return <p>目前沒有進行中的工具。</p>;
  }

  return (
    <ul className="flex flex-col gap-1">
      {active.map((tool, index) => (
        <li key={`${tool.toolName}:${tool.startedAt}:${index}`}>
          <span className="font-mono">{tool.toolName}</span>
          {" · "}
          {tool.route === "direct" ? "直接呼叫" : "Code Mode"}
          {" · "}
          開始 {tool.startedAt}
        </li>
      ))}
    </ul>
  );
}

const WAITING_DETAILS: Record<Extract<ProgressRow, { status: "waiting" }>["reason"], string> = {
  dependency: "等待相依條件完成。",
  dispatch: "等待派工。",
};

function RoleProgressDetail({ row }: { row: ProgressRow }) {
  switch (row.status) {
    case "waiting":
      return <p className="text-xs text-muted-foreground">{WAITING_DETAILS[row.reason]}</p>;
    case "reused":
      return (
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <p className="font-mono break-all select-all">{row.artifact}</p>
          <p>
            原 run {row.provenance.originalRunId} · {ROLE_LABELS[row.provenance.role]} ·{" "}
            {row.provenance.issuedAt}
          </p>
          <p>凍結快照，非最新內容。</p>
        </div>
      );
    case "not_required":
      return <p className="text-xs text-muted-foreground">無樣式檢查，不需要派工。</p>;
    case "undispatched":
      return (
        <p className="text-xs text-muted-foreground">
          未派工：{undispatchedReasonLabel(row.reason)}
        </p>
      );
    case "running":
      return (
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <p>{runningActivityLabel(row.activity)}</p>
          <CheckProgressLine checks={row.checks} />
        </div>
      );
    case "tool_activity":
      return (
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <ToolActivityList active={row.active} />
          <CheckProgressLine checks={row.checks} />
        </div>
      );
    case "cancelling":
      return (
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <p>已接受取消，尚未確認停止。</p>
          <ToolActivityList active={row.active} />
        </div>
      );
    case "terminal":
      return <p className="text-xs text-muted-foreground">原因：{row.reasonCode}</p>;
  }
}

function RoleProgressRow({ role, row }: { role: RoleId; row: ProgressRow }) {
  return (
    <li
      data-role={role}
      data-status={row.status}
      data-outcome={row.status === "terminal" ? row.outcome : undefined}
      className="flex flex-col gap-1 rounded-lg border border-border p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{ROLE_LABELS[role]}</span>
        <Badge variant={rowBadgeVariant(row)}>{rowStatusLabel(row)}</Badge>
      </div>
      <RoleProgressDetail row={row} />
    </li>
  );
}

function AcceptanceSummary({ acceptance }: { acceptance: Acceptance }) {
  if (acceptance.verdict === "not_verified") {
    return (
      <div data-verdict="not_verified" className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">未驗證真實網站</Badge>
        <span className="text-xs text-muted-foreground">模擬資料（{acceptance.reason}）</span>
      </div>
    );
  }

  return (
    <div data-verdict="blocked" className="flex flex-col gap-1">
      <Badge variant="destructive">受阻</Badge>
      <ul className="flex flex-col gap-1">
        {acceptance.reasons.map((reason) => (
          <li key={reason} className="text-xs text-muted-foreground">
            {reasonLabel(reason)}（{reason}）
          </li>
        ))}
      </ul>
    </div>
  );
}

function RequirementsSummary({ requirements }: { requirements: PublicRequirements | null }) {
  if (!requirements) {
    return (
      <div className="flex flex-col gap-1">
        <h4 className="text-sm font-medium">需求</h4>
        <p className="text-xs text-muted-foreground">需求缺失，未取得固定需求全集。</p>
      </div>
    );
  }

  const selectedKeys = new Set(
    requirements.selection.kind === "selected" ? requirements.selection.keys : [],
  );
  const allSelected = requirements.selection.kind === "all";

  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-sm font-medium">需求</h4>
      <p className="text-xs">目標：{requirements.goal}</p>
      <p className="text-xs text-muted-foreground">
        選取範圍：
        {allSelected ? "全部需求" : `已選 ${selectedKeys.size} 項`}
      </p>
      <ul className="flex flex-col gap-1">
        {requirements.criteria.map((criterion) => {
          const chosen = allSelected || selectedKeys.has(criterion.key);

          return (
            <li
              key={criterion.id}
              data-criterion-id={criterion.id}
              data-selected={chosen}
              className="text-xs text-muted-foreground"
            >
              <span className="font-mono">{criterion.key}</span>
              {" · "}
              {criterion.statement}
              {chosen ? "（已選）" : "（未選）"}
            </li>
          );
        })}
      </ul>
      {requirements.unresolved.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {requirements.unresolved.map((item) => (
            <li key={item} className="text-xs text-destructive">
              待解決：{item}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function PlanSummary({ plan }: { plan: PublicPlan | null }) {
  if (!plan) {
    return (
      <div className="flex flex-col gap-1">
        <h4 className="text-sm font-medium">測試計畫</h4>
        <p className="text-xs text-muted-foreground">計畫缺失，未產生案例與檢查。</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-medium">測試計畫</h4>
      <p className="text-xs text-muted-foreground">
        AC 指派：{plan.assignments.ac.join("、") || "無"}；UI 指派：
        {plan.assignments.ui.join("、") || "無"}
      </p>
      <p className="text-xs text-muted-foreground">以下為計畫內容，不是實際瀏覽器操作紀錄。</p>
      <ol className="flex flex-col gap-2">
        {plan.cases.map((planCase) => (
          <li
            key={planCase.id}
            data-case-id={planCase.id}
            className="flex flex-col gap-1 rounded-md border border-border p-2"
          >
            <p className="text-xs font-medium">
              {planCase.title}（案例 {planCase.id}）
            </p>
            {planCase.preconditions.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {planCase.preconditions.map((precondition) => (
                  <li key={precondition} className="text-xs text-muted-foreground">
                    前置條件：{precondition}
                  </li>
                ))}
              </ul>
            ) : null}
            <ol className="flex flex-col gap-1">
              {planCase.actions.map((action, index) => (
                <li key={index} className="text-xs text-muted-foreground">
                  預定動作 {index + 1}：{actionText(action)}
                </li>
              ))}
            </ol>
            <ul className="flex flex-col gap-1">
              {planCase.checks.map((check) => (
                <li
                  key={check.id}
                  data-check-id={check.id}
                  className="text-xs text-muted-foreground"
                >
                  {checkText(check)}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}

function EvidenceItem({ evidence }: { evidence: PublicEvidence }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-muted/30 p-2 text-xs text-muted-foreground">
      {evidence.kind === "functional" ? (
        evidence.outcome === "blocked" ? (
          <p>受阻原因：{evidence.reason}</p>
        ) : (
          <>
            <p>預期：{evidence.expected}</p>
            <p>觀察：{evidence.observed}</p>
          </>
        )
      ) : (
        <>
          <p>屬性：{evidence.property}</p>
          {evidence.outcome === "blocked" ? (
            <p>受阻原因：{evidence.reason}</p>
          ) : (
            <>
              <p>預期：{evidence.expected}</p>
              <p>觀察：{evidence.observed}</p>
            </>
          )}
          <p>容差：{toleranceText(evidence.tolerance)}</p>
          <p>設計：{designReferenceText(evidence.capturedDesign.reference)}</p>
          <p>屬性摘要：{evidence.capturedDesign.propertiesDigest}</p>
          <p>擷取時間：{evidence.capturedDesign.capturedAt}</p>
        </>
      )}
      {evidence.kind === "functional" ? <p>動作索引：{evidence.actionIndex}</p> : null}
      <p>來源：模擬（{evidence.origin}）</p>
      <p>
        Fixture：{evidence.fixture.id}@{evidence.fixture.version}
      </p>
      <p>Adapter：{evidence.adapterVersion}</p>
    </div>
  );
}

function CheckResultList({
  title,
  results,
}: {
  title: string;
  results: readonly PublicCheckResult[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-sm font-medium">{title}</h4>
      {results.length === 0 ? (
        <p className="text-xs text-muted-foreground">沒有結果。</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {results.map((result) => (
            <li
              key={`${result.caseId}:${result.checkId}`}
              data-case-id={result.caseId}
              data-check-id={result.checkId}
              data-judgment={result.judgment}
              className="flex flex-col gap-1"
            >
              <p className="flex flex-wrap items-center gap-2 text-xs">
                <Badge
                  variant={result.judgment === "simulated_blocked" ? "destructive" : "outline"}
                >
                  {JUDGMENT_LABELS[result.judgment]}
                </Badge>
                案例 {result.caseId} · 檢查 {result.checkId}
              </p>
              {result.evidence.length === 0 ? (
                <p className="text-xs text-muted-foreground">沒有證據。</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {result.evidence.map((evidence, index) => (
                    <li key={index}>
                      <EvidenceItem evidence={evidence} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CoverageSummary({ coverage }: { coverage: readonly Coverage[] }) {
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-sm font-medium">覆蓋範圍</h4>
      {coverage.length === 0 ? (
        <p className="text-xs text-muted-foreground">沒有覆蓋資料。</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {coverage.map((row, index) => (
            <li
              key={`${row.criterionId}:${row.caseId ?? "none"}:${row.checkId ?? "none"}:${index}`}
              data-coverage-state={row.state}
              className="text-xs text-muted-foreground"
            >
              <span className="font-mono">{row.criterionId}</span>
              {" · "}
              案例 {row.caseId ?? "未指定"} · 檢查 {row.checkId ?? "未指定"} ·{" "}
              {coverageStateText(row.state)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SourceList({ title, sources }: { title: string; sources: readonly Source[] }) {
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-sm font-medium">{title}</h4>
      {sources.length === 0 ? (
        <p className="text-xs text-muted-foreground">沒有未解決來源。</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {sources.map((source) => (
            <li
              key={sourceKey(source)}
              data-source-kind={source.kind}
              className="text-xs text-destructive"
            >
              {sourceText(source)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RoleOutcomeList({ rows }: { rows: Readonly<Record<RoleId, ProgressRow>> }) {
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-sm font-medium">角色結果</h4>
      <ul className="flex flex-col gap-1">
        {ROLE_ORDER.map((role) => {
          const row = rows[role];

          return (
            <li
              key={role}
              data-role={role}
              data-status={row.status}
              className="text-xs text-muted-foreground"
            >
              {ROLE_LABELS[role]}：{rowStatusLabel(row)}
              {row.status === "terminal" ? `（${row.reasonCode}）` : ""}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ArtifactList({
  title,
  artifacts,
  note,
}: {
  title: string;
  artifacts: readonly ArtifactRef[];
  note?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-sm font-medium">{title}</h4>
      {artifacts.length === 0 ? (
        <p className="text-xs text-muted-foreground">沒有參照。</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {artifacts.map((artifact) => (
            <li
              key={artifact}
              className="font-mono text-xs break-all text-muted-foreground select-all"
            >
              {artifact}
            </li>
          ))}
        </ul>
      )}
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}

function TestReportSection({
  report,
  availableArtifacts,
}: {
  report: PublicTestReport;
  availableArtifacts: readonly ArtifactRef[];
}) {
  return (
    <section
      aria-live="off"
      aria-label="測試報告"
      data-testid="testing-report"
      data-run-id={report.runId}
      className="flex flex-col gap-3 break-words"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">測試報告</h3>
        <AcceptanceSummary acceptance={report.acceptance} />
      </div>
      <p className="text-xs text-muted-foreground">
        模擬結果只描述與預期的差異，不構成真實網站驗收。
      </p>
      <RequirementsSummary requirements={report.requirements} />
      <PlanSummary plan={report.plan} />
      <CheckResultList title="AC 功能結果" results={report.results.ac} />
      <CheckResultList title="UI 樣式結果" results={report.results.ui} />
      <CoverageSummary coverage={report.coverage} />
      <SourceList title="未解決來源" sources={report.unresolvedSources} />
      <RoleOutcomeList rows={report.roleOutcomes} />
      <ArtifactList title="報告產物" artifacts={report.artifacts} />
      <ArtifactList
        title="可用既有參照"
        artifacts={availableArtifacts}
        note="參照供後續要求使用，重用與相容性由伺服器判定。"
      />
    </section>
  );
}

function TaskResult({ view }: { view: TestView }) {
  const result = view.task?.result;

  if (!result) {
    return null;
  }

  return (
    <section
      aria-live="off"
      aria-label="任務結果"
      data-run-id={view.runId}
      className="flex flex-col gap-3 break-words"
    >
      <h3 className="text-sm font-medium">任務結果</h3>
      {result.kind === "requirements" ? (
        <RequirementsSummary requirements={result.payload} />
      ) : null}
      {result.kind === "plan" ? <PlanSummary plan={result.payload} /> : null}
      {result.kind === "ac-result" || result.kind === "ui-result" ? (
        <>
          <p className="text-xs text-muted-foreground">僅為模擬結果，不構成真實網站驗收。</p>
          <CheckResultList
            title={result.kind === "ac-result" ? "AC 功能結果" : "UI 樣式結果"}
            results={result.payload}
          />
        </>
      ) : null}
      <ArtifactList title="產物參照" artifacts={[result.ref]} />
    </section>
  );
}

function useCancelRequest(view: TestView, onCancel?: (runId: TestRunId) => Promise<void>) {
  const [tracker, setTracker] = useState<CancelTracker | null>(null);
  const cancelGeneration = useRef(0);
  const request = cancelRequestFor(tracker, view.runId);
  const cancelDisabled = cancelButtonDisabled(view, request);

  async function requestCancel() {
    if (!onCancel || cancelDisabled) {
      return;
    }

    const runId = view.runId;
    const generation = ++cancelGeneration.current;
    setTracker((current) => beginCancelRequest(current, runId, generation));

    try {
      await onCancel(runId);
      setTracker((current) =>
        settleCancelRequest(current, runId, generation, { status: "accepted" }),
      );
    } catch (error) {
      setTracker((current) =>
        settleCancelRequest(current, runId, generation, {
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  return { request, cancelDisabled, requestCancel };
}

function cancelLabel(view: TestView, request: CancelRequest): string {
  return view.state === "cancelling" ||
    request.status === "requesting" ||
    request.status === "accepted"
    ? "取消中…"
    : "取消";
}

function CancelAction({
  label,
  disabled,
  onCancel,
}: {
  label: string;
  disabled: boolean;
  onCancel: () => void;
}) {
  return (
    <div data-slot="card-action">
      <Button variant="outline" size="sm" aria-label="取消" disabled={disabled} onClick={onCancel}>
        {label}
      </Button>
    </div>
  );
}

export function TestingPanel({
  view,
  onCancel,
}: {
  view: TestView;
  onCancel?: (runId: TestRunId) => Promise<void>;
}) {
  const { request, cancelDisabled, requestCancel } = useCancelRequest(view, onCancel);

  const content = (
    <>
      <Card size="sm">
        <CardHeader>
          <CardTitle>{view.task ? ROLE_LABELS[view.task.role] : "測試角色進度"}</CardTitle>
          {onCancel && (!view.task || view.state !== "finished") ? (
            <CancelAction
              label={cancelLabel(view, request)}
              disabled={cancelDisabled}
              onCancel={requestCancel}
            />
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {view.task ? <p className="text-sm break-words">{view.task.summary}</p> : null}
          {request.status === "failed" ? (
            <p className="break-words text-xs text-destructive">{cancelRequestMessage(request)}</p>
          ) : null}
          <ul className="flex flex-col gap-2">
            {visibleRows(view).map(([role, row]) => (
              <RoleProgressRow key={role} role={role} row={row} />
            ))}
          </ul>
        </CardContent>
      </Card>
      {view.task && view.state === "finished" ? <TaskResult view={view} /> : null}
      {!view.task && view.state === "finished" ? (
        <TestReportSection report={view.report} availableArtifacts={view.availableArtifacts} />
      ) : null}
    </>
  );

  return (
    <section
      aria-label="測試角色進度"
      data-testid="testing-progress"
      data-run-id={view.runId}
      data-state={view.state}
      className="flex flex-col gap-3"
    >
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label="測試狀態摘要"
        className="sr-only"
      >
        {progressStatusSummary(view, request)}
      </p>
      {view.task && view.state === "finished" ? (
        <details className="rounded-xl border border-border bg-card p-3">
          <summary className="cursor-pointer rounded-md text-sm focus-visible:outline-2 focus-visible:outline-ring">
            <span className="inline-flex flex-wrap items-center gap-2">
              <span className="font-medium">{ROLE_LABELS[view.task.role]}</span>
              <span className="break-words">{view.task.summary}</span>
              <Badge variant={rowBadgeVariant(view.progress.rows[view.task.role])}>
                {rowStatusLabel(view.progress.rows[view.task.role])}
              </Badge>
            </span>
          </summary>
          <div className="mt-3 flex flex-col gap-3">{content}</div>
        </details>
      ) : (
        content
      )}
    </section>
  );
}
