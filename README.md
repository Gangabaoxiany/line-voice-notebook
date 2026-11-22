# LINE 語音記事本

**在 LINE 跟自己的機器人講話（語音或打字）→ 原話存進記事本 → AI 自動分類 → 行程前 LINE 提醒、每天早上推今日摘要 → 同步 iPhone／Google 行事曆。**

- 全免費：Cloudflare 免費方案＋LINE 每月 200 則免費推播
- 資料存在你自己的 Cloudflare 帳號，別人看不到
- 一句話講好幾件事也會自動分開記；講錯字跟它說「剛剛的 X 是 Y」，以後自動改

## 需要準備
| 項目 | 說明 |
|---|---|
| Mac＋電腦版 Claude | Claude Desktop 的「Code」分頁，或 Claude Code |
| LINE 帳號 | 用來開你自己的 LINE 官方帳號（免費） |
| 一個 email | 註冊 Cloudflare 用（免費） |
| 時間 | 大約 40 分鐘，Claude 會一步一步帶你 |

## 安裝（兩步）
1. 打開電腦版 Claude 的 Code 分頁，貼上這句：

   > 幫我安裝這個外掛：GitHub 上的 Gangabaoxiany/line-voice-notebook，照它 README 的「給 Claude 看」做

2. 裝好後開一個新對話，說：**幫我裝 LINE 語音記事本**

之後要修或改設定，跟 Claude 說「LINE 記事本壞了」「改早上摘要時間」就好。

---

## 給 Claude 看（安裝方法）
這是 Claude Code 外掛市集。用外掛指令安裝；`claude` 不在 PATH 時，Mac 版 Claude Desktop 內建的程式在
`~/Library/Application Support/Claude/claude-code/<版本>/<一串英數字>/claude.app/Contents/MacOS/claude`（選最新版本那個）。

```bash
claude plugin marketplace add Gangabaoxiany/line-voice-notebook
claude plugin install line-voice-notebook@line-voice-notebook
```

裝好後請使用者開新對話（或在對話裡打 `/reload-plugins`），再說「幫我裝 LINE 語音記事本」。

## 裡面有什麼
- `plugins/line-voice-notebook/skills/line-voice-notebook/SKILL.md`：安裝精靈（8 關）＋維修
- `…/template/`：機器人程式（`worker.js`，Cloudflare Worker）、設定範本、安裝與維修工具 `tool.mjs`
- `…/references/`：LINE 後台設定步驟、卡關排除、說明書範本
- 不含任何密碼或鑰匙；LINE 的 Channel secret 安裝時直接從剪貼簿送進你自己的 Cloudflare，不會出現在對話或檔案裡
