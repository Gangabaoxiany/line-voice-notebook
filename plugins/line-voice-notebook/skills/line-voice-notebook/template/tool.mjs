#!/usr/bin/env node
// LINE 語音記事本｜安裝與維修小工具（給 Claude 用；主人平常直接在 LINE 講話就好）
//
//   node tool.mjs check                  檢查 Node、wrangler、Cloudflare 登入
//   node tool.mjs init <英文名字>          建資料庫（正式＋測試）、workers.dev 網址、管理碼，寫好 wrangler.toml
//   node tool.mjs channel <Channel ID>    把 LINE 的 Channel ID 寫進 wrangler.toml
//   node tool.mjs deploy                 上線（讀 config.json，改了設定也是跑這個）
//   node tool.mjs secret                 從剪貼簿讀 LINE Channel secret → 存進 Cloudflare 機密設定（不印出來），再清空剪貼簿
//   node tool.mjs webhook                把 LINE Webhook 指到這支程式，請 LINE 打一次測試
//   node tool.mjs validate               所有訊息格式送 LINE 官方驗證（要全部 200）
//   node tool.mjs status                 系統狀態＋LINE 帳號＋本月推播用量
//   node tool.mjs list [天數]             接下來幾天的行程、待辦（預設 7）
//   node tool.mjs todo                   還沒做的待辦
//   node tool.mjs log [YYYY-MM-DD]        那天記事本的原話（預設今天）
//   node tool.mjs dict [add 錯 對 | del 錯]  錯字字典
//   node tool.mjs sql "<SQL>" [--test]    直接查資料庫
//
// 設定存在 .setup.json（帳號 ID、資料庫 ID、網址、管理碼；沒有密碼）。資料只在雲端，這支只印在螢幕上。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomInt } from "node:crypto";

const DIR = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME;
const SETUP = join(DIR, ".setup.json");
const S = existsSync(SETUP) ? JSON.parse(readFileSync(SETUP, "utf8")) : {};
const save = () => writeFileSync(SETUP, JSON.stringify(S, null, 2) + "\n");
const die = (m) => { console.error("❌ " + m); process.exit(1); };
const SCHEMA = "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER)";

// wrangler：先找 ~/.local/node（安裝工具.sh 裝的），再找系統的
function wranglerBin() {
  for (const p of [process.env.WRANGLER, `${HOME}/.local/node/bin/wrangler`, "/opt/homebrew/bin/wrangler", "/usr/local/bin/wrangler"]) if (p && existsSync(p)) return p;
  return null;
}
const PATH = `${dirname(process.execPath)}:${HOME}/.local/node/bin:${process.env.PATH}`;

