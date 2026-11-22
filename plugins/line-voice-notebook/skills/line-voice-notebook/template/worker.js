// LINE 語音記事本｜LINE 講話 → 記事本＋自動分類＋提醒＋手機行事曆（Cloudflare Worker 免費方案）
//
// 主人在 LINE 跟機器人講話（語音或打字）→ 原話先存進記事本 → AI 整理、分類 → 回「OK，幫你記了」
//   ・行程（開會、看醫生、聚餐…）：前 N 分鐘 LINE 提醒＋同步手機行事曆
//   ・待辦（要做的事，可以有期限、幾點提醒）：每天早上摘要列出來，做完按 ✅ 或講「○○做完了」
//   ・記事（發生的事、成果、想法）：記在當天，可以「這週回顧」「查 ○○」
// 個人設定（名字、分類、提醒時間）都在 config.json，這支程式不用改。
// 排程每 5 分鐘一次：到時間就推提醒；早上推今日摘要（週一附月曆＋上週回顧）；之後自我檢查，壞了 LINE 通知主人。
//
// 資料存在 Cloudflare D1（SQLite）的 kv 表，用法跟 KV 一樣（key → JSON 字串）。
// 為什麼不用 KV：KV 免費寫入一天只有 1,000 次，整個帳號共用，很容易被別的程式用光。
//   owner                 主人的 LINE userId（第一個傳話的人自動綁定）
//   day:YYYY-MM-DD        那天的行程、有日期的待辦、記事 [{id,kind:event|todo|note,t,end,cat,title,who,place,note,src,done,pushed}]
//   todo                  沒有日期的待辦 [{id,kind:"todo",cat,title,who,note,src,at}]
//   log:YYYY-MM-DD        記事本：當天每一句原話 [{id,at,text,fixed,voice,got[]}]（不管 AI 看不看得懂，一定先存）
//   names / dict          講過的人名（語音校正用）／錯字字典 {聽錯的寫法: 正確寫法}
//   cal_key / admin_code  行事曆網址密碼、管理碼（/setup 用；也給別的 LINE 帳號開測試）
//   errors / last_run / recent / testing / testers / mute:*
// 機密：CHANNEL_SECRET 用 wrangler secret put；權杖每次用 Channel ID＋secret 換 15 分鐘的臨時權杖。
import CFG from "./config.json";

const API = "https://api.line.me/v2/bot";
let BASE = ""; // 這支程式自己的網址：收到第一個請求時自動記下（不用寫死）
const DAY = 24 * 60 * 60 * 1000;
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
const STT_MODEL = "@cf/openai/whisper-large-v3-turbo";
// 第一個壞了（例如被 Cloudflare 下架）自動換下一個，並通知主人
// 比過：llama-3.3-70b 五題全對、1.4～2.7 秒；gpt-oss-20b 會把兩個人混成一人、最慢 32 秒（超過 LINE 30 秒會沒回覆）
const LLM_MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/openai/gpt-oss-20b", "@cf/qwen/qwen3.8-27b"];
const BOT = CFG.botName || "語音記事本"; // LINE 帳號名稱＝手機行事曆名稱
const ME = CFG.ownerCall || ""; // 機器人怎麼叫主人
const hi = (s = "") => (ME ? `${s}${ME}` : s); // 「早安小明」「早安」
const MORNING = CFG.morning || "09:30"; // 每天推今日摘要
const addMin = (t, n) => { const m = +t.slice(0, 2) * 60 + +t.slice(3) + n; return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
const CHECK = addMin(MORNING, 30); // 摘要後 30 分鐘自我檢查（摘要沒發出去會通知）
const BEFORE = +CFG.before || 30; // 行程前幾分鐘提醒
const QUOTA_STOP = 185; // LINE 免費 200 則／月：用到這裡就不推提醒（改靠手機行事曆響），留給早上摘要
// 分類（config.json 的 categories）：key 去掉空白，顯示用原本的名字
const CATS = {}, CAT_NAME = {}, CAT_KW = [];
for (const c of CFG.categories || []) {
  const k = String(c.name).replace(/\s/g, "");
  CATS[k] = c.icon || "📌"; CAT_NAME[k] = c.name;
  if (c.keywords) CAT_KW.push([new RegExp(c.keywords, "i"), k]);
}
const FALLBACK = String(CFG.fallback || Object.keys(CATS).pop() || "待辦").replace(/\s/g, ""); // 哪一類都不像就放這
if (!CATS[FALLBACK]) { CATS[FALLBACK] = "📌"; CAT_NAME[FALLBACK] = FALLBACK; }
const KIND_NAME = { event: "行程", todo: "待辦", note: "記事" };
const FIX_HINT = "要修：打開電腦的 Claude，說「LINE 記事本壞了」，它會照說明書修。";
// 語音常聽錯的字（config.json 的 dict）；主人糾正過的另外存在資料庫 dict，越用越準
const BASE_DICT = { "Cloud Code": "Claude Code", "cloud code": "Claude Code", ...(CFG.dict || {}) };
// 台灣常見姓氏；語音常把姓聽成同音字（喝大哥→何大哥），稱呼的姓由程式改，不給 AI 亂配
const SURNAMES = "陳林黃張李王吳劉蔡楊許鄭謝洪郭邱曾廖賴徐周葉蘇莊呂江何蕭羅高潘簡朱鍾鐘游彭詹胡施沈余盧梁趙顏柯翁魏孫戴范方宋鄧杜傅侯曹薛丁卓阮馬董溫唐藍石蔣古紀姚連馮歐程湯田康姜白汪鄒尤巫黎涂龔嚴韓袁金童陸夏柳邵錢伍倪于譚駱熊任甘秦顧毛章史官萬俞雷饒闕凌崔尹孔辛武辜陶段龍韋葛池孟褚殷麥賀賈莫文管關向包丘梅利裴樊房全左花";
const SURNAME_FIX = { 喝: "何", 河: "何", 合: "何", 和: "何", 成: "陳", 晨: "陳", 沉: "陳", 零: "林", 鈴: "林", 臨: "林", 琳: "林", 淋: "林", 皇: "黃", 煌: "黃", 紅: "洪", 裡: "李", 理: "李", 禮: "李", 無: "吳", 五: "吳", 流: "劉", 留: "劉", 菜: "蔡", 彩: "蔡", 陽: "楊", 洋: "楊", 羊: "楊", 需: "許", 正: "鄭", 政: "鄭", 寫: "謝", 國: "郭", 過: "郭", 秋: "邱", 球: "邱", 增: "曾", 料: "廖", 來: "賴", 週: "周", 州: "周", 業: "葉", 夜: "葉", 酥: "蘇", 裝: "莊", 旅: "呂", 將: "江", 消: "蕭", 蘿: "羅", 糕: "高", 盤: "潘", 豬: "朱", 遊: "游", 朋: "彭", 沾: "詹", 湖: "胡", 壺: "胡", 師: "施", 詩: "施", 涼: "梁", 良: "梁", 照: "趙", 言: "顏", 鹽: "顏", 科: "柯", 為: "魏", 位: "魏", 送: "宋", 肚: "杜", 猴: "侯", 懂: "董", 糖: "唐", 獎: "蔣", 講: "蔣", 記: "紀", 搖: "姚", 蓮: "連", 甜: "田", 百: "白", 由: "尤", 梨: "黎", 寒: "韓", 今: "金", 下: "夏" };
const HONORIFIC = /(小姐|太太|先生|阿姨|姐|哥|老師|媽媽|阿嬤|伯|叔|經理|總|董|主任|醫師|醫生|老闆|襄理|協理|處長)$/; // 「王大哥」這種稱呼不進字典，免得改錯別人

let NOW = 0; // 測試用：假裝現在是幾點（只有 wrangler dev 的 /test-cron 會設）
const now = () => NOW || Date.now();
const twDate = (offset = 0) => new Date(now() + 8 * 3600 * 1000 + offset * DAY).toISOString().slice(0, 10);
const twTime = () => new Date(now() + 8 * 3600 * 1000).toISOString().slice(11, 16);
const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
const wk = (d) => WEEK[new Date(d + "T00:00:00Z").getUTCDay()];
const addDays = (d, n) => new Date(new Date(d + "T00:00:00Z").getTime() + n * DAY).toISOString().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const isTime = (s) => /^\d{1,2}:\d{2}$/.test(s || "") && +s.split(":")[0] < 24 && +s.split(":")[1] < 60;
const pad = (t) => t.padStart(5, "0");
const msOf = (d, t) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), +t.slice(0, 2) - 8, +t.slice(3, 5)); // 台灣時間 → 毫秒
const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clean = (s) => (s === null || s === undefined ? "" : String(s).trim());
const icon = (c) => CATS[c] || "📌";
function catOf(c) {
  c = clean(c).replace(/\s/g, "");
  if (CATS[c]) return c;
  for (const [re, k] of CAT_KW) if (re.test(c)) return k; // AI 寫了很像的分類名（例如「家庭」→「生活」）
  return FALLBACK;
}

// ───── 資料庫：D1 包成跟 KV 一樣的用法（get/put/delete/list），另外多一個 range 一次讀一段日期 ─────
function d1kv(db, pre = "") {
  return {
    async get(k) {
      const r = await db.prepare("SELECT v FROM kv WHERE k = ?1 AND (exp IS NULL OR exp > ?2)").bind(pre + k, Date.now()).first();
      return r ? r.v : null;
    },
    async put(k, v, o = {}) {
      await db.prepare("INSERT INTO kv (k, v, exp) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET v = excluded.v, exp = excluded.exp")
        .bind(pre + k, String(v), o.expirationTtl ? Date.now() + o.expirationTtl * 1000 : null).run();
    },
    async delete(k) { await db.prepare("DELETE FROM kv WHERE k = ?1").bind(pre + k).run(); },
    async list(o = {}) {
      const p = pre + (o.prefix || "");
      const { results } = await db.prepare("SELECT k FROM kv WHERE k >= ?1 AND k < ?2 AND (exp IS NULL OR exp > ?3) ORDER BY k").bind(p, p + "￿", Date.now()).all();
      return { keys: results.map((r) => ({ name: r.k.slice(pre.length) })), list_complete: true };
    },
    async range(a, b) {
      const { results } = await db.prepare("SELECT k, v FROM kv WHERE k >= ?1 AND k <= ?2 AND (exp IS NULL OR exp > ?3) ORDER BY k").bind(pre + a, pre + b, Date.now()).all();
      return results.map((r) => ({ name: r.k.slice(pre.length), value: r.v }));
    },
  };
}
const SCHEMA = "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER)";
function wrap(env) {
  const e = Object.create(env);
  e.DB = d1kv(env.D1);
  return e;
}

// ───── LINE ─────
async function token(env) {
  const res = await fetch("https://api.line.me/oauth2/v3/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.CHANNEL_ID, client_secret: env.CHANNEL_SECRET }),
  });
  const body = await res.json();
  if (!body.access_token) throw new Error("LINE token: " + JSON.stringify(body));
  return body.access_token;
}

