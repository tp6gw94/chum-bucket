# Planner Eval Cases

每個 `cases/*.yaml` 是一筆 promptfoo 的 test case：一份交給 Planner 的需求原文，加上「好的計畫應該具備的性質」。

期望在生成**之前**就寫好，不依據產出回頭調整。

`promptfooconfig.yaml` 以 `tests: file://cases/*.yaml` 載入全部 case，並用 `defaultTest.options` 設定評分方式。

## 檔名

`<難度代碼><編號>-<主題>.yaml`

| 代碼 | 難度   | 用途                                                   |
| ---- | ------ | ------------------------------------------------------ |
| `S`  | simple | 回歸：基本功能一定要對                                 |
| `M`  | medium | 邊界值、負向、範圍限定、未知路由                       |
| `H`  | hard   | 設計稿、跨頁狀態、多角色                               |
| `R`  | hard   | 真實資料回歸（DB 中 FETM-78 的 `jira_get_issue` 原文） |
| `E`  | edge   | 全部不支援、模糊、prompt injection、外部依賴、矛盾     |

## 欄位

一筆 test case 有四個頂層欄位：`description`、`metadata`、`vars`、`assert`。

### `description` 與 `metadata`：基本資料

`description` 是 case 標題。`metadata` 放 `id`、`difficulty`、`category`、`intent`，供篩選與報表使用。

### `vars`：交給 Planner 的內容

對應正式流程中 planner 收到的 task：atlassian 只負責讀取，host 把原文組成 requirements artifact，planner 再從原文自行定義 criteria 與 unresolved。

| 欄位                  | 說明                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `summary`             | 主 agent 委派 planner 時的摘要；範圍限定（例如只測 AC-2、AC-5）只會出現在這裡                        |
| `goal`                | requirements artifact 的 `goal`，也就是委派 atlassian 時的目標                                       |
| `sources`             | requirements artifact 的 `sources`，每筆是 `{ reference, text, links }`                              |
| `sources[].reference` | 假的需求來源，例如 `{ kind: jira, issueKey: EVAL-101 }`                                              |
| `sources[].text`      | 來源原文。Jira 為 `<key> <summary>`、空行、description（Markdown）                                   |
| `sources[].links`     | 來源附帶的 Figma 連結（只是參考，不等於 `design`）                                                   |
| `design`              | `{ fileKey, nodeId }`；沒有綁定設計稿時省略，provider 視為 `null`（promptfoo 的 vars 不接受 `null`） |

`digest` 與 `capturedAt` 由 provider 補上。task 的其餘欄位固定為 `targetUrl: null`、`plan: null`、`checks: []`。

`defaultTest.options.disableVarExpansion: true` 讓 `sources` 陣列不會被展開成多筆 test。

### `assert`：評分

每個 case 的 `assert` 第一個是 L1 的 javascript assertion，其後每個 `llm-rubric` 是一題 L2。

#### L1：程式評分

第一個 assertion 是 `type: javascript`、`metric: L1`、`value: file://l1.mjs`，評分欄位放在它的 `config`。promptfoo 以 config 所在目錄解析 `file://`，所以路徑是相對 `evals/planner/`。

原文有 `AC-1`、`UI-1` 這類標籤時，planner 必須沿用為 criterion id，因此可以用 id 評分：

| 欄位         | 判定方式                                                                             |
| ------------ | ------------------------------------------------------------------------------------ |
| `executable` | 每個 id 都要定義，且至少要有一個可執行 check                                         |
| `deferred`   | 每個 id 都要定義，不能有可執行 check，且至少要有一個 deferred expectation            |
| `either`     | 每個 id 都要定義，可執行或 deferred 都可以，但一定要涵蓋                             |
| `excluded`   | 範圍外的 id，不能出現在 `criteria`，也不能被任何 check 或 expectation 引用           |
| `literals`   | id → 字串清單；這些字串必須原樣出現在該 id 的 `expectedObservation` 中               |
| `boundaries` | id → 值清單；這些值必須出現在涵蓋該 id 的 case 的 fill 值或 `expectedObservation` 中 |

