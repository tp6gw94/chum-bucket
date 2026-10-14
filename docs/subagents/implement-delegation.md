# 建立委派

讓主 Agent 呼叫 `delegate_task`，由 host 為選定的角色建立一個 DBOS 子 workflow，等它結束後把結果交回主 Agent。架構分工見[子 Agent 的委派架構](architecture.md)。

這份文件先把委派的骨架接通：registry、工具權限、`delegate_task`、主 workflow 的七個 steps 與子 workflow。角色內部的 prompt、工具與產出驗證在[建立四個角色](role-agents.md)，瀏覽器工具在[建立瀏覽器驗證](browser-verification.md)。

每一步先用假的模型串流確認結果，最後才接上真實模型。

## 1. 建立 Agent registry

在 `agents.ts` 用一個物件列出所有 Agent。主對話是 `conversation`，四個角色是 `qa`：

```typescript
export const agentRegistry = {
  main: {
    kind: "conversation",
    model: MODEL,
    tools: [getFigma, read, write, edit, delegateTaskTool],
    codeMode: "enabled",
    systemPrompt: openuiInstructions,
  },
  atlassian: {
    kind: "qa",
    model: MODEL,
    artifact: "requirements",
    tools: [atlassianToolFactory],
    registration: "atlassian_read",
    codeMode: "enabled",
    profile: "requirements-v4",
    systemPrompt: qaSystemPrompts.atlassian,
  },
  // planner、ac、ui 同樣的形狀
} as const satisfies AgentDefinitions;
```

欄位的用途：

- `tools` 放工具物件本身，不放名稱字串。Atlassian MCP 的工具在執行時才知道定義，所以放一個帶有 `names` 與 `create(catalog)` 的 factory。`toolNamesFor(agentId)` 把兩種攤平成名稱清單。
- `artifact` 是角色產出的 artifact 種類：`requirements`、`plan`、`ac-result`、`ui-result`。
- `profile` 是 prompt 與輸出格式的版本。改了 prompt 或 schema 就升版。舊版本存下的 artifact 不再重用。
- `registration` 是工具組合的名稱，和 `profile` 一起寫進 artifact 的 metadata。

四個角色的工具：

| 角色        | 工具                                                        |
| ----------- | ----------------------------------------------------------- |
| `atlassian` | `jira_get_issue`、`confluence_get_page`（經由 MCP factory） |
| `planner`   | 無                                                          |
| `ac`        | `verify_ac`                                                 |
| `ui`        | `verify_ui`、`get_figma`                                    |

所有 Agent 先共用同一個 `MODEL`。registry 讓你之後改成每個角色不同的模型，不必改其他程式。

## 2. 用一個函式判斷工具權限

建立 `allowsTool(agentId, name, route)`。`route` 是 `"direct"`（模型直接呼叫）或 `"codemode"`（sandbox 裡的 `external_*`）。依序判斷：

1. `codemode` 本身只能直接呼叫，而且 Agent 的 `codeMode` 是 `"enabled"`。
2. `discover_atlassian_tools` 只能直接呼叫，而且 Agent 的工具裡有 Atlassian 工具。
3. 名稱不在 Agent 的 `tools` 裡，回傳 `false`。
4. 工具帶有 `metadata.direct === true` 時，只允許 `"direct"`。
5. 其餘交給 Atlassian 工具的 `routes` 政策，沒有設定就兩種都允許。

主對話建立工具清單、Code Mode bindings 與執行工具時，都呼叫這個函式。角色也一樣。權限只寫在一個地方，你才能用測試證明「主 Agent 讀不到 Jira」和「`planner` 什麼工具都不能用」。

## 3. 定義 `delegate_task`

