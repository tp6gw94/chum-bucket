# 司康小舖

原生靜態多頁網站，無須安裝依賴或建置。

使用原本的 serve 指令啟動：

```sh
cd demo-site
npx serve .
```

開啟終端顯示的網址。也可以從 repo 根目錄執行 `npx serve .` 後開啟 `/demo-site/`。不需要額外設定 cleanUrls。

若環境已有 Python，也能從 repo 根目錄啟動：

```sh
python3 -m http.server 8080 --bind 127.0.0.1 --directory demo-site
```

開啟 http://127.0.0.1:8080/ 。若伺服器以 repo 根目錄啟動，開啟 `/demo-site/`。所有頁面、JS、CSS 和圖片使用同目錄的相對路徑；請完整保留 `demo-site/`，不要只複製 HTML。請以 HTTP(S) 開啟，避免 file URL 的儲存行為差異。

頁面為 `index.html` 首頁、`product.html` 商品詳情、`cart.html` 購物車、`checkout.html` 確認訂單、`order.html` 完成明細。共用 `styles.css`、`shop.js` 與本地 `scone.svg`。

商品使用 JS 固定 mock 資料。訂單僅儲存於瀏覽器，沒有真實收款、配送或訂單服務，也没有登入、地址、信用卡、後台、外部 API 或資料庫。

購物車與最近 20 筆訂單儲存在目前 origin 的 localStorage（`scone-shop:v1`），跨頁、返回與重新整理會保留。舊版單筆訂單會在讀取時保留到新的訂單清單。成功提交會以一次寫入清空數量並保留訂單摘要，空車不能再提交；下一筆訂單不會覆蓋前一筆明細，超過 20 筆後移除最舊一筆。保存失敗時保留購物車，不跳轉完成頁。不同 port／origin 不共用購物車。清除此站網站資料，或在瀏覽器開發工具刪除該 key，即可完全重設；改版前單頁記憶體資料不會遷移。

完成頁使用 `order.html#order=<UUID>`。serve 的 cleanUrls 301 redirect 會移除 `.html` 和 query，瀏覽器仍保留 fragment，因此訂單 ID 不會遺失。URL 只帶訂單 ID，不帶備註或其他個資。完成頁只顯示 ID 相符的訂單；缺少、未知、格式錯誤或重複的 ID 都顯示找不到，不會默認顯示最近一單。沒有被伺服器移除的舊 `?order=<UUID>` 連結仍可讀取，但已遺失的 ID 無法安全猜回。

頁面使用 defer 載入共用 JS，依 data 屬性绑定目前存在的控制項。載入完成前按鈕停用；無 JavaScript 或無法使用 localStorage 時會顯示提示，避免看似成功卻未保存。瀏覽器預覽環境必須允許載入本地 JS/CSS 並執行 script。

提交前在 repo 根目錄執行 `fallow audit --config demo-site/.fallowrc.json --base main --format json --quiet --explain --gate-marker agent`；專用設定只補上靜態頁直接載入的入口，繼承 repo 規則。


## 回歸測試

網站執行不需要套件。測試使用 Node.js 24、jsdom 與 serve-handler，可以把測試依賴放在 repo 外：

```sh
export SCONE_TEST_TOOLS="$(mktemp -d)"
npm install --prefix "$SCONE_TEST_TOOLS" --no-save --ignore-scripts jsdom@27.4.0 serve-handler@6.1.6
node --test demo-site/tests/shop.test.mjs
```

從 repo 根目錄執行。12 個測試會讀取實際 HTML 與 shop.js，在 jsdom 中驗證購物、重複提交、下一筆訂單、舊資料、ID 錯誤、20 筆保存上限與保存失敗，再啟動真正的 serve-handler 以 HTTP 核實 301 redirect 和根路徑／子目錄服務。jsdom 的 pageshow、hashchange 與 popstate 事件測試不等同瀏覽器的歷史與 BFCache 測試。

瀏覽器驗收：

1. 以 `npx serve .` 啟動，商品頁加入 1 顆，從購物車結帳。確認完成網址為 `/order#order=<UUID>`，小計 NT$100、運費 NT$50、總額 NT$150。
2. 重新整理完成頁，再返回結帳頁。舊單明細不變，空車不能再次送出。
3. 再購買 3 顆。確認第二筆總額 NT$300，兩筆 ID 不同，原完成頁連結仍顯示第一筆。
4. 改為未知 ID、移除 ID 或重複 order 參數。應顯示找不到訂單，不能顯示最近一筆。
5. 分別由 demo-site 目錄和 repo 根目錄啟動，確認完整流程與相對資源路徑。

本次環境通過上述自動化測試；Chromium 啟動受環境 socket 權限阻擋，因此尚未完成真實瀏覽器驗收。
