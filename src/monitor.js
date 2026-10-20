/**
 * 當沖盤中監控
 *
 * 流程：06:00 晨報用 MCP 工具 set_daytrade_watchlist 寫入當日清單（結構化條件）
 *      → Cloudflare Cron 每分鐘（台北 09:00–13:59）呼叫 runMonitorTick
 *      → 查即時報價、比對條件 → 成立時用 Telegram 通知
 *
 * 狀態存在 Durable Object（WatchMonitor），只當作簡單的 key-value 儲存。
 */

// ---------------------------------------------------------------------------
// 時間（台北）
// ---------------------------------------------------------------------------

export function taipeiParts(date = new Date(Date.now())) {
  const t = new Date(date.getTime() + 8 * 3600 * 1000);
  return {
    date: t.toISOString().slice(0, 10),
    minute: t.getUTCHours() * 60 + t.getUTCMinutes(), // 當日第幾分鐘
    hhmm: t.toISOString().slice(11, 16),
    weekday: t.getUTCDay(), // 0=日
  };
}

export function hhmmToMinute(s) {
  const m = String(s ?? "").match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const OPEN_MIN = 9 * 60; // 09:00
const SESSION_MINUTES = 270; // 09:00–13:30
const CLOSE_REMINDER_MIN = 13 * 60 + 15; // 13:15 提醒平倉
const LAST_CHECK_MIN = 13 * 60 + 25;

// ---------------------------------------------------------------------------
// 台股升降單位
// ---------------------------------------------------------------------------

export function tickSize(price) {
  if (price < 10) return 0.01;
  if (price < 50) return 0.05;
  if (price < 100) return 0.1;
  if (price < 500) return 0.5;
  if (price < 1000) return 1;
  return 5;
}

function snap(x, tick, mode) {
  const n = x / tick;
  const k = mode === "up" ? Math.ceil(n - 1e-9) : Math.floor(n + 1e-9);
  return Number((k * tick).toFixed(2));
}

/** 停損 -1%、第一目標 +0.6%，依升降單位取整（停損往上取、目標往上取，確保虧損不超過 1%、獲利至少 0.6%） */
export function exitLevels(entry) {
  const stopRaw = entry * 0.99;
  const targetRaw = entry * 1.006;
  return {
    stop: snap(stopRaw, tickSize(stopRaw), "up"),
    target: snap(targetRaw, tickSize(targetRaw), "up"),
  };
}

export function scenarioOf(openGapPercent) {
  if (openGapPercent == null || Number.isNaN(openGapPercent)) return null;
  if (openGapPercent >= 1) return "high";
  if (openGapPercent <= -1) return "low";
  return "flat";
}

const SCENARIO_LABEL = { high: "開高", flat: "開平", low: "開低", any: "任何開盤" };

// ---------------------------------------------------------------------------
// 量能基準：依近幾日「實際分時累計量」估算同時段的正常量
// ---------------------------------------------------------------------------

const PROFILE_MIN_DAYS = 3; // 分 K 至少要有 3 天，否則退回線性估算

/**
 * 由近幾個交易日的 1 分 K 建立「同時段平均累計量」曲線。
 * cum[k] = 這幾天在 09:00+k 分「之前」（不含該分鐘）累計成交量的平均（張）。
 * 盤中第 M 分鐘檢查時，今天的累計量涵蓋到 M 分，與 cum[M-09:00] 時間對齊。
 * @param candles 富果 1 分 K：{ date: "2026-10-20T09:00:00.000+08:00", volume }（上市櫃單位為張）
 * @param today   台北日期 YYYY-MM-DD，今天的資料會排除
 * @param maxDays 最多取幾天（最近的）
 */
export function buildVolumeProfile(candles, today, maxDays = 5) {
  const byDay = new Map();
  for (const c of candles || []) {
    const d = String(c?.date ?? "");
    const m = d.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
    if (!m || m[1] >= today || c.volume == null) continue;
    const minute = Number(m[2]) * 60 + Number(m[3]);
    if (!byDay.has(m[1])) byDay.set(m[1], []);
    byDay.get(m[1]).push([minute, Number(c.volume)]);
  }
  const days = [...byDay.keys()].sort().reverse().slice(0, maxDays);
  if (days.length < PROFILE_MIN_DAYS) return null;
  const size = SESSION_MINUTES + 2; // k = 0..271，最後一格含 13:30 收盤集合競價
  const cum = new Array(size).fill(0);
  for (const day of days) {
    const perMin = new Array(size).fill(0);
    for (const [minute, vol] of byDay.get(day)) {
      const k = minute - OPEN_MIN;
      if (k >= 0 && k < size - 1) perMin[k + 1] += vol; // 該分鐘的量計入「下一分鐘之前」
    }
    let run = 0;
    for (let k = 0; k < size; k++) {
      run += perMin[k];
      cum[k] += run;
    }
  }
  return {
    method: "profile",
    days: days.length,
    dates: days,
    cum: cum.map((v) => Math.round(v / days.length)),
  };
}

/** 某分鐘的「正常累計量」（張）；無法估算時回傳 null */
export function expectedVolume(base, minute) {
  if (!base) return null;
  const k = Math.min(Math.max(minute - OPEN_MIN, 1), SESSION_MINUTES + 1);
  if (base.method === "profile") {
    const v = base.cum?.[k];
    return v > 0 ? v : null;
  }
  if (base.method === "linear" && base.avgVol5) {
    return (base.avgVol5 * Math.min(k, SESSION_MINUTES)) / SESSION_MINUTES;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 清單驗證
// ---------------------------------------------------------------------------

function posNum(v, field) {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${field} 必須是正數`);
  return n;
}

function strList(v, maxItems, maxLen) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, maxItems).map((x) => x.slice(0, maxLen));
}

export function validateWatchlist(input) {
  const date = String(input?.date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date 必須是 YYYY-MM-DD（台北日期）");
  const items = Array.isArray(input?.items) ? input.items : [];
  if (items.length > 5) throw new Error("一次最多監控 5 檔");
  const noNewEntryAfter = input?.noNewEntryAfter ?? "12:30";
  if (hhmmToMinute(noNewEntryAfter) == null) throw new Error("noNewEntryAfter 格式為 HH:MM");
  const seen = new Set();
  const out = items.map((it, i) => {
    const symbol = String(it?.symbol ?? "").trim().toUpperCase();
    if (!/^[0-9A-Z]{4,6}$/.test(symbol)) throw new Error(`items[${i}].symbol 格式錯誤`);
    if (seen.has(symbol)) throw new Error(`${symbol} 重複`);
    seen.add(symbol);
    const entries = Array.isArray(it?.entries) ? it.entries : [];
    if (entries.length === 0) throw new Error(`${symbol} 至少要有一個進場條件`);
    const ids = new Set();
    return {
      symbol,
      name: String(it?.name ?? ""),
      prevClose: posNum(it?.prevClose, `${symbol}.prevClose`),
      invalidBelow: posNum(it?.invalidBelow, `${symbol}.invalidBelow`),
      note: it?.note ? String(it.note).slice(0, 200) : undefined,
      reason: it?.reason ? String(it.reason).slice(0, 200) : undefined,
      checks: strList(it?.checks, 8, 60),
      tier: it?.tier === "secondary" ? "secondary" : "main",
      entries: entries.map((e, j) => {
        const id = String(e?.id ?? `e${j + 1}`);
        if (ids.has(id)) throw new Error(`${symbol} 的條件 id 重複：${id}`);
        ids.add(id);
        const when = e?.when ?? "any";
        if (!["high", "flat", "low", "any"].includes(when)) throw new Error(`${symbol}.${id}.when 只能是 high／flat／low／any`);
        const priceAbove = posNum(e?.priceAbove, `${symbol}.${id}.priceAbove`);
        if (priceAbove == null) throw new Error(`${symbol}.${id} 缺少 priceAbove（觸發價）`);
        const holdMinutes = e?.holdMinutes == null ? 1 : Math.max(1, Math.min(30, parseInt(e.holdMinutes, 10) || 1));
        return {
          id,
          label: String(e?.label ?? `${SCENARIO_LABEL[when]}站上 ${priceAbove}`).slice(0, 60),
          when,
          priceAbove,
          holdMinutes,
          minVolumeRatio: e?.minVolumeRatio == null ? null : posNum(e.minVolumeRatio, `${symbol}.${id}.minVolumeRatio`),
          abandonBelow: posNum(e?.abandonBelow, `${symbol}.${id}.abandonBelow`),
        };
      }),
    };
  });
  return {
    date,
    noNewEntryAfter,
    criteria: strList(input?.criteria, 10, 80),
    noPickReason: input?.noPickReason ? String(input.noPickReason).slice(0, 200) : undefined,
    items: out,
    setAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 條件判斷（純函式，方便測試）
// ---------------------------------------------------------------------------

export function newSymbolState() {
  return { invalidated: false, fired: {}, abandoned: {}, holdSince: {}, log: [] };
}

/**
 * @param item   清單中的一檔
 * @param quote  get_quotes 的單檔結果
 * @param st     該檔狀態（會被修改）
 * @param ctx    { minute, hhmm, noNewEntryMin, volBase }（volBase 來自 buildVolumeProfile 或 {method:"linear",avgVol5}）
 * @returns 事件陣列：{ type: "entry"|"invalid"|"abandon", ... }
 */
export function evaluateItem(item, quote, st, ctx) {
  const events = [];
  if (st.invalidated || !quote || quote.error || quote.isToday === false) return events;
  const price = quote.lastPrice;
  if (price == null) return events;

  // 交易限制變化：處置、分盤撮合、不可當沖 → 直接失效
  const blocked =
    quote.isDisposition === true ? "被列為處置股"
      : quote.matchingIntervalSeconds > 0 ? `改為分盤撮合（${quote.matchingIntervalSeconds} 秒）`
        : quote.canDayTrade === false ? "今日不可現股當沖"
          : null;
  if (blocked) {
    st.invalidated = true;
    events.push({ type: "invalid", reason: blocked, price });
    return events;
  }

  if (item.invalidBelow != null && price <= item.invalidBelow) {
    st.invalidated = true;
    events.push({ type: "invalid", reason: `跌破失效價 ${item.invalidBelow}`, price });
    return events;
  }

  const scenario = scenarioOf(quote.openGapPercent);
  if (!scenario) return events;
  // 量能基準：優先用分時曲線（ctx.volBase），舊呼叫方式 ctx.avgVol5 視為線性
  const volBase = ctx.volBase ?? (ctx.avgVol5 ? { method: "linear", avgVol5: ctx.avgVol5 } : null);
  const expectedVol = expectedVolume(volBase, ctx.minute);
  const volRatio = expectedVol && quote.tradeVolume != null ? quote.tradeVolume / expectedVol : null;
  const volMethod = volBase?.method ?? null;
  const volDays = volBase?.days ?? null;

  for (const e of item.entries) {
    if (e.when !== "any" && e.when !== scenario) continue;
    if (st.fired[e.id] || st.abandoned[e.id]) continue;

    if (e.abandonBelow != null && price <= e.abandonBelow) {
      st.abandoned[e.id] = true;
      delete st.holdSince[e.id];
      events.push({ type: "abandon", entry: e, price, scenario });
      continue;
    }
    if (ctx.minute > ctx.noNewEntryMin) continue; // 太晚不再發進場通知

    let ok = price >= e.priceAbove;
    if (ok && e.minVolumeRatio != null) ok = volRatio != null && volRatio >= e.minVolumeRatio;
    if (!ok) {
      delete st.holdSince[e.id];
      continue;
    }
    if (st.holdSince[e.id] == null) st.holdSince[e.id] = ctx.minute;
    if (ctx.minute - st.holdSince[e.id] + 1 >= e.holdMinutes) {
      st.fired[e.id] = { at: ctx.hhmm, price };
      events.push({ type: "entry", entry: e, price, scenario, volRatio, volMethod, volDays, levels: exitLevels(price) });
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// 通知文字
// ---------------------------------------------------------------------------

const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 }));

export function formatEvent(item, quote, ev, hhmm) {
  const title = `${item.symbol} ${item.name || quote?.name || ""}`.trim();
  const chg = quote?.changePercent != null ? `${quote.changePercent > 0 ? "+" : ""}${quote.changePercent}%` : "—";
  if (ev.type === "entry") {
    const lot = Math.round(ev.price * 1000);
    const loss = Math.round((ev.price - ev.levels.stop) * 1000);
    const how = ev.volMethod === "profile" ? `近 ${ev.volDays} 日同時段實際累計量` : "近 5 日均量線性估算";
    const vol =
      ev.volRatio != null
        ? `量能：累計 ${fmt(quote.tradeVolume)} 張，為${how}的 ${ev.volRatio.toFixed(1)} 倍`
        : `量能：累計 ${fmt(quote?.tradeVolume)} 張`;
    return [
      `🟢 當沖條件成立｜${title}`,
      `劇本：${SCENARIO_LABEL[ev.scenario]}｜${ev.entry.label}`,
      `現價 ${fmt(ev.price)}（${hhmm}）｜今日 ${chg}`,
      vol,
      `若進場：停損 ${fmt(ev.levels.stop)}（-1%）｜第一目標 ${fmt(ev.levels.target)}（+0.6%）`,
      `1 張約 ${fmt(lot)} 元，觸發停損約虧 ${fmt(loss)} 元＋來回成本`,
      `13:20 前一律平倉。這是條件通知，不是下單指令；請先看分時與五檔。`,
    ].join("\n");
  }
  if (ev.type === "invalid") {
    return `🔴 失效｜${title}\n${ev.reason}（現價 ${fmt(ev.price)}，${hhmm}），今日停止監控這一檔。`;
  }
  if (ev.type === "abandon") {
    return `⚪ 劇本放棄｜${title}\n${SCENARIO_LABEL[ev.scenario]}劇本「${ev.entry.label}」跌破 ${fmt(ev.entry.abandonBelow)}（現價 ${fmt(ev.price)}，${hhmm}）。`;
  }
  return "";
}

/** 晨報寫入清單後的「今日標的」公告 */
export function formatWatchlistAnnouncement(wl, { isUpdate = false, test = false } = {}) {
  const d = new Date(`${wl.date}T00:00:00Z`);
  const wd = "日一二三四五六"[d.getUTCDay()];
  const md = `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${wd}）`;
  const head = `${test ? "🧪 測試推播（不啟動監控）\n" : ""}📋 ${md}當沖監控清單${isUpdate ? "（更新）" : ""}`;
  const crit = wl.criteria?.length
    ? ["", "🔎 選股條件", ...wl.criteria.map((c, i) => `${"①②③④⑤⑥⑦⑧⑨⑩"[i]} ${c}`)]
    : [];
  if (!wl.items.length) {
    return [head, `今日沒有符合條件的當沖標的，不啟動盤中監控。${wl.noPickReason ? `\n原因：${wl.noPickReason}` : ""}`, ...crit].join("\n");
  }
  const lines = [head, `共 ${wl.items.length} 檔，09:01 起自動監控，條件成立會另行通知。`, ...crit];
  wl.items.forEach((it, i) => {
    const tag = it.tier === "secondary" ? "【⚠️ 次級觀察，部位減半】" : "";
    lines.push("", `${i + 1}) ${it.symbol} ${it.name}`.trim() + `${tag}｜昨收 ${fmt(it.prevClose)}｜失效價 ${fmt(it.invalidBelow)}`);
    if (it.reason) lines.push(`  入選理由：${it.reason}`);
    if (it.checks?.length) lines.push(`  條件檢核：${it.checks.join("｜")}`);
    for (const e of it.entries) {
      const cond = [`≥ ${fmt(e.priceAbove)}`, e.holdMinutes > 1 ? `連續 ${e.holdMinutes} 分鐘` : null, e.minVolumeRatio ? `量比 ≥ ${e.minVolumeRatio}` : null]
        .filter(Boolean).join("、");
      const ab = e.abandonBelow != null ? `；跌破 ${fmt(e.abandonBelow)} 放棄` : "";
      lines.push(`  • ${SCENARIO_LABEL[e.when]}｜${e.label}（${cond}${ab}）`);
    }
    const p = it.entries[0]?.priceAbove;
    if (p) {
      const lv = exitLevels(p);
      lines.push(`  1 張約 ${fmt(Math.round(p * 1000))} 元；依觸發價停損 ${fmt(lv.stop)}，約虧 ${fmt(Math.round((p - lv.stop) * 1000))} 元`);
    }
    if (it.note) lines.push(`  備註：${it.note}`);
  });
  lines.push("", `${wl.noNewEntryAfter} 後不發新進場通知；有部位 13:20 前平倉。`, "⚠️ 這是條件監控清單，不是買賣建議。");
  const text = lines.join("\n");
  return text.length > 4000 ? text.slice(0, 3990) + "\n…（過長截斷）" : text; // Telegram 單則上限 4096 字
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

export async function sendTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.log(JSON.stringify({ telegram: "not_configured", text: text.slice(0, 80) }));
    return { ok: false, reason: "未設定 TELEGRAM_BOT_TOKEN／TELEGRAM_CHAT_ID" };
  }
  const chatIds = telegramChatIds(env);
  if (!chatIds.length) return { ok: false, reason: "TELEGRAM_CHAT_ID 沒有有效的 id" };
  // 多個收件者（私訊、頻道、群組）各自發送；一個失敗不影響其他
  const results = await Promise.all(chatIds.map((id) => sendOne(env, id, text)));
  const failed = results.filter((r) => !r.ok);
  return {
    ok: failed.length === 0,
    sentTo: results.length - failed.length,
    total: results.length,
    reason: failed.length ? failed.map((r) => `${r.chatId}：${r.reason}`).join("；") : undefined,
  };
}

/** TELEGRAM_CHAT_ID 可填多個，以逗號、分號或空白分隔；例：8656980423,-1004373470716 或 @頻道名稱 */
export function telegramChatIds(env) {
  return [...new Set(String(env.TELEGRAM_CHAT_ID ?? "").split(/[\s,;，、]+/).map((s) => s.trim()).filter(Boolean))];
}

async function sendOne(env, chatId, text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) return { ok: false, chatId, reason: `Telegram ${res.status}：${body.description ?? ""}` };
    return { ok: true, chatId };
  } catch (e) {
    return { ok: false, chatId, reason: `Telegram 連線失敗：${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// Durable Object：簡單的 key-value 儲存
// ---------------------------------------------------------------------------

export class WatchMonitor {
  constructor(state) {
    this.storage = state.storage;
  }
  async fetch(request) {
    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.replace(/^\/kv\//, ""));
    if (!key || !url.pathname.startsWith("/kv/")) return new Response("bad path", { status: 400 });
    if (request.method === "GET") {
      const v = await this.storage.get(key);
      return new Response(JSON.stringify(v ?? null), { headers: { "content-type": "application/json" } });
    }
    if (request.method === "PUT") {
      await this.storage.put(key, await request.json());
      return new Response(null, { status: 204 });
    }
    return new Response("method not allowed", { status: 405 });
  }
}

function stub(env) {
  return env.MONITOR.get(env.MONITOR.idFromName("main"));
}

export async function kvGet(env, key) {
  const r = await stub(env).fetch(`https://monitor/kv/${encodeURIComponent(key)}`);
  return r.json();
}

export async function kvPut(env, key, value) {
  await stub(env).fetch(`https://monitor/kv/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: JSON.stringify(value),
  });
}

// ---------------------------------------------------------------------------
// 每分鐘執行
// ---------------------------------------------------------------------------

/**
 * @param deps { getQuotes(env,{symbols}), getDailyHistory(env,{symbol,days}) }
 */
export async function runMonitorTick(env, now, deps) {
  if (!env.MONITOR) return { skipped: "no_monitor_binding" };
  const t = taipeiParts(now);
  if (t.weekday === 0 || t.weekday === 6) return { skipped: "weekend" };
  if (t.minute < OPEN_MIN + 1 || t.minute > LAST_CHECK_MIN) return { skipped: "outside_session", hhmm: t.hhmm };

  const wl = await kvGet(env, "watchlist");
  if (!wl || wl.date !== t.date || !wl.items?.length) return { skipped: "no_watchlist_today", date: t.date };

  const state = (await kvGet(env, `state:${t.date}`)) ?? { symbols: {}, reminded: false, sent: [] };
  state.volBase ??= {};
  const active = wl.items.filter((it) => !state.symbols[it.symbol]?.invalidated);

  // 量能基準：每天每檔只建一次。優先用近 5 日 1 分 K 的實際分時累計量；
  // 分 K 取不到或不足 3 天時，退回「近 5 日均量 × 經過時間比例」的線性估算。
  for (const it of active) {
    if (state.volBase[it.symbol] !== undefined) continue;
    let base = null;
    if (deps.getMinuteHistory) {
      try {
        const r = await deps.getMinuteHistory(env, { symbol: it.symbol, today: t.date });
        base = buildVolumeProfile(r?.candles, t.date, 5);
      } catch {
        base = null;
      }
    }
    if (!base) {
      try {
        const h = await deps.getDailyHistory(env, { symbol: it.symbol, days: 5 });
        const vols = (h.candles || []).filter((c) => c.date < t.date).map((c) => c.volume).filter((v) => v != null);
        base = vols.length ? { method: "linear", days: vols.length, avgVol5: vols.reduce((a, b) => a + b, 0) / vols.length } : null;
      } catch {
        base = null;
      }
    }
    state.volBase[it.symbol] = base;
  }

  const messages = [];
  if (active.length) {
    const q = await deps.getQuotes(env, { symbols: active.map((it) => it.symbol) });
    const bySym = Object.fromEntries((q.quotes || []).map((x) => [x.symbol, x]));
    const noNewEntryMin = hhmmToMinute(wl.noNewEntryAfter) ?? 12 * 60 + 30;
    for (const it of active) {
      const st = (state.symbols[it.symbol] ??= newSymbolState());
      const quote = bySym[it.symbol];
      const events = evaluateItem(it, quote, st, { minute: t.minute, hhmm: t.hhmm, noNewEntryMin, volBase: state.volBase[it.symbol] });
      for (const ev of events) {
        st.log.push({ at: t.hhmm, type: ev.type, id: ev.entry?.id ?? null, price: ev.price });
        messages.push(formatEvent(it, quote, ev, t.hhmm));
      }
    }
  }

  // 13:15 平倉提醒（只有今天有發出進場通知時）
  const firedList = Object.entries(state.symbols).flatMap(([sym, st]) => Object.keys(st.fired).map(() => sym));
  if (!state.reminded && t.minute >= CLOSE_REMINDER_MIN && firedList.length) {
    state.reminded = true;
    const names = [...new Set(firedList)].map((s) => `${s} ${wl.items.find((i) => i.symbol === s)?.name ?? ""}`.trim());
    messages.push(`⏰ 13:15 平倉提醒\n今天有發出進場通知：${names.join("、")}\n若有部位，13:20 前一律平倉，不留倉、不轉現股。`);
  }

  for (const text of messages) {
    const r = await sendTelegram(env, text);
    state.sent.push({ at: t.hhmm, ok: r.ok, reason: r.ok ? undefined : r.reason, preview: text.split("\n")[0] });
  }
  if (state.sent.length > 100) state.sent = state.sent.slice(-100);
  await kvPut(env, `state:${t.date}`, state);
  return { ran: true, hhmm: t.hhmm, checked: active.length, messages: messages.length };
}

/** 給 MCP 工具與診斷用：今日清單與狀態摘要 */
export async function watchStatus(env, now = new Date(Date.now())) {
  const t = taipeiParts(now);
  const wl = await kvGet(env, "watchlist");
  const state = wl ? await kvGet(env, `state:${wl.date}`) : null;
  return {
    today: t.date,
    now: t.hhmm,
    watchlistDate: wl?.date ?? null,
    activeToday: wl?.date === t.date,
    noNewEntryAfter: wl?.noNewEntryAfter ?? null,
    telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
    items: (wl?.items ?? []).map((it) => {
      const st = state?.symbols?.[it.symbol];
      const vb = state?.volBase?.[it.symbol];
      const expNow = expectedVolume(vb, t.minute);
      return {
        symbol: it.symbol,
        name: it.name,
        invalidBelow: it.invalidBelow,
        volumeBaseline:
          vb === undefined ? "尚未建立（開盤後第一次檢查時建立）"
            : vb === null ? "無法取得歷史量，量能條件不會成立"
              : vb.method === "profile" ? `近 ${vb.days} 日實際分時累計量（${vb.dates?.join("、")}）`
                : `近 ${vb.days} 日均量線性估算（分 K 不足）`,
        expectedVolumeNow: expNow == null ? null : Math.round(expNow),
        entries: it.entries.map((e) => ({
          id: e.id,
          label: e.label,
          when: e.when,
          priceAbove: e.priceAbove,
          holdMinutes: e.holdMinutes,
          minVolumeRatio: e.minVolumeRatio,
          abandonBelow: e.abandonBelow,
          status: st?.fired?.[e.id] ? `已觸發 ${st.fired[e.id].at} @ ${st.fired[e.id].price}` : st?.abandoned?.[e.id] ? "已放棄" : "監控中",
        })),
        invalidated: st?.invalidated ?? false,
        log: st?.log ?? [],
      };
    }),
    notifications: state?.sent ?? [],
  };
}
