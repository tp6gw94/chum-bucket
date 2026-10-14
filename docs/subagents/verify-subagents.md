# 驗證子 Agent

先用假的模型串流與固定資料驗證權限、產出檢查與恢復，再用真實模型、Jira 與瀏覽器跑一次完整流程。先完成[建立委派](implement-delegation.md)、[建立四個角色](role-agents.md)與[建立瀏覽器驗證](browser-verification.md)。

## 1. 驗證工具權限

在 `tests/server/harness/agents.test.ts` 直接呼叫 `allowsTool` 與 `toolNamesFor`，確認：

- `main` 在兩種 route 都不能呼叫 `jira_get_issue` 與 `discover_atlassian_tools`。
- `delegate_task` 只能直接呼叫，Code Mode 裡不行。
- `toolNamesFor("planner")` 是空陣列。`ac` 只有 `verify_ac`，`ui` 只有 `get_figma` 與 `verify_ui`。
- `roleSystemPrompt(role, "舊的 profile")` 丟出錯誤。
- `roleTaskPrompt` 產生的訊息只有資料，裡面的 JSON 能還原成原本的任務。

在 `tests/shared/delegation.test.ts` 加上 `delegationInputSchema` 的測試，確認：

- `planner` 帶 `goal` 或 `targetUrl` 時失敗。
- 任何角色多一個欄位，例如 `criteria` 或 `childWorkflowId`，都失敗。
- `sources` 為空陣列時失敗。

在 `tests/server/harness/testing-run.test.ts` 確認附屬對話的工具清單沒有 `delegate_task`，Code Mode 的 prompt 裡也沒有 `external_delegate_task`。

## 2. 驗證角色的工具限制

在 `tests/server/harness/testing-tools.test.ts` 用 MCP fixture 確認：

- `atlassian` 的 discovery 只接受 `jira_get_issue` 與 `confluence_get_page`。
- `atlassian` 讀不在 `intent.sources` 裡的 issue 時丟出錯誤，fixture 沒有收到請求。
- `jira_get_issue` 送出的參數帶有 `summary,description` 與 `include=remote_links`。
- `planner` 呼叫任何工具都失敗，Code Mode 裡可以做本機計算。
- `verify_ac` 收到分派給 `ui` 的 check 時丟出 `Unknown scoped check`。
- `ui` 在 Figma capture 存好前看不到可用的 `verify_ui`，`get_figma` 讀別的節點時失敗。
- handoff 回傳值沒有 `receiptId`，結束的回傳值有 `receiptId` 與 `outputDigest`。

## 3. 驗證產出檢查

在 `tests/server/harness/testing-domain.test.ts` 直接呼叫純函式：

- `assembleRequirements`：每個來源取第一筆成功讀取，原文的空白與換行不變。少一個來源時，問題寫成 `task.sources[i]: <key> has no successful read`。
- 在 `tests/server/harness/source-links.test.ts` 確認：Jira 的 `remote_links` 裡有重複或不是 `figma.com` 的連結時，只留下有效且不重複的那些。
- `canonicalizePlan`：重複的 criterion ID、指向不存在的 criterion、樣式檢查的設計和委派不同，三種都被拒絕。通過時 `assignments` 把功能檢查分給 `ac`、樣式檢查分給 `ui`。
- `assembleToolResults`：同一個 check 的兩筆矛盾觀察都留下。沒有 receipt 的 check 不產生結果。內容損壞或綁定別的 check 的 receipt 不計入。

在 `tests/server/harness/testing-run.test.ts` 確認 `rolePassTurns`：`ac` 與 `ui` 一次用完 20 回合，沒有回饋輪。`atlassian` 與 `planner` 是 6 回合加 2 回合回饋。

在 `tests/shared/testing-event.test.ts` 確認 task v3 保留 `findings`、`missingChecks` 與 `conflictingChecks`，多出的欄位解析失敗。在 `tests/src/components/testing-panel.test.tsx` 確認卡片把 findings 當成文字顯示，矛盾的觀察每筆都顯示。

## 4. 驗證瀏覽器工具

`tests/server/harness/playwright-check.test.ts` 用真實 Chromium 和一個測試用的本機 HTTP server，Jev 改用假的 `fetch`。確認：

- Jev 不接受選擇時，case 暫停，瀏覽器沒有關閉，回傳的 handoff 有候選與標好框的截圖。
- `choose` 完成原本的操作，`selections` 記錄 `agent_choose`，沒有 `confidence`。
- `navigate` 換頁後用原本的描述再問一次 Jev。
- `abandon` 讓這個 check 和後面的 check 都是 `blocked`。
- 第 4 次選擇 handoff 直接 `blocked`。
- 同一個 handoff 重送相同決定得到相同結果，送不同決定丟出錯誤。
- handoff 過期後瀏覽器關閉。
- 標記檔已存在時，不開瀏覽器，回傳 `replay is forbidden`。
- `verify_ui` 遇到含點擊的 case，在開瀏覽器前回傳 `blocked`。

