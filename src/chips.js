/**
 * 籌碼面：三大法人買賣超（證交所 T86／櫃買中心）與集保股權分散（大戶持股）
 * 全部使用免費官方資料，不吃富果額度。
 *
 * - 上市三大法人：https://www.twse.com.tw/rwd/zh/fund/T86（每個交易日一份全市場檔）
 * - 上櫃三大法人：https://www.tpex.org.tw（新舊兩種網址，第一次成功後記住用哪一種）
 * - 集保股權分散：https://opendata.tdcc.com.tw/getOD.ashx?id=1-5（只有最新一週的全市場 CSV）
 *   → 每週把精簡快照存進 Durable Object，之後就能算週增減與近幾週趨勢。
 */

const UA = "Mozilla/5.0 (compatible; tw-stock-mcp; +https://github.com/jojo10098/tw-stock-mcp)";
const DAY_MS = 86400 * 1000;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function n(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/,/g, "").trim();
  if (s === "" || s === "-" || s === "--") return null;
  const x = Number(s);
  return Number.isFinite(x) ? x : null;
}

const lots = (shares) => (shares == null ? null : Math.round(shares / 1000)); // 股 → 張
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

function taipeiDate(offsetDays = 0) {
  return new Date(Date.now() + 8 * 3600 * 1000 - offsetDays * DAY_MS);
}
const iso = (d) => d.toISOString().slice(0, 10);

/** 從今天往回的平日（不含週末），最多 count 個，新到舊 */
export function recentWeekdays(count, now = taipeiDate()) {
  const out = [];
  for (let i = 0; out.length < count && i < count * 2 + 7; i++) {
    const d = new Date(now.getTime() - i * DAY_MS);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(iso(d));
  }
  return out;
}

function normalizeSymbol(s) {
  return String(s).trim().toUpperCase().replace(/\.(TW|TWO)$/, "");
}

function symbolList(args, max = 30) {
  const symbols = Array.isArray(args?.symbols) ? args.symbols.map(normalizeSymbol).filter(Boolean) : [];
  if (symbols.length === 0) throw new Error("symbols 不可為空");
  if (symbols.length > max) throw new Error(`一次最多 ${max} 檔`);
  return [...new Set(symbols)];
}

async function getText(url, { ttl = 600, method = "GET", body, headers = {} } = {}) {
  const init = {
    method,
    headers: { "user-agent": UA, accept: "application/json, text/plain, */*", ...headers },
  };
  if (body) init.body = body;
  if (method === "GET") init.cf = { cacheTtl: ttl, cacheEverything: true };
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 120)}`);
  return text;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} 回傳的不是 JSON（可能被擋或維護中）：${text.slice(0, 80).replace(/\s+/g, " ")}`);
  }
}

// ---------------------------------------------------------------------------
// 三大法人：欄位對應（依欄位名稱找，找不到才用固定位置）
// ---------------------------------------------------------------------------

/** 依欄位名稱找出各數值的位置；fields 為空時回傳 null */
export function mapInstFields(fields) {
  if (!Array.isArray(fields) || fields.length < 5) return null;
  const f = fields.map((s) => String(s).replace(/\s/g, ""));
  const find = (pred) => f.findIndex(pred);
  const isForeign = (s) => /外陸資|外資及陸資/.test(s) && s.includes("不含") && !s.startsWith("外資自營商");
  const isDealerTotal = (s) =>
    s.includes("自營商") && !s.includes("外資自營商") && !s.includes("自行") && !s.includes("避險");
  const idx = {
    foreignBuy: find((s) => isForeign(s) && s.includes("買進")),
    foreignSell: find((s) => isForeign(s) && s.includes("賣出")),
    foreignNet: find((s) => isForeign(s) && s.includes("買賣超")),
    trustBuy: find((s) => s.includes("投信") && s.includes("買進")),
    trustSell: find((s) => s.includes("投信") && s.includes("賣出")),
    trustNet: find((s) => s.includes("投信") && s.includes("買賣超")),
    dealerNet: find((s) => isDealerTotal(s) && s.includes("買賣超")),
    total: find((s) => s.includes("三大法人")),
  };
  if (idx.foreignNet < 0 || idx.trustNet < 0 || idx.total < 0) return null;
  return idx;
}

