# 第 5、7 關：LINE 官方帳號設定（一步一步帶他）

> LINE 的後台畫面偶爾會改版，按鈕名字可能不一樣。對不上的時候請他截圖，照畫面找最接近的按鈕，不要硬照這份。
> 有瀏覽器工具（Claude in Chrome、內建瀏覽器）就幫他點；登入、QR Code、驗證碼一律他自己來。

## 瀏覽器已經登入別人的 LINE？
不要登出（那可能是家人的帳號，登出會害對方的東西壞掉）。另開一個**全新空白**的 Chrome 視窗給他登入自己的：
```bash
open -na "Google Chrome" --args --user-data-dir="$HOME/.line-notebook-chrome" https://entry.line.biz/start/tw/
```

## A. 建 LINE 官方帳號（免費）
1. 打開 https://entry.line.biz/start/tw/ →「免費開設帳號」
2. 「使用 LINE 帳號登入」→ 他用手機 LINE 掃 QR Code（或輸入 email 密碼、手機上的認證碼）
3. 填表：
   - 帳號名稱：第 1 關取的機器人名字
   - 電子郵件：他的 email
   - 公司名稱：可以填自己的名字
   - 業種：選最接近的（例如「個人」相關的類別，沒有就選「其他」）
4. 確認 → 完成 →「前往 LINE Official Account Manager」
5. 他的 LINE 通常會自動加這個帳號好友；沒有的話：後台首頁「增加好友」→ QR Code 用手機掃

## B. 開 Messaging API、拿 Channel ID
1. LINE Official Account Manager 右上「設定」→ 左邊「Messaging API」→「啟用 Messaging API」
2. 服務提供者：「建立新的服務提供者」，名字填他的名字或暱稱 → 隱私權政策、服務條款網址都留空 →「確定」
3. 打開 https://developers.line.biz/console/ → 點剛剛的服務提供者 → 點跟機器人同名的頻道 →「Basic settings」
4. **Channel ID**（一串數字，不是機密）：請他念給你，或你看畫面 → `node tool.mjs channel <ID>`
5. **Channel secret**：不要截這一塊、不要念出來。第 6 關 deploy 完，請他按 Channel secret 旁邊的複製圖示 → 你跑 `node tool.mjs secret`（從剪貼簿直接送進 Cloudflare，再清空剪貼簿）

## C. 第 7 關：回應設定
LINE Official Account Manager →「設定」→「回應設定」：
| 項目 | 設成 | 為什麼 |
|---|---|---|
| 聊天 | 關 | 開著的話是真人聊天模式，機器人收不到 |
| 加入好友的歡迎訊息 | 關 | 機器人自己會打招呼，不然會講兩次 |
| 自動回應訊息 | 關 | 不然 LINE 會搶著回罐頭訊息 |
| Webhook | 開 | 機器人靠這個收到他講的話 |

設好後跑 `node tool.mjs status`，`LINE.帳號.chatMode` 應該是 `bot`。
