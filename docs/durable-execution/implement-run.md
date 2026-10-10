# 建立可恢復的 run

把聊天改成先保存請求、啟動背景 workflow，再以 SSE 觀察結果。先讀[可恢復的聊天架構](architecture.md)，以下步驟依資料與模組的依賴排序。

## 1. 建立資料庫與 run 契約

使用 `@dbos-inc/dbos-sdk@5.0.2` 與專案的 Postgres、Drizzle。保留 lockfile，新增依賴時確認實際安裝版本。以下使用 `registerWorkflow`、`runStep` 與 `startWorkflow`，不需要 decorator。

將 `DATABASE_URL` 放在後端環境設定。DBOS 使用 `systemDatabaseUrl`，Drizzle 使用同一個連線設定建立應用資料表。讓 DBOS 管理自己的 system schema，不把它複製進 Drizzle schema。

在 `server/db/schema.ts` 建立 `chat_runs`、`chat_events`，並替 `threads` 加入 `revision` 與 `active_run_id`。將 run 狀態限制為 `pending`、`succeeded`、`failed`。設定下列資料庫約束：

- `chat_runs.id` 唯一，且 `thread_id` 必須指向存在的 thread。
- `chat_events` 的 `(run_id, sequence)` 為主鍵，`(run_id, event_key)` 唯一。
- `revision` 與 `sequence` 不得為負數。

在 `run-store.ts` 定義 `RunInput`，包含 `threadId`、`runId`、`baseRevision` 與單一新訊息 `{ id, text }`。驗證識別碼格式與文字長度。讓 `AcceptedRun` 再包含伺服器固定的 `messages`、`prompt`、`model` 與 `build`。

產生並檢查 migration，再套用到專用的練習資料庫：

```sh
pnpm db:generate
pnpm db:migrate
```

確認新資料庫可建立空 thread，且不能插入重複 run ID、重複事件序號或無效狀態。

## 2. 先保存請求，再允許執行

在 `run-store.ts` 實作 `persistRun`。在一個 transaction 鎖定 thread，依序處理以下情況：

1. 找不到 thread，回傳 404。
2. `runId` 已存在且請求相同，回傳原本的 accepted run。請求內容不同則回傳 409。
3. 新 run 的 `baseRevision` 與 thread 不同，或 thread 已有 active run，回傳 409。
4. 新訊息 ID 已存在於可信歷史，拒絕請求。
5. 以伺服器歷史加上新訊息建立 `accepted`，寫入 pending run、占用 thread，並追加 `RUN_STARTED`。

不要以瀏覽器傳回的整份歷史覆寫伺服器資料。相同 run ID 的重送檢查要早於 revision 檢查，才能在 run 完成後仍辨認原本的請求。

實作 `emit`，在 transaction 內鎖住 run、取得下一個 sequence、寫入事件並遞增序號。需要更新快照時，將快照與對應事件一起寫入。拒絕對已結束 run 追加一般事件。

用資料庫測試驗證相同請求重送，以及兩個分頁用相同 revision 競爭送出的結果。後者只能接受一個新 run。

## 3. 將一次模型呼叫拆成 model turn

在 `model-turn.ts` 實作 `streamModelTurn`，接收訊息、模型串流與持久化事件的 `append` 函式，回傳 `{ messages, calls }`。