async function line(env, path, payload, method = "POST") {
  if (env.TEST_MODE === "1") { (env.__sent ||= []).push({ path, payload }); return; } // 測試時不真的發
  const res = await fetch(API + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + (await token(env)) },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`${path} ${res.status} ${await res.text()}`);
  return res.text();
}

const getJ = async (env, key, dflt) => { const v = await env.DB.get(key); return v ? JSON.parse(v) : dflt; };
const getList = (env, key) => getJ(env, key, []);
const putJ = (env, key, v) => env.DB.put(key, JSON.stringify(v));
const getDay = (env, d) => getList(env, `day:${d}`);
async function pushTo(env, key, rec) {
  const list = await getList(env, key);
  list.push(rec);
  await putJ(env, key, list);
}
// 一次讀一段日期：{ "2026-11-21": [...], ... }
async function days(env, from, to) {
  const out = {};
  for (const { name, value } of await env.DB.range(`day:${from}`, `day:${to}`)) out[name.slice(4)] = JSON.parse(value);
  return out;
}

// ───── 出錯通知主人 ─────
async function alertAdmin(env, kind, detail, logOnly = false) {
  if (env.__real) { kind = "（測試模式）" + kind; env = env.__real; } // 測試模式出錯也要知道
  const at = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
  const errors = await getList(env, "errors");
  errors.unshift({ at, kind, detail: String(detail).slice(0, 300) });
  await putJ(env, "errors", errors.slice(0, 50));
  if (logOnly) return;
  // 同一種錯誤 6 小時內只通知一次，省 LINE 免費額度
  const muteKey = "mute:" + kind;
  if (await env.DB.get(muteKey)) return;
  await env.DB.put(muteKey, "1", { expirationTtl: 6 * 3600 });
  const owner = await env.DB.get("owner");
  if (!owner) return;
  try {
    await line(env, "/message/push", { to: owner, messages: [{ type: "text", text: `🛠️ ${BOT}出狀況（${at}）\n類型：${kind}\n${String(detail).slice(0, 400)}\n\n你講的原話都有先存進記事本，不會掉。\n${FIX_HINT}` }] });
  } catch (e) { console.log("alert push failed", e.message); }
}

// ───── 快速按鈕 ─────
const qa = (label, text) => ({ type: "action", action: { type: "message", label, text } });
const qpb = (label, data, displayText) => ({ type: "action", action: { type: "postback", label: label.slice(0, 20), data, displayText: displayText || label } });
async function quick(env, extra = []) {
  const items = [...extra.slice(0, 8), qa("📅 這個月", "這個月"), qa("📌 待辦", "待辦"), qa("🔔 今天", "今天"), qa("📒 記事本", "記事本")];
  if (!(await env.DB.get("cal_installed"))) items.push(qa("📲 裝到手機行事曆", "裝行事曆"));
  return { items: items.slice(0, 13) };
}
// 最後一則訊息才能掛快速按鈕
function withQuick(msgs, qr) {
  for (const m of msgs) delete m.quickReply;
  msgs[msgs.length - 1].quickReply = qr;
  return msgs;
}

// ───── 名字沒把握：給主人按一下改 ─────
function nameButtons(asks) {
  const out = [];
  for (const k of asks) {
    out.push(qpb(`✅ ${k.name} 沒錯`, `nm=${k.name}|${k.name}|${k.heard || ""}`, `${k.name} 沒錯`));
    for (const alt of k.alt) out.push(qpb(`改成 ${alt}`, `nm=${k.name}|${alt}|${k.heard || ""}`, `名字改成 ${alt}`));
  }
  return out;
}
const askLine = (k) => `❓「${k.name}」${k.heard && k.heard !== k.name ? `（我聽到的是「${k.heard}」）` : ""}`;

// ───── 顯示用 ─────
const whoTag = (r) => (r.who && !r.title.includes(r.who) ? `｜${r.who}` : "");
const itemLine = (r) => `${icon(r.cat)} ${r.kind === "todo" ? (r.done ? "✔️ " : "☐ ") : ""}${r.t ? r.t + (r.end ? "–" + r.end : "") + " " : ""}${r.title}${r.alt ? "❓" : ""}${whoTag(r)}${r.place ? ` 📍${r.place}` : ""}`;
const noteLine = (r) => `${icon(r.cat)} ${r.title}${r.alt ? "❓" : ""}${whoTag(r)}${r.note ? `：${r.note}` : ""}`;
const byTime = (a, b) => (a.t || "99").localeCompare(b.t || "99");
const doneBtn = (r) => qpb(`✅ ${r.title}`, `done=${r.date || "todo"}|${r.id}`, `${r.title} 做完了`);

// 還沒做的待辦：有日期的（前後 60 天）＋沒日期的
async function openTodos(env) {
  const out = [];
  for (const [d, list] of Object.entries(await days(env, twDate(-60), twDate(60))))
    for (const r of list) if (r.kind === "todo" && !r.done) out.push({ ...r, date: d });
  out.sort((a, b) => (a.date + (a.t || "99")).localeCompare(b.date + (b.t || "99")));
  return [...out, ...(await getList(env, "todo")).map((r) => ({ ...r, kind: "todo", date: "" }))];
}
const todoLine = (r) => `${icon(r.cat)} ${r.title}${whoTag(r)}${r.date ? `（${r.date < twDate() ? "⚠️ 過期 " : ""}${r.date === twDate() ? "今天" : md(r.date)}${r.t ? " " + r.t : ""}）` : ""}`;

// 某一天的全部事情（greet=true 是早上 9:30 的摘要版）
async function dayView(env, day = twDate(), greet = false) {
  const list = (await getDay(env, day)).sort(byTime);
  const ev = list.filter((r) => r.kind === "event"), td = list.filter((r) => r.kind === "todo"), nt = list.filter((r) => r.kind === "note");
  const isToday = day === twDate();
  const parts = [greet ? `☀️ ${hi("早安")}！今天 ${md(day)}（${wk(day)}）` : `📅 ${md(day)}（${wk(day)}）${isToday ? "今天" : day === twDate(1) ? "明天" : ""}`];
  parts.push(ev.length ? `🗓️ 行程（${ev.length} 件）\n${ev.map(itemLine).join("\n")}` : "🗓️ 沒有行程");
  let btns = [];
  if (greet) {
    const open = (await openTodos(env)).filter((r) => !r.date || r.date <= day);
    if (open.length) parts.push(`📌 還沒做的待辦（${open.length} 件）\n${open.slice(0, 10).map(todoLine).join("\n")}${open.length > 10 ? `\n…還有 ${open.length - 10} 件，按「待辦」看全部` : ""}\n做完按下面 ✅，或直接講「○○做完了」`);
    btns = open.slice(0, 4).map(doneBtn);
  } else if (td.length) {
    parts.push(`📌 這天的待辦\n${td.map(itemLine).join("\n")}`);
    btns = td.filter((r) => !r.done).slice(0, 4).map((r) => doneBtn({ ...r, date: day }));
  }
  if (nt.length) parts.push(`📝 記事\n${nt.map(noteLine).join("\n")}`);
  const asks = list.filter((r) => r.alt).map((r) => ({ name: r.who, heard: r.heard, alt: r.alt }))
    .filter((k, i, a) => k.name && a.findIndex((x) => x.name === k.name) === i).slice(0, 2);
  if (asks.length) parts.push(`這幾個名字我沒把握，不對的話按下面改：\n${asks.map(askLine).join("\n")}`);
  const msgs = [{ type: "text", text: parts.join("\n\n").slice(0, 4900) }];
  return withQuick(msgs, await quick(env, [...nameButtons(asks), ...btns]));
}

async function todoView(env) {
  const open = await openTodos(env);
  if (!open.length) return [{ type: "text", text: "📌 待辦都做完了 👍\n有新的事直接跟我講，例如「提醒我週三前繳電話費」。", quickReply: await quick(env) }];
  const text = `📌 還沒做的待辦（${open.length} 件）\n\n${open.slice(0, 30).map((r, i) => `${i + 1}. ${todoLine(r)}`).join("\n")}\n\n做完按下面 ✅，或直接講「○○做完了」`;
  return [{ type: "text", text: text.slice(0, 4900), quickReply: await quick(env, open.slice(0, 8).map(doneBtn)) }];
}