`executable`、`deferred`、`either`、`excluded` 四組加起來必須剛好等於原文中所有標籤；planner 另外拆出的 id 不扣分。

原文沒有標籤時，id 由 planner 自訂，改用不依賴 id 的欄位：

| 欄位               | 判定方式                                               |
| ------------------ | ------------------------------------------------------ |
| `minCriteria`      | `criteria` 至少要有這麼多筆                            |
| `observations`     | 這些字串必須原樣出現在某個 `expectedObservation` 中    |
| `functionalChecks` | `forbidden`：計畫中不能有任何可執行的 functional check |

兩種原文都適用：

| 欄位           | 判定方式                                              |
| -------------- | ----------------------------------------------------- |
| `unresolved`   | `required`：`unresolved` 不能是空陣列；省略代表不限   |
| `styleChecks`  | `required` 或 `forbidden`；省略代表不限               |
| `design`       | 所有 style check 都必須引用這個 `{ fileKey, nodeId }` |
| `allowedPaths` | `navigate` 只能使用這些 path；省略代表不限            |
| `forbidden`    | 這些字串不能出現在整份計畫 JSON 的任何地方            |

#### L2：LLM judge

每個 `llm-rubric` assertion（`metric: L2`）是一題獨立的是非題，用自然語言寫出程式難以判斷的性質，包括 `unresolved` 應該記下哪些缺口。

Judge 由 `promptfooconfig.yaml` 的 `defaultTest.options.provider` 指定：DeepInfra 的 `zai-org/GLM-5.3-Flash`，API key 讀取環境變數 `MODEL_API_KEY`。

## Case 一覽

| 檔案                               | 測什麼                                                               |
| ---------------------------------- | -------------------------------------------------------------------- |
| `S01-login-wrong-password`         | 負向輸入、空白欄位、未知 origin 下的 URL 檢查                        |
| `S02-newsletter-subscribe`         | 正向、空白、格式錯誤；不驗證寄信                                     |
| `S03-todo-add`                     | 新增、空清單、只有空白字元的輸入                                     |
| `S04-about-static-page`            | 無標籤的散文原文；最小計畫：純 navigate + 文字檢查，不灌水           |
| `S05-dark-mode-toggle`             | 狀態切換；無 design 時背景色要 defer；不捏造保存行為                 |
| `M01-age-field-boundary`           | 17 / 18 / 65 / 66 邊界值；不能把多個輸入塞進同一 case                |
| `M02-coupon-code`                  | 金額字面值、大小寫不敏感、重複套用                                   |
| `M03-product-search`               | 無結果、空白查詢、前後空白                                           |
| `M04-signup-wizard-unknown-routes` | 只知道 `/`，後續步驟靠點擊；資料不足的步驟要 defer 並記入 unresolved |
| `M05-scoped-subset`                | `summary` 限定只測 AC-2、AC-5，不能定義或碰其他 criteria             |
| `H01-design-bound-button`          | 有 design：style check 只能用指定 node；hover / 其他 node 要 defer   |
| `H02-design-null-mixed`            | 無 design：所有樣式需求 defer，且原樣保留數值                        |
| `H04-ticket-discount-crossflow`    | 跨頁、折扣計算（2 張 vs 3 張）、隨機訂單編號用 contains              |
| `H05-multi-role-permissions`       | 需要登入帳號的需求要 defer，記下缺少的帳號，不捏造帳密               |
| `R01-fetm-78-scone-cart`           | 真實原文，沒有 AC 標籤；已知失敗：在 `/` 操作購物車頁才有的控制項    |
| `E01-all-unsupported`              | 全部是 hover / focus / 響應式 / 字型，cases 可為 `[]`                |
| `E02-vague-requirements`           | 無標籤、不可量測；不能自行發明門檻或文案                             |
| `E03-prompt-injection`             | 原文夾帶指令；不能照做                                               |
| `E04-external-dependencies`        | 信箱、時間、測試帳號都無法取得                                       |
| `E05-contradiction`                | 上限 5 顆 vs 10 顆；記入 unresolved，不能默默選邊                    |
