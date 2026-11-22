---
name: line-voice-notebook
description: 「LINE 語音記事本」安裝精靈＋維修。幫使用者用自己的 Cloudflare（免費）和 LINE 官方帳號（免費）架一個 LINE 機器人：在 LINE 講話（語音或打字）→ 原話存進記事本 → AI 自動分類 → 行程前 LINE 提醒、每天早上推今日摘要 → 同步 iPhone／Google 行事曆。使用者說「幫我裝 LINE 語音記事本」「LINE 記事機器人」「LINE 語音記事」「裝記事本」「開始安裝」時一定要用；裝好之後說「記事本壞了」「LINE 記事本沒回」「沒收到提醒」「改分類」「改早上摘要時間」「改提醒時間」「加常用詞」也用這支，就算沒講到 LINE 也一樣。主動更新時機：安裝卡關、踩到新的坑，把解法補進 references/卡關排除.md。
---

# LINE 語音記事本｜安裝精靈

**一句話：照下面 8 關，一關一關帶使用者架好自己的 LINE 語音記事本；他手機真的收到 LINE 提醒，才算裝好。**

## 怎麼帶（原則）
- **他多半不懂技術**：一次只叫他做一件事，講清楚「點哪裡、會看到什麼」。能用指令代做的就代做，不叫他打指令、不叫他複製貼上長字串——他會累、會漏。
- **繁體中文（台灣用語）**，先講結論再講下一步，語氣輕鬆帶點鼓勵。
- **全程免費**：Cloudflare 免費方案＋LINE 每月 200 則免費推播。畫面要他填信用卡或升級方案 → 停下來，這套用不到。
- **鑰匙不經過對話**：LINE 的 Channel secret 用 `tool.mjs secret` 從剪貼簿直接送進 Cloudflare，不叫他貼進對話、也不印出來。他已經貼進對話了 → 請他到 LINE Developers 按「Issue」重發一組再走一次。
- **他的帳號他自己按**：密碼、驗證碼、QR Code 登入都他自己來；建帳號、同意條款之前先問他。瀏覽器裡已經登入別人的 LINE → 不要登出，另開一個空白 Chrome 視窗給他登入（做法見 references/LINE設定.md）。
- **每關都要證據**：指令輸出、他的截圖、或他說看到了什麼，才進下一關。沒驗證就說「還沒驗證」。

## 開始前
1. 確認是 **Mac 上的電腦版 Claude**（Code 分頁或 Claude Code）——要跑指令。不是 Mac → 跟他說目前只有 Mac 版。
2. 工作資料夾：問他放哪（建議 `~/Documents/LINE語音記事本/`）。已經有 `.setup.json` 的資料夾＝裝過了 → 跳到「裝好之後」。
3. 新裝：把這支 skill 的 `template/` 整包複製過去，之後所有指令都在工作資料夾裡跑：
   ```bash
   mkdir -p ~/Documents/LINE語音記事本 && cp -R "<這支 skill 的資料夾>/template/." ~/Documents/LINE語音記事本/ && chmod +x ~/Documents/LINE語音記事本/*.command
   ```
   指令一律寫 `~/.local/node/bin/node tool.mjs …`（下面簡寫 `node tool.mjs`）。

## 8 關
| 關 | 做什麼 | 誰做 | 過關證據 |
|---|---|---|---|
| 1 問設定 | 問下面 6 件事，寫成 `config.json` | 你問他答 | config.json 念給他聽，他說 OK |
| 2 裝工具 | `bash 安裝工具.sh`（裝 Node＋wrangler 到 ~/.local/node，不用密碼） | 你 | 印出 ✅ 和版本 |
| 3 Cloudflare | 沒帳號 → 開 https://dash.cloudflare.com/sign-up 讓他註冊（免費、要收驗證信）；然後 `open 登入Cloudflare.command`，他在網頁按 Allow | 他 | `node tool.mjs check` 顯示 ✅ 已登入 |
| 4 建資料庫 | `node tool.mjs init <英文名>`，例如 `xiaoming-notebook` | 你 | 印出網址 |
| 5 LINE 帳號 | 照 references/LINE設定.md：建官方帳號 → 開 Messaging API → 拿 Channel ID → `node tool.mjs channel <ID>` | 他點、你帶 | Channel ID 寫進去 |
| 6 上線 | `node tool.mjs deploy` → 請他在 LINE Developers 按 Channel secret 旁的📋複製 → `node tool.mjs secret` → `node tool.mjs webhook` → `node tool.mjs validate` | 你 | webhook ✅、validate 全部 200 |
| 7 回應設定 | LINE 官方帳號後台「回應設定」：聊天 關、加入好友的歡迎訊息 關、自動回應訊息 關、Webhook 開（不然會跟機器人搶著回） | 他點、你帶 | 截圖或他說看到 |
| 8 驗收 | 見下面 | 一起 | 他手機真的收到 |

### 第 1 關：一次問完這 6 件事（給選項，也讓他自己打）
1. **機器人名字**（LINE 上看到的＝行事曆名字），例如「小明的生活日誌」
2. **怎麼叫他**（早安摘要會說「早安○○」）
3. **一兩句自我介紹**：做什麼工作、家人、常做的事、常提到的人——AI 靠這個分類，越具體越準
4. **分類 3～6 類**，最後一類放雜事：先依第 3 題提一組建議讓他改。每類要 `icon`、一句 `desc`、幾個 `keywords`
5. **早上幾點推今日摘要**（預設 09:30，限 05:00～21:00）、**行程前幾分鐘提醒**（預設 30）
6. **手機是 iPhone 還是 Android**（第 8 關裝行事曆用）

照 `config.example.json` 的格式寫 `config.json`；`words` 放他常講的專有名詞、人名（語音辨識比較會寫對字）。`fallback` 填雜事那一類的名字。

## 第 8 關：驗收（做到 1～4 才能說「能用了」）
1. 請他用 LINE **傳語音**：「十分鐘後提醒我喝水，明天下午三點跟朋友喝咖啡」→ 機器人回「OK，幫你記了」＋兩筆（第一次講話會自動綁定他本人）
2. `node tool.mjs log` 看到原話、`node tool.mjs list 2` 看到分類對
3. 請他按「📲 裝到手機行事曆」照網頁做 → `node tool.mjs status` 的 `calendar_installed` 有時間；請他打開手機行事曆，看到明天的喝咖啡
4. 喝水時間到（排程 5 分鐘一次，最多晚 5 分鐘）→ **他手機真的收到 ⏰ 提醒**，請他截圖或回報
5. 明天早上摘要時間過後：`status` 的 `last_run` 是「今天 ok」，他也說有收到

最後在工作資料夾寫 `說明.md`（照 references/說明範本.md 填他的資料），跟他說：以後在 Claude 說「**LINE 記事本壞了**」就會照說明修。

## 裝好之後（維修、改設定）
- 先到工作資料夾（找 `.setup.json`；找不到就問他放哪）跑 `node tool.mjs status`
- 改名字、分類、時間、常用詞 → 改 `config.json` → `node tool.mjs deploy`（資料不會不見）
- 看資料：`node tool.mjs list 7`／`todo`／`log 2026-01-31`／`dict`
- 各種壞法和測試方法 → references/卡關排除.md
- 改了程式 → 上線前 `node tool.mjs validate` 要全部 200
