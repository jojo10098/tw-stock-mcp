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
// 清單驗證
// ---------------------------------------------------------------------------

function posNum(v, field) {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${field} 必須是正數`);
  return n;
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
  return { date, noNewEntryAfter, items: out, setAt: new Date().toISOString() };
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
 * @param ctx    { minute, hhmm, noNewEntryMin, avgVol5 }
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
  const expectedVol = ctx.avgVol5 ? (ctx.avgVol5 * Math.min(Math.max(ctx.minute - OPEN_MIN, 1), SESSION_MINUTES)) / SESSION_MINUTES : null;
  const volRatio = expectedVol && quote.tradeVolume != null ? quote.tradeVolume / expectedVol : null;

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
      events.push({ type: "entry", entry: e, price, scenario, volRatio, levels: exitLevels(price) });
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
    const vol =
      ev.volRatio != null
        ? `量能：累計 ${fmt(quote.tradeVolume)} 張，約近 5 日同時段 ${ev.volRatio.toFixed(1)} 倍（線性估算）`
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

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

export async function sendTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.log(JSON.stringify({ telegram: "not_configured", text: text.slice(0, 80) }));
    return { ok: false, reason: "未設定 TELEGRAM_BOT_TOKEN／TELEGRAM_CHAT_ID" };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) return { ok: false, reason: `Telegram ${res.status}：${body.description ?? ""}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `Telegram 連線失敗：${e.message}` };
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

  const state = (await kvGet(env, `state:${t.date}`)) ?? { symbols: {}, avgVol5: {}, reminded: false, sent: [] };
  const active = wl.items.filter((it) => !state.symbols[it.symbol]?.invalidated);

  // 近 5 日均量：每天每檔只查一次
  for (const it of active) {
    if (state.avgVol5[it.symbol] === undefined) {
      try {
        const h = await deps.getDailyHistory(env, { symbol: it.symbol, days: 5 });
        const vols = (h.candles || []).filter((c) => c.date < t.date).map((c) => c.volume).filter((v) => v != null);
        state.avgVol5[it.symbol] = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : null;
      } catch {
        state.avgVol5[it.symbol] = null;
      }
    }
  }

  const messages = [];
  if (active.length) {
    const q = await deps.getQuotes(env, { symbols: active.map((it) => it.symbol) });
    const bySym = Object.fromEntries((q.quotes || []).map((x) => [x.symbol, x]));
    const noNewEntryMin = hhmmToMinute(wl.noNewEntryAfter) ?? 12 * 60 + 30;
    for (const it of active) {
      const st = (state.symbols[it.symbol] ??= newSymbolState());
      const quote = bySym[it.symbol];
      const events = evaluateItem(it, quote, st, { minute: t.minute, hhmm: t.hhmm, noNewEntryMin, avgVol5: state.avgVol5[it.symbol] });
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
      return {
        symbol: it.symbol,
        name: it.name,
        invalidBelow: it.invalidBelow,
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
