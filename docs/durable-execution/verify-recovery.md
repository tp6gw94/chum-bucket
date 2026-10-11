# 驗證中斷與重連

用可控制的模型與工具，證明重啟後能接續原 run，並區分 checkpoint 完成前後的差異。先完成[run 實作](implement-run.md)與[lazy discovery](lazy-discovery.md)。

## 1. 建立可觀察的測試環境

使用專用 Postgres 資料庫、假模型串流與測試用工具。工具用獨立於應用程序的紀錄保存呼叫次數與操作 ID，應用重啟後仍能核對結果。

為每次測試記下 thread ID、run ID、已完成 step、最後事件 sequence，以及模型和工具的呼叫次數。在指定位置設置可等待的測試控制點，確認資料已保存後再終止程序，不靠猜測睡眠秒數。

分開執行兩層測試：

- 離線契約測試驗證事件解析、run ID 衝突、工具分派與 UI 狀態。假的 checkpoint cache 可以驗證迴圈是否重用結果。
- 串接測試使用真正的 DBOS、Postgres 與兩次獨立 server 程序。只有這一層能驗證持久化與跨程序恢復。

Mock 通過不代表真正重啟測試通過。不要在正式 Jira 新增留言做中斷實驗，沿用唯讀工具或測試服務。

## 2. 先確認不中斷的完整流程

讓模型探索 `jira_get_issue`、執行唯讀查詢，再產生回答。確認以下結果：

- 每次模型呼叫與每個工具呼叫各有 step，discovery 結果進入下一輪訊息。
- 所有 SSE 事件先存入 `chat_events`，sequence 按順序遞增。
- 模型回覆結束後，thread revision 增加一次，active run 清空，run 為 succeeded。
- 重送同一個 run ID 與相同請求，只取得原 run。換掉輸入但沿用 ID 則得到 409。
- 同一 thread 的兩個新 run 同時送出，只有一個取得執行權。

以 `model-turn.test.ts` 驗證串流邊界，以 `run-store.test.ts` 驗證資料與終態契約，並在 `run.test.ts` 驗證跨 step 的訊息傳遞。測試放在 `tests/server/harness/`，不要只斷言內部函式被呼叫。

## 3. 在各個提交空窗中斷程序

每個情境都先確認中斷位置，再終止 server 程序。保留同一個資料庫與相容 build，重啟後觀察同一個 run ID。

1. 在 accepted run 已提交、DBOS 尚未啟動時中斷。預期狀態核對流程補啟動原 run，不新增 user message 或 run。
2. 在模型已送出部分文字、model step 尚未完成時中斷。預期模型重新呼叫，先用完整快照取代舊 attempt，再顯示新文字；不能將兩次回答接在一起。
3. 在 model checkpoint 已完成、第一個工具尚未執行時中斷。預期不再次呼叫該輪模型，直接依已保存 calls 執行工具。
4. 在工具外部操作成功、tool checkpoint 尚未完成時中斷。預期 handler 可能再執行。讓測試服務按固定操作 ID 去重，驗證同一操作只生效一次，並確認不同操作 ID 仍可分別生效。
5. 在 tool checkpoint 已完成、下一輪模型尚未執行時中斷。預期已完成工具的呼叫次數不增加，下一輪模型收到保存的工具結果。
6. 在 finish transaction 已提交、finish step 尚未保存 checkpoint 時中斷。預期重新收尾無副作用，revision 不再增加，terminal event 只有一筆。
7. 在 discovery checkpoint 完成後中斷。預期新 client 能從已保存 call 與 result 重建可用工具，不依靠舊程序的記憶體集合。

第 4 個情境要另外移除測試服務的去重，觀察重複副作用確實可能發生。這能區分「DBOS 重用已完成 step」與「外部服務避免重複寫入」各自的保證。

一般事件可包含失敗 attempt 的紀錄。驗收重點是事件順序與快照能正確重建畫面，不是要求整份事件 log 從未出現重試。

## 4. 驗證重連只觀察原 run

在模型串流進行中關閉 SSE 連線，保持 server 運作。確認模型與工具沒有因此取消，run 仍能完成。

再完成以下前端測試：

1. 重新整理頁面，從 thread 取得 active run，接續原 run 的事件。
2. 以最後收到的 sequence 重連，只讀取後面的事件。以 `offset=-1` 完整重播時，最終畫面與原畫面一致。
3. 傳入超前、非整數與格式錯誤的 cursor，確認伺服器拒絕，不默默略過事件。
4. 讓串流在尚未收到 terminal event 時結束，確認 UI 保持結果未確認，並查詢原 run。
5. 傳入其他 run 的終態，確認不會解除目前 run 的 busy 狀態。

另外讓模型連續失敗直到重試上限，確認 run 最終為 failed、thread 釋放，事件仍可讀回。讓資料庫暫時失聯，確認服務不會回報成功，連線恢復後能繼續核對狀態。

## 5. 交付可重現的驗收結果

執行新增測試，以及 `pnpm typecheck`、`pnpm exec oxlint` 與 `pnpm build`。依專案的 `AGENTS.md` 執行提交前檢查。

交付時記錄每個中斷點的 run ID、前後呼叫次數、最後狀態與畫面結果。分開列出已通過、失敗與未執行的檢查。資料庫、模型金鑰或 MCP 服務受阻時，指出缺少的條件，不以離線 fixture 代替真實串接結果。

這個 Target 完成時，應能用同一個 run ID 證明已完成工作被重用、未完成工作可接續、畫面可重建，以及副作用空窗有明確處理方式。
