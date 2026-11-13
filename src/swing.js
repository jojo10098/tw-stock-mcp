/**
 * 波段盤中價位通知（v0.9.0）
 *
 * 流程：晨報用 MCP 工具 set_swing_alerts 寫入當日清單（持股的停損／目標警示、候選股的進場觸發價）
 *      → WatchMonitor 的 alarm 在台北 09:01–13:25 約每 60 秒檢查一次
 *      → 條件成立時用 Telegram 通知（每個條件每天只通知一次）
 *
 * 與當沖監控不同：不追蹤 1% 停損、0.6% 目標、保本，也沒有 13:15 平倉提醒；波段的出場以收盤價為準，
 * 盤中通知只是提醒「價位到了」。持股（role:"holding"）的通知只送到個人私訊，不送頻道。
 */

import { taipeiParts, expectedVolume, buildVolumeProfile, sendTelegram } from "./monitor.js";

const OPEN_MIN = 9 * 60;
const LAST_CHECK_MIN = 13 * 60 + 25;
export const SWING_CHECK_SECONDS = 60;
const MAX_ITEMS = 12;
const MAX_ALERTS = 4;
const KINDS = ["entry", "stop", "target", "info"];
const KIND_LABEL = { entry: "📈 波段進場價位到了", stop: "🛑 波段停損價位到了", target: "🎯 波段目標價位到了", info: "🔔 波段價位提醒" };