// 櫃買中心舊版 24 欄的固定位置（無欄位名稱時使用）
const TPEX_POSITIONAL = {
  foreignBuy: 2, foreignSell: 3, foreignNet: 4,
  trustBuy: 11, trustSell: 12, trustNet: 13,
  dealerNet: 22, total: 23,
};

/** rows → Map(code → { name, foreign:{buy,sell,net}, trust:{...}, dealerNet, total })，單位：張 */
export function parseInstRows(rows, idx) {
  const map = new Map();
  const at = (row, i) => (i == null || i < 0 ? null : n(row[i]));
  for (const row of rows || []) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const code = String(row[0]).trim();
    if (!code) continue;
    map.set(code, {
      name: String(row[1] ?? "").trim(),
      foreign: { buy: lots(at(row, idx.foreignBuy)), sell: lots(at(row, idx.foreignSell)), net: lots(at(row, idx.foreignNet)) },
      trust: { buy: lots(at(row, idx.trustBuy)), sell: lots(at(row, idx.trustSell)), net: lots(at(row, idx.trustNet)) },
      dealerNet: lots(at(row, idx.dealerNet)),
      total: lots(at(row, idx.total)),
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// 三大法人：抓取（每日一份全市場資料，isolate 內記憶）
// ---------------------------------------------------------------------------

const instMemo = new Map(); // "TWSE:2026-11-10" → { ok, map } | { ok:false, reason }
let tpexVariant = null; // 記住哪一種櫃買網址可用

async function fetchTwseInst(date, today) {
  const ymd = date.replace(/-/g, "");
  const url = `https://www.twse.com.tw/rwd/zh/fund/T86?date=${ymd}&selectType=ALLBUT0999&response=json`;
  const text = await getText(url, { ttl: date < today ? 86400 : 600 });
  const j = parseJson(text, "證交所 T86");
  if (String(j.stat).toUpperCase() !== "OK" || !Array.isArray(j.data) || j.data.length === 0) {
    return { ok: false, reason: String(j.stat ?? "無資料") };
  }
  const idx = mapInstFields(j.fields);
  if (!idx) throw new Error("證交所 T86 欄位格式改變，無法解析：" + JSON.stringify(j.fields).slice(0, 200));
  return { ok: true, map: parseInstRows(j.data, idx) };
}

function tpexUrls(date) {
  const slash = date.replace(/-/g, "/");
  const [y, m, d] = date.split("-");
  const roc = `${Number(y) - 1911}/${m}/${d}`;
  const q = `type=Daily&sect=EW&date=${encodeURIComponent(slash)}&id=&response=json`;
  return {
    get: { url: `https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?${q}` },
    post: {
      url: "https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade",
      method: "POST",
      body: q,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    },
    legacy: {
      url: `https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&o=json&se=EW&t=D&d=${encodeURIComponent(roc)}`,
    },
  };
}

function parseTpexJson(j) {
  const table = Array.isArray(j?.tables) ? j.tables.find((t) => Array.isArray(t?.data)) : null;
  const rows = table?.data ?? j?.aaData ?? null;
  if (!Array.isArray(rows)) return null; // 格式不認得
  if (rows.length === 0) return { ok: false, reason: String(j?.stat ?? "無資料") };
  let idx = mapInstFields(table?.fields ?? j?.fields);
  if (!idx) {
    if (rows[0].length < 24) throw new Error(`櫃買三大法人欄位數不符（${rows[0].length} 欄），無法解析`);
    idx = TPEX_POSITIONAL;
  }
  return { ok: true, map: parseInstRows(rows, idx) };
}

async function fetchTpexInst(date, today) {
  const urls = tpexUrls(date);
  const order = tpexVariant ? [tpexVariant] : ["get", "post", "legacy"];
  const errors = [];
  for (const v of order) {
    try {
      const { url, ...opt } = urls[v];
      const text = await getText(url, { ...opt, ttl: date < today ? 86400 : 600 });
      const r = parseTpexJson(parseJson(text, "櫃買中心"));
      if (r) {
        tpexVariant = v;
        return r;
      }
      errors.push(`${v}: 格式不認得`);
    } catch (e) {
      errors.push(`${v}: ${e.message}`);
    }
  }
  if (tpexVariant) tpexVariant = null; // 下次重新探測
  throw new Error("櫃買中心三大法人抓取失敗（" + errors.join("；").slice(0, 300) + "）");
}

async function getInstDay(market, date) {
  const key = `${market}:${date}`;
  const hit = instMemo.get(key);
  if (hit && (hit.ok || Date.now() - hit.at < 10 * 60 * 1000)) return hit;
  const today = iso(taipeiDate());
  let r;
  try {
    r = market === "TWSE" ? await fetchTwseInst(date, today) : await fetchTpexInst(date, today);
  } catch (e) {
    r = { ok: false, error: e.message };
  }
  r.at = Date.now();
  // 過去日期的成功結果不會再變；失敗或今天的結果只記 10 分鐘
  if (instMemo.size > 60) instMemo.clear();
  instMemo.set(key, r);
  return r;
}

/** 取最近 days 個「有資料」的交易日，兩個市場各自回傳 [{date, map}]（新到舊） */
async function getInstHistory(days, markets = ["TWSE", "TPEX"]) {
  const candidates = recentWeekdays(days + 4); // 多抓幾天涵蓋國定假日、今天尚未公布
  const out = {};
  const errors = {};
  for (const market of markets) {
    // TPEx 先探測一天，確定網址後再平行抓其他天
    let rest = candidates;
    const first = market === "TPEX" && !tpexVariant ? [await getInstDay(market, candidates[0])] : [];
    if (first.length) rest = candidates.slice(1);
    const results = first.concat(await Promise.all(rest.map((d) => getInstDay(market, d))));
    const ok = [];
    results.forEach((r, i) => {
      if (r.ok) ok.push({ date: candidates[i], map: r.map });
      else if (r.error) errors[market] = r.error;
    });
    out[market] = ok.slice(0, days);
  }
  return { history: out, errors };
}

function streak(values) {
  // values 新到舊；回傳 +N（連 N 日買超）或 -N（連 N 日賣超）
  let s = 0;
  for (const v of values) {
    if (v == null || v === 0) break;
    if (s === 0) s = v > 0 ? 1 : -1;
    else if ((v > 0) === s > 0) s += s > 0 ? 1 : -1;
    else break;
  }
  return s;
}

const sum = (arr) => arr.reduce((a, b) => a + (b ?? 0), 0);

export async function getInstitutionalTrades(env, args) {
  const symbols = symbolList(args);
  const days = Math.min(Math.max(parseInt(args?.days ?? 5, 10) || 5, 1), 8);
  const { history, errors } = await getInstHistory(days);

  const results = symbols.map((symbol) => {
    let market = null;
    let rows = [];
    for (const m of ["TWSE", "TPEX"]) {
      const found = (history[m] || []).filter((d) => d.map.has(symbol)).map((d) => ({ date: d.date, ...d.map.get(symbol) }));
      if (found.length) {
        market = m;
        rows = found;
        break;
      }
    }
    if (!rows.length) {
      return {
        symbol,
        error: "查無三大法人資料：可能近期法人都沒有交易、代號錯誤，或資料來源暫時無法連線" +
          (Object.keys(errors).length ? `（${Object.entries(errors).map(([k, v]) => `${k}: ${v}`).join("；")}）` : ""),
      };
    }
    const f = rows.map((r) => r.foreign.net);
    const t = rows.map((r) => r.trust.net);
    const dl = rows.map((r) => r.dealerNet);
    return {
      symbol,
      name: rows[0].name,
      market: market === "TWSE" ? "上市" : "上櫃",
      latestDate: rows[0].date,
      foreignStreak: streak(f), // +N 連 N 日買超，-N 連 N 日賣超
      trustStreak: streak(t),
      periodNet: { days: rows.length, foreign: sum(f), trust: sum(t), dealer: sum(dl), total: sum(rows.map((r) => r.total)) },
      daily: rows.map((r) => ({
        date: r.date,
        foreignNet: r.foreign.net,
        trustNet: r.trust.net,
        dealerNet: r.dealerNet,
        totalNet: r.total,
      })),
    };
  });

  return {
    source: "臺灣證券交易所 T86／櫃買中心三大法人買賣明細（盤後，約 15:00–16:30 公布）",
    unit: "張（已由股換算）",
    order: "daily 新到舊；foreignStreak／trustStreak：+N＝連 N 日買超、-N＝連 N 日賣超（只算查詢區間內）",
    note: "外資為外資及陸資（不含外資自營商）；自營商為自行買賣＋避險合計。法人當天沒有交易的日子不會出現在 daily。",
    dataDates: { 上市: (history.TWSE || []).map((d) => d.date), 上櫃: (history.TPEX || []).map((d) => d.date) },
    ...(Object.keys(errors).length ? { sourceErrors: errors } : {}),
    results,
  };
}

export async function getInstitutionalRanking(env, args) {
  const top = Math.min(Math.max(parseInt(args?.top ?? 10, 10) || 10, 1), 30);
  const includeEtf = args?.includeEtf === true;
  const { history, errors } = await getInstHistory(1);
  const rows = [];
  const dates = {};
  for (const m of ["TWSE", "TPEX"]) {
    const d = history[m]?.[0];
    if (!d) continue;
    dates[m === "TWSE" ? "上市" : "上櫃"] = d.date;
    for (const [code, r] of d.map) {
      if (!includeEtf && !/^[1-9]\d{3}$/.test(code)) continue; // 只留一般個股（排除 00 開頭 ETF、權證、特別股）
      rows.push({ code, name: r.name, market: m === "TWSE" ? "上市" : "上櫃", foreign: r.foreign.net, trust: r.trust.net, dealer: r.dealerNet, total: r.total });
    }
  }
  if (!rows.length) throw new Error("查無三大法人資料" + (Object.keys(errors).length ? "：" + JSON.stringify(errors) : ""));
  const rank = (key, dir) =>
    rows
      .filter((r) => r[key] != null && (dir > 0 ? r[key] > 0 : r[key] < 0))
      .sort((a, b) => (b[key] - a[key]) * dir)
      .slice(0, top)
      .map((r) => ({ code: r.code, name: r.name, market: r.market, net: r[key], foreign: r.foreign, trust: r.trust, total: r.total }));
  return {
    source: "臺灣證券交易所 T86／櫃買中心三大法人買賣明細（最近一個已公布的交易日）",
    unit: "張",
    dataDates: dates,
    scope: includeEtf ? "上市櫃全部（含 ETF）" : "上市櫃一般個股（不含 ETF、權證）",
    ...(Object.keys(errors).length ? { sourceErrors: errors } : {}),
    foreignBuy: rank("foreign", 1),
    foreignSell: rank("foreign", -1),
    trustBuy: rank("trust", 1),
    trustSell: rank("trust", -1),
    totalBuy: rank("total", 1),
    totalSell: rank("total", -1),
  };
}

// ---------------------------------------------------------------------------
// 集保股權分散（大戶持股）
// ---------------------------------------------------------------------------

const TDCC_URL = "https://opendata.tdcc.com.tw/getOD.ashx?id=1-5";
// 持股分級（股）：1:1-999 2:1-5張 3:5-10張 4:10-15張 5:15-20張 6:20-30張 7:30-40張 8:40-50張
// 9:50-100張 10:100-200張 11:200-400張 12:400-600張 13:600-800張 14:800-1000張 15:1000張以上 16:差異數調整 17:合計
/**
 * 解析 CSV → { date, snap: { code: [合計人數, 千張大戶%, 400張以上%, 50張以下%, 千張大戶人數, 400張以上人數] } }
 * 用 indexOf 逐行掃描，避免 split 整個 2MB 字串，壓低 CPU。
 */
export function parseTdccCsv(text) {
  const snap = {};
  let date = null;
  let pos = text.indexOf("\n") + 1; // 跳過標題列
  const len = text.length;
  let cur = null;
  let curCode = null;
  while (pos < len) {
    let end = text.indexOf("\n", pos);
    if (end < 0) end = len;
    // 欄位：資料日期,證券代號,持股分級,人數,股數,占集保庫存數比例%
    const c1 = text.indexOf(",", pos);
    const c2 = text.indexOf(",", c1 + 1);
    const c3 = text.indexOf(",", c2 + 1);
    const c4 = text.indexOf(",", c3 + 1);
    const c5 = text.indexOf(",", c4 + 1);
    if (c5 > 0 && c5 < end) {
      if (!date) date = text.slice(pos, c1).trim();
      const code = text.slice(c1 + 1, c2).trim();
      const tier = +text.slice(c2 + 1, c3);
      if (code !== curCode) {
        curCode = code;
        cur = snap[code] = [0, 0, 0, 0, 0, 0];
      }
      if (tier === 17) cur[0] = +text.slice(c3 + 1, c4);
      else if (tier >= 1 && tier <= 15) {
        const pct = +text.slice(c5 + 1, end);
        if (tier === 15) {
          cur[1] = pct;
          cur[4] = +text.slice(c3 + 1, c4);
        }
        if (tier >= 12) {
          cur[2] += pct;
          cur[5] += +text.slice(c3 + 1, c4);
        }
        if (tier <= 8) cur[3] += pct;
      }
    }
    pos = end + 1;
  }
  for (const k in snap) {
    const s = snap[k];
    s[2] = r2(s[2]);
    s[3] = r2(s[3]);
  }
  if (date && /^\d{8}$/.test(date)) date = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  return { date, snap };
}

const tdccMemo = { checkedAt: 0, date: null, snaps: new Map() };
const TDCC_RECHECK_MS = 3 * 3600 * 1000;
const TDCC_KEEP_WEEKS = 12;

/**
 * 取最新一週快照，並確保已存進 store（Durable Object KV）。
 * store: { get(key), put(key, value) }；沒有 store 時只能回傳最新一週、沒有週增減。
 */
async function loadTdcc(store) {
  let dates = store ? (await store.get("tdcc:dates")) || [] : [];
  const fresh = Date.now() - tdccMemo.checkedAt < TDCC_RECHECK_MS && tdccMemo.date;
  let latest = fresh ? tdccMemo.date : null;

  if (!latest) {
    const meta = store ? await store.get("tdcc:meta") : null;
    if (meta && Date.now() - meta.checkedAt < TDCC_RECHECK_MS && dates.includes(meta.date)) {
      latest = meta.date;
    } else {
      const text = await getText(TDCC_URL, { ttl: 3600, headers: { accept: "text/csv,*/*" } });
      if (!text.startsWith("資料日期") && !text.includes("持股分級")) {
        throw new Error("集保開放資料格式不符或暫時無法連線：" + text.slice(0, 80));
      }
      // 先只讀第一筆資料的日期；已經存過這一週就不用整份解析（解析 2MB 約要 20ms CPU）
      const firstLine = text.slice(text.indexOf("\n") + 1, text.indexOf("\n", text.indexOf("\n") + 1));
      const raw = firstLine.split(",")[0].trim();
      const peek = /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : null;
      let date = peek;
      if (!peek || !dates.includes(peek) || !store) {
        const parsed = parseTdccCsv(text);
        date = parsed.date;
        if (!date) throw new Error("集保開放資料沒有日期");
        tdccMemo.snaps.set(date, parsed.snap);
      }
      latest = date;
      if (store) {
        if (!dates.includes(date)) {
          const snap = tdccMemo.snaps.get(date);
          await store.put(`tdcc:${date}`, snap);
          dates = [...dates, date].sort().reverse();
          for (const old of dates.slice(TDCC_KEEP_WEEKS)) await store.put(`tdcc:${old}`, null);
          dates = dates.slice(0, TDCC_KEEP_WEEKS);
          await store.put("tdcc:dates", dates);
        }
        await store.put("tdcc:meta", { date, checkedAt: Date.now() });
      }
    }
    tdccMemo.date = latest;
    tdccMemo.checkedAt = Date.now();
  }
  if (!dates.includes(latest)) dates = [latest, ...dates].sort().reverse();
  return { latest, dates };
}

async function getSnap(store, date) {
  if (tdccMemo.snaps.has(date)) return tdccMemo.snaps.get(date);
  const s = store ? await store.get(`tdcc:${date}`) : null;
  if (s) {
    if (tdccMemo.snaps.size > TDCC_KEEP_WEEKS) tdccMemo.snaps.clear();
    tdccMemo.snaps.set(date, s);
  }
  return s;
}

export async function getMajorHolders(env, args, store) {
  const symbols = symbolList(args);
  const weeks = Math.min(Math.max(parseInt(args?.weeks ?? 4, 10) || 4, 1), TDCC_KEEP_WEEKS);
  const { latest, dates } = await loadTdcc(store);
  const useDates = dates.filter((d) => d <= latest).slice(0, weeks);
  const snaps = [];
  for (const d of useDates) {
    const s = await getSnap(store, d);
    if (s) snaps.push({ date: d, snap: s });
  }

  const results = symbols.map((symbol) => {
    const series = snaps
      .filter((x) => x.snap[symbol])
      .map(({ date, snap }) => {
        const [holders, p1000, p400, pSmall, h1000, h400] = snap[symbol];
        return { date, holders, bigHolder1000Pct: p1000, bigHolder1000Count: h1000, bigHolder400Pct: p400, bigHolder400Count: h400, retailUnder50Pct: pSmall };
      });
    if (!series.length) return { symbol, error: "集保資料查無此代號" };
    const [now, prev] = series;
    const diff = (k) => (prev && now[k] != null && prev[k] != null ? r2(now[k] - prev[k]) : null);
    return {
      symbol,
      date: now.date,
      ...now,
      weekOverWeek: prev
        ? {
            prevDate: prev.date,
            bigHolder1000PctChange: diff("bigHolder1000Pct"),
            bigHolder400PctChange: diff("bigHolder400Pct"),
            retailUnder50PctChange: diff("retailUnder50Pct"),
            holdersChange: now.holders - prev.holders,
          }
        : null,
      history: series,
    };
  });

  const hasPrev = results.some((r) => r.weekOverWeek);
  return {
    source: "臺灣集中保管結算所 集保戶股權分散表（opendata 1-5，每週更新，通常週五資料、週六前後公布）",
    latestDate: latest,
    definitions: {
      bigHolder1000Pct: "持股 1,000 張以上（千張大戶）占集保庫存 %",
      bigHolder400Pct: "持股 400 張以上占集保庫存 %",
      retailUnder50Pct: "持股 50 張以下（散戶）占集保庫存 %",
      holders: "總股東人數",
      changes: "百分點（pp）；大戶比例上升＋股東人數減少＝籌碼集中",
    },
    ...(hasPrev
      ? {}
      : { note: "伺服器每週自行保存快照，目前只有最新一週，週增減要等下一週資料進來才有（集保開放資料只提供最新一週）。" }),
    weeksAvailable: snaps.length,
    results,
  };
}
