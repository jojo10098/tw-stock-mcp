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
    sec: t.getUTCHours() * 3600 + t.getUTCMinutes() * 60 + t.getUTCSeconds(), // 當日第幾秒
    hhmm: t.toISOString().slice(11, 16),
    hhmmss: t.toISOString().slice(11, 19),
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

// 檢查間隔：依監控檔數自動調整，讓監控最多用掉富果即時額度（60 次／分）的一半，
// 其餘留給晨報、盤中檢查與手動查價。可用環境變數微調：
//   MONITOR_INTERVAL_SECONDS（最短間隔，預設 5 秒）、MONITOR_QUOTA_PER_MIN（監控可用額度，預設 30）
/** 保護條件（大盤、同業）的查價間隔：不需要秒級，最多用每分鐘 15 次額度，至少 30 秒一次 */
export function guardRefreshSeconds(guardCount) {
  if (!guardCount) return 0;
  return Math.max(30, Math.ceil((guardCount * 60) / 15));
}

export function checkIntervalSeconds(env, symbolCount) {
  const floor = Math.max(3, Number(env?.MONITOR_INTERVAL_SECONDS) || 5);
  const budget = Math.min(55, Math.max(6, Number(env?.MONITOR_QUOTA_PER_MIN) || 30));
  const n = Math.max(1, symbolCount || 1);
  return Math.min(60, Math.max(floor, Math.ceil((n * 60) / budget)));
}

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

/**
 * 多方：停損 -1%、第一目標 +0.6%（都往上取）。
 * 空方：停損 +1%、第一目標 -0.6%（都往下取）。
 * 依升降單位取整，確保虧損不超過 1%、獲利至少 0.6%。
 */
