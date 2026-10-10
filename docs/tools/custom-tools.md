# 建立自訂工具

建立 `get_figma` 與 Pi 的 `read`、`write`、`edit`，再把工具接入聊天。以下工具檔案放在 `server/harness/tools/`。

## 1. 實作 get_figma

在 `get-figma.ts` 建立 `getFigma`。用 `toolDefinition` 宣告名稱、description 與 input schema，再用 `.server()` 綁定 handler。注入 fetch 與金鑰讀取函式，讓測試不依賴真實服務。

依照以下要求處理輸入與 API 回應：

- 讓 `target` 接受 Figma `/file/`、`/design/` URL 或 file key。用選填的 `nodeId` 覆蓋 URL 的 `node-id`，並把 `1-2` 轉成 `1:2`。
- 限制 `depth` 為 1–10 的整數，預設 2。限制 `offset` 為非負整數，預設 0，只用於摘要分頁。
- 從後端讀取 `FIGMA_API_KEY`。固定呼叫 `https://api.figma.com/v1/files/{key}`，指定節點時使用 `/nodes?ids=...`。拒絕模型提供任意 API URL。
- 保留節點 ID、名稱、文字、尺寸、layout 與樣式，移除隱藏節點。詳細結果超過 30,000 bytes 時，回傳節點摘要，每頁 20 筆，並提供 `nextOffset`。
- 用 `depthLimited` 標記子節點可能不完整，用 `truncated` 標記是否改成摘要。摘要總數只計算本次取得的節點。
- 處理缺少金鑰、HTTP 錯誤、非 JSON、找不到節點、30 秒逾時與取消。回傳可辨識的錯誤種類，排除金鑰與原始錯誤 body。

新增 `get-figma.test.ts`。用假 fetch 驗證 URL 解析、指定節點、隱藏節點、摘要分頁與錯誤處理。確認結果標明深度限制，以及是否改回節點摘要。

## 2. 包裝 Pi 的 read、write、edit

`cwd` 只是相對路徑的起點，不能限制工具可存取的路徑。使用沒有私人檔案的練習環境。這個 Target 不建立檔案沙箱或寫入批准 UI，取消已開始的寫入也不會自動復原。

在 `fs.ts` 使用 `@earendil-works/pi-coding-agent` 的 `createReadTool`、`createWriteTool`、`createEditTool`，並注入工作目錄。用 TanStack wrapper 保留 Pi 的名稱、description、JSON schema 與結果 `content`、`details`。

讓 wrapper 驗證輸入，並保留以下操作：

- 讓 `read` 接受 `{ path, offset?, limit? }`，`offset` 從第 1 行開始。
- 讓 `write` 接受 `{ path, content }`，建立父目錄並覆寫檔案。
- 讓 `edit` 接受 `{ path, edits: [{ oldText, newText }] }`，依原始文字做精確替換。找不到、匹配多處或修改範圍重疊時，拒絕修改並保留原檔。

對 write 與 edit，將 `toolCallId` 與 `abortSignal` 傳給 Pi 的 `execute`。在 `read-worker.mjs` 中以 `toolCallId` 執行 read。主執行緒收到取消訊號後，終止 Worker 並清理監聽器。

新增 `fs.test.ts`，只在暫存目錄測試。驗證 write、read、edit、再 read 的內容相符，錯誤的 edit 不改檔，取消 read 後仍能再次讀取。

## 3. 將自訂工具接入聊天

在 `index.ts` 匯出 `localTools = [getFigma, read, write, edit]`。在 `server/chat.ts` 將清單傳入 `chat()` 的 `tools`。讓工具定義只描述模型能呼叫的操作，把金鑰與 handler 留在後端。

把 `tool-playground/` 加入 `.gitignore`。在聊天介面執行一次檔案寫入、讀取、修改與讀回，再讀取有權限的 Figma 檔案及指定 frame。確認工具結果回到模型，重新整理後仍能讀回對話。

接著[接入本機 Atlassian MCP](atlassian-mcp.md)，完成兩組工具的串接驗收。