在 `shared/testing.ts` 用 `z.discriminatedUnion("role", [...])` 定義 `delegationInputSchema`，每個分支都用 `z.strictObject`。欄位見[架構文件的表格](architecture.md#角色之間用-artifact-參照串起來)：

```typescript
const sourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("jira"), issueKey: z.string().trim().min(1).max(128) }),
  z.strictObject({ kind: z.literal("confluence"), pageId: z.string().trim().min(1).max(128) }),
]);
```

`strictObject` 讓模型多傳的欄位直接失敗。模型常把 `goal` 或 `targetUrl` 也塞給 `planner`，嚴格 schema 會把這種錯誤擋在 admit 之前。

在 `delegate-task.ts` 用 `toolDefinition` 建立工具，標記 `metadata: { direct: true }`。description 要寫清楚四件事：一次只委派一個角色、每個角色只接受哪些欄位、不會自動補跑前置角色、`PROJ-123` 要寫成 `sources:[{kind:'jira',issueKey:'PROJ-123'}]`。

`delegate_task` 不能交給一般的工具 dispatcher 執行。主對話的 `executeTool` 收到它時丟出錯誤，真正的執行只走下一步的 hook。

## 4. 在模型迴圈加上 orchestration hook

在 `agent-loop.ts` 加入：

```typescript
export type AgentOrchestration = (
  call: ModelCall,
) => Promise<{ state: "handled"; output: unknown; error?: boolean } | { state: "unhandled" }>;
```

`toolTurn` 處理每個工具呼叫時，先呼叫 hook，再進入 `tool:<turn>:<index>` 這個 DBOS step：

```typescript
const orchestrated = input.orchestration ? await input.orchestration(call) : undefined;
conversation = await input.checkpoint({
  name: `tool:${turn}:${index}`,
  work: () =>
    orchestrated?.state === "handled"
      ? settleToolStep(session, {
          conversation,
          call,
          output: orchestrated.output,
          error: orchestrated.error ?? false,
        })
      : executeToolStep(session, { conversation, call, signal }),
});
```

hook 在 step 外面執行，因為委派本身由許多 DBOS steps 組成，不能包在另一個 step 裡。step 只負責把 hook 的結果寫成工具結果。

在 `run.ts` 建立 `testingOrchestration(run)`：

- 附屬對話的 run 回傳 `undefined`，附屬對話不能委派。
- `call.name` 不是 `delegate_task` 時回傳 `unhandled`。
- 呼叫 `delegateTask(run, call)`，成功就回傳 `handled`。丟出錯誤時，轉成 `{ error: message, decisions? }` 並標記 `error: true`。模型在工具結果裡看到原因，可以修正參數重試。

## 5. 建立資料表

在 `server/db/schema.ts` 新增下列資料表，用 drizzle-kit 產生 migration。委派的骨架需要這些：

- `testing_operations`：一次 `delegate_task` 呼叫一列。`id`、`parent_run_id`、`thread_id`、`request_key`（工具呼叫 ID）、`intent`、`runtime`、`deadline`、`cancel_accepted_at`、`finished_at`、`terminal_outcome`。`(parent_run_id, request_key)` 唯一。
- `testing_tasks`：一個角色的執行。`id`、`operation_id`、`role`、`child_workflow_id`、`attempt_nonce`、`input_digest`、`input`，以及 `model_steps`、`native_calls`、`nested_calls` 計數。`(operation_id, role)` 與 `child_workflow_id` 各自唯一。
- `testing_decisions`：只新增不修改的狀態紀錄。`(operation_id, decision_index)` 是主鍵，`(operation_id, decision_key)` 唯一。內容有 `dispatch`、`satisfied`、`task_result`、`cancel`、`terminal` 等。
- `testing_artifacts`：`ref`、`thread_id`、`role`、`kind`、`scope_digest`、`payload_digest`、`metadata`、`payload`。

- `testing_deliveries`：`delivery_key`（`start:<taskId>` 或 `cancel:<taskId>`）、`operation_id`、`task_id`、`kind`、`acknowledgement`。reserve 寫入 `start`，drain 與 quiet 等它被標成 `quiet`。
- `testing_pins`：`(operation_id, ref)`，記錄 operation 用到哪些 artifact。寫入 artifact 時一起寫入。
- `testing_publications`：`(operation_id, version)`，projection 的快照，見第 10 步。

另外兩張在後面用到：`testing_receipts`（工具紀錄）見[建立四個角色](role-agents.md)，`testing_observations`（模型與工具的進度）讓 projection 顯示正在執行什麼。

## 6. 主 workflow 的七個 steps

在 `testing-run.ts` 建立 `delegateTask(run, call)`。每一步都是 `DBOS.runStep`，名稱要固定，恢復時才能重用結果：

1. **`delegate-v2:admit:<call.id>`**：在 transaction 裡用 `delegationInputSchema` 驗證輸入，算出 `operationId`。operation 已存在時，輸入必須相同，否則回傳 409。新的 operation 要載入依賴的 artifact：`planner` 讀 `requirementsRef`，`ac`/`ui` 讀 `planRef`。種類不對或不屬於這個 thread 時，丟出帶有 `decisions` 的錯誤。最後寫入 `testing_operations`，`deadline` 是現在加 15 分鐘。
2. **`<operationId>:reserve`**：建立 `testing_tasks`，算出 `taskId` 與 `childWorkflowId`，`attempt_nonce` 固定為 1。task 已存在時，`input_digest` 必須相同，回傳原本那列。前置角色還沒完成時拒絕：`planner` 需要 `atlassian` 已 `satisfied`，`ac`/`ui` 需要 `planner` 已 `satisfied`。寫入 `dispatch:<role>` decision。
3. **`<taskId>:start-join`**：用 `DBOSClient.enqueue` 把子 workflow 排進 `testing-delegation` 佇列，`workflowID` 是 `childWorkflowId`。接著 `handle.getResult()` 等它結束。子 workflow 以 ERROR 結束時，轉成 `{ state: "failed", reason: "child_failed" }`。
4. **`<operationId>:drain`**：確認子 workflow 的工作都已停止。
5. **`<operationId>:settle`**：已收到取消時記錄 `cancelled`。子 workflow 回傳失敗時，把原因對應成 `RoleFailureCode` 後記錄。成功時呼叫 `acceptRoleCompletion`，再驗證一次產出並寫入 artifact。這次驗證失敗就記錄 `proposal_rejected`。`ac` 與 `ui` 失敗時，仍用已存下的 receipt 寫入工具觀察。
6. **`<operationId>:quiet`**：每 200 毫秒檢查一次，直到 operation 已結束，或所有子流程都停了。等待期間更新 projection。
7. **`<operationId>:close`**：寫入 `finished_at` 與 `terminal_outcome`，只寫一次。取消優先，接著是超過期限，最後看角色的 `task_result`。`ac` 或 `ui` 的 task 還沒有 `task_result` 時，close 先記錄 `child_failed`，取消時記錄 `cancelled`。

`delegateTask` 回傳的物件就是主 Agent 看到的工具結果：

```typescript
{
	runId,    // operationId
	state,    // "finished"
	task,     // 依角色不同，見下方
	progress, // 角色的進度列，只代表生命週期，失敗時帶 reasonCode 與 issues
}
```

`task` 有兩種形狀：

- `atlassian` 與 `planner`：`{ version: 2, role, summary, origin, result }`。`result` 是 artifact 的 ref 與內容，失敗時為 `null`。
- `ac` 與 `ui`：`{ version: 3, role, summary, origin, findings, missingChecks, conflictingChecks, result }`。`findings` 是角色寫的純文字，沒有或失敗時為 `null`。`result` 是 host 從 receipt 組出的工具觀察，角色失敗時也會有。欄位的意思見[子 Agent 的委派架構](architecture.md)。

在 `testing-child.ts` 的模組頂層註冊子 workflow：`DBOS.registerWorkflow(executeTestingChild, { name: TESTING_WORKFLOW_VERSION })`，目前的版本是 `testing-child-v3`。這個模組必須在 `DBOS.launch()` 之前載入。角色產出的格式改變時，升級這個版本。`childWorkflowId` 也由這個版本算出，舊的子 workflow 不會被新程式接手。

## 7. 建立子 workflow

在 `testing-child.ts` 建立 `executeTestingChild(input)`，`input` 是 `{ taskId, attemptNonce, childWorkflowId, parentRunId, operationId, role }`：

1. **`claim` step**：檢查 task、`childWorkflowId` 與 `attemptNonce` 都相符，operation 沒有結束、沒有取消、沒有超過期限。不符合就回傳 `{ state: "denied", reason }`，不呼叫模型。
2. 讀回 operation 的 `intent` 與 runtime，用 `roleSystemPrompt(role, profile)` 取得 system prompt。存下的 profile 和 registry 不同時丟出錯誤。這代表 operation 是舊版程式建立的。
3. 設定一個在 `deadline` 觸發的 `AbortSignal`。
4. 依角色組合工具，執行角色的模型迴圈。細節在[建立四個角色](role-agents.md)。
5. 回傳 `{ state: "ready", completion }`、`{ state: "failed", reason, issues? }` 或 `{ state: "denied", reason }`。`ac` 與 `ui` 的 `completion` 是 `{ role, findings }`。回合用完時 `reason` 是 `budget`。context 超過模型上限時 `reason` 是 `context_overflow`，主 workflow 記錄成 `child_failed`。

子 workflow 呼叫的是同一個 `runAgentLoop`，差異在三個參數：

- `checkpoint` 的 step 名稱加上前綴，第一輪是 `a:`，回饋輪是 `b:`。
- `compaction` 用 `{ kind: "bounded", maxTurn }`。角色不做聊天壓縮，回合數用完就停。
- session 的 `emit` 不做事。角色的對話不寫進 `chat_events`，主對話的訊息清單不會被角色的工具呼叫塞滿。

## 8. 每次 IO 前檢查預算

在 `testing-store.ts` 建立 `guardActualIO({ taskId, parentRunId, attemptNonce, childWorkflowId, kind, step? })`。子 workflow 每次呼叫模型（`kind: "model"`）或工具（`kind: "tool"`，Code Mode 內的呼叫是 `"nested"`）之前都要呼叫它。在一個 transaction 裡檢查：

- task、nonce 相符，operation 沒有結束、沒有取消、沒有超過期限。
- 新的模型 step 數小於回合上限。同一個 step 最多嘗試 3 次。
- 工具呼叫次數小於上限。

不通過時回傳 `{ state: "denied", reason }`，`reason` 是 `cancel_requested`、`terminal`、`deadline`、`budget`、`nonce` 或 `scope`。子 workflow 收到後中止並以這個原因失敗。

預設上限是 8 回合、24 次工具呼叫、8 次 Code Mode 內呼叫。`ac` 與 `ui` 要逐一操作瀏覽器，放寬到 20 回合、60 次工具呼叫。

預算記在資料庫，而不是記在記憶體。程序重啟後計數還在，模型無法靠重啟拿到更多回合。

## 9. 取消委派

`POST /api/testing/:runId/cancel`，body 是 `{ threadId }`：

1. 在 transaction 裡設定 `cancel_accepted_at`，寫入 `cancel` decision，並為每個還沒停下的 task 新增 `cancel:<taskId>` delivery。
2. 子 workflow 每 200 毫秒讀一次 delivery。看到取消後，把 delivery 標成 `cancel_requested`，中止進行中的模型與瀏覽器操作，停下後標成 `stopped`。
3. 主 workflow 的 quiet 迴圈等到 delivery 是 `stopped`，才執行 close。close 看到 `cancel_accepted_at` 就寫入 `cancelled`。

角色剛好在取消前完成時，settle 仍記錄 `cancelled`，不寫入 artifact。

## 10. 把進度送到瀏覽器

每次 publish 時，`publishOperation` 從 decisions、tasks 與 observations 組出一份 `TestView`。內容和上一版相同時沿用上一版，不寫新事件。有變化時版本號加一，寫進 `testing_publications`，同一個 transaction 裡在主對話的 run 新增一個事件：

```typescript
{ type: EventType.CUSTOM, name: "testing.projection", value: testView, timestamp }
```

事件的 `event_key` 是 `testing:<operationId>:v<version>`。瀏覽器沿用原本的 SSE 收到事件，用 `parseTestingProjectionEvent` 解析，版本號比較新才取代舊的。

`TestingPanel` 用 `task.origin.parentMessageId` 與 `requestKey` 找到對應的 `delegate_task` 工具呼叫，把卡片顯示在那則 assistant 訊息後面。卡片顯示角色狀態、正在跑的工具、失敗原因，以及結束後的 artifact。執行中的卡片有取消按鈕。

`ac` 與 `ui` 的卡片把模型文字和工具觀察分成兩塊，並註明任務完成不代表檢查通過。`conflictingChecks` 與 `missingChecks` 不是空的時候，卡片列出這些 check。同一個 check 的每筆觀察都顯示，不合併。

重新整理頁面時，`GET /api/chat` 的 `hydrateThread` 多回傳 `publishedTasks`，前端用 `parsePublishedTasks` 讀回每個 operation 的最新卡片。

## 11. 啟動時接回未完成的委派

`launchChatRuntime` 在 `DBOS.launch()` 之後呼叫 `reconcileTestingOperations()`，之後每秒再執行一次：

- 已取消的 operation 補上缺少的 `cancel:<taskId>` delivery。
- 重新 publish 每個未結束的 operation。

啟動時 `assertDelegationCutover` 先檢查未結束的 operation。有 operation 是別的 `TESTING_WORKFLOW_VERSION` 建立的，就拒絕啟動，不修改任何紀錄。先用原本的 worker 跑完這些 operation，再啟動新版。

不要在這裡重新啟動子 workflow。DBOS 會自己恢復佇列裡的 workflow。主 workflow 恢復時重新執行 `delegateTask`，admit 與 reserve 拿回同一筆紀錄，`enqueue` 拿回同一個 workflow handle。

接著依照[建立四個角色](role-agents.md)完成角色的 prompt、工具與產出驗證。
