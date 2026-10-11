# 執行、隔離與恢復邊界

Code Mode 的限制分成 guest 執行、host 工具與持久化三部分。每部分保護的對象不同。QuickJS 限制 guest 的執行環境，dispatcher 決定工具權限，DBOS 保存外層 step 的結果。

## QuickJS 限制 guest，host 工具仍有權限

本章使用 QuickJS 的 WASM driver。Guest 在獨立的 QuickJS context 執行，沒有自動取得 Node.js globals 或模組載入能力。[TanStack 的 isolate driver 說明](https://tanstack.com/ai/latest/docs/code-mode/code-mode-isolates)介紹了這個執行方式。

`external_*` 是刻意開放的 host 入口。Driver 將輸入序列化為 JSON，host 執行對應工具，再把成功值或錯誤交回 guest。因此 guest 雖然沒有直接的檔案或網路 API，仍能透過獲准工具讀檔、寫檔或查詢服務。

檔案路徑、服務白名單與帳號權限由 host handler 管理。將 `process.cwd()` 傳給 Pi 工具只設定工作目錄，不等於建立檔案系統隔離。若需要限制到某個目錄，必須另外處理絕對路徑、`..` 與符號連結，或採用作業系統層的隔離。

QuickJS context 不是獨立作業系統程序，也不保證 host 的全部記憶體、CPU 或網路用量受限。這份設計適合說明受限工具編排；對外提供任意不可信程式執行，還需要依威脅模型評估程序或容器隔離、服務權限與系統資源限制。

## 資源預算各自保護不同位置

將下列數值集中在 `CodeModePolicy`，作為本章的起始設定：

- `timeoutMs: 30_000` 與 `memoryLimitMb: 128` 限制一次 guest 執行及 QuickJS heap。
- `maxSourceBytes: 60_000` 限制送入轉譯器的使用者程式。
- `maxHostCalls: 24` 與 `maxHostInputBytes: 64_000` 限制整次執行的 host 呼叫數及每次輸入。
- `maxHostResultBytes: 1_000_000` 限制單次工具結果進入 guest 的大小。
- `maxConsoleEntries: 64`、`maxConsoleBytes: 16_384` 與 `maxConsoleEntryBytes: 2_048` 限制 console 的筆數、總量與單筆大小。
- `maxResultBytes: 256_000` 限制外層結果序列化後的總大小，包含結果、logs 或錯誤。

大小限制按 UTF-8 bytes 計算，不能用 JavaScript 字串的 `length` 代替。Console 要在 guest 送到 host collector 前限制內容，保存必要的原生函式參照，避免 guest 改寫 console 或原型後繞過限制。

自訂事件另有 buffer 預算，可採每個外層工具最多 192 筆、序列化總量 65,536 bytes。這些事件只保存投影後的追蹤資料，與最終工具結果分開計算。

結果大小檢查發生在 host 已取得資料之後，不能阻止 handler 在內部先配置大量記憶體。JSON 序列化本身也會配置記憶體。工具仍需要自己的分頁、回應大小與取消機制；QuickJS 的 heap 限制不能取代這些措施。

## 逾時不等於撤回操作

這個版本的 driver 在 QuickJS 執行開始時設定 deadline。Interrupt handler 檢查 guest 執行時間，等待 host Promise 時也有 deadline。[QuickJS 0.3.1 的執行實作](https://github.com/TanStack/ai/blob/%40tanstack/ai-isolate-quickjs%400.3.1/packages/ai-isolate-quickjs/src/isolate-context.ts)可用來核對這些範圍。

Guest 的 CPU 迴圈可能占用 host 執行緒，不能只依賴 Node.js timer 中斷它。Driver 的 interrupt handler 才能在 guest 執行時檢查 deadline。本章傳入的父層 `AbortSignal` 不直接控制該 handler，因此純 guest 迴圈主要仍靠 sandbox deadline 停止。

30 秒限制不涵蓋工具組合、轉譯、MCP 初始化與清理的全部時間，也不是整個 HTTP 請求的硬上限。

Driver 停止等待或釋放 context，不會殺掉已啟動的 host Promise。Harness 必須把 `AbortSignal` 傳給工具，工具也必須配合。MCP request 已送出或檔案已寫入後，取消不會自動撤回副作用。

執行結束時關閉新呼叫，可防止未等待的 Promise 接著發出另一個工具操作。但先前已開始的工作仍須追蹤與清理。只用 `Promise.race` 回報超時，不能證明背景工作已停止。

清理路徑呼叫 `dispose()`，但這個 driver 對無法完成處理的 guest Promise 可能保留 VM，以避免破壞共用 WASM runtime。不能把呼叫 `dispose()` 寫成任何情況都即時釋放全部資源的保證。

## 憑證與錯誤資料也是邊界

憑證留在 host 的設定與 client。模型只收到工具定義，guest 只收到工具需要的資料，不取得環境變數或 client。

沿用 Atlassian guard，檢查定義、程式輸入、host 參數、host 結果、原始事件、錯誤與最終結果。比對集合包含已設定 token、`email:token`，以及這些值的 Base64、Base64URL 與 percent-encoding 形式。若這些值出現在字串、物件欄位或鍵名，停止本次執行並回傳不含該值的錯誤。

這種比對只涵蓋已設定憑證與列入集合的編碼形式，不保證識別任意轉碼、拆分或其他機密。Metadata-only 事件可以減少複製內容，卻不會讓最終結果中的資料自動變得適合公開。

套件的 `onSecretParameter: "ignore"` 只略過 schema 欄位名稱疑似包含 secret 的[啟發式提示](https://github.com/TanStack/ai/blob/@tanstack/ai-code-mode@0.4.13/packages/ai-code-mode/src/validate-bindings.ts)。它不遮罩資料，也不保護憑證。是否使用這個選項，不能改變 host 的驗證與授權責任。

普通工具錯誤可以交給程式處理。憑證、授權或預算違規則會讓 wrapper 記住失敗狀態。Guest 的 `try/catch` 不能清除這個狀態，也不能讓後續 host 呼叫繼續。

## Checkpoint、retry 與重新呼叫是不同事件

一次 `codemode` 包含整段程式與其中的 host 操作。DBOS 保存的是外層 tool step 完成時的結果，沒有保存 guest 的 heap、區域變數或每個 `await` 的位置。

這帶來三種不同情況：

1. 外層 checkpoint 已完成。恢復重用結果，不再次執行程式或內部工具。
2. 程序在 checkpoint 完成前中斷。恢復可能從頭執行同一段程式，內部已成功的操作也可能重做。
3. 程式回傳失敗結果，或 Harness 把例外轉成工具錯誤。若這份結果已完成 checkpoint，恢復會重用失敗結果。模型下一輪再次要求執行，則是新的工具呼叫。

DBOS 的例外 retry 必須另外設定，也只處理拋出到 step 邊界的例外。回傳 `success: false` 不會自動觸發 retry。本章不替包含多個副作用的整段程式開啟盲目重試。

在 step 內再呼叫另一個 step，不會得到獨立 checkpoint；內層仍屬於外層執行。[DBOS steps 說明](https://docs.dbos.dev/typescript/tutorials/step-tutorial)列出這個限制。若未來需要每個 host 操作獨立恢復，必須重新設計 workflow 的編排邊界。

`<parentToolCallId>/external/<序號>` 只是追蹤 ID。程式重跑時，時間、隨機值或讀取結果可能改變分支與呼叫順序，序號不能直接當作可靠的業務去重鍵。

本章先用唯讀 Atlassian 工具與暫存檔案驗收。對於不可重複的寫入，需要在 host 設計穩定的操作 ID，並讓目標服務確認或去重同一操作。Code Mode 失敗不會回滾先前成功的檔案修改，DBOS 也不會替外部服務補上一個 transaction。

驗收方式見[Code Mode 驗收](verify-code-mode.md)。