// ───── LINE 裡的月曆（不用圖片：格子＋接下來的清單，點日期看那天）─────
const C = { main: "#2F6B4F", accent: "#E9B949", bg: "#F5F8F2", ink: "#22302A" }; // 設計規範四色
const ymOf = (d) => d.slice(0, 7);
const nextYm = (ym) => { const [y, m] = ym.split("-").map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`; };
const txt = (text, o = {}) => ({ type: "text", text, size: "md", color: C.ink, ...o });

async function monthBubble(env, ym, nextBtn) {
  const [y, m] = ym.split("-").map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const got = await days(env, `${ym}-01`, `${ym}-31`);
  const all = Array.from({ length: n }, (_, i) => `${ym}-${String(i + 1).padStart(2, "0")}`).map((d) => {
    const l = (got[d] || []).sort(byTime);
    return { d, e: l.filter((r) => r.kind === "event"), t: l.filter((r) => r.kind === "todo" && !r.done), n: l.filter((r) => r.kind === "note") };
  });
  const today = twDate();
  const from = ymOf(today) === ym ? today : `${ym}-01`;
  const ahead = all.filter((x) => x.d >= from);
  const nE = ahead.reduce((s, x) => s + x.e.length, 0), nT = ahead.reduce((s, x) => s + x.t.length, 0);
  const sum = [nE && `${nE} 個行程`, nT && `${nT} 件待辦`].filter(Boolean).join("・");
  const lead = from === today ? "今天到月底" : `${m} 月`;
  const headline = sum ? `${lead}：${sum}` : `${lead}還沒有行程`;

  const cell = (x) => {
    if (!x) return { type: "box", layout: "vertical", flex: 1, height: "52px", contents: [{ type: "filler" }] };
    const k = x.e.length + x.t.length;
    const has = k + x.n.length;
    const mark = k ? `${k}件` : x.n.length ? "記事" : " ";
    const isT = x.d === today;
    const box = { type: "box", layout: "vertical", flex: 1, height: "52px", paddingTop: "4px", cornerRadius: "8px", contents: [
      txt(String(+x.d.slice(8)), { align: "center", weight: has ? "bold" : "regular", color: has && !isT ? C.main : C.ink }),
      txt(mark, { align: "center", color: isT ? C.ink : C.main, adjustMode: "shrink-to-fit" }),
    ] };
    if (isT) box.backgroundColor = C.accent; // 強調色只用在「今天」這一格
    if (has) box.action = { type: "postback", label: md(x.d), data: `day=${x.d}`, displayText: `${md(x.d)} 有什麼？` };
    return box;
  };
  const slots = [...Array(new Date(`${ym}-01T00:00:00Z`).getUTCDay()).fill(null), ...all];
  while (slots.length % 7) slots.push(null);
  const rows = [];
  for (let i = 0; i < slots.length; i += 7) rows.push({ type: "box", layout: "horizontal", spacing: "xs", contents: slots.slice(i, i + 7).map(cell) });

  const list = [];
  let more = 0;
  for (const x of ahead) {
    const items = [...x.e, ...x.t].sort(byTime).map((r) => `${icon(r.cat)} ${r.kind === "todo" ? "☐ " : ""}${r.t ? r.t + " " : ""}${r.title}${whoTag(r)}`);
    if (!items.length) continue;
    if (list.length > 28) { more += items.length; continue; }
    list.push(txt(`${md(x.d)}（${wk(x.d)}）${x.d === today ? "今天" : ""}`, { weight: "bold", color: C.main, margin: "lg" }));
    for (const s of items) list.push(txt(s, { wrap: true, lineSpacing: "12px", margin: "md" })); // 行距 ≥ 1.7（設計規範）
  }
  if (more) list.push(txt(`…還有 ${more} 件，點上面的日期看`, { wrap: true, margin: "lg" }));

  const bubble = {
    type: "bubble", size: "giga",
    styles: { body: { backgroundColor: C.bg }, footer: { backgroundColor: C.bg } },
    body: { type: "box", layout: "vertical", paddingAll: "12px", spacing: "sm", contents: [
      txt(`📅 ${m} 月行事曆`, { size: "xl", weight: "bold", color: C.main }),
      txt(headline, { wrap: true, lineSpacing: "12px" }),
      { type: "box", layout: "horizontal", spacing: "xs", margin: "lg", contents: WEEK.map((w) => txt(w, { align: "center", weight: "bold", color: C.main, flex: 1 })) },
      ...rows,
      ...(list.length ? [txt("接下來", { size: "lg", weight: "bold", color: C.main, margin: "xl" }), ...list] : []),
    ] },
  };
  if (nextBtn) bubble.footer = { type: "box", layout: "vertical", contents: [{ type: "button", style: "link", color: C.main, height: "sm", action: { type: "postback", label: `看 ${+nextBtn.slice(5)} 月 ▶`, data: `cal=${nextBtn}`, displayText: `看 ${+nextBtn.slice(5)} 月` } }] };
  return { bubble, headline };
}

// 這個月＋下個月兩張，左右滑
async function monthMsgs(env, ym = ymOf(twDate())) {
  const n1 = nextYm(ym);
  const [a, b] = await Promise.all([monthBubble(env, ym), monthBubble(env, n1, nextYm(n1))]);
  return withQuick([{ type: "flex", altText: `📅 ${+ym.slice(5)} 月行事曆｜${a.headline}`, contents: { type: "carousel", contents: [a.bubble, b.bubble] } }], await quick(env));
}

async function weekTable(env) {
  const got = await days(env, twDate(), twDate(6));
  const parts = [];
  for (let i = 0; i < 7; i++) {
    const d = twDate(i);
    const l = (got[d] || []).filter((r) => r.kind !== "note").sort(byTime);
    if (!l.length) continue;
    parts.push(`【${md(d)}（${wk(d)}）${i === 0 ? "今天" : i === 1 ? "明天" : ""}】\n${l.map(itemLine).join("\n")}`);
  }
  const text = parts.length ? "📋 未來 7 天\n\n" + parts.join("\n\n") : "📋 未來 7 天還沒有行程";
  return [{ type: "text", text: text.slice(0, 4900), quickReply: await quick(env) }];
}

// 記事本：那天講過的每一句原話＋分到哪
async function notebookView(env, d = twDate()) {
  const list = await getList(env, `log:${d}`);
  if (!list.length) return [{ type: "text", text: `📒 ${md(d)}（${wk(d)}）的記事本還是空的。\n有什麼事直接跟我講（語音或打字），我先存原話再幫你分類。`, quickReply: await quick(env, [qa("📒 昨天", "昨天記了什麼")]) }];
  const rows = list.slice(-15).map((r) => `🕐 ${r.at}${r.voice ? " 🎙️" : ""}${r.by ? "（測試）" : ""}\n「${(r.fixed || r.text).slice(0, 150)}」${r.got && r.got.length ? `\n→ ${r.got.join("；")}` : ""}`);
  const text = `📒 記事本 ${md(d)}（${wk(d)}）共 ${list.length} 句${list.length > 15 ? "（只列最後 15 句）" : ""}\n\n${rows.join("\n\n")}`;
  return [{ type: "text", text: text.slice(0, 4900), quickReply: await quick(env, d === twDate() ? [qa("📒 昨天", "昨天記了什麼")] : []) }];
}

// 回顧：最近幾天做了什麼，照分類排（每週檢討用）
async function reviewText(env, from, to, title) {
  const got = await days(env, from, to);
  const by = Object.fromEntries(Object.keys(CATS).map((c) => [c, []]));
  for (const [d, l] of Object.entries(got)) for (const r of l) if (r.kind !== "todo" || r.done) (by[r.cat] || by[FALLBACK]).push(`${md(d)} ${r.kind === "todo" ? "✔️ " : ""}${r.title}${whoTag(r)}`);
  const total = Object.values(by).reduce((s, l) => s + l.length, 0);
  if (!total) return `${title}\n還沒有記錄。`;
  return `${title}（共 ${total} 件）\n\n` + Object.keys(CATS).filter((c) => by[c].length).map((c) => `${icon(c)} ${CAT_NAME[c]}（${by[c].length}）\n${by[c].slice(0, 8).map((s) => "・" + s).join("\n")}${by[c].length > 8 ? `\n・…還有 ${by[c].length - 8} 件` : ""}`).join("\n\n");
}
async function countLine(env, from, to) {
  const got = await days(env, from, to);
  const n = Object.fromEntries(Object.keys(CATS).map((c) => [c, 0]));
  for (const l of Object.values(got)) for (const r of l) if (r.kind !== "todo" || r.done) n[r.cat in n ? r.cat : FALLBACK]++;
  return Object.keys(CATS).map((c) => `${icon(c)}${n[c]}`).join("　");
}

// 查：最近半年講過的事
async function searchView(env, q) {
  q = clean(q);
  const hits = [];
  const has = (r) => [r.title, r.who, r.note, r.place, r.src].some((s) => s && s.includes(q));
  const got = await days(env, twDate(-180), twDate(90));
  for (const d of Object.keys(got).sort().reverse()) for (const r of got[d]) if (has(r)) hits.push(`${md(d)}（${wk(d)}）${KIND_NAME[r.kind] || ""} ${itemLine(r)}${r.note && r.kind !== "note" ? `\n　📝${r.note}` : r.kind === "note" && r.note ? `：${r.note}` : ""}`);
  for (const r of await getList(env, "todo")) if (has(r)) hits.unshift(`沒日期的待辦 ${itemLine(r)}`);
  const text = hits.length ? `🔍「${q}」找到 ${hits.length} 筆（新的在上面）\n\n${hits.slice(0, 15).join("\n\n")}` : `🔍 最近半年沒有「${q}」的紀錄`;
  return [{ type: "text", text: text.slice(0, 4900), quickReply: await quick(env) }];
}

async function dictView(env) {
  const d = await getJ(env, "dict", {});
  const keys = Object.keys(d);
  const text = keys.length ? `📖 錯字字典（你糾正過的，以後聽到會自動改）\n\n${keys.slice(0, 80).map((k) => `${k} → ${d[k]}`).join("\n")}` : "📖 錯字字典還是空的。\n名字或字聽錯了，直接跟我說「剛剛的○○是△△」，我就記起來，以後自動改。";
  return withQuick([{ type: "text", text: text.slice(0, 4900) }], await quick(env));
}

async function installCal(env) {
  const k = await calKey(env);
  return [{
    type: "flex", altText: `📲 把${BOT}裝到手機行事曆（只要一次）`,
    contents: { type: "bubble", size: "kilo", styles: { body: { backgroundColor: C.bg } },
      body: { type: "box", layout: "vertical", spacing: "md", paddingAll: "16px", contents: [
        txt("📲 裝到手機行事曆", { size: "lg", weight: "bold", color: C.main }),
        txt("只要一次。按下面的按鈕，照網頁上的步驟做。之後行程、待辦都會自動出現在手機行事曆。", { wrap: true, lineSpacing: "12px" }),
        { type: "box", layout: "vertical", backgroundColor: C.accent, cornerRadius: "12px", paddingAll: "14px", margin: "lg",
          action: { type: "uri", label: "裝到手機", uri: `${BASE}/sub/${k}?openExternalBrowser=1` },
          contents: [txt("裝到手機", { align: "center", weight: "bold", color: C.ink })] },
      ] } },
    quickReply: await quick(env),
  }];
}

// ───── 語音轉文字 ─────
const b64 = (buf) => { let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000)); return btoa(bin); };

async function sttBytes(env, buf) {
  // 把常講到的人名先告訴語音辨識，它就比較會寫對字
  const names = (await getList(env, "names")).filter((n) => !HONORIFIC.test(n)).slice(0, 30);
  const prompt = `以下是繁體中文${ME ? "，" + ME + "的" : "的"}日誌${CFG.words ? "：" + CFG.words : ""}。` + (names.length ? `人名：${names.join("、")}。` : "");
  const out = await env.AI.run(STT_MODEL, { audio: b64(buf), language: "zh", initial_prompt: prompt });
  return clean(out.text);
}

// ───── 錯字字典 ─────
async function fixText(env, text) {
  text = text.replace(/,\s*/g, "，").replace(/(?<=[一-鿿])\.(?=\s*$)/, "。").replace(/下周|這周|上周|本周/g, (m) => m[0] + "週");
  const dict = { ...BASE_DICT, ...(await getJ(env, "dict", {})) };
  // 已知的人名先保護起來，免得字典把別人的名字也改掉
  const keep = [];
  for (const n of (await getList(env, "names")).filter((n) => n.length >= 2 && !(n in dict)).sort((a, b) => b.length - a.length))
    if (text.includes(n)) { text = text.split(n).join(`\u0000${keep.length}\u0000`); keep.push(n); }
  for (const w of Object.keys(dict).sort((a, b) => b.length - a.length)) if (w && dict[w] && w !== dict[w] && text.includes(w)) text = text.split(w).join(dict[w]);
  return text.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[+i]);
}

async function rememberName(env, name) {
  if (!name || name.length > 10) return;
  const names = await getList(env, "names");
  if (names.includes(name)) return;
  names.unshift(name);
  await putJ(env, "names", names.slice(0, 300));
}

// 名字改正：從昨天起的行程／待辦／記事、沒日期的待辦、已知名字一起改；聽錯的寫法記進字典
async function renameName(env, from, to, heard = "") {
  let n = 0;
  const froms = new Set([from]);
  const fix = (r) => {
    if (!(r.who === from || (r.heard && r.heard === from) || (r.title && r.title.includes(from)))) return false;
    if (r.who === from || r.heard === from) { if (r.who) froms.add(r.who); r.who = to; }
    for (const f of froms) if (r.title && f) r.title = r.title.split(f).join(to);
    delete r.alt; delete r.heard;
    n++;
    return true;
  };
  for (const [d, list] of Object.entries(await days(env, twDate(-1), twDate(400)))) {
    let changed = false;
    for (const r of list) if (fix(r)) changed = true;
    if (changed) await putJ(env, `day:${d}`, list);
  }
  const td = await getList(env, "todo");
  if (td.some(fix)) await putJ(env, "todo", td);
  if ([...froms].some((f) => f !== to)) {
    const names = (await getList(env, "names")).filter((x) => !froms.has(x) && x !== to);
    if (/[一-鿿]/.test(to)) names.unshift(to);
    await putJ(env, "names", names.slice(0, 300));
  }
  const wrong = heard || from;
  let learned = false;
  // 只是補上姓（大明→王大明）或去掉字的，不算錯字，不進字典
  if (wrong !== to && wrong.length >= 2 && !HONORIFIC.test(wrong) && !to.includes(wrong) && !wrong.includes(to)) {
    const dict = await getJ(env, "dict", {});
    dict[wrong] = to;
    for (const k of Object.keys(dict)) if (dict[k] === wrong) dict[k] = to;
    const keys = Object.keys(dict);
    await putJ(env, "dict", Object.fromEntries(keys.slice(Math.max(0, keys.length - 300)).map((k) => [k, dict[k]])));
    learned = true;
  }
  return { n, learned };
}

async function transcribe(env, messageId) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, { headers: { Authorization: "Bearer " + (await token(env)) } });
  if (!res.ok) throw new Error("下載錄音失敗 " + res.status);
  return sttBytes(env, new Uint8Array(await res.arrayBuffer()));
}

// ───── 看懂主人講的話 ─────
// 「大後天」「下下週四」這種日期由程式先算好寫在括號裡，AI 自己推算常差一天
// 中文數字（十、二十五、兩）→ 數字
function cnNum(s) {
  if (/^\d+$/.test(s)) return +s;
  const D = { 零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const m = s.match(/^([一二兩三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? D[m[1]] : 1) * 10 + (m[2] ? D[m[2]] : 0);
  return s.length === 1 && s in D ? D[s] : NaN;
}
function annotateDates(text) {
  // 「十分鐘後」「半小時後」「兩個小時後」→ 程式先算好幾點（AI 自己算常算錯）
  const at = (mins) => { const d = new Date(now() + mins * 60e3 + 8 * 3600e3).toISOString(); return `(${d.slice(0, 10)} ${d.slice(11, 16)})`; };
  text = text.replace(/(一個半|半個?)(小時|鐘頭)(後|之後|以後)/g, (m, h) => m + at(h === "一個半" ? 90 : 30));
  text = text.replace(/(\d{1,3}|[一二兩三四五六七八九十]{1,3})\s*(分鐘|分|個?小時|個?鐘頭)(後|之後|以後)/g, (m, n, u) => {
    const v = cnNum(n);
    return Number.isNaN(v) ? m : m + at(/分/.test(u) ? v : v * 60);
  });
  const todayDow = (new Date(twDate() + "T00:00:00Z").getUTCDay() + 6) % 7; // 週一=0
  const DOW = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 };
  const WOFF = { 上: -1, 這: 0, 本: 0, 下: 1, 下下: 2 };
  text = text.replace(/(下下|下|這|本|上)個?(週|周|禮拜|星期)([一二三四五六日天])/g, (m, p, _w, d) => `${m}(${twDate(WOFF[p] * 7 + DOW[d] - todayDow)})`);
  // 只講「週六」：這週還沒到就是這週那天；已經過了，兩個日期都給，讓 AI 看講的是做過了還是要來
  text = text.replace(/(^|[^下這本上個])(週|周|禮拜|星期)([一二三四五六日天])(?!\()/g, (m, pre, w, d) => {
    const diff = DOW[d] - todayDow;
    return `${pre}${w}${d}(${diff >= 0 ? twDate(diff) : `還沒到的是${twDate(diff + 7)}，已經過了的是${twDate(diff)}`})`;
  });
  const REL = { 大前天: -3, 大後天: 3, 前天: -2, 後天: 2, 昨天: -1, 明天: 1, 今天: 0 };
  return text.replace(/大前天|大後天|前天|後天|昨天|明天|今天/g, (m) => `${m}(${twDate(REL[m])})`);
}

function calendarHint() {
  const todayDow = (new Date(twDate() + "T00:00:00Z").getUTCDay() + 6) % 7; // 週一=0
  const rows = [];
  const say = { "-2": "（前天）", "-1": "（昨天）", 0: "（今天）", 1: "（明天）", 2: "（後天）", 3: "（大後天）" };
  for (let i = -7; i < 21; i++) {
    const d = twDate(i);
    const w = Math.floor((todayDow + i) / 7);
    const tag = ["上週", "本週", "下週", "下下週"][w + 1] || "";
    rows.push(`${d}＝${tag}${wk(d)}${say[i] || ""}`);
  }
  return `現在是 ${twDate()} ${twTime()}\n` + rows.join("\n");
}

const SYSTEM = `你是${ME ? "「" + ME + "」" : "主人"}的語音記事本小幫手。他會用口語跟你講今天發生的事、要做的事、約好的行程、想法（常是語音轉文字，有錯字、簡體字、口語）。
${CFG.about ? "關於他：" + CFG.about + "\n" : ""}把他講的每一件事都整理成 JSON，只輸出 JSON，不要其他文字：
{"actions":[...],"unclear":""}
actions 每一筆是以下其中一種（欄位沒講到就給空字串）：
1. 行程（有日期、要去某處或跟人碰面的事：拜訪、開會、上課、拍攝、聚餐、看醫生…）：{"type":"event","date":"YYYY-MM-DD","time":"HH:MM","end":"HH:MM","cat":"分類","title":"簡短標題","who":"相關的人","place":"地點","note":"其他細節"}
2. 待辦（他要自己做的事、「提醒我…」）：{"type":"todo","due":"YYYY-MM-DD 有講哪天或期限才填","time":"HH:MM 有講幾點提醒才填","cat":"分類","title":"要做什麼（動詞開頭，例如：打電話給王大哥）","who":"","note":""}
3. 記事（已經發生的事、成果、對方說了什麼、想法、靈感、心得，不用排也不用做）：{"type":"note","date":"YYYY-MM-DD 發生的日期，沒講就今天","cat":"分類","title":"一句話重點","who":"","note":"細節（金額、對方的需求…）"}
4. 做完了（他說某件待辦做完了）：{"type":"done","title":"做完的是哪件事"}
5. 改字（他說之前某個名字或字聽錯要改，例如「剛剛的王大明是王大銘」）：{"type":"fix","from":"錯的寫法","to":"正確寫法"}
分類 cat 只能填這 ${Object.keys(CATS).length} 個其中一個：
${Object.keys(CATS).map((k) => { const c = (CFG.categories || []).find((x) => String(x.name).replace(/\s/g, "") === k); return `- ${k}：${(c && c.desc) || (k === FALLBACK ? "不屬於其他類的雜事" : CAT_NAME[k])}`; }).join("\n")}
（都不像就填「${FALLBACK}」）
規則：
- 一段話有幾件事就給幾筆，不要漏。一件事可以同時產生記事和待辦，例如「今天跟小美吃飯，她下個月要搬家，下週三前要幫她問搬家公司」→ 一筆記事＋一筆待辦「幫小美問搬家公司」due=下週三。
- 未來有日期、要去或要見面＝event；他自己要做的事＝todo；已經發生或只是記下來＝note。
- 「X 點提醒我做某事」＝todo，due 和 time 都要填。只說「記得」「要」但沒講時間的就 due、time 都空。
- 日期後面括號裡的 YYYY-MM-DD 是系統算好的，直接用；「十分鐘後(YYYY-MM-DD HH:MM)」這種括號是系統算好的日期和時間，date／due 和 time 直接照填。沒有括號的「下週三」就找日曆裡標「下週三」的那天，不要自己推算。同一段話後面沒講日期的，沿用前面最近講到的日期；行程整段都沒日期就當今天。
- 時間 24 小時制；「早上10點」=10:00，「下午2點」=14:00，「晚上7點」=19:00；「兩點半」=14:30；行程只說 1~6 點當下午。
- title 15 字內、繁體中文；人名、金額、商品名照他講的寫，不要自己加。語音明顯的同音錯字要改對（例如「撿影片」是「剪影片」）。
- who：講到的人，照他講的稱呼或代號（例如「王大哥」「小美」「客戶A」）；沒有就空字串。
名字（語音很常把名字聽成同音字）：
- 跟「已知的人名」同音或很像，就直接用已知的寫法。
- 「王大哥」「陳經理」這種稱呼照他講的寫：稱呼不一樣就是不同的人，不要換成名單裡別的稱呼。
- 有 who 的每一筆都多給兩個欄位："heard"＝他話裡原本的寫法（跟 who 一樣就給空字串），"name_alt"＝who 以外其他可能的寫法（陣列，最多 2 個）。已知的人、「客戶A」這種代號或稱呼，name_alt 給 []。
- 真的看不懂，就在 unclear 用一句白話問他少了什麼（其他看得懂的照樣給）。
日曆：
`;

function parseJson(s) {
  s = (s || "").replace(/<think>[\s\S]*?<\/think>/g, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  return JSON.parse(s.slice(a, b + 1));
}

async function askAI(env, text) {
  const names = await getList(env, "names");
  const known = names.length ? `\n已知的人名：${names.slice(0, 200).join("、")}\n名字跟上面某個同音或很像（語音常打錯字），就改成那個已知名字。` : "\n已知的人名：（還沒有）";
  const messages = [{ role: "system", content: SYSTEM + calendarHint() + known }, { role: "user", content: text }];
  const models = env.FORCE_MODEL ? [env.FORCE_MODEL, ...LLM_MODELS] : LLM_MODELS;
  let lastErr;
  for (const model of models) {
    try {
      const out = await env.AI.run(model, { messages, max_tokens: 2500, temperature: 0.1 });
      const raw = out.response ?? out.choices?.[0]?.message?.content ?? "";
      const plan = parseJson(typeof raw === "string" ? raw : JSON.stringify(raw));
      // 偶爾回傳不完整只記錄就好；模型壞掉／下架才傳 LINE
      if (model !== models[0]) await alertAdmin(env, "AI 模型換備援", `主要模型 ${models[0]} 失敗，已改用 ${model}。原因：${lastErr}`, /JSON/.test(lastErr));
      return plan;
    } catch (e) { lastErr = e.message; console.log("model fail", model, e.message); }
  }
  throw new Error("所有 AI 模型都失敗：" + lastErr);
}

// AI 會太愛套用「已知的人」（王大明→大明、喝大哥→何經理），程式再把關一次：
// 改過的名字要跟他講的「像」（一樣長、至少一半的字一樣，姓先查表），不像就用他講的（姓查表改）
function settleName(name, heard) {
  const said = heard || name;
  if (!said) return name;
  if (/^客戶\s*[A-Za-z0-9]+$/.test(said)) return said.replace(/\s/g, "").toUpperCase(); // 客戶A 這種代號照講的
  const fixSur = (x, fb) => (SURNAMES.includes(x[0]) ? x[0] : SURNAME_FIX[x[0]] || fb || x[0]) + x.slice(1);
  if (said.length <= 4 && HONORIFIC.test(said)) return fixSur(said, name && name[0]);
  if (!name) return name;
  if (!heard || heard === name) return name.length >= 3 && SURNAME_FIX[name[0]] && !SURNAMES.includes(name[0]) ? fixSur(name) : name;
  const h = fixSur(heard);
  if (name.length > h.length && name.endsWith(h)) return name;
  if (name.length < h.length && !HONORIFIC.test(name)) name = h.slice(0, h.length - name.length) + name;
  if (HONORIFIC.test(name) || name.length !== h.length) return h;
  return [...name].filter((c, i) => c === h[i]).length * 2 >= name.length ? name : h;
}

// 「○○做完了」：在還沒做的待辦裡找最像的那件
async function markDone(env, title) {
  const open = await openTodos(env);
  const score = (r) => { const s = r.title + (r.who || ""); return [...new Set(title)].filter((c) => s.includes(c)).length / Math.max(2, new Set(title).size); };
  const best = open.map((r) => [score(r), r]).sort((a, b) => b[0] - a[0])[0];
  if (!best || best[0] < 0.5) return null;
  return finishTodo(env, best[1].date || "todo", best[1].id);
}
async function finishTodo(env, where, id) {
  if (where === "todo") {
    const list = await getList(env, "todo");
    const i = list.findIndex((r) => r.id === id);
    if (i < 0) return null;
    const [r] = list.splice(i, 1);
    await putJ(env, "todo", list);
    await pushTo(env, `day:${twDate()}`, { ...r, kind: "todo", done: true, doneAt: twTime() }); // 做完的記在今天，回顧看得到
    return r;
  }
  const list = await getDay(env, where);
  const r = list.find((x) => x.id === id);
  if (!r) return null;
  r.done = true; r.doneAt = `${twDate()} ${twTime()}`;
  await putJ(env, `day:${where}`, list);
  return r;
}

// 把 AI 整理好的事一件一件存起來，回傳給主人看的句子
async function apply(env, plan, text = "") {
  const lines = [], btns = [], asks = [], got = [];
  const knownNames = new Set(await getList(env, "names"));
  const when = (d, t) => `${md(d)}（${wk(d)}）${d === twDate() ? "今天" : d === twDate(1) ? "明天" : ""}${t ? " " + t : ""}`;
  const src = text.slice(0, 200);
  for (const a of plan.actions || []) {
    const type = clean(a.type);
    const cat = catOf(a.cat);
    const title = clean(a.title).slice(0, 60);
    const aiName = clean(a.who), heard = clean(a.heard) || aiName;
    const who = aiName ? settleName(aiName, heard) : "";
    const note = clean(a.note), place = clean(a.place);
    // 新名字沒把握 → 記下原本聽到的、其他可能寫法，回覆時給他按一下改
    const unsure = who && !knownNames.has(who) && !HONORIFIC.test(who) && !/^客戶[A-Z0-9]+$/.test(who);
    const alt = unsure ? [...new Set([...(Array.isArray(a.name_alt) ? a.name_alt : []).map(clean), HONORIFIC.test(aiName) ? "" : aiName, SURNAMES.includes(heard[0]) ? heard : ""])].filter((x) => x && x !== who && x.length <= 8).slice(0, 2) : [];
    const mark = (rec) => {
      if (!unsure || (!alt.length && (!heard || heard === who))) return rec;
      rec.alt = alt;
      if (heard && heard !== who) rec.heard = heard;
      if (!asks.some((k) => k.name === who)) asks.push({ name: who, heard: rec.heard || "", alt });
      return rec;
    };
    const head = (k) => (CAT_NAME[cat] === k ? `${icon(cat)} ${k}` : `${icon(cat)} ${CAT_NAME[cat]}｜${k}`); // 分類就叫「待辦」時不寫「待辦｜待辦」
    if (type === "event" && title) {
      const date = isDate(a.date) ? a.date : twDate();
      const t = isTime(a.time) ? pad(a.time) : "";
      const rec = mark({ id: rid(), kind: "event", t, end: isTime(a.end) && t && pad(a.end) > t ? pad(a.end) : "", cat, title, who, place, note, src });
      const left = t ? (msOf(date, t) - now()) / 60e3 : 0;
      if (t && left < 10) rec.pushed = true; // 10 分鐘內就開始的（或已經過了）不另外提醒
      await pushTo(env, `day:${date}`, rec);
      await rememberName(env, who);
      lines.push(`${head("行程")}\n　${when(date, t)} ${title}${whoTag(rec)}${place ? ` 📍${place}` : ""}${note ? `\n　📝${note}` : ""}${t && !rec.pushed ? `\n　⏰ ${new Date(msOf(date, t) - BEFORE * 60e3 + 8 * 3600e3).toISOString().slice(11, 16)} LINE 提醒你` : ""}`);
      got.push(`${icon(cat)}行程 ${title}`);
      btns.push({ title, ref: `day|${date}|${rec.id}` });
    } else if (type === "todo" && title) {
      const due = isDate(a.due) ? a.due : isTime(a.time) ? twDate() : "";
      const t = due && isTime(a.time) ? pad(a.time) : "";
      const rec = mark({ id: rid(), kind: "todo", t, cat, title, who, note, src, at: twDate() });
      if (t && msOf(due, t) <= now()) rec.pushed = true;
      if (due) await pushTo(env, `day:${due}`, rec); else await pushTo(env, "todo", rec);
      await rememberName(env, who);
      lines.push(`${head("待辦")}\n　☐ ${title}${whoTag(rec)}${due ? `（${when(due, t)}${t ? "" : "前"}）` : ""}${t && !rec.pushed ? `\n　⏰ ${t} LINE 提醒你` : ""}`);
      got.push(`${icon(cat)}待辦 ${title}`);
      btns.push({ title, ref: `${due ? "day|" + due : "todo|"}|${rec.id}` });
    } else if (type === "note" && title) {
      const date = isDate(a.date) && a.date <= twDate() ? a.date : twDate();
      const rec = mark({ id: rid(), kind: "note", cat, title, who, note, src });
      await pushTo(env, `day:${date}`, rec);
      await rememberName(env, who);
      lines.push(`${head("記事")}\n　${date === twDate() ? "" : md(date) + " "}${title}${whoTag(rec)}${note ? `\n　📝${note}` : ""}`);
      got.push(`${icon(cat)}記事 ${title}`);
      btns.push({ title, ref: `day|${date}|${rec.id}` });
    } else if (type === "done" && title) {
      const r = await markDone(env, title);
      lines.push(r ? `✔️ 「${r.title}」打勾了，辛苦了 👏` : `🤔 待辦清單裡找不到「${title}」，按「📌 待辦」看清單、直接按 ✅`);
      if (r) got.push(`✔️做完 ${r.title}`);
    } else if (type === "fix" && clean(a.from) && clean(a.to) && clean(a.from) !== clean(a.to)) {
      const from = clean(a.from);
      let to = clean(a.to);
      // AI 常把正確寫法又套回已知名字 → 直接從他的話抓「是／改成」後面那幾個字
      if (text && !text.includes(to)) {
        const hits = [...text.matchAll(new RegExp(`(?:應該是|改成|寫成|是)「?([一-鿿]{${to.length}})`, "g"))].map((x) => x[1]).filter((x) => x !== from);
        if (hits.length) to = hits[hits.length - 1];
      }
      const { n, learned } = await renameName(env, from, to);
      lines.push(`✏️ 「${from}」改成「${to}」了${n ? `（改了 ${n} 筆）` : ""}${learned ? "，以後聽到會自動改" : ""}`);
      got.push(`✏️ ${from}→${to}`);
    }
  }
  return { lines, btns, asks, got };
}

async function understand(env, raw, fromVoice = false) {
  // 不管講什麼，原話先存進記事本
  const text = await fixText(env, raw);
  const logKey = `log:${twDate()}`, logId = rid();
  await pushTo(env, logKey, { id: logId, at: twTime(), text: raw, ...(text !== raw ? { fixed: text } : {}), voice: fromVoice, ...(env.__SANDBOX ? { by: "test" } : {}) });
  const heard = fromVoice ? `🎙️ 我聽到：「${text}」\n\n` : "";
  let plan;
  try { plan = await askAI(env, annotateDates(text)); } catch (e) {
    await alertAdmin(env, "AI 看不懂／壞掉", e.message + "\n你說：" + text);
    return [{ type: "text", text: `${heard}📒 原話先存進記事本了，不過 AI 有點狀況，等修好再幫你分類。`, quickReply: await quick(env) }];
  }
  const { lines, btns, asks, got } = await apply(env, plan, text);
  if (got.length) {
    try { const lg = await getList(env, logKey); const e = lg.find((x) => x.id === logId); if (e) { e.got = got; await putJ(env, logKey, lg); } } catch {}
  }
  const calNote = (await env.DB.get("cal_installed")) ? "" : "\n\n📲 還沒裝到手機行事曆的話，按下面「裝到手機行事曆」，只要一次。";
  const askNote = asks.length ? `\n\n名字我先這樣寫，不對的話按下面改：\n${asks.map(askLine).join("\n")}` : "";
  let out;
  if (lines.length) out = `${heard}OK，幫你記了 👌\n\n${lines.join("\n\n")}${askNote}${plan.unclear ? `\n\n🤔 另外：${plan.unclear}` : ""}${calNote}`;
  else out = `${heard}📒 OK，原話記進記事本了。${plan.unclear ? `\n\n🤔 ${plan.unclear}` : ""}`;
  const extra = [...nameButtons(asks.slice(0, 1)),
    ...btns.slice(0, 2).map((b) => qpb(`🏷️ 改分類 ${b.title}`, `cat=${b.ref}`, `改「${b.title}」的分類`)),
    ...btns.slice(0, 3).map((b) => qpb(`刪 ${b.title}`, `undo=${b.ref}`, `刪掉「${b.title}」`))];
  return [{ type: "text", text: out.slice(0, 4900), quickReply: await quick(env, extra) }];
}

// 刪、改分類用：ref = "day|日期|id" 或 "todo||id"
async function findRef(env, ref) {
  const [where, date, id] = ref.split("|");
  const key = where === "todo" ? "todo" : `day:${date}`;
  const list = await getList(env, key);
  return { key, list, i: list.findIndex((x) => x.id === id) };
}
async function undo(env, ref) {
  const { key, list, i } = await findRef(env, ref);
  if (i < 0) return "這筆已經刪掉了 👌";
  const [gone] = list.splice(i, 1);
  list.length ? await putJ(env, key, list) : await env.DB.delete(key);
  return `🗑️ 已刪掉：${key === "todo" ? "" : md(key.slice(4)) + " "}${gone.t ? gone.t + " " : ""}${gone.title}`;
}

// ───── 手機行事曆（iPhone 行事曆訂閱網址）─────
async function calKey(env) {
  let k = await env.DB.get("cal_key");
  if (!k) { k = crypto.randomUUID().replace(/-/g, ""); await env.DB.put("cal_key", k); }
  return k;
}

const icsEsc = (s) => String(s || "").replace(/[\\;,]/g, (c) => "\\" + c).replace(/\n/g, "\\n");
const icsUtc = (date, t, addMin = 0) => new Date(msOf(date, t) + addMin * 60e3).toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
const fold = (l) => (l.length > 24 ? l.match(/.{1,24}/gu).join("\r\n ") : l);

async function buildIcs(env) {
  const out = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//line-voice-notebook//ZH", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${BOT}${env.__SANDBOX ? "（測試）" : ""}`, "X-WR-TIMEZONE:Asia/Taipei", "REFRESH-INTERVAL;VALUE=DURATION:PT15M", "X-PUBLISHED-TTL:PT15M"];
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const ev = (uid, title, date, t, mins, desc, alarms) => {
    out.push("BEGIN:VEVENT", `UID:${uid}@line-voice-notebook`, `DTSTAMP:${stamp}`, `SUMMARY:${icsEsc(title)}`);
    if (t) out.push(`DTSTART:${icsUtc(date, t)}`, `DTEND:${icsUtc(date, t, mins)}`);
    else out.push(`DTSTART;VALUE=DATE:${date.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${addDays(date, 1).replace(/-/g, "")}`);
    if (desc) out.push(`DESCRIPTION:${icsEsc(desc)}`);
    for (const trig of alarms) out.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsEsc(title)}`, `TRIGGER:${trig}`, "END:VALARM");
    out.push("END:VEVENT");
  };
  for (const [date, list] of Object.entries(await days(env, twDate(-60), twDate(400)))) {
    for (const r of list) {
      if (r.kind === "note") continue; // 記事不進行事曆（在 LINE 記事本看），行事曆保持乾淨
      const desc = [`分類：${CAT_NAME[r.cat] || r.cat}`, r.who && `👤 ${r.who}`, r.place && `📍 ${r.place}`, r.note && `📝 ${r.note}`, r.src && `你當時說：「${r.src}」`].filter(Boolean).join("\n");
      if (r.kind === "event") {
        const mins = r.end ? (msOf(date, r.end) - msOf(date, r.t)) / 60e3 : 60;
        ev(`ev-${r.id}`, `${icon(r.cat)} ${r.title}${whoTag(r)}`, date, r.t, mins, desc, r.t ? [`-PT${BEFORE}M`] : []);
      } else {
        ev(`td-${r.id}`, `${r.done ? "✔️" : "📌"} ${r.title}${whoTag(r)}`, date, r.t, 15, desc, r.t && !r.done ? ["PT0M"] : []);
      }
    }
  }
  out.push("END:VCALENDAR");
  return out.map(fold).join("\r\n") + "\r\n";
}

function subPage(host, key, test = false) {
  const webcal = `webcal://${host}/cal/${key}.ics`;
  const https = `https://${host}/cal/${key}.ics`;
  const name = `${BOT}${test ? "（測試）" : ""}`;
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>裝到手機行事曆</title>
<style>body{margin:0;background:#F5F8F2;color:#22302A;font:18px/1.8 -apple-system,"PingFang TC","Noto Sans TC",sans-serif;padding:32px 20px}h1,h2{color:#2F6B4F;line-height:1.4}h1{font-size:24px}h2{font-size:20px;margin-top:36px}a.btn{display:block;background:#E9B949;color:#22302A;text-align:center;padding:18px;border-radius:12px;font-weight:bold;text-decoration:none;margin:24px 0;font-size:20px}li{margin:8px 0}code{word-break:break-all;font-size:16px;border:1px solid #2F6B4F;border-radius:8px;padding:8px;display:block}</style></head>
<body><h1>${name} → 手機行事曆</h1><p>只要做一次，之後在 LINE 講的行程、待辦會自動出現。</p>
<h2>iPhone</h2><a class="btn" href="${webcal}">📲 訂閱行事曆</a><ol><li>按上面黃色按鈕</li><li>跳出視窗按「訂閱」，再按「完成」</li><li>打開 iPhone 行事曆，「${name}」打勾就看得到</li></ol>
<h2>Android（Google 日曆）</h2><ol><li>用電腦打開 Google 日曆網頁版</li><li>左邊「其他日曆」旁的 ＋ →「透過網址新增」</li><li>貼上這個網址，按「新增日曆」：<code>${https}</code></li></ol>
<p>更新：約 15 分鐘～1 小時同步一次。行程前 ${BEFORE} 分鐘 LINE 會提醒你。</p></body></html>`;
}

// ───── LINE 事件 ─────
async function verify(env, body, sig) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.CHANNEL_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(mac))) === sig;
}

async function adminStatus(env) {
  const errors = (await getList(env, "errors")).slice(0, 5);
  const cal = await env.DB.get("cal_installed");
  return `🛠️ 系統狀態\n今日摘要：${(await env.DB.get("last_run")) || "還沒跑過"}（每天 ${MORNING}）\n手機行事曆：${cal ? "已裝（最後同步 " + cal.slice(0, 16).replace("T", " ") + "）" : "還沒裝"}\n測試模式：${(await env.DB.get("testing")) ? "開著" : "關著"}\n最近錯誤：${errors.length ? "\n" + errors.map((e) => `${e.at} ${e.kind}`).join("\n") : "沒有 👍"}`;
}

// ───── 測試模式：講的話照一樣的流程跑，但只記在測試資料庫（D1_TEST，key 前面加 sb:）─────
const SB = "sb:";
function sandboxEnv(env) {
  const s = Object.create(env);
  s.DB = d1kv(env.D1_TEST, SB);
  s.__SANDBOX = true;
  s.__real = env;
  return s;
}
async function clearSandbox(env) {
  const r = await env.D1_TEST.prepare("DELETE FROM kv WHERE k >= ?1 AND k < ?2").bind(SB, SB + "￿").run();
  return r.meta?.changes ?? 0;
}
// 測試模式回的按鈕都加 s=1，按了也只動測試資料庫
function tagSandbox(msgs) {
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== "object") return;
    if (o.type === "postback" && typeof o.data === "string" && !o.data.startsWith("s=1&")) o.data = "s=1&" + o.data;
    Object.values(o).forEach(walk);
  };
  walk(msgs);
  return msgs;
}
const SB_HELLO = "🧪 測試模式開了（2 小時後自動關）：你講的話照一樣的流程回你，但只記在「測試資料庫」，不會進你的行事曆、不會推提醒。\n\n・「結束測試」→ 回到正式\n・「清空測試」→ 測試資料全部清掉";
const HELP_TEXT = `📒 ${BOT}怎麼用（語音或打字都可以）

・「明天下午兩點跟王大哥開會，在公司」→ 排行程，前 ${BEFORE} 分鐘 LINE 提醒
・「提醒我週三前繳電話費」→ 待辦
・「今天去健身房練腿」→ 記事
・一句講好幾件事也可以，我會自動分成 ${Object.keys(CATS).map((k) => `${icon(k)} ${CAT_NAME[k]}`).join("、")}

常用指令：
・「這個月」月曆／「這週」／「今天」「明天」
・「待辦」看還沒做的，做完按 ✅ 或講「○○做完了」
・「記事本」看今天講過的原話
・「這週回顧」照分類列出這 7 天
・「查 王大哥」找以前的紀錄
・「剛剛的 X 是 Y」改名字，以後自動改
・「測試模式」「狀態」「字典」
每天 ${MORNING} 推今日摘要。`;

// 最近 15 句對話（講什麼、回什麼），壞掉時查這個
const PB_SAID = { undo: "按了「刪」", nm: "按了名字按鈕", day: "點了月曆的日期", cal: "看下個月", done: "按了 ✅", cat: "按了改分類", setcat: "選了分類" };
async function remember(env, ev, text, out) {
  let said = text;
  if (ev.type === "postback") said = PB_SAID[[...new URLSearchParams(ev.postback.data.replace(/^s=1&/, "")).keys()][0]] || "按了按鈕";
  else if (!said) said = ev.message && ev.message.type === "audio" ? "🎙️ 語音" : ev.type === "follow" ? "加好友" : "傳了貼圖／照片";
  const reply = (out || []).map((m) => m.text || m.altText || "").join(" ／ ").replace(/\s+/g, " ").slice(0, 160);
  const list = await getList(env, "recent");
  list.unshift({ at: `${md(twDate())} ${twTime()}`, said: said.slice(0, 120), reply });
  await putJ(env, "recent", list.slice(0, 15));
}
async function recentView(env) {
  const list = await getList(env, "recent");
  if (!list.length) return [{ type: "text", text: "最近還沒有對話紀錄" }];
  return [{ type: "text", text: ("🕐 最近的對話（新的在上面）\n\n" + list.slice(0, 10).map((r) => `${r.at}\n你：${r.said}\n回：${r.reply || "（沒回）"}`).join("\n\n")).slice(0, 4900) }];
}

// 「壞了」「怪怪的」→ 直接回系統狀態＋修法（主人自己就是管理員，不用另外推播）
const HELP_RE = /^(好像|這個|怎麼|機器人|系統)?(壞了|怪怪的?|有問題|不能用|沒反應|救命|求救)(了|耶|欸|啦|喔)?$/;
async function askHelp(env) {
  const real = env.__real || env;
  return [{ type: "text", text: `${await adminStatus(real)}\n\n你講的原話都有存進記事本，不會不見。\n${FIX_HINT}`, quickReply: await quick(env, [qa("🕐 最近的對話", "最近的對話")]) }];
}

// 固定指令（不用 AI）
async function command(env, text) {
  const t = text.replace(/[\s？?！!。，,]/g, "");
  if (/^(這個月|本月|月曆|行事曆|這個月行事曆|這個月的行程)$/.test(t)) return monthMsgs(env);
  if (/^(下個月|下個月行事曆)$/.test(t)) return monthMsgs(env, nextYm(ymOf(twDate())));
  if (/^(這週|這禮拜|這星期|行程表|預約表|未來一週)$/.test(t)) return weekTable(env);
  if (/^(今天|今天的行程|今天有什麼)$/.test(t)) return dayView(env, twDate());
  if (/^(明天|明天的行程|明天有什麼)$/.test(t)) return dayView(env, twDate(1));
  if (/^(待辦|待辦清單|待辦事項|還沒做的|代辦)$/.test(t)) return todoView(env);
  if (/^(記事本|日誌|今天記了什麼|今天講了什麼)$/.test(t)) return notebookView(env);
  if (/^(昨天記了什麼|昨天的記事本|昨天講了什麼)$/.test(t)) return notebookView(env, twDate(-1));
  if (/^(這週回顧|回顧|每週回顧|本週回顧)$/.test(t)) return [{ type: "text", text: (await reviewText(env, twDate(-6), twDate(), `📊 這週回顧 ${md(twDate(-6))}–${md(twDate())}`)).slice(0, 4900), quickReply: await quick(env) }];
  if (t === "裝行事曆") return installCal(env);
  if (/^(錯字字典|字典)$/.test(t)) return dictView(env);
  if (/^(早安|今日摘要|摘要|推播)$/.test(t)) return morningMsgs(env, wk(twDate()) === "一");
  if (/^(說明|怎麼用|指令|幫助)$/.test(t)) return [{ type: "text", text: HELP_TEXT, quickReply: await quick(env) }];
  if (/^(最近的對話|最近對話)$/.test(t)) return recentView(env);
  if (HELP_RE.test(t)) return askHelp(env);
  const q = text.trim().match(/^(?:查|搜尋|找)\s*[:：]?\s*(.{1,20})$/);
  if (q) return searchView(env, q[1]);
  return null;
}

async function onPostback(env, data) {
  const p = new URLSearchParams(data);
  if (p.get("undo")) return [{ type: "text", text: await undo(env, p.get("undo")), quickReply: await quick(env) }];
  if (p.get("done")) {
    const [where, id] = p.get("done").split("|");
    const r = await finishTodo(env, where, id);
    return [{ type: "text", text: r ? `✔️ 「${r.title}」打勾了，辛苦了 👏` : "這件已經打勾或刪掉了 👌", quickReply: await quick(env) }];
  }
  if (p.get("cat")) {
    const { list, i } = await findRef(env, p.get("cat"));
    if (i < 0) return [{ type: "text", text: "這筆已經刪掉了 👌", quickReply: await quick(env) }];
    return [{ type: "text", text: `「${list[i].title}」現在是 ${icon(list[i].cat)} ${CAT_NAME[list[i].cat]}，要改成哪一類？`,
      quickReply: { items: Object.keys(CATS).map((c) => qpb(`${icon(c)} ${CAT_NAME[c]}`, `setcat=${p.get("cat")}|${c}`, `改成${CAT_NAME[c]}`)) } }];
  }
  if (p.get("setcat")) {
    const parts = p.get("setcat").split("|");
    const c = parts.pop();
    const { key, list, i } = await findRef(env, parts.join("|"));
    if (i < 0 || !CATS[c]) return [{ type: "text", text: "這筆已經刪掉了 👌", quickReply: await quick(env) }];
    list[i].cat = c;
    await putJ(env, key, list);
    return [{ type: "text", text: `🏷️ 改好了：「${list[i].title}」→ ${icon(c)} ${CAT_NAME[c]}`, quickReply: await quick(env) }];
  }
  if (p.get("nm")) {
    const [from, to, heard] = p.get("nm").split("|");
    const { n, learned } = await renameName(env, from, to, heard);
    const text = from === to ? `👌 好，就是「${to}」，我記住了${learned ? "，以後聽到「" + heard + "」會自動寫成「" + to + "」" : ""}` : `✏️ 改好了：「${from}」→「${to}」（${n} 筆）${learned ? "，以後聽到會自動寫對" : ""}`;
    return [{ type: "text", text, quickReply: await quick(env) }];
  }
  if (isDate(p.get("day"))) return dayView(env, p.get("day"));
  if (/^\d{4}-\d{2}$/.test(p.get("cal") || "")) return monthMsgs(env, p.get("cal"));
  return null;
}

const WELCOME = `✅ 綁定完成！${ME ? ME + "，" : ""}以後有什麼事直接跟我講（語音或打字），我先把原話存進記事本，再幫你分類、排提醒、同步手機行事曆。\n\n${HELP_TEXT}\n\n👇 先按「📲 裝到手機行事曆」，只要一次。`;

async function handleEvent(env, ev) {
  const uid = ev.source && ev.source.userId;
  if (!uid || !ev.replyToken) return;
  const reply = (messages) => line(env, "/message/reply", { replyToken: ev.replyToken, messages });
  const text = ev.type === "message" && ev.message.type === "text" ? ev.message.text.trim() : "";
  const t = text.replace(/[\s？?！!。，,]/g, "");

  let owner = await env.DB.get("owner");
  if (!owner) { owner = uid; await env.DB.put("owner", uid); } // 第一個傳話的人＝主人；這句話照常記（下面會附上歡迎詞）
  if (uid !== owner) {
    // 別的 LINE 帳號要幫忙測：傳「測試＋綁定碼」→ 只能用測試資料庫
    const code = await env.DB.get("admin_code");
    const testers = await getList(env, "testers");
    if (code && t === "測試" + code) {
      if (!testers.includes(uid)) await putJ(env, "testers", [...testers, uid].slice(-5));
      return reply([{ type: "text", text: `🧪 這個 LINE 帳號開通測試了：講的話只記在測試資料庫，不會動到${ME || "主人"}的記事本。` }]);
    }
    if (!testers.includes(uid)) return reply([{ type: "text", text: `這是「${BOT}」，私人帳號 🙏` }]);
    const senv = sandboxEnv(env);
    const out = await asOwner(senv, ev, uid, text);
    if (out) await reply(tagSandbox(out));
    return;
  }
  // ── 主人本人 ──
  if (ev.type === "follow") { await env.DB.put("hello", "1"); return reply([{ type: "text", text: WELCOME, quickReply: await quick(env) }]); }
  if (/^(測試模式|開始測試|開測試)$/.test(t)) {
    await env.DB.put("testing", "1", { expirationTtl: 2 * 3600 });
    return reply([{ type: "text", text: SB_HELLO }]);
  }
  if (/^(結束測試|離開測試|關掉測試|關測試)$/.test(t)) {
    await env.DB.delete("testing");
    return reply([{ type: "text", text: "✅ 測試模式關了，接下來講的都會記進正式的記事本。", quickReply: await quick(env) }]);
  }
  if (/^(清空測試|重新測試)$/.test(t)) {
    const n = await clearSandbox(env);
    return reply([{ type: "text", text: `🧹 測試資料清空了（${n} 筆）。正式的記事本沒有動。` }]);
  }
  if (/^(狀態|系統狀態)$/.test(t)) return reply([{ type: "text", text: await adminStatus(env), quickReply: await quick(env) }]);
  const pbSandbox = ev.type === "postback" && ev.postback.data.startsWith("s=1&");
  const testing = pbSandbox || (await env.DB.get("testing"));
  const uenv = testing ? sandboxEnv(env) : env;
  if (pbSandbox) ev = { ...ev, postback: { ...ev.postback, data: ev.postback.data.slice(4) } };
  let out = await asOwner(uenv, ev, uid, text);
  if (!out) return;
  // 第一次講話：先回歡迎詞＋用法，再回這句記了什麼（建帳號的人 LINE 會自動加好友，收不到加好友事件）
  if (!testing && !(await env.DB.get("hello")) && out.length < 5) {
    await env.DB.put("hello", "1");
    out = [{ type: "text", text: WELCOME }, ...out];
  }
  if (testing) {
    out = tagSandbox(out);
    if (out[0].type === "text") out[0].text = "🧪 測試模式\n" + out[0].text;
  }
  await reply(out);
  try { await remember(uenv, ev, text, out); } catch (e) { console.log("remember failed", e.message); }
}

// 主人（或測試模式）講的話 → 要回的訊息
async function asOwner(env, ev, uid, text) {
  if (ev.type === "postback") return onPostback(env, ev.postback.data);
  if (ev.type !== "message") return null;
  const m = ev.message;
  if (m.type === "text") return (await command(env, text)) || (await understand(env, text));
  if (m.type === "audio") {
    try { await line(env, "/chat/loading/start", { chatId: uid, loadingSeconds: 30 }); } catch {}
    let heard = "";
    try { heard = await transcribe(env, m.id); } catch (e) { await alertAdmin(env, "語音轉文字失敗", e.message); }
    if (!heard) return [{ type: "text", text: "😅 這段錄音我沒聽清楚，可以再講一次，或打字給我嗎？", quickReply: await quick(env) }];
    return (await command(env, heard)) || understand(env, heard, true);
  }
  return dayView(env, twDate()); // 貼圖、照片 → 回今天
}

// ───── 排程（每 5 分鐘）─────
// 9:30 今日摘要；每週一順便附月曆＋上週回顧（同一次推播，不多算 LINE 額度）
async function morningMsgs(env, monday) {
  const msgs = await dayView(env, twDate(), true);
  if (!monday) return msgs;
  const qr = msgs[msgs.length - 1].quickReply;
  msgs[0].text += `\n\n📊 上週（${md(twDate(-7))}–${md(twDate(-1))}）\n${await countLine(env, twDate(-7), twDate(-1))}\n想看細節打「回顧」`;
  return withQuick([...msgs, ...(await monthMsgs(env))], qr);
}

async function morning(env) {
  const owner = env.__TEST_OWNER || (await env.DB.get("owner"));
  if (!owner) return;
  if (((await env.DB.get("last_run")) || "").startsWith(twDate() + " ok")) return; // 今天推過了
  try {
    await line(env, "/message/push", { to: owner, messages: await morningMsgs(env, wk(twDate()) === "一" || env.__FORCE_MONDAY) });
    await env.DB.put("last_run", `${twDate()} ok ${twTime()}`);
  } catch (e) {
    await env.DB.put("last_run", `${twDate()} ERROR ${e.message}`.slice(0, 300));
    await alertAdmin(env, "早上摘要推播失敗", e.message);
  }
}

async function quotaUsed(env) {
  if (env.TEST_MODE === "1") return +(env.__QUOTA || 0);
  const r = await fetch(API + "/message/quota/consumption", { headers: { Authorization: "Bearer " + (await token(env)) } });
  return (await r.json()).totalUsage || 0;
}

// 到時間的提醒：行程前 30 分鐘、待辦到點；同一次排程的合成一則（省額度）
async function remind(env) {
  const owner = env.__TEST_OWNER || (await env.DB.get("owner"));
  if (!owner) return;
  const nowMs = now();
  const ds = [twDate()];
  if (twTime() >= "23:30") ds.push(twDate(1));
  const due = [], dirty = {};
  for (const d of ds) {
    const list = await getDay(env, d);
    for (const r of list) {
      if (r.pushed || r.done || !r.t || r.kind === "note") continue;
      const at = msOf(d, r.t);
      const fire = r.kind === "event" ? at - BEFORE * 60e3 : at;
      const until = r.kind === "event" ? at : at + 60 * 60e3;
      if (nowMs >= fire && nowMs < until) { due.push({ ...r, date: d, mins: Math.round((at - nowMs) / 60e3) }); r.pushed = true; dirty[d] = list; }
    }
  }
  if (!due.length) return;
  const save = () => Promise.all(Object.entries(dirty).map(([d, l]) => putJ(env, `day:${d}`, l)));
  let used = 0;
  try { used = await quotaUsed(env); } catch {}
  if (used >= QUOTA_STOP) {
    await save(); // 額度快滿：不推了，手機行事曆一樣會響
    return alertAdmin(env, "LINE 免費額度快用完", `本月已用 ${used}／200 則，行程提醒先改靠手機行事曆響，早上摘要照推`, true);
  }
  const rows = due.map((r) => `${itemLine(r)}（${r.kind === "event" ? (r.mins > 0 ? `${r.mins} 分鐘後` : "現在") : r.mins >= 0 ? "現在" : `${-r.mins} 分鐘前`}）${r.note ? `\n　📝${r.note}` : ""}`);
  const btns = due.filter((r) => r.kind === "todo").slice(0, 4).map(doneBtn);
  try {
    await line(env, "/message/push", { to: owner, messages: [{ type: "text", text: `⏰ 提醒\n\n${rows.join("\n")}`.slice(0, 4900), quickReply: await quick(env, btns) }] });
    await save();
  } catch (e) { await alertAdmin(env, "提醒推播失敗", e.message); }
}

async function selfCheck(env) {
  const last = (await env.DB.get("last_run")) || "";
  if (!last.startsWith(twDate() + " ok")) await alertAdmin(env, "早上摘要沒發出去", `last_run = ${last || "空的"}`);
  try {
    const used = await quotaUsed(env);
    if (used >= 160) await alertAdmin(env, "LINE 免費額度快用完", `本月已用 ${used}／200 則`);
  } catch {}
  try { await env.D1.prepare("DELETE FROM kv WHERE exp IS NOT NULL AND exp < ?1").bind(Date.now()).run(); } catch {} // 清掉過期的暫存
}

async function tick(env, ms) {
  NOW = ms || 0;
  try {
    const t = twTime();
    if (t >= MORNING && t < CHECK) await morning(env); // 沒推成功的話，5 分鐘後會再試（推過就不會重推）
    if (t >= CHECK && t < addMin(CHECK, 5)) await selfCheck(env);
    await remind(env);
  } finally { NOW = 0; }
}

export default {
  async fetch(req, rawEnv, ctx) {
    const env = wrap(rawEnv);
    const url = new URL(req.url);
    BASE = url.origin;
    if (req.method === "POST" && url.pathname === "/webhook") {
      const body = await req.text();
      if (!(await verify(env, body, req.headers.get("x-line-signature") || ""))) return new Response("bad signature", { status: 401 });
      ctx.waitUntil((async () => {
        for (const ev of JSON.parse(body).events || []) {
          try { await handleEvent(env, ev); } catch (e) {
            console.log("event error", e.message);
            await alertAdmin(env, "處理訊息失敗", e.message);
            try { await line(env, "/message/reply", { replyToken: ev.replyToken, messages: [{ type: "text", text: "📒 原話先存進記事本了，不過系統有點狀況，已經記下錯誤，修好再幫你分類。" }] }); } catch {}
          }
        }
      })());
      return new Response("ok");
    }
    const calM = url.pathname.match(/^\/(cal|sub)\/([0-9a-f]{32})(\.ics)?$/);
    if (calM) {
      let cenv = env;
      if (calM[2] !== (await env.DB.get("cal_key"))) {
        cenv = sandboxEnv(env); // 測試模式的行事曆
        if (calM[2] !== (await cenv.DB.get("cal_key"))) return new Response("not found", { status: 404 });
      }
      if (calM[1] === "sub") return new Response(subPage(url.host, calM[2], cenv !== env), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      if (!url.searchParams.has("check")) {
        // 手機有來抓＝已訂閱；6 小時才記一次，省寫入
        const last = await cenv.DB.get("cal_installed");
        if (!last || Date.now() + 8 * 3600e3 - Date.parse(last + "Z") > 6 * 3600e3) await cenv.DB.put("cal_installed", new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19));
      }
      return new Response(await buildIcs(cenv), { headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-cache" } });
    }
    if (url.pathname === "/status") {
      const errors = await getList(env, "errors");
      return Response.json({ ok: true, owner_bound: !!(await env.DB.get("owner")), calendar_installed: await env.DB.get("cal_installed"), last_run: await env.DB.get("last_run"), testing: !!(await env.DB.get("testing")), recent_errors: errors.slice(0, 5).map((e) => `${e.at} ${e.kind}`) });
    }
    // 第一次設定用（要帶 admin_code）：把 LINE 的 webhook 網址設成這支程式，並請 LINE 打一次測試；info 看官方帳號的 @ID
    if (url.pathname === "/setup") {
      const code = await env.DB.get("admin_code");
      if (!code || url.searchParams.get("code") !== code) return new Response("not found", { status: 404 });
      const out = {};
      try {
        const tk = await token(env);
        const h = { "Content-Type": "application/json", Authorization: "Bearer " + tk };
        if (url.searchParams.has("webhook")) {
          out.set = (await fetch(API + "/channel/webhook/endpoint", { method: "PUT", headers: h, body: JSON.stringify({ endpoint: `${BASE}/webhook` }) })).status;
          out.test = await (await fetch(API + "/channel/webhook/test", { method: "POST", headers: h, body: JSON.stringify({ endpoint: `${BASE}/webhook` }) })).json();
        }
        if (url.searchParams.has("validate")) { // 每一種訊息格式送 LINE 官方驗證，要全部 200
          const senv = sandboxEnv(env);
          const sets = { 月曆: await monthMsgs(senv), 下個月: await monthMsgs(senv, nextYm(ymOf(twDate()))), 裝行事曆: await installCal(senv), 早安週一: await morningMsgs(senv, true),
            今天: await dayView(senv), 待辦: await todoView(senv), 這週: await weekTable(senv), 記事本: await notebookView(senv), 說明: [{ type: "text", text: HELP_TEXT }], 歡迎: [{ type: "text", text: WELCOME, quickReply: await quick(senv) }],
            改分類: [{ type: "text", text: "要改成哪一類？", quickReply: { items: Object.keys(CATS).map((c) => qpb(`${icon(c)} ${CAT_NAME[c]}`, `setcat=day|2026-01-01|x|${c}`, `改成${CAT_NAME[c]}`)) } }] };
          out.validate = {};
          for (const [k, msgs] of Object.entries(sets)) {
            const r = await fetch(API + "/message/validate/push", { method: "POST", headers: h, body: JSON.stringify({ messages: msgs }) });
            out.validate[k] = r.status === 200 ? 200 : `${r.status} ${await r.text()}`;
          }
        }
        if (url.searchParams.has("dump")) out.dump = (await monthMsgs(env))[0].contents; // 品管用：月曆的 Flex JSON（貼到 LINE Flex Simulator 看）
        out.endpoint = await (await fetch(API + "/channel/webhook/endpoint", { headers: h })).json();
        const info = await (await fetch(API + "/info", { headers: h })).json();
        out.info = { basicId: info.basicId, displayName: info.displayName, chatMode: info.chatMode, markAsReadMode: info.markAsReadMode };
        out.quota = await (await fetch(API + "/message/quota/consumption", { headers: h })).json();
      } catch (e) { out.error = e.message; }
      return Response.json(out);
    }
    // ── 測試用（只有 wrangler dev 加 TEST_MODE=1 才開，正式網址沒有）──
    if (rawEnv.TEST_MODE === "1" && url.pathname.startsWith("/test")) {
      env.__sent = [];
      const at = url.searchParams.get("at"); // 假裝現在是幾點：2026-11-22T13:35（台灣時間）
      NOW = at ? Date.parse(at + ":00+08:00") : 0;
      try {
        if (url.pathname === "/test-init") { await env.D1.prepare(SCHEMA).run(); await env.D1_TEST.prepare(SCHEMA).run(); return Response.json({ ok: true }); }
        if (url.pathname === "/test") {
          const q = url.searchParams.get("q") || "";
          const out = req.method === "POST" ? await understand(env, await sttBytes(env, new Uint8Array(await req.arrayBuffer())), true) : (await command(env, q)) || (await understand(env, q));
          return Response.json({ reply: out, sent: env.__sent });
        }
        if (url.pathname === "/test-ai") { // 只看 AI 整理結果，不存資料（比較模型用）
          env.FORCE_MODEL = url.searchParams.get("model") || undefined;
          const t0 = Date.now();
          try { const plan = await askAI(env, annotateDates(await fixText(env, url.searchParams.get("q") || ""))); return Response.json({ ms: Date.now() - t0, plan }); }
          catch (e) { return Response.json({ ms: Date.now() - t0, error: e.message }); }
        }
        if (url.pathname === "/test-sb") { // 模擬 LINE 傳來的訊息（走真正的 handleEvent）
          const uid = url.searchParams.get("uid") || (await env.DB.get("owner")) || "Utest-owner";
          const pb = url.searchParams.get("pb");
          const type = url.searchParams.get("type");
          const ev = type === "follow" ? { type: "follow", source: { userId: uid }, replyToken: "t" }
            : pb ? { type: "postback", source: { userId: uid }, replyToken: "t", postback: { data: pb } }
              : { type: "message", source: { userId: uid }, replyToken: "t", message: { type: "text", text: url.searchParams.get("q") || "" } };
          await handleEvent(env, ev);
          return Response.json({ sent: env.__sent });
        }
        if (url.pathname === "/test-pb") return Response.json({ reply: await onPostback(env, url.searchParams.get("data") || "") });
        if (url.pathname === "/test-kv") return Response.json(await getJ(env, url.searchParams.get("k"), null));
        if (url.pathname === "/test-ics") return new Response(await buildIcs(env), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
        if (url.pathname === "/test-cron") {
          env.__FORCE_MONDAY = url.searchParams.has("monday") ? 1 : 0;
          env.__TEST_OWNER = "Utest-not-real";
          env.__QUOTA = url.searchParams.get("quota") || 0;
          const c = url.searchParams.get("c");
          if (c === "morning") { await env.DB.delete("last_run"); await morning(env); }
          else if (c === "check") await selfCheck(env);
          else if (c === "remind") await remind(env);
          else await tick(env, NOW);
          return Response.json({ sent: env.__sent, errors: (await getList(env, "errors")).slice(0, 3) });
        }
        if (url.pathname === "/test-admin") { // 模擬 AI 全壞
          env.FORCE_MODEL = "@cf/does-not/exist";
          const out = await understand(env, url.searchParams.get("q") || "");
          return Response.json({ reply: out, sent: env.__sent, errors: await getList(env, "errors") });
        }
      } finally { NOW = 0; }
    }
    return new Response(BOT, { status: 200 });
  },

  async scheduled(event, rawEnv) {
    return tick(wrap(rawEnv), 0);
  },
};