// Cloudflare 權杖：讀 wrangler login 存的登入檔（快過期自動續期）
let TOKEN = "";
function token() {
  if (!TOKEN) {
    try { TOKEN = execFileSync(process.execPath, [join(DIR, "cf-token.mjs")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { die("Cloudflare 還沒登入或登入過期 → 在終端機跑 wrangler login，網頁按 Allow\n" + String(e.stderr || e.message).slice(0, 300)); }
  }
  return TOKEN;
}
async function cf(path, method = "GET", body) {
  const r = await fetch("https://api.cloudflare.com/client/v4" + path, {
    method, headers: { Authorization: "Bearer " + token(), "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!j.success) { const e = new Error(`Cloudflare ${method} ${path}：${JSON.stringify(j.errors || r.status)}`); e.codes = (j.errors || []).map((x) => x.code); throw e; }
  return j.result;
}
async function sql(q, params = [], test = false) {
  const id = test ? S.d1_test : S.d1;
  if (!id) die("還沒 init");
  const r = await cf(`/accounts/${S.account}/d1/database/${id}/query`, "POST", { sql: q, params });
  return r[0].results;
}
function wrangler(args, input) {
  const w = wranglerBin();
  if (!w) die("找不到 wrangler → 先跑 bash 安裝工具.sh");
  return execFileSync(w, args, { cwd: DIR, input, encoding: "utf8", env: { ...process.env, PATH, CLOUDFLARE_API_TOKEN: token(), CLOUDFLARE_ACCOUNT_ID: S.account }, stdio: [input === undefined ? "inherit" : "pipe", "pipe", "pipe"] });
}
const site = async (path) => { const r = await fetch(S.url + path); const t = await r.text(); try { return JSON.parse(t); } catch { return { status: r.status, text: t.slice(0, 300) }; } };

function writeToml() {
  const toml = `# 由 tool.mjs 產生；要改設定請改 config.json，再跑 node tool.mjs deploy
name = "${S.name}"
main = "worker.js"
compatibility_date = "2026-11-01"
workers_dev = true

[vars]
# LINE 官方帳號的 Channel ID（不是機密）；Channel secret 用 node tool.mjs secret 放進 Cloudflare，不寫在這裡
CHANNEL_ID = "${S.channel_id || ""}"

# 每 5 分鐘跑一次：到時間推提醒、早上推今日摘要、自我檢查
[triggers]
crons = ["*/5 * * * *"]

# 資料庫（D1）：正式＋測試（測試模式、wrangler dev 用）
[[d1_databases]]
binding = "D1"
database_name = "${S.name}"
database_id = "${S.d1}"
preview_database_id = "${S.d1_test}"

[[d1_databases]]
binding = "D1_TEST"
database_name = "${S.name}-test"
database_id = "${S.d1_test}"
preview_database_id = "${S.d1_test}"

# Workers AI：語音轉文字＋看懂句子（免費每日額度）
[ai]
binding = "AI"
`;
  writeFileSync(join(DIR, "wrangler.toml"), toml);
}

const ICON = () => { try { return Object.fromEntries(JSON.parse(readFileSync(join(DIR, "config.json"), "utf8")).categories.map((c) => [String(c.name).replace(/\s/g, ""), c.icon])); } catch { return {}; } };
const tw = (o = 0) => new Date(Date.now() + 8 * 3600e3 + o * 864e5).toISOString().slice(0, 10);
const lineOf = (r, I) => `${I[r.cat] || "📌"} ${r.kind === "todo" ? (r.done ? "✔️ " : "☐ ") : r.kind === "note" ? "📝 " : ""}${r.t ? r.t + " " : ""}${r.title}${r.who ? "｜" + r.who : ""}${r.pushed ? "（已推提醒）" : ""}`;
const getK = async (k, d) => { const r = (await sql("SELECT v FROM kv WHERE k = ?1", [k]))[0]; try { return r ? JSON.parse(r.v) : d; } catch { return r.v; } };
const putK = (k, v) => sql("INSERT INTO kv (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [k, JSON.stringify(v)]);

const [cmd, ...a] = process.argv.slice(2);

if (cmd === "check") {
  const w = wranglerBin();
  console.log(`Node：${process.version}`);
  console.log(`wrangler：${w ? execFileSync(w, ["--version"], { encoding: "utf8", env: { ...process.env, PATH } }).trim() : "❌ 沒裝 → bash 安裝工具.sh"}`);
  try {
    token();
    const acc = await cf("/accounts");
    console.log(`Cloudflare：✅ 已登入（帳號 ${acc.map((x) => x.name).join("、")}）`);
  } catch (e) { console.log("Cloudflare：❌ " + e.message.slice(0, 200)); }
  console.log(`設定：${existsSync(join(DIR, "config.json")) ? "✅ config.json 有了" : "❌ 還沒有 config.json"}；${S.url ? "網址 " + S.url : "還沒 init"}`);
} else if (cmd === "init") {
  const name = (a[0] || "").toLowerCase();
  if (!/^[a-z][a-z0-9-]{2,30}$/.test(name)) die("名字要英文小寫開頭，可以有數字和 -，3～31 個字，例如 xiaoming-notebook");
  const acc = await cf("/accounts");
  if (!acc.length) die("這個 Cloudflare 登入沒有帳號");
  S.account = S.account || acc[0].id;
  S.name = name;
  // workers.dev 網址（新帳號要先取一個子網域）
  let sub;
  try { sub = (await cf(`/accounts/${S.account}/workers/subdomain`)).subdomain; } catch { sub = ""; }
  if (!sub) {
    for (const s of [name, `${name}-${randomInt(100, 999)}`, `${name}-${randomInt(1000, 9999)}`]) {
      try { sub = (await cf(`/accounts/${S.account}/workers/subdomain`, "PUT", { subdomain: s })).subdomain; break; } catch (e) { console.log(`子網域 ${s} 不能用，換一個…`); }
    }
    if (!sub) die("workers.dev 子網域建不起來，請到 Cloudflare 網頁 Workers 頁面手動取一個");
  }
  S.url = `https://${name}.${sub}.workers.dev`;
  // 資料庫：有同名的就沿用
  const dbs = await cf(`/accounts/${S.account}/d1/database?per_page=100`);
  for (const [key, dn] of [["d1", name], ["d1_test", `${name}-test`]]) {
    const found = dbs.find((d) => d.name === dn);
    S[key] = found ? found.uuid : (await cf(`/accounts/${S.account}/d1/database`, "POST", { name: dn })).uuid;
    await sql(SCHEMA, [], key === "d1_test");
  }
  const old = (await sql("SELECT v FROM kv WHERE k = 'admin_code'"))[0];
  S.admin_code = old ? old.v : String(randomInt(10000000, 99999999));
  if (!old) await sql("INSERT INTO kv (k, v) VALUES ('admin_code', ?1)", [S.admin_code]);
  save();
  writeToml();
  console.log(`✅ 準備好了\n網址：${S.url}\n資料庫：${name}（正式）、${name}-test（測試）\n下一步：建 LINE 官方帳號，拿到 Channel ID 後跑 node tool.mjs channel <ID>`);
} else if (cmd === "channel") {
  if (!/^\d{8,12}$/.test(a[0] || "")) die("Channel ID 是一串 10 個左右的數字（LINE Developers → Basic settings）");
  S.channel_id = a[0]; save(); writeToml();
  console.log(`✅ Channel ID ${a[0]} 寫好了。下一步：node tool.mjs deploy`);
} else if (cmd === "deploy") {
  if (!existsSync(join(DIR, "config.json"))) die("還沒有 config.json");
  JSON.parse(readFileSync(join(DIR, "config.json"), "utf8")); // 格式錯就在這裡停
  if (!S.url) die("先跑 node tool.mjs init <名字>");
  writeToml();
  const out = wrangler(["deploy"]);
  console.log(out.split("\n").filter((l) => /Uploaded|Deployed|https:|schedule|Current Version/i.test(l)).join("\n"));
  await new Promise((r) => setTimeout(r, 3000));
  console.log("上線確認：", JSON.stringify(await site("/status")));
} else if (cmd === "secret") {
  // 主人在 LINE Developers 按 Channel secret 旁邊的複製鍵 → 這裡從剪貼簿讀，直接送進 Cloudflare，不印、不存檔
  const s = execFileSync("pbpaste", { encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{32}$/.test(s)) die("剪貼簿裡不是 Channel secret（應該是 32 個英數字）。請在 LINE Developers 的 Channel secret 旁邊按複製，再跑一次");
  wrangler(["secret", "put", "CHANNEL_SECRET"], s);
  execFileSync("pbcopy", { input: "" }); // 清空剪貼簿
  console.log("✅ Channel secret 存進 Cloudflare 機密設定了（沒有印出來，剪貼簿也清空了）");
} else if (cmd === "webhook") {
  const r = await site(`/setup?code=${S.admin_code}&webhook`);
  console.log(JSON.stringify(r, null, 1));
  console.log(r.test && r.test.success ? "✅ LINE 打得到這支程式了" : "❌ LINE 還打不到：看上面的 error（secret 錯就重跑 node tool.mjs secret；剛上線可以 30 秒後再試）");
} else if (cmd === "validate") {
  const r = await site(`/setup?code=${S.admin_code}&validate`);
  console.log(JSON.stringify(r.validate || r, null, 1));
} else if (cmd === "status") {
  console.log("狀態：", JSON.stringify(await site("/status"), null, 1));
  const r = await site(`/setup?code=${S.admin_code}`);
  console.log("LINE：", JSON.stringify({ 帳號: r.info, webhook: r.endpoint, 本月推播: r.quota, error: r.error }, null, 1));
} else if (cmd === "list") {
  const n = +(a[0] || 7), I = ICON();
  for (const r of await sql("SELECT k, v FROM kv WHERE k >= ?1 AND k <= ?2 ORDER BY k", [`day:${tw()}`, `day:${tw(n - 1)}`])) {
    console.log(`【${r.k.slice(4)}】`);
    for (const x of JSON.parse(r.v)) console.log("  " + lineOf(x, I));
  }
} else if (cmd === "todo") {
  const I = ICON();
  for (const r of await sql("SELECT k, v FROM kv WHERE k >= ?1 AND k <= ?2 ORDER BY k", [`day:${tw(-60)}`, `day:${tw(60)}`]))
    for (const x of JSON.parse(r.v)) if (x.kind === "todo" && !x.done) console.log(`${r.k.slice(4)}  ${lineOf(x, I)}`);
  for (const x of await getK("todo", [])) console.log(`（沒日期）  ${lineOf({ ...x, kind: "todo" }, I)}`);
} else if (cmd === "log") {
  for (const e of await getK(`log:${a[0] || tw()}`, [])) console.log(`${e.at} ${e.voice ? "🎙️" : "⌨️"} 「${e.fixed || e.text}」\n   → ${(e.got || []).join("；") || "（沒分類）"}`);
} else if (cmd === "dict") {
  const [op, wrong, right] = a;
  const d = await getK("dict", {});
  if (op === "add" && wrong && right) { d[wrong] = right; await putK("dict", d); console.log(`✅ 已加：${wrong} → ${right}`); }
  else if (op === "del" && wrong) { delete d[wrong]; await putK("dict", d); console.log(`🗑️ 已刪：${wrong}`); }
  else console.log(Object.keys(d).length ? Object.entries(d).map(([k, v]) => `${k} → ${v}`).join("\n") : "（字典是空的；內建的在 config.json 的 dict）");
} else if (cmd === "sql") {
  console.log(JSON.stringify(await sql(a[0], [], a.includes("--test")), null, 1));
} else {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 18).join("\n"));
}
