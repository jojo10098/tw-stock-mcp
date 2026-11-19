/**
 * 波段掃描（scan_swing）
 *
 * 晨報原本要把股票池每檔 75 日 K 線（csv）一檔一檔抓回對話、再自己算指標，
 * 50 檔約要 40 萬 token 以上。這裡改在伺服器端抓資料、算好波段策略 v1 需要的指標，
 * 只回傳每檔一行的結果，晨報直接拿來判斷濾網、設定與紙上交易。
 *
 * 規則與 swing/strategy v1 的 params 一致：
 *   大盤濾網：加權收盤 > 20 日線，且 20 日線 > 60 日線
 *   趨勢：收盤 > 60 日線，且 60 日線高於 10 個交易日前
 *   流動性：近 20 日平均成交金額（收盤 × 張數 × 1000）≥ 3 億
 *   拉回設定：當日最低 ≤ 20 日線 ×1.02、收盤 ≥ 20 日線 ×0.98、收盤 > 開盤
 *   觸發價：當日最高 + 1 檔；停損：max（近 5 日最低 − 1 檔，觸發價 − 3×ATR14）；停損幅度 > 10% 不做
 *   部位：floor（總部位 × 風險% ÷ 每股風險），且市值不超過總部位 × 單檔上限%
 *
 * Cloudflare 免費方案每次呼叫最多 50 個子請求，所以一次最多 25 檔（＋加權指數）。
 */

export const SCAN_MAX_SYMBOLS = 25;
export const SCAN_DAYS = 75; // 60 日線＋10 日前的 60 日線需要 70 根，多抓 5 根

// 台股升降單位
export function tick(p) {
  return p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5;
}

const r2 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
// 價格加減升降單位後去掉浮點誤差（例如 79.6 + 0.1 = 79.69999…）
const px = (n) => Math.round(n * 100) / 100;

function sma(arr, n, end = arr.length) {
  if (end < n) return null;
  let s = 0;
  for (let i = end - n; i < end; i++) s += arr[i];
  return s / n;
}

/**
 * rows：舊到新的日 K [{date, open, high, low, close, volume(張)}]
 * 回傳該檔最近一個交易日的指標；資料不足 70 根時 ok=false。
 */
export function computeSwingMetrics(rows, opts = {}) {
  const totalCapital = opts.totalCapital ?? 250000;
  const riskPct = opts.riskPct ?? 1;
  const maxPosPct = opts.maxPosPct ?? 20;
  const minTurnover = opts.minTurnoverE8 ?? 3;
  const clean = (rows || []).filter((r) => [r.open, r.high, r.low, r.close].every((v) => Number.isFinite(v)));
  if (clean.length < 70) return { ok: false, reason: `日 K 只有 ${clean.length} 根，不足 70 根` };
  const c = clean.map((r) => r.close);
  const t = clean.at(-1);
  const prev = clean.at(-2);
  const ma10 = sma(c, 10);
  const ma20 = sma(c, 20);
  const ma60 = sma(c, 60);
  const ma60Prev = sma(c, 60, c.length - 10);
  let trSum = 0;
  for (let i = clean.length - 14; i < clean.length; i++) {
    const d = clean[i];
    const pc = clean[i - 1].close;
    trSum += Math.max(d.high - d.low, Math.abs(d.high - pc), Math.abs(d.low - pc));
  }
  const atr14 = trSum / 14;
  const last20 = clean.slice(-20);
  const turnover20e8 = last20.reduce((s, r) => s + r.close * (r.volume ?? 0) * 1000, 0) / 20 / 1e8;
  const low5 = Math.min(...clean.slice(-5).map((r) => r.low));
  const ma60Up = ma60 > ma60Prev;
  const trend = t.close > ma60 && ma60Up;
  const liquid = turnover20e8 >= minTurnover;
  const pullShape = t.low <= ma20 * 1.02 && t.close >= ma20 * 0.98 && t.close > t.open;

  const out = {
    ok: true,
    date: t.date,
    o: t.open,
    h: t.high,
    l: t.low,
    c: t.close,
    v: t.volume ?? null,
    chgPct: prev ? r2((t.close / prev.close - 1) * 100) : null,
    ma10: r2(ma10),
    ma20: r2(ma20),
    ma60: r2(ma60),
    ma60Up,
    atr14: r2(atr14),
    turnover20e8: r2(turnover20e8),
    low5,
    high75: Math.max(...clean.map((r) => r.high)),
    low75: Math.min(...clean.map((r) => r.low)),
    trend,
    liquid,
    pullShape,
    setup: null,
  };

  if (pullShape) {
    const trigger = px(t.high + tick(t.high));
    const stop = px(Math.max(low5 - tick(low5), trigger - 3 * atr14));
    const risk = trigger - stop;
    const stopPct = (risk / trigger) * 100;
    let qty = Math.floor((totalCapital * riskPct) / 100 / risk);
    qty = Math.min(qty, Math.floor((totalCapital * maxPosPct) / 100 / trigger));
    const reasons = [];
    if (!trend) reasons.push("趨勢不符");
    if (!liquid) reasons.push("流動性不足");
    if (stopPct > 10) reasons.push("停損幅度超過 10%");
    out.setup = {
      type: "pull",
      valid: reasons.length === 0,
      ...(reasons.length ? { rejectedBy: reasons } : {}),
      trigger,
      stop,
      R: r2(risk),
      stopPct: r2(stopPct),
      qty,
      amount: Math.round(qty * trigger),
      gapLimit: px(trigger * 1.03), // 跳空超過觸發價 3% 不追
    };
  }
  return out;
}

