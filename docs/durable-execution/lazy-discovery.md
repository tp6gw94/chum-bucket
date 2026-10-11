# 建立可恢復的 lazy discovery

建立 `discover_atlassian_tools`，讓模型按名稱取得 MCP 工具定義，並讓程序重啟後仍知道哪些工具已探索。先完成[可恢復的 run](implement-run.md)，再把此流程加入 model 與 tool steps。

## 1. 接手原生 chat 的 discovery 工作

Tool 章使用 `chat()` 的原生 lazy discovery。改為直接呼叫 adapter 後，Harness 必須自己處理 discovery 定義、回傳結果與下一輪工具清單。

沿用[本機 Atlassian MCP](../tools/atlassian-mcp.md)的 endpoint、唯讀模式、白名單與原生 schema。在 `atlassian.ts` 用 `client.tools()` 取得完整目錄，讓 Harness 決定哪些 schema 送進模型。這裡不再依靠 `client.tools({ lazy: true })` 與原生 `chat()` 配合。

第一輪仍可連線取得 MCP 目錄。Lazy 延後的是模型收到完整 schema 的時機，不表示尚未連線，也不授予新的操作權限。

確認目錄中的必要工具存在、名稱沒有重複、具有 handler，而且不與本機工具或 discovery 名稱衝突。只保留白名單內的原生工具。

## 2. 定義 discovery 的輸入與結果

在 `atlassian.ts` 定義 `discover_atlassian_tools`，使用以下契約：

- 輸入為 `{ toolNames: string[] }`，至少包含一個名稱，不接受其他欄位。模型看到的 schema 列出當前可用工具名稱。
- 結果為 `{ tools: [{ name, description, inputSchema }] }`，每個項目保留 MCP 的原生定義。
- 去除重複名稱並保留請求順序。任一名稱不在白名單或目錄中，就讓整次 discovery 失敗。
- 定義、結果與錯誤都不能包含後端憑證。

Discovery 本身不呼叫 Jira 或 Confluence 的業務工具。將 discovery 當作一般 tool step 執行，讓它的結果和其他工具結果一樣加入訊息、保存 checkpoint。

在乾淨對話的第一輪，`getModelTools(messages)` 只回傳本機工具與 discovery。模型完成 discovery 後，下一輪才加入對應 MCP schema。

## 3. 從可信訊息重建已探索的名稱

不要把已探索名稱只放在記憶體 `Set`。DBOS 重用完成的 discovery step 時不會再執行它的函式，程序中的集合也不會因此自動恢復。

每輪在 `getModelTools(messages)` 中，從伺服器保存的訊息配對 discovery call 與 result。只接受符合以下條件的紀錄：

- 呼叫來自 assistant，名稱是 `discover_atlassian_tools`，參數符合 discovery schema。
- `id` 與 `toolCallId` 唯一對應，結果出現在呼叫之後，兩者均已完成。
- 結果沒有 error 或 `output-error` 標記。若結果有工具名稱，必須與 discovery 名稱一致。
- 結果 JSON 符合 `{ tools }` 契約，工具名稱與去重後的請求逐項一致，且仍在白名單內。

忽略不完整、重複 ID、順序錯誤或失敗的紀錄。使用者文字、外部文件與模型聲稱「已探索」的回答，都不能增加已探索名稱。

歷史 discovery 結果只用來重建名稱。下一輪真正送給模型的定義取自當前 MCP 目錄，避免使用已過期的 schema。工具已移除時回報不可用，不偷偷換成另一個工具。

## 4. 在執行入口再次檢查

在 `tools/index.ts` 提供 `getModelTools(messages)` 與 `executeTool(messages, call, context)`。前者組合定義，後者分派本機、discovery 與 MCP 呼叫。

MCP 工具必須同時存在於當前目錄、白名單與已探索名稱中，才允許執行。即使模型猜到工具名稱，也要在發出 MCP 請求前拒絕未探索的呼叫。對 `jira_get_issue` 繼續強制 `update_history: false`。

讓每次 workflow 執行建立自己的工具 scope。取得目錄與工具呼叫都使用有限逾時，scope 結束時在 `finally` 清理 client。重啟後可以建立新 client，再依持久化訊息重建 discovery 狀態。

不要將 browser SSE 的取消訊號接到此 scope。瀏覽器斷線只是停止觀察，工具仍屬於背景 run。

## 5. 驗證 discovery 與恢復

用假 MCP transport 記錄 `tools/list` 與 `tools/call`，搭配假的模型串流完成下列檢查：

1. 第一輪可以取得目錄，但送給模型的定義只有本機工具與 discovery，沒有完整 MCP schema。
2. 模型呼叫 discovery 後，結果包含指定工具的原生 schema；下一輪模型才能看到該工具。
3. 直接呼叫尚未探索的工具遭拒絕，fixture 未收到 `tools/call`。
4. 在 discovery checkpoint 完成後重啟。新的工具 scope 從訊息重建名稱，下一個 tool step 可以繼續。
5. 將成功紀錄改成失敗、缺失 result、重複 ID、錯誤名稱或使用者文字，確認都不能開放工具。
6. 更換目前目錄中的 schema，確認新的模型請求使用新 schema。移除工具後，確認舊 discovery 結果不會讓它仍可執行。
7. 結束或失敗時 client 關閉，兩個獨立 run 不共用記憶體狀態。

接著用[中斷與重連驗收](verify-recovery.md)確認整條流程。