`tests/server/harness/jev-client.test.ts` 確認 Jev 回傳 `none`、機率不足或候選超過 254 個時不接受選擇。

## 5. 驗證中斷與恢復

`tests/server/harness/testing-run.integration.test.ts` 用真實 DBOS 與 PostgreSQL 執行。為它建立一個獨立的資料庫，套用 migration 後執行：

```bash
DATABASE_URL=<測試資料庫> TESTING_RUNTIME_DATABASE_URL=<測試資料庫> \
	pnpm test tests/server/harness/testing-run.integration.test.ts
```

模型由 fixture 依角色回傳固定內容，不呼叫真實服務。確認下列情境：

- 只要計畫的對話建立兩個 task，重新整理後兩張卡片都還在。
- 來源少讀一個時，`dbos.operation_outputs` 依序有 `proposal` 與 `proposal-2`，只有一則回饋訊息。仍讀不到時，結果是 `source_reads_incomplete`，沒有 artifact。
- `planner` 給出重複的 criterion ID，回饋後修正，artifact 只寫入一次。
- 依賴的 ref 不存在時，工具結果是一般錯誤，沒有建立 task。
- 在 `planner` 執行中結束 worker 程序再重啟。`atlassian` 的模型沒有再被呼叫，operation 的 `id` 與 `deadline` 不變，requirements artifact 的 ref 不變。
- 完成後重啟，模型呼叫次數不變。
- 取消一個還沒開始的 task，沒有呼叫模型，主 workflow 正常結束。

`tests/server/harness/testing-store.integration.test.ts` 要另外設定 `TESTING_STORE_DATABASE_URL`，否則整個檔案會跳過。在這裡確認預算：超過回合上限的新模型 step 被拒絕，同一個 step 超過 3 次嘗試被拒絕，工具呼叫超過上限被拒絕，期限過後所有 IO 被拒絕，原因分別是 `budget` 與 `deadline`。

同一個檔案也確認 QA 的結果：

- `acceptRoleCompletion` 寫入的 `findings` 原樣出現在 projection。同一個 task 重送不同的 `findings` 時丟出錯誤。
- 角色沒有 receipt 就結束時，分派的 check 列在 `missingChecks`，即使 task 是完成狀態。
- 舊版 workflow 建立的 operation 仍以 task v2 顯示，沒有 `findings`。

## 6. 用真實模型與瀏覽器驗收

準備：

1. 在 `.env` 設定 `MODEL_API_KEY`、`JIRA_BASE_URL`、`JIRA_EMAIL`、`JIRA_API_TOKEN`、`FIGMA_API_KEY` 與 `JEV_API_KEY`。
2. 執行 `pnpm dev`。它同時啟動 Atlassian MCP，並用 `serve` 在 `http://127.0.0.1:5124/` 啟動 demo 商店。
3. 準備一張描述 demo 商店行為的 Jira issue，例如「購物車數量增加後，小計會更新」。

在瀏覽器依序操作：

1. 送出「讀 PROJ-123，幫我寫測試計畫」。確認出現兩張卡片，`atlassian` 與 `planner` 都完成。計畫卡片列出 criteria、case 與分派。主 Agent 沒有自己寫計畫。
2. 送出「用 http://127.0.0.1:5124/ 執行這份計畫的功能檢查」。確認主 Agent 只委派 `ac`，帶上前一步的 `planRef`。卡片顯示正在執行的 `verify_ac`。
3. 等 `ac` 完成。確認卡片把模型文字和工具觀察分開顯示。每個分派的 check 都有工具觀察，否則列在「缺少工具證據的檢查」。evidence 的 `origin` 是 `browser`，截圖檔存在 `.data/browser-evidence/`。
4. 讀主 Agent 的回覆。確認它是自然語言的 QA 報告，不是 JSON。報告沒有把「任務完成」說成檢查通過，缺少的證據寫成限制。
5. 再委派一次 `ac`，在卡片按「取消」。確認卡片顯示取消中，接著變成 `cancelled`，瀏覽器程序已關閉。
6. 送出「直接用 planRef=art-不存在 執行」。確認主 Agent 收到錯誤並回報，沒有新的 task。
7. 開啟附屬對話，要求它委派測試。確認附屬對話沒有 `delegate_task` 可用。

從資料庫確認：

- 每次 `delegate_task` 各有一列 `testing_operations`，`terminal_outcome` 和畫面一致。
- `testing_artifacts` 的 `requirements` 與 `plan` 各一列，`plan` 的 `metadata` 依賴 `requirements` 的 ref。
- `ac` 的 receipts 綁定的 `checkId` 和計畫的分派相同。

保存每一步的截圖、operation ID、artifact ref，以及 `chat_events` 裡的 `testing.projection` 事件。
