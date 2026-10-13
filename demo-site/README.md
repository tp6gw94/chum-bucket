# 司康小舖

原生靜態多頁網站，無須安裝依賴或建置。

從 repo 根目錄以現有 Python 靜態伺服器啟動：

```sh
python3 -m http.server 8080 --bind 127.0.0.1 --directory demo-site
```

開啟 http://127.0.0.1:8080/ 。若伺服器以 repo 根目錄啟動，開啟 `/demo-site/`。所有頁面、JS、CSS 和圖片使用同目錄的相對路徑；請完整保留 `demo-site/`，不要只複製 HTML。請以 HTTP(S) 開啟，避免 file URL 的儲存行為差異。

頁面為 `index.html` 首頁、`product.html` 商品詳情、`cart.html` 購物車、`checkout.html` 確認訂單、`order.html` 完成明細。共用 `styles.css`、`shop.js` 與本地 `scone.svg`。

商品使用 JS 固定 mock 資料。訂單僅儲存於瀏覽器，沒有真實收款、配送或訂單服務，也没有登入、地址、信用卡、後台、外部 API 或資料庫。

購物車與最近一筆訂單儲存在目前 origin 的 localStorage（`scone-shop:v1`），跨頁、返回與重新整理會保留。成功提交會以一次寫入清空數量並保留訂單摘要，空車不能再提交；完成頁 URL 的 order ID 須符合最近一筆訂單。不同 port／origin 不共用購物車。清除此站網站資料，或在瀏覽器開發工具刪除該 key，即可完全重設；改版前單頁記憶體資料不會遷移。

頁面使用 defer 載入共用 JS，依 data 屬性绑定目前存在的控制項。載入完成前按鈕停用；無 JavaScript 或無法使用 localStorage 時會顯示提示，避免看似成功卻未保存。瀏覽器預覽環境必須允許載入本地 JS/CSS 並執行 script。


