#!/usr/bin/env node
// 印出一張有效的 Cloudflare 權杖（給 tool.mjs／wrangler 用）
// 為什麼需要：在 Claude 的環境裡，wrangler 有時讀不到自己的登入檔，也不會自己續期。
// 這支直接讀 `wrangler login` 存的登入檔，快過期就用 refresh_token 換新的，再寫回去（跟 wrangler 自己做的一樣）。
// 權杖只印到 stdout 給指令用，不寫進任何其他檔案。
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const H = process.env.HOME;
const FILE = [`${H}/Library/Preferences/.wrangler/config/default.toml`, `${H}/.config/.wrangler/config/default.toml`, `${H}/.wrangler/config/default.toml`].find(existsSync);
const CLIENT_ID = "54d11594-84e4-41aa-b438-e81b8fa78ee7"; // wrangler 公開的 OAuth client id

if (!FILE) { console.error("找不到 Cloudflare 登入檔 → 在終端機跑一次 wrangler login，網頁按 Allow"); process.exit(1); }
let text = readFileSync(FILE, "utf8");
const get = (k) => (text.match(new RegExp(`^${k} = "([^"]*)"`, "m")) || [])[1];
const exp = Date.parse(get("expiration_time") || 0);

if (!(exp - Date.now() > 5 * 60 * 1000)) {
  const res = await fetch("https://dash.cloudflare.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: get("refresh_token") || "", client_id: CLIENT_ID }),
  });
  const j = await res.json();
  if (!j.access_token) {
    console.error("續期失敗：", j.error || res.status, "→ 在終端機重跑一次 wrangler login");
    process.exit(1);
  }
  const set = (k, v) => { text = text.replace(new RegExp(`^${k} = "[^"]*"`, "m"), `${k} = "${v}"`); };
  set("oauth_token", j.access_token);
  if (j.refresh_token) set("refresh_token", j.refresh_token);
  set("expiration_time", new Date(Date.now() + (j.expires_in || 3600) * 1000).toISOString());
  writeFileSync(FILE, text, { mode: 0o600 });
}
process.stdout.write(get("oauth_token"));