用 `normalizeStreamChunk` 整理 adapter 事件，再交給 `StreamProcessor` 組成訊息與 tool calls。保留 `UIMessage` 與 `StreamChunk`，讓前端繼續使用 TanStack 的串流格式。介面以 [TanStack AI 0.58.0 的 adapter](https://github.com/TanStack/ai/blob/@tanstack/ai@0.58.0/packages/ai/src/activities/chat/adapter.ts) 與 [StreamProcessor](https://github.com/TanStack/ai/blob/@tanstack/ai@0.58.0/packages/ai/src/activities/chat/stream/processor.ts) 為準。

依照下列要求處理串流：

- 持久化文字與 tool call 事件後，才讓觀察者讀到它們。
- 等待完整的模型終止事件，且所有 tool call 參數均已結束、可解析為 JSON object，才回傳成功。
- 拒絕缺少終止事件、重複 tool call ID、工具事件順序錯誤，provider 冒充工具結果，以及 provider 事件覆寫既有訊息或 tool call ID。
- 不將 provider 的 `RUN_FINISHED` 寫成整個 run 的終態。模型可能還要求工具，真正終態由 `finishRun` 發出。
- 發生錯誤時關閉串流，且不把半段訊息當作成功 step 結果。

注入假模型串流，驗證正常文字、工具呼叫、半途斷線與不完整參數。此時不要執行任何真實工具。

## 4. 建立明確的 model 與 tool steps

在 `agent-loop.ts` 建立自己的迴圈，在 `run.ts` 用 `DBOS.runStep` 提供 checkpoint。移除後端對 `chat()` 自動工具迴圈的依賴，改由 adapter 的 `chatStream()` 產生單輪串流。

每輪依序完成以下工作：

1. 在 `model:${turn}` step 開始時保存完整 `MESSAGES_SNAPSHOT`，清除上一次未完成 attempt 的畫面。
2. 取得這一輪可見的工具定義，轉換訊息，呼叫 adapter，再交給 `streamModelTurn`。
3. 保存完成後的快照，讓 model step 回傳訊息與 calls。
4. 若有 calls，依模型給出的順序，各自執行 `tool:${turn}:${index}` step。驗證名稱與參數後才呼叫 handler。
5. 把每個結果轉成對應 `toolCallId` 的 `TOOL_CALL_RESULT`，更新訊息並回傳，作為下一個 step 的輸入。
6. 模型不再要求工具時離開迴圈。超過明確的輪數上限則回報失敗。

先依序執行工具，避免完成時間改變 step 次序。在 model step 設定有限重試，例如 `maxAttempts: 3` 包含第一次嘗試，搭配 `retriesAllowed`、`intervalSeconds` 與 `backoffRate`。模型與工具的網路呼叫各有逾時，不無限等待。

工具操作錯誤可轉成 `output-error` 結果，讓模型知道操作失敗；資料庫寫入失敗必須向外拋出。不要把保存失敗包成成功的工具結果，也不要直接替所有有副作用的工具開啟重試。

用計數器檢查 checkpoint 行為。恢復後，已完成的 model 與 tool step 不再增加呼叫次數，未完成的 model step 可以重新執行。下一輪訊息必須帶有先前的工具結果。

## 5. 原子提交對話與 run 終態

在 `run-store.ts` 實作可重複呼叫的 `finishRun`。鎖住 thread 與 run，確認 run 仍為 pending，而且仍占用接受時的 thread revision。

成功時，在同一個 transaction 完成以下寫入：

- 保存最終 messages，增加 thread revision，清除 `active_run_id`。
- 保存最終快照與唯一 terminal event。
- 將 run 改為 `succeeded`。

失敗時保存最後可查閱的快照與 `RUN_ERROR`，清除 `active_run_id`，並把 run 改為 `failed`。本階段不把未完成的回覆提交成下一個 run 的正式歷史。

從 workflow 的 `finish` step 呼叫成功收尾。若 DBOS 最後以錯誤結束，交給下一步的狀態核對流程收尾。已終態的 run 再次呼叫 `finishRun` 時，直接回傳。

故意在 transaction 中途拋出錯誤，確認對話、revision、終態事件與 run state 一起回滾。成功後再次收尾，確認 revision 只增加一次。

## 6. 啟動、恢復與關閉 runtime

在 `run.ts` 使用 `DBOS.registerWorkflow(executeRun, { name: BUILD })` 註冊 workflow。接受 run 後，用 `DBOS.startWorkflow(workflow, { workflowID: run.runId })(run)` 啟動背景工作。不要等待整個模型回答才回傳 SSE。

在 `server/index.ts` 接收 HTTP 前完成 `launchChatRuntime`：

1. 用 `DBOS.setConfig` 設定應用名稱、`applicationVersion` 與 `systemDatabaseUrl`。
2. 執行 `DBOS.launch()`，讓 DBOS 啟動及恢復相容的 workflow。
3. 掃描本地 pending run，以 `DBOS.getWorkflowStatus(runId)` 核對狀態，啟動定期核對流程。

核對時，DBOS 尚無此 workflow 就用原 run ID 補啟動。DBOS 仍在執行則等待。若 DBOS 已是 `ERROR`、`CANCELLED` 或 `MAX_RECOVERY_ATTEMPTS_EXCEEDED`，將本地 run 收尾為失敗。若 DBOS 已 `SUCCESS`，本地卻仍 pending，視為收尾不一致。以 `workflow_success` 錯誤碼呼叫冪等失敗收尾，寫入 `RUN_ERROR` 並釋放 thread，避免永久停在 busy。

固定 run 的 build，並拒絕以不相容的程式執行它。改變 step 順序時，依 [DBOS workflow 升級規則](https://docs.dbos.dev/typescript/tutorials/upgrading-workflows)安排版本。Step 的名稱不會讓任意重排變得安全，DBOS 也依賴呼叫順序辨認 checkpoint。只改 build 字串不會替舊 pending run 完成工作，也不能直接丟棄它們。

關機時先停止接收 HTTP，再停止並等待核對流程，接著 `DBOS.shutdown()`，最後關閉 Drizzle 使用的連線池。這個關閉順序不保證正在執行的外部 I/O 已全部完成，重啟仍需處理未完成 step。不要把關閉瀏覽器當成取消 workflow。

## 7. 接上事件觀察與前端重連

在 `server/chat.ts` 保留三個入口：

- `POST /api/chat` 驗證新訊息，呼叫 `acceptRun`，回傳該 run 的事件串流。
- `GET /api/chat?threadId=...` 回傳 messages、revision 與 `activeRun`，供前端載入對話。
- `GET /api/chat?runId=...` 接續該 run 的事件，不建立新工作。

在 `observeRun` 按 sequence 讀取 cursor 之後的事件。SSE 使用 `id: sequence`，重連優先讀取 `Last-Event-ID`，沒有此 header 才讀取 `offset`。Cursor 只接受非負整數，且不得超過已保存的最後序號。唯一例外是沒有 `Last-Event-ID` 時，可用 `offset=-1` 表示從頭讀取；`Last-Event-ID` 本身不接受 `-1`。

讓 request 的取消訊號只停止這次 SSE 訂閱與資料庫輪詢。模型、工具與 MCP 使用 runtime 自己的取消訊號及逾時。Tool 章綁在 HTTP 串流上的 MCP client，這裡要改由 workflow 的工具 scope 管理，並在 `finally` 關閉。

前端重新載入時先取得對話。若有 active run，訂閱原 run 的事件。完整重播要從一致的初始訊息搭配 `offset=-1` 開始；使用中途快照則必須同時取得對應 cursor，不能把舊 delta 再接一次。

只有匹配目前 run 的持久化 `RUN_FINISHED` 或 `RUN_ERROR` 才解除 busy 狀態。SSE 中斷、模型單輪結束與工具結束都不代表整個 run 已完成。結果未確認時先重連查詢，不另建 run ID 重送同一則訊息。

完成本機工具的恢復測試後，再[建立可恢復的 lazy discovery](lazy-discovery.md)。DBOS API 可查閱[方法參考](https://docs.dbos.dev/typescript/reference/methods)及[Steps 說明](https://docs.dbos.dev/typescript/tutorials/step-tutorial)，實作時以 lockfile 版本提供的型別為準。
