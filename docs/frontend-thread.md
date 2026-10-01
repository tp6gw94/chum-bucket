# 每個文件固定一個對話

空網址顯示既有對話與「建立新對話」。建立只接受空物件、儲存空歷史，不會送訊息。成功後導覽到 `?threadId=<UUID>`；重新載入只取得歷史並接回既有 run，不會自動送出。非法 ID 與不存在的對話直接顯示錯誤。

載入、提交、執行中不能切換對話；只有目前 run 的最終成功或失敗才解除限制。工具呼叫的中途結束不是最終成功。連線中斷、HTTP 拒絕與沒有 terminal 的 EOF 均維持未知狀態，請重新載入同一網址確認，不要直接重送。成功才清除草稿；失敗或未知結果保留原文。

SDK 單獨載入及串流訊息；應用只觀察 transport 的原始 terminal，避免 SDK 為 EOF 合成的事件誤開 gate。hydration 的下一個 task 才解除載入限制，確保 SDK 已套用歷史。React form action 的提交 claim 使用同步 render，避免 transition 將停用編輯延後到請求完成。

## 離線檢查

不要啟動真實後端、執行 migration 或使用模型金鑰。測試的資料庫連線指向不可用本機埠；SQL 與工具請求均由測試 mock。

```sh
./node_modules/.bin/tsc --noEmit
DATABASE_URL=postgresql://offline:offline@127.0.0.1:1/offline ./node_modules/.bin/tsx --test server/thread.test.ts server/harness/run.test.ts server/harness/tools/*.test.ts src/hooks/*.test.ts
./node_modules/.bin/tsx scripts/check-contrast.ts
./node_modules/.bin/tsx scripts/check-openui-parse.ts
./node_modules/.bin/vite --config scripts/thread-browser-vite.mjs
```

另一個終端使用已安裝的 Playwright 模組與 Chromium；不下載或安裝套件：

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs CHROMIUM_EXECUTABLE=/absolute/path/to/chromium node scripts/check-thread-browser.mjs
```

瀏覽器檢查會攔截全部 API 與外部請求，使用真實 React StrictMode、TanStack SDK 與 Composer。可用 `THREAD_TEST_PORT` 設定 Vite 埠、`THREAD_TEST_ORIGIN` 設定檢查網址。測試包含空入口、建立互斥、hydration、原文保留、手機選取、404、同 tick send／navigate、terminal／未知結果、reload rejoin 與 BFCache 恢復事件。BFCache 是合成 `pageshow.persisted` 的 handler 檢查，並非各瀏覽器原生快取相容性保證。

第一提交的非 durable 版本只恢復已儲存歷史，GET 的 `activeRun: null` 不保證伺服器沒有執行中的 run，也不提供跨頁籤仲裁。DBOS 版本才提供權威 activeRun 與 rejoin。建立回應遺失可能留下空對話；不自動清理或重試。
