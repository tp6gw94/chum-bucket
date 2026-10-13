# 執行專項測試

所有測試共用 `pnpm test`，也可以指定檔案：

```bash
pnpm test tests/scripts/contrast.test.ts
pnpm test tests/scripts/openui-parse.test.ts
pnpm test tests/check-boundaries.test.ts
```

配色、OpenUI 解析、架構邊界與原本 compaction-offline 選取的測試，都會由一般 `pnpm test` 執行。`pnpm typecheck` 只做 TypeScript 型別檢查。

以下三項需要額外環境，未提供對應環境變數時會明確顯示跳過，而不是宣稱通過。

## Mock 對話瀏覽器

先在另一個終端啟動 `pnpm dev:thread-browser`，再執行：

```bash
THREAD_TEST_ORIGIN=http://127.0.0.1:4187 pnpm test tests/scripts/thread-browser.test.js
```

測試攔截整個 API，不使用真實後端或資料庫。預設使用專案安裝的 Playwright；可用 `PLAYWRIGHT_MODULE` 指向其他 ESM 模組，或用 `CHROMIUM_EXECUTABLE` 指定瀏覽器執行檔。

## Jira 核准重啟恢復

```bash
JIRA_COMMENT_RECOVERY_DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/TEST_DB pnpm test tests/scripts/jira-comment-recovery.test.js
```

只對**已建好 schema 的隔離測試資料庫**執行。測試會寫入 thread、run、事件與 DBOS 紀錄，並強制終止及重啟自己建立的 worker。模型與 Jira 都是 fixture；不呼叫真實服務。它不使用日常 `DATABASE_URL` 作為預設，也不負責刪除測試資料庫。

三個情境為等待核准時重啟、外部接受後結果未保存時重啟，以及取消後重啟。第二種情境容許重複送出，不代表外部 exactly-once 保證。若任何情境失敗，會停止後續情境並清理 worker。

## 真實 Jev 與瀏覽器

```bash
BROWSER_TARGET_URL=http://127.0.0.1:PORT/product.html pnpm test tests/scripts/jev-browser.test.ts
```

只在已授權的 demo site 上執行。這項會讀取 `.env` 取得 `JEV_API_KEY` 等設定並呼叫真實 Jev，可能產生費用；一般測試不會自行開啟它。可用 `BROWSER_ARTIFACT_DIRECTORY` 指定證據目錄，並沿用 `BROWSER_REQUIRE_CHECKOUT=1` 啟用原有的完整 checkout 結果斷言。
