# Planner Eval

每個 `cases/*.yaml` 是一筆 promptfoo test case，內容是一份交給 Planner 的需求原文，加上好計畫應該具備的性質。`provider.ts` 把 case 的 `vars` 組成正式流程的 planner task，再呼叫 `runPlanner`。

## 執行

從 repo 根目錄執行。promptfoo 會讀取 cwd 的 `.env`，所以 `.env` 要有 `MODEL_API_KEY`。

```sh
pnpm eval:planner
pnpm eval:planner --filter-metadata id=S01-login-wrong-password
pnpm exec promptfoo view
```

第一行跑全部 case，第二行只跑一個 case，第三行開啟結果頁面。

## 評分

每個 case 的第一個 assertion 是 L1，由 `l1.mjs` 以程式評分，規則寫在它的 `config`。`l1.mjs` 的 default export 列出所有支援的 config key，每條規則的語意由 `tests/evals/planner-l1.test.ts` 定義。

其餘的 `llm-rubric` assertion 是 L2，每題是一個交給 LLM judge 的是非題。Judge 的模型與 prompt 寫在 `promptfooconfig.yaml` 的 `defaultTest.options`。

## 撰寫 case

程式不會檢查下面這些規則，寫 case 時要自己遵守：

- 在看到 Planner 的產出之前寫好期望。不要依產出回頭調整。
- 原文有 `AC-1` 這類標籤時，`executable`、`deferred`、`either`、`excluded` 四組加起來必須剛好等於原文的所有標籤。
- 範圍限定（例如只測 AC-2 與 AC-5）只寫在 `vars.summary`，不寫進 `vars.goal`。
- 沒有設計稿時省略 `vars.design`，不要寫 `null`。promptfoo 的 vars 不接受 `null`。
- `description` 寫 case 標題，`metadata.intent` 寫這個 case 要測什麼。

檔名格式為 `<難度代碼><編號>-<主題>.yaml`：

| 代碼 | 難度   | 用途                                                   |
| ---- | ------ | ------------------------------------------------------ |
| `S`  | simple | 回歸：基本功能一定要對                                 |
| `M`  | medium | 邊界值、負向、範圍限定、未知路由                       |
| `H`  | hard   | 設計稿、跨頁狀態、多角色                               |
| `R`  | hard   | 真實資料回歸（DB 中 FETM-78 的 `jira_get_issue` 原文） |
| `E`  | edge   | 全部不支援、模糊、prompt injection、外部依賴、矛盾     |