export function computeMarketFilter(rows) {
  const clean = (rows || []).filter((r) => Number.isFinite(r.close));
  if (clean.length < 60) return { ok: false, reason: `指數日 K 只有 ${clean.length} 根，不足 60 根` };
  const c = clean.map((r) => r.close);
  const close = c.at(-1);
  const ma20 = sma(c, 20);
  const ma60 = sma(c, 60);
  return {
    ok: true,
    date: clean.at(-1).date,
    close,
    chgPct: r2((close / c.at(-2) - 1) * 100),
    ma20: r2(ma20),
    ma60: r2(ma60),
    aboveMa20: close > ma20,
    ma20AboveMa60: ma20 > ma60,
    filterOk: close > ma20 && ma20 > ma60,
    closeVsMa20Pct: r2((close / ma20 - 1) * 100),
    ma20VsMa60Pct: r2((ma20 / ma60 - 1) * 100),
  };
}

// 小並行池：避免一次打出太多請求撞到富果每分鐘額度
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * fetchDaily(symbol, days) → { latestDate, candles: 新到舊 [{date,open,high,low,close,volume}] }
 */
export async function scanSwing(args, fetchDaily) {
  const raw = Array.isArray(args?.symbols) ? args.symbols : [];
  const symbols = [...new Set(raw.map((s) => String(s ?? "").trim().toUpperCase()).filter(Boolean))];
  if (!symbols.length && args?.includeIndex === false) throw new Error("symbols 不可為空");
  if (symbols.length > SCAN_MAX_SYMBOLS) {
    throw new Error(`一次最多 ${SCAN_MAX_SYMBOLS} 檔（Cloudflare 子請求上限），請分批呼叫`);
  }
  for (const s of symbols) if (!/^[0-9A-Z]{4,6}$/.test(s)) throw new Error(`股票代號格式錯誤：${s}`);
  const opts = {
    totalCapital: Number(args?.totalCapital) > 0 ? Number(args.totalCapital) : 250000,
    riskPct: Number(args?.riskPct) > 0 ? Number(args.riskPct) : 1,
    maxPosPct: Number(args?.maxPosPct) > 0 ? Number(args.maxPosPct) : 20,
  };
  const holdings = new Set((args?.holdings || []).map((s) => String(s).trim().toUpperCase()));
  const toRows = (r) => (r?.candles || []).slice().reverse();

  const includeIndex = args?.includeIndex !== false;
  const [market, stocks] = await Promise.all([
    includeIndex
      ? fetchDaily("IX0001", SCAN_DAYS).then((r) => computeMarketFilter(toRows(r))).catch((e) => ({ ok: false, reason: e.message }))
      : null,
    mapLimit(symbols, 6, async (s) => {
      try {
        const r = await fetchDaily(s, SCAN_DAYS);
        return { symbol: s, ...computeSwingMetrics(toRows(r), opts) };
      } catch (e) {
        return { symbol: s, ok: false, reason: e.message };
      }
    }),
  ]);

  const good = stocks.filter((x) => x.ok);
  for (const x of good) if (holdings.has(x.symbol)) x.holding = true;
  const setups = good
    .filter((x) => x.setup)
    .sort((a, b) => b.turnover20e8 - a.turnover20e8)
    .map((x) => ({ symbol: x.symbol, holding: !!x.holding, c: x.c, turnover20e8: x.turnover20e8, ...x.setup }));

  // 每檔一行的精簡表，省 token；欄位順序見 columns
  const columns = "symbol,date,o,h,l,c,v,chgPct,ma10,ma20,ma60,ma60Up,atr14,turnover20e8,low5,high75,low75,trend,liquid,pullShape";
  const rows = good.map((x) =>
    [x.symbol, x.date, x.o, x.h, x.l, x.c, x.v, x.chgPct, x.ma10, x.ma20, x.ma60, x.ma60Up ? 1 : 0, x.atr14, x.turnover20e8, x.low5, x.high75, x.low75, x.trend ? 1 : 0, x.liquid ? 1 : 0, x.pullShape ? 1 : 0].join(","),
  );
  const failed = stocks.filter((x) => !x.ok).map((x) => ({ symbol: x.symbol, reason: x.reason }));
  const dates = [...new Set(good.map((x) => x.date))];

  return {
    source: "富果 Fugle MarketData API（日 K 未還原權息，伺服器端計算）",
    strategy: "swing v1：濾網＝加權收盤 > 20MA 且 20MA > 60MA；趨勢＝收盤 > 60MA 且 60MA 高於 10 日前；流動性＝20 日均成交金額 ≥ 3 億；拉回＝低 ≤ 20MA×1.02、收 ≥ 20MA×0.98、收紅",
    params: opts,
    market,
    dataDates: dates,
    ...(dates.length > 1 ? { note: "各檔最新資料日期不一致（可能有停牌），請看每行的 date" } : {}),
    counts: { requested: symbols.length, ok: good.length, trend: good.filter((x) => x.trend).length, setups: setups.length, validSetups: setups.filter((s) => s.valid).length },
    setups,
    columns,
    rows: rows.join("\n"),
    ...(failed.length ? { failed } : {}),
  };
}
