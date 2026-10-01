# DBOS 即時串流執行

## 執行合約

`server/harness/run.ts` 使用課程的 model → tools → model while loop，最多五輪。每個 model 與每個 tool 各自一個 `DBOS.runStep`，最後一個 finish step 原子保存 thread transcript、增加 revision、釋放 claim 並寫 terminal。DBOS 擁有 checkpoint 與 recovery；應用不再維護 model slot、epoch、receipt 驗證、commit-model 或 publish-tool steps。

model callback 先寫 `MESSAGES_SNAPSHOT(messages)`，接著逐個 provider chunk 持久化。reader 不等完整 turn 或 checkpoint 才取得 token。保留 TanStack normalization，以 `StreamProcessor.process()` 組裝訊息、reasoning 與 tool calls；沿用 SDK／provider 原生 ID、metadata 與簽章，不另做身分映射。持久 append 成功後才交給 SDK，append 失敗立即停止消費 provider。工具名稱與原始 arguments 仍即時可見，工具結果可以等執行完成。

每次真正執行 callback 都先 snapshot，撤回上一個未完成 attempt 的畫面。provider／SDK 管理訊息身分；不同 attempt 不要求相同 ID，也不是 writer fencing。model 完成後寫 snapshot 與 projection；tool 完成後寫 result 與 projection，再回傳 step output。這些 app writes 早於 DBOS checkpoint。

workflow 只從 accepted messages 與 DBOS 回傳的 step outputs 重建歷史。`projection` 是最新完整 app 輸出或重試 baseline，不是 checkpoint receipt。finish 使用 workflow 傳入的 messages，不使用可能 speculative 的 projection。失敗只保留可見輸出與 terminal，不覆寫 thread 最後成功的歷史。

## 恢復邊界

| 中斷位置                                                                | 接受的行為                                                                                          |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| model／tool checkpoint 已完成                                           | DBOS 重用 output，不執行 callback，不再呼叫外部服務或重送該 step 事件。                             |
| model 已送 token、checkpoint 未完成                                     | callback 可重跑，先 snapshot 撤回舊 partial，再即時串流。                                           |
| tool side effect／result 已完成、checkpoint 未完成                      | tool 可再執行。重試 snapshot 撤回舊 speculative result。這是 at-least-once，不是外部 exactly-once。 |
| app output 已保存、checkpoint 失敗且 workflow 終止                      | 失敗畫面可能保留未 checkpoint 的完整 output，不可當作已完成工作證明。                               |
| finish transaction 成功、checkpoint 尚未完成                            | replay finish 是 no-op，revision 與 terminal 不重複。                                               |
| accept 成功、startWorkflow 失敗                                         | reconciler 用相同 workflow ID 補提交。                                                              |
| DBOS 明確 ERROR／CANCELLED／MAX_RECOVERY 或缺少 app terminal 的 SUCCESS | reconciler 寫 failure terminal、釋放 claim。status query 失敗不能推測終態。                         |

snapshot 只修復依序重試。移除 epoch 後，重疊 executor 或仍存活的 stale writer 可能混流；原生 ID、資料庫 row lock 與 DBOS streams 都不等於 app writer fencing。本版本沒有額外仲裁此風險。工具若有不可重複副作用，需工具端 idempotency key 或獨立授權的解法。

已安裝 DBOS 5.0.2 的 `callStepFunction` 先查 operation output，完成 callback 後 await checkpoint，才回傳結果。本版直接依賴此 SDK 合約，不用 `listWorkflowSteps` 建第二套提交協定。原同毫秒 fixture 固定時鐘並 mock SQL，只暴露 callback 回傳值與保存 output 可能不同的程式路徑，沒有重現真 PostgreSQL 並行 bug。移除 guard 不表示風險不存在；若真實 checkpoint collision 發生，本版不再自行偵測 output 分歧。

## HTTP 與固定 thread UI

`launchChatRuntime()` 在 HTTP listen 前執行。`acceptRun({threadId,runId,baseRevision,message:{id,text}})` 接受不可變輸入；`observeRun(runId,cursor,signal)` 只讀事件。斷線只停止 reader，不取消 producer。

POST `/api/chat` 使用 AG-UI body。`threadId` 為 UUID；`runId` 是 SDK 原生 opaque ID，長度 1..200、字元 `[A-Za-z0-9_-]`。必填 `forwardedProps.baseRevision`，只接受最後一筆 user 的固定 ID 與單一 text，其餘 client history 不可信。相同 run/input attach；不同 input、過期 revision、重複 message ID 或其他 active run 回 409。`X-Run-Id` 若存在必須相同。

GET `?threadId=UUID` 回 `{messages,activeRun,revision}`。active messages 是 accepted baseline，接著 SDK join 事件 log。GET `?runId=run-123-abcdef&offset=-1` 從頭 replay。`Last-Event-ID` 是非負 run-local 十進位 sequence，優先於 offset；未知 run 404、超前或錯誤 cursor 400。每筆 SSE 為 `id` 與 JSON `StreamChunk`。只有 app 的持久 terminal 正常結束串流；transport error 不合成 `RUN_ERROR` 或 `[DONE]`。