function posNum(v, field) {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${field} 必須是正數`);
  return n;
}

export function validateSwingList(input) {
  const date = String(input?.date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date 必須是 YYYY-MM-DD（台北日期）");
  const items = Array.isArray(input?.items) ? input.items : [];
  if (items.length > MAX_ITEMS) throw new Error(`一次最多 ${MAX_ITEMS} 檔`);
  const seen = new Set();
  return {
    date,
    items: items.map((it, i) => {
      const symbol = String(it?.symbol ?? "").trim().toUpperCase();
      if (!/^[0-9A-Z]{4,6}$/.test(symbol)) throw new Error(`items[${i}].symbol 格式錯誤`);
      if (seen.has(symbol)) throw new Error(`${symbol} 重複`);
      seen.add(symbol);
      const role = it?.role === "holding" ? "holding" : "candidate";
      const alerts = Array.isArray(it?.alerts) ? it.alerts : [];
      if (!alerts.length) throw new Error(`${symbol} 至少要有一個 alert`);
      if (alerts.length > MAX_ALERTS) throw new Error(`${symbol} 最多 ${MAX_ALERTS} 個 alert`);
      const ids = new Set();
      return {
        symbol,
        name: String(it?.name ?? "").slice(0, 20),
        role,
        note: it?.note ? String(it.note).slice(0, 200) : undefined,
        alerts: alerts.map((a, j) => {
          const id = String(a?.id ?? `a${j + 1}`).slice(0, 20);
          if (ids.has(id)) throw new Error(`${symbol} 的 alert id 重複：${id}`);
          ids.add(id);
          const kind = KINDS.includes(a?.kind) ? a.kind : "info";
          const priceAbove = posNum(a?.priceAbove, `${symbol}.${id}.priceAbove`);
          const priceBelow = posNum(a?.priceBelow, `${symbol}.${id}.priceBelow`);
          if ((priceAbove == null) === (priceBelow == null)) throw new Error(`${symbol}.${id} 需要 priceAbove 或 priceBelow 其中一個`);
          const holdMinutes = a?.holdMinutes == null ? 2 : Math.max(1, Math.min(30, parseInt(a.holdMinutes, 10) || 1));
          const minVolumeRatio = a?.minVolumeRatio == null ? null : posNum(a.minVolumeRatio, `${symbol}.${id}.minVolumeRatio`);
          const trigger = priceAbove != null ? `站上 ${priceAbove}` : `跌破 ${priceBelow}`;
          return {
            id,
            kind,
            label: String(a?.label ?? trigger).slice(0, 80),
            priceAbove,
            priceBelow,
            holdMinutes,
            minVolumeRatio,
            action: a?.action ? String(a.action).slice(0, 120) : undefined,
          };
        }),
      };
    }),
    setAt: new Date().toISOString(),
  };
}

/** 純函式：判斷一檔的 alert 是否成立（會修改 st） */
export function evaluateSwingItem(item, quote, st, ctx) {
  const events = [];
  if (!quote || quote.error || quote.isToday === false || quote.lastPrice == null) return events;
  const price = quote.lastPrice;
  const expected = expectedVolume(ctx.volBase, ctx.minute);
  const volRatio = expected && quote.tradeVolume != null ? quote.tradeVolume / expected : null;
  for (const a of item.alerts) {
    if (st.fired[a.id]) continue;
    let ok = a.priceAbove != null ? price >= a.priceAbove : price <= a.priceBelow;
    if (ok && a.minVolumeRatio != null) ok = volRatio != null && volRatio >= a.minVolumeRatio;
    if (!ok) {
      delete st.holdSince[a.id];
      continue;
    }
    if (st.holdSince[a.id] == null) st.holdSince[a.id] = ctx.sec;
    if (ctx.sec - st.holdSince[a.id] >= (a.holdMinutes - 1) * 60) {
      st.fired[a.id] = { at: ctx.hhmm, price };
      events.push({ alert: a, price, volRatio, volMethod: ctx.volBase?.method ?? null });
    }
  }
  return events;
}

const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 }));

export function formatSwingEvent(item, quote, ev, hhmm) {
  const a = ev.alert;
  const chg = quote?.changePercent != null ? `${quote.changePercent > 0 ? "+" : ""}${quote.changePercent}%` : "—";
  const vol = ev.volRatio != null ? `量比 ${ev.volRatio.toFixed(1)}（今日累計 ${fmt(quote?.tradeVolume)} 張）` : `今日累計 ${fmt(quote?.tradeVolume)} 張`;
  const lines = [
    `${KIND_LABEL[a.kind]}｜${item.symbol} ${item.name || quote?.name || ""}`.trim(),
    `${a.label}｜現價 ${fmt(ev.price)}（${hhmm}）｜今日 ${chg}`,
    vol,
  ];
  if (a.action) lines.push(a.action);
  if (a.kind === "stop") lines.push("波段停損以收盤價為準：13:25 前若仍在停損價之下，請準備依計畫出場。");
  lines.push("這是價位提醒，不是下單指令。");
  return lines.join("\n");
}

/** 由 WatchMonitor.alarm 呼叫；約每 60 秒實際執行一次 */
export async function runSwingTick(env, now, deps) {
  const store = deps.store;
  const t = taipeiParts(now);
  if (t.weekday === 0 || t.weekday === 6) return { skipped: "weekend" };
  if (t.minute < OPEN_MIN + 1 || t.minute > LAST_CHECK_MIN) return { skipped: "outside_session" };
  const list = await store.get("swing");
  if (!list || list.date !== t.date || !list.items?.length) return { skipped: "no_swing_today" };
  const key = `swingstate:${t.date}`;
  const state = (await store.get(key)) ?? { symbols: {}, volBase: {}, sent: [], lastRunSec: null };
  if (state.lastRunSec != null && t.sec - state.lastRunSec < SWING_CHECK_SECONDS - 2) return { skipped: "throttled" };
  state.lastRunSec = t.sec;
  const active = list.items.filter((it) => it.alerts.some((a) => !state.symbols[it.symbol]?.fired?.[a.id]));
  const needVol = active.filter((it) => it.alerts.some((a) => a.minVolumeRatio != null) && state.volBase[it.symbol] === undefined);
  for (const it of needVol) {
    let base = null;
    try {
      const r = await deps.getMinuteHistory(env, { symbol: it.symbol, today: t.date });
      base = buildVolumeProfile(r?.candles, t.date, 5);
    } catch {
      base = null;
    }
    state.volBase[it.symbol] = base;
  }
  const messages = [];
  for (let i = 0; i < active.length; i += 10) {
    const chunk = active.slice(i, i + 10);
    const q = await deps.getQuotes(env, { symbols: chunk.map((x) => x.symbol) });
    const bySym = Object.fromEntries((q.quotes || []).map((x) => [x.symbol, x]));
    for (const it of chunk) {
      const st = (state.symbols[it.symbol] ??= { fired: {}, holdSince: {} });
      const evs = evaluateSwingItem(it, bySym[it.symbol], st, { minute: t.minute, sec: t.sec, hhmm: t.hhmmss, volBase: state.volBase[it.symbol] });
      for (const ev of evs) messages.push({ text: formatSwingEvent(it, bySym[it.symbol], ev, t.hhmmss), privateOnly: it.role === "holding" });
    }
  }
  for (const m of messages) {
    const r = await sendTelegram(env, m.text, { privateOnly: m.privateOnly });
    state.sent.push({ at: t.hhmmss, ok: r.ok, reason: r.ok ? undefined : r.reason, preview: m.text.split("\n")[0] });
  }
  if (state.sent.length > 100) state.sent = state.sent.slice(-100);
  state.lastCheck = t.hhmmss;
  await store.put(key, state);
  return { ran: true, checked: active.length, messages: messages.length };
}

export function swingStatus(list, state, now = new Date(Date.now())) {
  const t = taipeiParts(now);
  return {
    today: t.date,
    listDate: list?.date ?? null,
    activeToday: list?.date === t.date,
    checkEverySeconds: SWING_CHECK_SECONDS,
    lastCheck: state?.lastCheck ?? null,
    items: (list?.items ?? []).map((it) => ({
      symbol: it.symbol,
      name: it.name,
      role: it.role,
      alerts: it.alerts.map((a) => ({
        ...a,
        status: state?.symbols?.[it.symbol]?.fired?.[a.id] ? `已通知 ${state.symbols[it.symbol].fired[a.id].at} @ ${state.symbols[it.symbol].fired[a.id].price}` : "監控中",
      })),
    })),
    notifications: state?.sent ?? [],
  };
}