export function exitLevels(entry, side = "long") {
  if (side === "short") {
    const stopRaw = entry * 1.01;
    const targetRaw = entry * 0.994;
    return {
      stop: snap(stopRaw, tickSize(stopRaw), "down"),
      target: snap(targetRaw, tickSize(targetRaw), "down"),
    };
  }
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

const SYMBOL_RE = /^(IX\d{4}|[0-9A-Z]{4,6})$/;

function pctIn(v, def, lo, hi, field) {
  if (v === undefined || v === null) return def;
  const n = Math.abs(Number(v));
  if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${field} 需介於 ${lo}–${hi}（%）`);
  return n;
}

/** 大盤保護：預設看加權指數與台積電，任一跌幅 ≥ 1.5% 暫停做多進場、任一漲幅 ≥ 1.5% 暫停做空進場；enabled:false 可關閉 */
export const DEFAULT_MARKET_GUARD = { enabled: true, symbols: ["IX0001", "2330"], dropPercent: 1.5, risePercent: 1.5 };
function validateMarketGuard(g) {
  if (g === false || g?.enabled === false) return { ...DEFAULT_MARKET_GUARD, enabled: false };
  const symbols = Array.isArray(g?.symbols) && g.symbols.length
    ? g.symbols.map((x) => String(x).trim().toUpperCase()).slice(0, 3)
    : DEFAULT_MARKET_GUARD.symbols;
  for (const x of symbols) if (!SYMBOL_RE.test(x)) throw new Error(`marketGuard.symbols 格式錯誤：${x}`);
  return {
    enabled: true,
    symbols,
    dropPercent: pctIn(g?.dropPercent, DEFAULT_MARKET_GUARD.dropPercent, 0.3, 5, "marketGuard.dropPercent"),
    risePercent: pctIn(g?.risePercent, DEFAULT_MARKET_GUARD.risePercent, 0.3, 5, "marketGuard.risePercent"),
  };
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
    const side = it?.side ?? "long";
    if (side !== "long" && side !== "short") throw new Error(`${symbol}.side 只能是 long／short`);
    const short = side === "short";
    if (short && it?.invalidBelow != null) throw new Error(`${symbol} 是空方，失效價請用 invalidAbove`);
    if (!short && it?.invalidAbove != null) throw new Error(`${symbol} 是多方，失效價請用 invalidBelow`);
    return {
      symbol,
      side,
      name: String(it?.name ?? ""),
      prevClose: posNum(it?.prevClose, `${symbol}.prevClose`),
      invalidBelow: posNum(it?.invalidBelow, `${symbol}.invalidBelow`),
      invalidAbove: posNum(it?.invalidAbove, `${symbol}.invalidAbove`),
      note: it?.note ? String(it.note).slice(0, 200) : undefined,
      reason: it?.reason ? String(it.reason).slice(0, 200) : undefined,
      checks: strList(it?.checks, 8, 60),
      tier: it?.tier === "secondary" ? "secondary" : "main",
      peers: (Array.isArray(it?.peers) ? it.peers : []).slice(0, 3).map((x) => {
        const p = String(x ?? "").trim().toUpperCase();
        if (!SYMBOL_RE.test(p) || p === symbol) throw new Error(`${symbol}.peers 格式錯誤：${x}`);
        return p;
      }),
      peerDropPercent: pctIn(it?.peerDropPercent, 2, 0.3, 8, `${symbol}.peerDropPercent`),
      entries: entries.map((e, j) => {
        const id = String(e?.id ?? `e${j + 1}`);
        if (ids.has(id)) throw new Error(`${symbol} 的條件 id 重複：${id}`);
        ids.add(id);
        const when = e?.when ?? "any";
        if (!["high", "flat", "low", "any"].includes(when)) throw new Error(`${symbol}.${id}.when 只能是 high／flat／low／any`);
        if (short && (e?.priceAbove != null || e?.abandonBelow != null)) throw new Error(`${symbol}.${id} 是空方，請用 priceBelow／abandonAbove`);
        if (!short && (e?.priceBelow != null || e?.abandonAbove != null)) throw new Error(`${symbol}.${id} 是多方，請用 priceAbove／abandonBelow`);
        const priceAbove = posNum(e?.priceAbove, `${symbol}.${id}.priceAbove`);
        const priceBelow = posNum(e?.priceBelow, `${symbol}.${id}.priceBelow`);
        if (!short && priceAbove == null) throw new Error(`${symbol}.${id} 缺少 priceAbove（觸發價）`);
        if (short && priceBelow == null) throw new Error(`${symbol}.${id} 缺少 priceBelow（觸發價）`);
        const holdMinutes = e?.holdMinutes == null ? 1 : Math.max(1, Math.min(30, parseInt(e.holdMinutes, 10) || 1));
        return {
          id,
          label: String(e?.label ?? (short ? `${SCENARIO_LABEL[when]}跌破 ${priceBelow}` : `${SCENARIO_LABEL[when]}站上 ${priceAbove}`)).slice(0, 60),
          when,
          priceAbove,
          priceBelow,
          holdMinutes,
          minVolumeRatio: e?.minVolumeRatio == null ? null : posNum(e.minVolumeRatio, `${symbol}.${id}.minVolumeRatio`),
          abandonBelow: posNum(e?.abandonBelow, `${symbol}.${id}.abandonBelow`),
          abandonAbove: posNum(e?.abandonAbove, `${symbol}.${id}.abandonAbove`),
        };
      }),
    };
  });
  return {
    date,
    noNewEntryAfter,
    criteria: strList(input?.criteria, 10, 80),
    marketGuard: validateMarketGuard(input?.marketGuard),
    noPickReason: input?.noPickReason ? String(input.noPickReason).slice(0, 200) : undefined,
    items: out,
    setAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 條件判斷（純函式，方便測試）
// ---------------------------------------------------------------------------

/** 空方部位：距漲停不到這個 % 就提醒立刻回補（鎖漲停買不回，須借券或標借） */
const LIMIT_UP_WARN_PERCENT = 2;

export function newSymbolState() {
  return { invalidated: false, fired: {}, abandoned: {}, holdSince: {}, positions: {}, log: [] };
}

/**
 * @param item   清單中的一檔
 * @param quote  get_quotes 的單檔結果
 * @param st     該檔狀態（會被修改）
 * @param ctx    { minute, sec, hhmm, noNewEntryMin, volBase }（volBase 來自 buildVolumeProfile 或 {method:"linear",avgVol5}）
 * @returns 事件陣列：{ type: "entry"|"invalid"|"abandon"|"stop"|"target"|"breakeven"|"limitUp", ... }
 */
export function evaluateItem(item, quote, st, ctx) {
  const events = [];
  if (!quote || quote.error || quote.isToday === false) return events;
  const price = quote.lastPrice;
  if (price == null) return events;
  st.positions ??= {};
  const nowSec = ctx.sec ?? ctx.minute * 60;
  const short = item.side === "short";

  // 已發出進場通知的部位：追蹤停損、第一目標、保本（即使該檔之後失效也繼續追蹤）
  for (const pos of Object.values(st.positions)) {
    const posShort = pos.side === "short";
    const hitStop = posShort ? price >= pos.stop : price <= pos.stop;
    const hitTarget = posShort ? price <= pos.target : price >= pos.target;
    const backToEntry = posShort ? price >= pos.entryPrice : price <= pos.entryPrice;
    if (pos.status === "open" && hitStop) {
      pos.status = "closed";
      pos.exit = { type: "stop", at: ctx.hhmm, price };
      events.push({ type: "stop", pos, price });
    } else if (pos.status === "open" && hitTarget) {
      pos.status = "target";
      pos.targetAt = { at: ctx.hhmm, price };
      events.push({ type: "target", pos, price });
    } else if (pos.status === "target" && backToEntry) {
      pos.status = "closed";
      pos.exit = { type: "breakeven", at: ctx.hhmm, price };
      events.push({ type: "breakeven", pos, price });
    }
    if (posShort && pos.status !== "closed" && !pos.limitWarned && quote.toLimitUpPercent != null && quote.toLimitUpPercent <= LIMIT_UP_WARN_PERCENT) {
      pos.limitWarned = true;
      events.push({ type: "limitUp", pos, price, toLimitUpPercent: quote.toLimitUpPercent });
    }
  }
  if (st.invalidated) return events;
  const tracking = Object.values(st.positions).some((p) => p.status !== "closed");

  // 交易限制變化：處置、分盤撮合、不可當沖 → 直接失效
  const blocked =
    quote.isDisposition === true ? "被列為處置股"
      : quote.matchingIntervalSeconds > 0 ? `改為分盤撮合（${quote.matchingIntervalSeconds} 秒）`
        : short && quote.canBuyFirstDayTradeOnly === true ? "今日暫停先賣後買"
          : quote.canDayTrade === false ? "今日不可現股當沖"
            : null;
  if (blocked) {
    st.invalidated = true;
    events.push({ type: "invalid", reason: blocked, price, tracking });
    return events;
  }

  if (item.invalidBelow != null && price <= item.invalidBelow) {
    st.invalidated = true;
    events.push({ type: "invalid", reason: `跌破失效價 ${item.invalidBelow}`, price, tracking });
    return events;
  }
  if (item.invalidAbove != null && price >= item.invalidAbove) {
    st.invalidated = true;
    events.push({ type: "invalid", reason: `漲破失效價 ${item.invalidAbove}`, price, tracking });
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

    if ((e.abandonBelow != null && price <= e.abandonBelow) || (e.abandonAbove != null && price >= e.abandonAbove)) {
      st.abandoned[e.id] = true;
      delete st.holdSince[e.id];
      events.push({ type: "abandon", entry: e, price, scenario });
      continue;
    }
    if (ctx.minute > ctx.noNewEntryMin) continue; // 太晚不再發進場通知
    if (ctx.blockEntries) {
      // 大盤或同業保護中：不累計「連續成立」時間，也不發進場通知
      delete st.holdSince[e.id];
      continue;
    }

    let ok = short ? price <= e.priceBelow : price >= e.priceAbove;
    if (ok && e.minVolumeRatio != null) ok = volRatio != null && volRatio >= e.minVolumeRatio;
    if (!ok) {
      delete st.holdSince[e.id];
      continue;
    }
    // 「連續成立 N 分鐘」：從第一次成立起算，持續 (N−1)×60 秒仍成立就觸發（N=1 為立即觸發）
    if (st.holdSince[e.id] == null) st.holdSince[e.id] = nowSec;
    if (nowSec - st.holdSince[e.id] >= (e.holdMinutes - 1) * 60) {
      const levels = exitLevels(price, short ? "short" : "long");
      st.fired[e.id] = { at: ctx.hhmm, price };
      st.positions[e.id] = { id: e.id, side: short ? "short" : "long", label: e.label, entryPrice: price, stop: levels.stop, target: levels.target, at: ctx.hhmm, status: "open" };
      events.push({ type: "entry", entry: e, price, scenario, volRatio, volMethod, volDays, levels });
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// 保護條件（大盤、同業）：觸發時暫停新的進場通知，回穩（多回到門檻內 0.5 個百分點）才恢復
// 做多看下跌、做空看上漲，兩邊各自判斷
// ---------------------------------------------------------------------------

const RESUME_MARGIN = 0.5;

/** 監控需要查價的代號：標的、大盤保護、同業 */
export function guardSymbols(wl) {
  const g = wl?.marketGuard?.enabled === false ? [] : (wl?.marketGuard?.symbols ?? DEFAULT_MARKET_GUARD.symbols);
  const peers = (wl?.items ?? []).flatMap((it) => it.peers ?? []);
  const own = new Set((wl?.items ?? []).map((it) => it.symbol));
  return [...new Set([...g, ...peers])].filter((x) => !own.has(x));
}

/**
 * 大盤保護判斷
 * @param guard   wl.marketGuard
 * @param quotes  { symbol: quote }
 * @param paused  目前是否暫停中
 * @param side    "long"（看跌幅）或 "short"（看漲幅）
 * @returns { paused, changed, detail }
 */
export function evalMarketGuard(guard, quotes, paused, side = "long") {
  if (!guard || guard.enabled === false) return { paused: false, changed: paused === true, detail: [] };
  const detail = guard.symbols
    .map((sym) => ({ sym, q: quotes[sym] }))
    .filter((x) => x.q && !x.q.error && x.q.isToday !== false && x.q.changePercent != null)
    .map((x) => ({ symbol: x.sym, name: x.q.name ?? x.sym, changePercent: x.q.changePercent }));
  if (!detail.length) return { paused, changed: false, detail };
  let next = paused;
  let worst;
  if (side === "short") {
    const rise = guard.risePercent ?? DEFAULT_MARKET_GUARD.risePercent;
    worst = Math.max(...detail.map((d) => d.changePercent));
    if (!paused && worst >= rise) next = true;
    else if (paused && worst < rise - RESUME_MARGIN) next = false;
  } else {
    worst = Math.min(...detail.map((d) => d.changePercent));
    if (!paused && worst <= -guard.dropPercent) next = true;
    else if (paused && worst > -(guard.dropPercent - RESUME_MARGIN)) next = false;
  }
  return { paused: next, changed: next !== paused, detail, worst };
}

/** 同業保護判斷：多方在同業平均跌幅達門檻時暫停；空方在同業平均漲幅達門檻時暫停 */
export function evalPeerGuard(item, quotes, paused) {
  if (!item.peers?.length) return { paused: false, changed: false, detail: [] };
  const detail = item.peers
    .map((sym) => ({ sym, q: quotes[sym] }))
    .filter((x) => x.q && !x.q.error && x.q.isToday !== false && x.q.changePercent != null)
    .map((x) => ({ symbol: x.sym, name: x.q.name ?? x.sym, changePercent: x.q.changePercent }));
  if (!detail.length) return { paused, changed: false, detail };
  const avg = detail.reduce((a, d) => a + d.changePercent, 0) / detail.length;
  const dir = item.side === "short" ? -1 : 1; // 空方把「上漲」當成不利方向
  const adverse = -dir * avg; // 不利方向的幅度
  let next = paused;
  if (!paused && adverse >= item.peerDropPercent) next = true;
  else if (paused && adverse < item.peerDropPercent - RESUME_MARGIN) next = false;
  return { paused: next, changed: next !== paused, detail, avg: Math.round(avg * 100) / 100 };
}

const pctTxt = (n) => `${n > 0 ? "+" : ""}${Number(n).toFixed(2)}%`;

export function formatMarketGuard(g, r, hhmm, side = "long") {
  const list = r.detail.map((d) => `${d.name} ${pctTxt(d.changePercent)}`).join("、");
  if (side === "short") {
    const rise = g.risePercent ?? DEFAULT_MARKET_GUARD.risePercent;
    return r.paused
      ? `⚠️ 大盤轉強，暫停做空進場（${hhmm}）\n${list}（門檻 +${rise}%）\n暫停新的做空進場通知；已進場的部位仍會追蹤停損與目標。`
      : `✅ 大盤回落，恢復做空監控（${hhmm}）\n${list}`;
  }
  return r.paused
    ? `⚠️ 大盤轉弱，暫停進場（${hhmm}）\n${list}（門檻 -${g.dropPercent}%）\n暫停所有新的進場通知；已進場的部位仍會追蹤停損與目標。`
    : `✅ 大盤回穩，恢復進場監控（${hhmm}）\n${list}`;
}

export function formatPeerGuard(item, r, hhmm) {
  const title = `${item.symbol} ${item.name ?? ""}`.trim();
  const list = r.detail.map((d) => `${d.name} ${pctTxt(d.changePercent)}`).join("、");
  if (item.side === "short") {
    return r.paused
      ? `⏸ 同業轉強｜${title}（${hhmm}）\n${list}，平均 ${pctTxt(r.avg)}（門檻 +${item.peerDropPercent}%）\n這檔暫停做空進場通知；已進場的部位仍會追蹤停損與目標。`
      : `▶️ 同業回落｜${title}（${hhmm}）\n${list}，平均 ${pctTxt(r.avg)}，恢復這檔的做空監控。`;
  }
  return r.paused
    ? `⏸ 同業轉弱｜${title}（${hhmm}）\n${list}，平均 ${pctTxt(r.avg)}（門檻 -${item.peerDropPercent}%）\n這檔暫停進場通知；已進場的部位仍會追蹤停損與目標。`
    : `▶️ 同業回穩｜${title}（${hhmm}）\n${list}，平均 ${pctTxt(r.avg)}，恢復這檔的進場監控。`;
}

// ---------------------------------------------------------------------------
// 通知文字
// ---------------------------------------------------------------------------

const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 }));

export function formatEvent(item, quote, ev, hhmm) {
  const title = `${item.symbol} ${item.name || quote?.name || ""}`.trim();
  const chg = quote?.changePercent != null ? `${quote.changePercent > 0 ? "+" : ""}${quote.changePercent}%` : "—";
  if (ev.type === "entry") {
    const short = item.side === "short";
    const lot = Math.round(ev.price * 1000);
    const loss = Math.round(Math.abs(ev.price - ev.levels.stop) * 1000);
    const how = ev.volMethod === "profile" ? `近 ${ev.volDays} 日同時段實際累計量` : "近 5 日均量線性估算";
    const vol =
      ev.volRatio != null
        ? `量能：累計 ${fmt(quote.tradeVolume)} 張，為${how}的 ${ev.volRatio.toFixed(1)} 倍`
        : `量能：累計 ${fmt(quote?.tradeVolume)} 張`;
    return [
      short ? `🔻 做空條件成立｜${title}` : `🟢 當沖條件成立｜${title}`,
      `劇本：${SCENARIO_LABEL[ev.scenario]}｜${ev.entry.label}`,
      `現價 ${fmt(ev.price)}（${hhmm}）｜今日 ${chg}`,
      vol,
      short
        ? `若進場：停損 ${fmt(ev.levels.stop)}（+1%）｜第一目標 ${fmt(ev.levels.target)}（-0.6%）`
        : `若進場：停損 ${fmt(ev.levels.stop)}（-1%）｜第一目標 ${fmt(ev.levels.target)}（+0.6%）`,
      `1 張約 ${fmt(lot)} 元，觸發停損約虧 ${fmt(loss)} 元＋來回成本`,
      short
        ? `13:20 前一律回補；急拉逼近漲停要立刻回補。這是條件通知，不是下單指令；請先看分時與五檔。`
        : `13:20 前一律平倉。這是條件通知，不是下單指令；請先看分時與五檔。`,
    ].join("\n");
  }
  if (ev.type === "invalid") {
    const more = ev.tracking ? "\n已發出的進場部位仍會繼續追蹤停損與目標。" : "";
    return `🔴 失效｜${title}\n${ev.reason}（現價 ${fmt(ev.price)}，${hhmm}），今日不再發新的進場通知。${more}`;
  }
  if (ev.type === "stop") {
    const p = ev.pos;
    const short = p.side === "short";
    const loss = Math.round(Math.abs(p.entryPrice - ev.price) * 1000);
    return [
      `🛑 ${short ? "漲破" : "跌破"}停損｜${title}`,
      `${p.at} 進場通知價 ${fmt(p.entryPrice)}（${p.label}）`,
      `現價 ${fmt(ev.price)}（${hhmm}）已${short ? "漲破" : "跌破"}停損 ${fmt(p.stop)}`,
      `若有部位請${short ? "回補" : "出場"}：每張約虧 ${fmt(loss)} 元＋來回成本。今天這檔不再追。`,
    ].join("\n");
  }
  if (ev.type === "target") {
    const p = ev.pos;
    const short = p.side === "short";
    return [
      `🎯 達第一目標｜${title}`,
      `${p.at} 進場通知價 ${fmt(p.entryPrice)}，現價 ${fmt(ev.price)}（${hhmm}）已達目標 ${fmt(p.target)}（${short ? "-0.6%" : "+0.6%"}）`,
      short
        ? `若有部位：先回補一半；剩餘停損下移到進場價 ${fmt(p.entryPrice)}（保本），漲回會再通知。`
        : `若有部位：先減半；剩餘停損上移到進場價 ${fmt(p.entryPrice)}（保本），跌回會再通知。`,
    ].join("\n");
  }
  if (ev.type === "breakeven") {
    const p = ev.pos;
    return p.side === "short"
      ? `⚪ 回到進場價｜${title}\n現價 ${fmt(ev.price)}（${hhmm}）反彈至進場價 ${fmt(p.entryPrice)}，剩餘部位保本回補。`
      : `⚪ 回到進場價｜${title}\n現價 ${fmt(ev.price)}（${hhmm}）回落至進場價 ${fmt(p.entryPrice)}，剩餘部位保本出場。`;
  }
  if (ev.type === "limitUp") {
    return [
      `🚨 逼近漲停，立刻回補｜${title}`,
      `現價 ${fmt(ev.price)}（${hhmm}），距漲停 ${ev.toLimitUpPercent}%；${ev.pos.at} 進場通知價 ${fmt(ev.pos.entryPrice)}`,
      `鎖漲停買不回時須借券或標借補足，成本與風險都高，請立刻回補。`,
    ].join("\n");
  }
  if (ev.type === "abandon") {
    const move = ev.entry.abandonAbove != null ? `漲破 ${fmt(ev.entry.abandonAbove)}` : `跌破 ${fmt(ev.entry.abandonBelow)}`;
    return `⚪ 劇本放棄｜${title}\n${SCENARIO_LABEL[ev.scenario]}劇本「${ev.entry.label}」${move}（現價 ${fmt(ev.price)}，${hhmm}）。`;
  }
  return "";
}

/** 晨報寫入清單後的「今日標的」公告 */
export function formatWatchlistAnnouncement(wl, { isUpdate = false, test = false } = {}) {
  const d = new Date(`${wl.date}T00:00:00Z`);
  const wd = "日一二三四五六"[d.getUTCDay()];
  const md = `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${wd}）`;
  const head = `${test ? "🧪 測試推播\n" : ""}📋 ${md}當沖監控清單${isUpdate ? "（更新）" : ""}`;
  const crit = wl.criteria?.length
    ? ["", "🔎 選股條件", ...wl.criteria.map((c, i) => `${"①②③④⑤⑥⑦⑧⑨⑩"[i]} ${c}`)]
    : [];
  if (!wl.items.length) {
    return [head, `今日沒有符合條件的當沖標的，不啟動盤中監控。${wl.noPickReason ? `\n原因：${wl.noPickReason}` : ""}`, ...crit].join("\n");
  }
  const lines = [head, test ? `共 ${wl.items.length} 檔（測試，不會啟動盤中監控）。` : `共 ${wl.items.length} 檔，09:01 起自動監控，條件成立會另行通知。`, ...crit];
  const isShort = (it) => it.side === "short";
  const hasShort = wl.items.some(isShort);
  const hasLong = wl.items.some((it) => !isShort(it));
  // 有空方時多空分開列，多方在前
  const ordered = hasShort ? [...wl.items.filter((it) => !isShort(it)), ...wl.items.filter(isShort)] : wl.items;
  ordered.forEach((it, i) => {
    const short = isShort(it);
    if (hasShort && (i === 0 || isShort(ordered[i - 1]) !== short)) lines.push("", short ? "🔻 空方（做空當沖）" : "📈 多方");
    const tag = it.tier === "secondary" ? "【⚠️ 次級觀察，部位減半】" : "";
    const invalid = short ? `漲破失效價 ${fmt(it.invalidAbove)}` : `失效價 ${fmt(it.invalidBelow)}`;
    lines.push("", `${i + 1}) ${short ? "🔻 " : ""}${it.symbol} ${it.name}`.trim() + `${tag}｜昨收 ${fmt(it.prevClose)}｜${invalid}`);
    if (it.reason) lines.push(`  入選理由：${it.reason}`);
    if (it.checks?.length) lines.push(`  條件檢核：${it.checks.join("｜")}`);
    for (const e of it.entries) {
      const cond = [short ? `≤ ${fmt(e.priceBelow)}` : `≥ ${fmt(e.priceAbove)}`, e.holdMinutes > 1 ? `連續 ${e.holdMinutes} 分鐘` : null, e.minVolumeRatio ? `量比 ≥ ${e.minVolumeRatio}` : null]
        .filter(Boolean).join("、");
      const ab = e.abandonBelow != null ? `；跌破 ${fmt(e.abandonBelow)} 放棄` : e.abandonAbove != null ? `；漲破 ${fmt(e.abandonAbove)} 放棄` : "";
      lines.push(`  • ${SCENARIO_LABEL[e.when]}｜${e.label}（${cond}${ab}）`);
    }
    const p = short ? it.entries[0]?.priceBelow : it.entries[0]?.priceAbove;
    if (p) {
      const lv = exitLevels(p, short ? "short" : "long");
      lines.push(`  1 張約 ${fmt(Math.round(p * 1000))} 元；依觸發價停損 ${fmt(lv.stop)}，約虧 ${fmt(Math.round(Math.abs(p - lv.stop) * 1000))} 元`);
    }
    if (it.peers?.length) lines.push(`  同業保護：${it.peers.join("、")} 平均${short ? "漲" : "跌"}逾 ${it.peerDropPercent}% 時暫停${short ? "做空" : ""}進場`);
    if (it.note) lines.push(`  備註：${it.note}`);
  });
  const mgd = wl.marketGuard ?? DEFAULT_MARKET_GUARD;
  if (mgd.enabled !== false) {
    const names = mgd.symbols.map((x) => (x === "IX0001" ? "加權指數" : x === "IX0043" ? "櫃買指數" : x === "2330" ? "台積電" : x)).join("或");
    lines.push("");
    if (hasLong) lines.push(`🛡 大盤保護：${names}跌逾 ${mgd.dropPercent}% 時暫停${hasShort ? "做多" : "所有"}進場通知`);
    if (hasShort) lines.push(`🛡 大盤保護（空方）：${names}漲逾 ${mgd.risePercent ?? DEFAULT_MARKET_GUARD.risePercent}% 時暫停做空進場通知`);
  }
  lines.push("", `${wl.noNewEntryAfter} 後不發新進場通知；有部位 13:20 前平倉。`);
  if (hasShort) lines.push("空方急拉逼近漲停要立刻回補；鎖漲停買不回須借券或標借，部位應比多方更小。");
  lines.push("⚠️ 這是條件監控清單，不是買賣建議。");
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

let MONITOR_DEPS = null;
/** index.js 啟動時注入行情函式（getQuotes／getDailyHistory／getMinuteHistory），供 Durable Object 的 alarm 使用 */
export function setMonitorDeps(deps) {
  MONITOR_DEPS = deps;
}

/** 現在是否在需要排程檢查的時段（平日 09:00–13:25） */
function inSession(now) {
  const t = taipeiParts(now);
  return t.weekday >= 1 && t.weekday <= 5 && t.minute >= OPEN_MIN && t.minute <= LAST_CHECK_MIN;
}

export class WatchMonitor {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
  }

  // 盤中每 N 秒一次：alarm 執行檢查後再排下一次；Cron 每分鐘呼叫 /arm 當看門狗
  async alarm() {
    const now = new Date(Date.now());
    let n = 1;
    let hasList = false;
    try {
      const store = { get: (k) => this.storage.get(k), put: (k, v) => this.storage.put(k, v) };
      const wl = await this.storage.get("watchlist");
      n = wl?.items?.length || 1;
      hasList = wl?.date === taipeiParts(now).date && wl.items?.length > 0;
      if (MONITOR_DEPS) await runMonitorTick(this.env, now, { ...MONITOR_DEPS, store });
    } catch (e) {
      console.log(JSON.stringify({ alarmError: String(e?.message ?? e) }));
    }
    const next = Date.now() + checkIntervalSeconds(this.env, n) * 1000;
    if (hasList && inSession(new Date(next))) await this.storage.setAlarm(next);
  }

  async arm() {
    if (!inSession(new Date(Date.now()))) return { armed: false, reason: "outside_session" };
    const wl = await this.storage.get("watchlist");
    if (!wl || wl.date !== taipeiParts().date || !wl.items?.length) return { armed: false, reason: "no_watchlist_today" };
    const cur = await this.storage.getAlarm();
    const interval = checkIntervalSeconds(this.env, wl.items.length);
    // 沒有排程，或排程時間異常（太遠）時重新排
    if (cur == null || cur > Date.now() + (interval + 5) * 1000) await this.storage.setAlarm(Date.now() + 200);
    return { armed: true, intervalSeconds: interval, nextAt: await this.storage.getAlarm() };
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/arm") return new Response(JSON.stringify(await this.arm()), { headers: { "content-type": "application/json" } });
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

/** Cron 每分鐘呼叫：確保盤中秒級檢查的排程在運作 */
export async function armMonitor(env) {
  if (!env.MONITOR) return { armed: false, reason: "no_monitor_binding" };
  const r = await stub(env).fetch("https://monitor/arm", { method: "POST" });
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
  const store = deps.store ?? (env.MONITOR ? { get: (k) => kvGet(env, k), put: (k, v) => kvPut(env, k, v) } : null);
  if (!store) return { skipped: "no_monitor_binding" };
  const t = taipeiParts(now);
  if (t.weekday === 0 || t.weekday === 6) return { skipped: "weekend" };
  if (t.minute < OPEN_MIN + 1 || t.minute > LAST_CHECK_MIN) return { skipped: "outside_session", hhmm: t.hhmm };

  const wl = await store.get("watchlist");
  if (!wl || wl.date !== t.date || !wl.items?.length) return { skipped: "no_watchlist_today", date: t.date };

  const state = (await store.get(`state:${t.date}`)) ?? { symbols: {}, reminded: false, sent: [] };
  state.volBase ??= {};
  // 失效的標的不再查價，但若還有未出場的進場部位，仍要繼續追蹤停損
  const openPos = (st) => Object.values(st?.positions ?? {}).some((p) => p.status !== "closed");
  const active = wl.items.filter((it) => !state.symbols[it.symbol]?.invalidated || openPos(state.symbols[it.symbol]));

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

  // 保護條件報價：大盤與同業不需要秒級，依 guardRefreshSeconds 定期更新、存在 state 中沿用
  const gSyms = guardSymbols(wl);
  state.guard ??= { quotes: {}, at: null, marketPaused: false };
  if (gSyms.length && (state.guard.at == null || t.sec - state.guard.at >= guardRefreshSeconds(gSyms.length))) {
    try {
      const got = {};
      for (let i = 0; i < gSyms.length; i += 10) {
        const r = await deps.getQuotes(env, { symbols: gSyms.slice(i, i + 10) });
        for (const x of r.quotes || []) got[x.symbol] = { name: x.name, changePercent: x.changePercent, isToday: x.isToday, error: x.error };
      }
      state.guard.quotes = got;
      state.guard.at = t.sec;
    } catch {
      /* 查不到就沿用上一次的值 */
    }
  }
  const gq = state.guard.quotes;
  const noNewEntryMin = hhmmToMinute(wl.noNewEntryAfter) ?? 12 * 60 + 30;
  const canStillEnter = t.minute <= noNewEntryMin;
  const guardCfg = wl.marketGuard ?? DEFAULT_MARKET_GUARD;
  // 多方看下跌、空方看上漲；清單沒有該方向的標的就不判斷，避免發無關的推播
  if (wl.items.some((it) => it.side !== "short")) {
    const mg = evalMarketGuard(guardCfg, gq, state.guard.marketPaused);
    if (mg.changed) {
      state.guard.marketPaused = mg.paused;
      if (canStillEnter) messages.push(formatMarketGuard(guardCfg, mg, t.hhmmss));
    }
  }
  if (wl.items.some((it) => it.side === "short")) {
    const mg = evalMarketGuard(guardCfg, gq, state.guard.marketPausedShort === true, "short");
    if (mg.changed) {
      state.guard.marketPausedShort = mg.paused;
      if (canStillEnter) messages.push(formatMarketGuard(guardCfg, mg, t.hhmmss, "short"));
    }
  }

  if (active.length) {
    const q = await deps.getQuotes(env, { symbols: active.map((it) => it.symbol) });
    const bySym = Object.fromEntries((q.quotes || []).map((x) => [x.symbol, x]));
    for (const it of active) {
      const st = (state.symbols[it.symbol] ??= newSymbolState());
      const quote = bySym[it.symbol];
      const pg = evalPeerGuard(it, gq, st.peerPaused === true);
      if (pg.changed) {
        st.peerPaused = pg.paused;
        if (canStillEnter && !st.invalidated) messages.push(formatPeerGuard(it, pg, t.hhmmss));
      }
      const marketBlocked = it.side === "short" ? state.guard.marketPausedShort === true : state.guard.marketPaused;
      const blockEntries = marketBlocked || st.peerPaused === true;
      const events = evaluateItem(it, quote, st, { minute: t.minute, sec: t.sec, hhmm: t.hhmmss, noNewEntryMin, volBase: state.volBase[it.symbol], blockEntries });
      for (const ev of events) {
        st.log.push({ at: t.hhmmss, type: ev.type, id: ev.entry?.id ?? ev.pos?.id ?? null, price: ev.price });
        messages.push(formatEvent(it, quote, ev, t.hhmmss));
      }
    }
  }

  // 13:15 平倉提醒（只有今天有發出進場通知時）
  const firedList = Object.entries(state.symbols).flatMap(([sym, st]) =>
    Object.values(st.positions ?? {}).filter((p) => p.status !== "closed").map(() => sym));
  if (!state.reminded && t.minute >= CLOSE_REMINDER_MIN && firedList.length) {
    state.reminded = true;
    const names = [...new Set(firedList)].map((s) => `${s} ${wl.items.find((i) => i.symbol === s)?.name ?? ""}`.trim());
    const anyShort = [...new Set(firedList)].some((s) => wl.items.find((i) => i.symbol === s)?.side === "short");
    messages.push(`⏰ 13:15 平倉提醒\n尚未出場的進場通知：${names.join("、")}\n若有部位，13:20 前一律平倉，不留倉、不轉現股。${anyShort ? "空方部位要買回，別拖到收盤。" : ""}`);
  }

  for (const text of messages) {
    const r = await sendTelegram(env, text);
    state.sent.push({ at: t.hhmmss, ok: r.ok, reason: r.ok ? undefined : r.reason, preview: text.split("\n")[0] });
  }
  if (state.sent.length > 100) state.sent = state.sent.slice(-100);
  state.lastCheck = t.hhmmss;
  await store.put(`state:${t.date}`, state);
  return { ran: true, hhmm: t.hhmmss, checked: active.length, messages: messages.length };
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
    checkIntervalSeconds: checkIntervalSeconds(env, wl?.items?.length || 1),
    marketGuard: wl ? {
      ...(wl.marketGuard ?? DEFAULT_MARKET_GUARD),
      paused: state?.guard?.marketPaused ?? false,
      pausedShort: state?.guard?.marketPausedShort ?? false,
      refreshSeconds: guardRefreshSeconds(guardSymbols(wl).length),
      lastQuotes: state?.guard?.quotes ?? {},
    } : null,
    lastCheck: state?.lastCheck ?? null,
    telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
    items: (wl?.items ?? []).map((it) => {
      const st = state?.symbols?.[it.symbol];
      const vb = state?.volBase?.[it.symbol];
      const expNow = expectedVolume(vb, t.minute);
      return {
        symbol: it.symbol,
        side: it.side ?? "long",
        name: it.name,
        invalidBelow: it.invalidBelow,
        invalidAbove: it.invalidAbove,
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
          priceBelow: e.priceBelow,
          holdMinutes: e.holdMinutes,
          minVolumeRatio: e.minVolumeRatio,
          abandonBelow: e.abandonBelow,
          abandonAbove: e.abandonAbove,
          status: st?.fired?.[e.id] ? `已觸發 ${st.fired[e.id].at} @ ${st.fired[e.id].price}` : st?.abandoned?.[e.id] ? "已放棄" : "監控中",
        })),
        invalidated: st?.invalidated ?? false,
        peers: it.peers ?? [],
        peerDropPercent: it.peerDropPercent,
        peerPaused: st?.peerPaused ?? false,
        positions: Object.values(st?.positions ?? {}).map((p) => ({
          id: p.id, side: p.side ?? "long", label: p.label, entryAt: p.at, entryPrice: p.entryPrice, stop: p.stop, target: p.target,
          status: p.status === "open" ? "持有中（追蹤停損／目標）" : p.status === "target" ? "已達第一目標，剩餘保本追蹤" : `已結束（${p.exit?.type === "stop" ? "停損" : "保本"} ${p.exit?.at} @ ${p.exit?.price}）`,
        })),
        log: st?.log ?? [],
      };
    }),
    notifications: state?.sent ?? [],
  };
}