建立 thread 僅接受 `{}`，儲存空 messages、revision 0。每個 document 固定一個 URL thread。client 先完成 hydration，送出前讀 detail revision，再用原生 persistence、SSE rejoin 與 snapshot replacement。只有目前 run 的持久 `RUN_FINISHED` 或 `RUN_ERROR` 解開 navigation gate；provider tool_calls、EOF、HTTP 拒絕與斷線都不算完成。此版沒有修改 client，詳見 `docs/frontend-thread.md`。

## 容量與安全界線

model bridge 不另限制 bytes、events 或 tool call 數量。應用不再限制 accepted run（history 與 prompt）、tool 更新後的 history、finish transcript、單筆 event、每個 run 的 log bytes／event 數量或 tool result 的容量，也不會自動壓縮或裁切 transcript。保留 JSON 可序列化檢查、事件 sequence／順序、DB transaction 與 log_bytes 計量；既有 integer 欄位及資料庫／SDK／provider 的實際資源界線仍適用，並非無限容量。run 仍最多五輪，新增文字最多 32,000 字元；request 的 Zod 長度／形狀／ID／revision 驗證、工具 allowlist、錯誤結果與 AbortSignal timeout 不變。工具內部的資源限制也不變：get_figma 仍使用 30,000 bytes 門檻決定摘要分頁，get_ticket 仍最多回傳 10 則留言。DB 查詢維持 10 秒 statement／15 秒 query timeout；持久 append 仍須完成後才繼續消費 provider。

model 只呼叫 schema-only `adapter.chatStream()`，每個執行中的 model callback 一次 generation，不讓 SDK 執行工具。TOOL_CALL_END 必須有完整原始 JSON object，且與宣告 input 一致；get_figma 的可選 null 欄位沿用既有調整。重複 START／END、END 後的參數、缺少 END／RUN_FINISHED、RUN_ERROR 與 provider tool result 都不能產生成功 checkpoint 或執行工具。provider RUN_STARTED／RUN_FINISHED 不寫入 app log，app 仍擁有唯一的持久 start／terminal。checkpoint output 保留 JSON round-trip。

已安裝 adapter 與 processor 都會在 upstream EOF 合成完成。bridge 可拒絕缺少公開 completion／END 或截斷 JSON，不能辨識「完整有效 JSON 後靜默 EOF」與正常結束；不宣稱更強偵測。

thread→run transaction 維持輸入／revision／claim 仲裁，不提供多租戶 ACL。run ID 不是授權憑證。本版不增加 broker、queue、lease、取消 UX 或第二個 workflow engine。

## 版本與 migration 限制

新 build／applicationVersion／workflow name 為 `durable-chat-loop-v2`。刪 sibling steps 改變 durable operation 序列與 step output shape，不能以新程式透明續跑 `durable-chat-stream-v1`。模型、prompt 語意或 schema 不相容變更也必須明確版本化。

reconciler 跳過 build／model 不相容的 pending run，不代為啟動或宣告失敗。POST attach 舊 pending run 回 409；GET 仍可讀既有事件。舊 run 的 claim 會保留，需原 build 完成或明確運維處理，不會自動遷移或解鎖。

本次保持 `server/db/schema.ts` 與全部 migration artifacts 原樣。`chat_model_slots` ORM 宣告／歷史表仍在，但新 runtime 不讀寫它，也未產生或套用 drop。

現存 migration chain 不一致。`0000_durable_chat.sql` 假設 threads 已存在，ALTER threads 並建立 chat tables；`0001_outstanding_mantis.sql` 又 CREATE threads 與相同 chat tables。journal 同時列出兩者；已有 `0001_snapshot.json`，其 prevId 是零 UUID。直接順跑在空 DB 的 0000 會失敗，在既有 DB 則有重複建表問題。這不是可用的 fresh baseline，也不能盲目 migrate／generate／push。必須先人工確認實際 deployment history，再另行修復，不能刪使用者歷史假裝解決。

## 離線驗證

使用已安裝的本機工具，不啟動真 backend、不載入 secrets、不呼叫模型／Jira／Figma、不安裝、不套用 migration。

```sh
pnpm typecheck
DATABASE_URL=postgresql://offline:offline@127.0.0.1:1/offline MODEL_API_KEY=offline node --import tsx --test server/harness/run.test.ts server/thread.test.ts server/harness/tools/*.test.ts src/hooks/*.test.ts src/components/*.test.tsx
node_modules/.bin/tsx scripts/check-contrast.ts
node_modules/.bin/tsx scripts/check-openui-parse.ts
```

tests 保留真 ChatClient deferred token、snapshot reset、reasoning/tool 原生參照與簽章、超過 2 MB 的 chunked arguments、native POST/reconnect/cursor、reader detach 與 terminal gate；另以真 compatible adapter 的離線 fetch 驗證 reasoning-first／tool-only 與 ChatClient snapshot/result round-trip。SQL-boundary fixture 執行真 workflow callback 與工具／模型替身，注入 model、tool、finish 的 app-write/checkpoint gap，檢查可見輸出、重試 snapshot、completed step reuse 與 revision 只增加一次。刪除舊 verifier 的 private SDK fixture。

SQL 與 checkpoint mock 不是 PostgreSQL 隔離或 DBOS recovery 證明。真正 kill/restart、concurrent executors、row locking、checkpoint visibility、版本交接與 deployment migration 均未驗證。本版不是 production-ready。
