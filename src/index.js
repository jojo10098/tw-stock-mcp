/**
 * tw-stock-mcp — 台股即時行情遠端 MCP server（Cloudflare Workers）
 *
 * 資料來源：
 *   - 富果 Fugle MarketData API v1.0（盤中即時行情，需金鑰，有次數限制）
 *   - 臺灣證券交易所 OpenAPI（盤後資料：本益比、融資融券、當沖標的、注意／處置股；免金鑰，不吃富果額度）
 * 傳輸方式：MCP Streamable HTTP（無狀態，每個 POST 直接回 JSON）
 *
 * 需要的 Secrets（在 Cloudflare 後台設定，不要寫進程式碼）：
 *   FUGLE_API_KEY  富果行情 API 金鑰
 *   MCP_TOKEN      自訂的隨機字串；連接器網址為 https://<worker>/mcp/<MCP_TOKEN>
 */

const FUGLE_BASE = "https://api.fugle.tw/marketdata/v1.0/stock";
const TWSE_BASE = "https://openapi.twse.com.tw/v1";
const TWSE_CACHE_SECONDS = 600; // 證交所資料一天更新一次，快取 10 分鐘足夠
const SERVER_INFO = { name: "tw-stock-mcp", version: "0.2.1" };
const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INDEX_SYMBOLS = {
  IX0001: "加權指數（上市）",
  IX0043: "櫃買指數（上櫃）",
};

// ---------------------------------------------------------------------------
// 工具定義
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "get_quotes",
    description:
      "查詢台股個股或指數的即時報價（盤中，上市上櫃都支援）。一次最多 10 檔。回傳開盤價、最新成交價、最高、最低、昨收（參考價）、漲跌、漲跌幅、開盤跳空幅度、累計成交量、最佳五檔、漲跌停價、距漲停／跌停 %、是否觸及漲跌停；個股另附當天的可否現沖（canDayTrade）、只能先買後賣、平盤下可否融券、是否注意股、是否處置股、撮合循環秒數。資料時間為台北時間。指數代號：IX0001 加權指數、IX0043 櫃買指數。額度：每檔每次 1 次，個股當天第一次查詢多 1 次（漲跌停資料快取一整天）。",
    inputSchema: {
      type: "object",
      properties: {
        symbols: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 10,
          description: "股票代號陣列，例如 [\"2330\", \"2344\", \"IX0001\"]",
        },
      },
      required: ["symbols"],
    },
  },
  {
    name: "get_intraday_candles",
    description:
      "查詢單一個股今日盤中的分時 K 線（開高低收量），用來判斷開盤後的走勢、量能是否放大、是否站上或跌破某價位。",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "股票代號，例如 \"2330\"" },
        timeframe: {
          type: "string",
          enum: ["1", "5", "10", "15", "30", "60"],
          description: "K 線週期（分鐘），預設 5",
        },
      },
      required: ["symbol"],
    },
  },
  {
    name: "get_market_overview",
    description:
      "一次查詢大盤背景：加權指數（IX0001）與櫃買指數（IX0043）的即時點數、漲跌、漲跌幅與資料時間。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_daily_history",
    description:
      "查詢個股最近 N 個交易日的日 K（開高低收量），可用來計算近 5 日均量、振幅、前高前低，或和今日盤中量做比較。",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "股票代號，例如 \"2330\"" },
        days: {
          type: "integer",
          minimum: 1,
          maximum: 60,
          description: "要幾個交易日，預設 10",
        },
      },
      required: ["symbol"],
    },
  },
  {
    name: "get_valuation",
    description:
      "【證交所 OpenAPI，上市股票，不吃富果額度】查詢個股最新的本益比、殖利率（%）、股價淨值比，資料為最近一個交易日盤後公布。一次最多 30 檔。",
    inputSchema: {
      type: "object",
      properties: {
        symbols: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 30,
          description: "股票代號陣列，例如 [\"2330\", \"2317\"]",
        },
      },
      required: ["symbols"],
    },
  },
  {
    name: "get_margin_trading",
    description:
      "【證交所 OpenAPI，上市股票，不吃富果額度】查詢個股最近一個交易日的融資融券：融資買賣、餘額與增減、融券買賣、餘額與增減、券資比、資券互抵（單位：張）。用來判斷散戶槓桿與軋空潛力。一次最多 30 檔。",
    inputSchema: {
      type: "object",
      properties: {
        symbols: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 30,
          description: "股票代號陣列，例如 [\"2330\", \"2344\"]",
        },
      },
      required: ["symbols"],
    },
  },
  {
    name: "get_daytrade_status",
    description:
      "【證交所 OpenAPI，上市股票，不吃富果額度】當沖前檢查：個股是否為可當沖標的、是否暫停「先賣後買」、今天是否被列為注意股、是否在處置期間（含處置原因、期間與措施，例如人工撮合、預收款券）。一次最多 30 檔。",
    inputSchema: {
      type: "object",
      properties: {
        symbols: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 30,
          description: "股票代號陣列，例如 [\"2330\", \"2344\"]",
        },
      },
      required: ["symbols"],
    },
  },
  {
    name: "get_alert_lists",
    description:
      "【證交所 OpenAPI，上市股票，不吃富果額度】列出證交所最新公布的全部注意股與處置股，用來避開被處置的標的或找出異常熱門股。",
    inputSchema: { type: "object", properties: {} },
  },
];

// 需要富果金鑰的工具
const FUGLE_TOOLS = new Set(["get_quotes", "get_intraday_candles", "get_market_overview", "get_daily_history"]);

// ---------------------------------------------------------------------------
// 富果 API
// ---------------------------------------------------------------------------

class FugleError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function fugle(env, path, params) {
  const url = new URL(FUGLE_BASE + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, { headers: { "X-API-KEY": env.FUGLE_API_KEY } });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    if (res.status === 401 || res.status === 403) msg = "富果 API 金鑰無效或無權限：" + msg;
    if (res.status === 429) msg = "超過富果 API 呼叫次數限制，請稍後再試：" + msg;
    throw new FugleError(res.status, msg);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new FugleError(502, "富果回傳的不是 JSON：" + text.slice(0, 200));
  }
}

// 富果時間戳為 epoch 微秒；轉成台北時間字串
function toTaipeiTime(micros) {
  if (!micros) return null;
  const ms = Math.floor(Number(micros) / 1000);
  const d = new Date(ms + 8 * 3600 * 1000);
  return d.toISOString().replace("T", " ").slice(0, 19) + " (UTC+8)";
}

function pct(a, b) {
  if (a == null || b == null || b === 0) return null;
  return Math.round(((a - b) / b) * 10000) / 100;
}

function normalizeSymbol(s) {
  return String(s).trim().toUpperCase().replace(/\.(TW|TWO)$/, "");
}

// 今天的台北日期 "YYYY-MM-DD"
function taipeiToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// 富果 Ticker（漲跌停價、可否當沖、注意／處置）：當天不會變，快取一整天
// ---------------------------------------------------------------------------

const tickerMemo = new Map(); // "日期:代號" → ticker
const TICKER_CACHE_HOST = "https://tw-stock-mcp.internal/ticker/";

async function getTicker(env, symbol) {
  const today = taipeiToday();
  const memoKey = `${today}:${symbol}`;
  if (tickerMemo.has(memoKey)) return tickerMemo.get(memoKey);

  // Cloudflare 邊緣快取（跨請求、跨 isolate）；本機測試時沒有 caches 就略過
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(`${TICKER_CACHE_HOST}${today}/${encodeURIComponent(symbol)}`);
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const t = await hit.json();
      tickerMemo.set(memoKey, t);
      return t;
    }
  }

  const t = await fugle(env, `/intraday/ticker/${encodeURIComponent(symbol)}`);
  // 只有拿到「今天」的 ticker 才長時間快取；開盤前可能還是前一天的資料，只快取 5 分鐘
  const isToday = t?.date === today;
  if (isToday) {
    if (tickerMemo.size > 2000) tickerMemo.clear();
    tickerMemo.set(memoKey, t);
  }
  if (cache) {
    const ttl = isToday ? 12 * 3600 : 300;
    await cache.put(cacheKey, new Response(JSON.stringify(t), {
      headers: { "content-type": "application/json", "cache-control": `max-age=${ttl}` },
    }));
  }
  return t;
}

function summarizeTicker(t) {
  if (!t) return {};
  return {
    referencePrice: t.referencePrice ?? null,
    limitUpPrice: t.limitUpPrice ?? null,
    limitDownPrice: t.limitDownPrice ?? null,
    canDayTrade: t.canDayTrade ?? null, // 可買賣現沖
    canBuyFirstDayTradeOnly: t.canDayTrade == null ? null : !t.canDayTrade && t.canBuyDayTrade === true, // 只能先買後賣
    canBelowFlatShortSell: t.canBelowFlatMarginShortSell ?? null, // 平盤下得融券賣出
    isAttention: t.isAttention ?? null,
    isDisposition: t.isDisposition ?? null,
    matchingIntervalSeconds: t.matchingInterval ?? null, // 處置股常見：非 0 代表分盤撮合
    securityStatus: t.securityStatus ?? null,
  };
}

function summarizeQuote(q, t) {
  const prev = q.previousClose ?? q.referencePrice ?? null;
  const total = q.total || {};
  const last = q.lastPrice ?? q.closePrice ?? null;
  const tk = summarizeTicker(t);
  const limitUp = tk.limitUpPrice ?? null;
  const limitDown = tk.limitDownPrice ?? null;
  return {
    symbol: q.symbol,
    name: q.name ?? INDEX_SYMBOLS[q.symbol] ?? null,
    date: q.date,
    lastPrice: last,
    openPrice: q.openPrice ?? null,
    highPrice: q.highPrice ?? null,
    lowPrice: q.lowPrice ?? null,
    previousClose: prev,
    change: q.change ?? null,
    changePercent: q.changePercent ?? null,
    openGapPercent: pct(q.openPrice, prev),
    avgPrice: q.avgPrice ?? null,
    tradeVolume: total.tradeVolume ?? null, // 股票為「張」
    tradeValue: total.tradeValue ?? null,
    limitUpPrice: limitUp,
    limitDownPrice: limitDown,
    toLimitUpPercent: limitUp != null && last ? pct(limitUp, last) : null, // 距漲停還有幾 %
    toLimitDownPercent: limitDown != null && last ? pct(limitDown, last) : null, // 距跌停（負值）
    isLimitUp: Boolean(q.isLimitUpPrice || q.isLimitUpBid),
    isLimitDown: Boolean(q.isLimitDownPrice || q.isLimitDownAsk),
    ...(t
      ? {
          canDayTrade: tk.canDayTrade,
          canBuyFirstDayTradeOnly: tk.canBuyFirstDayTradeOnly,
          canBelowFlatShortSell: tk.canBelowFlatShortSell,
          isAttention: tk.isAttention,
          isDisposition: tk.isDisposition,
          matchingIntervalSeconds: tk.matchingIntervalSeconds,
          securityStatus: tk.securityStatus,
        }
      : {}),
    isTrial: Boolean(q.isTrial),
    isClose: Boolean(q.isClose),
    lastUpdated: toTaipeiTime(q.lastUpdated),
    bids: q.bids ?? undefined, // 最佳五檔買
    asks: q.asks ?? undefined, // 最佳五檔賣
  };
}

// ---------------------------------------------------------------------------
// 工具實作
// ---------------------------------------------------------------------------

async function getQuotes(env, args) {
  const symbols = Array.isArray(args?.symbols) ? args.symbols : [];
  if (symbols.length === 0) throw new Error("symbols 不可為空");
  if (symbols.length > 10) throw new Error("一次最多 10 檔");
  const results = await Promise.all(
    symbols.map(async (raw) => {
      const symbol = normalizeSymbol(raw);
      const isIndex = /^IX\d+$/.test(symbol);
      try {
        // 指數沒有漲跌停，不查 ticker；ticker 失敗不影響報價
        const [q, t] = await Promise.all([
          fugle(env, `/intraday/quote/${encodeURIComponent(symbol)}`),
          isIndex ? null : getTicker(env, symbol).catch((e) => ({ __error: e.message })),
        ]);
        const tickerError = t?.__error;
        const out = summarizeQuote(q, tickerError ? null : t);
        if (tickerError) out.tickerError = "漲跌停價暫時取不到：" + tickerError;
        return out;
      } catch (e) {
        return { symbol, error: e.message };
      }
    })
  );
  return { source: "富果 Fugle MarketData API", quotes: results };
}

async function getIntradayCandles(env, args) {
  const symbol = normalizeSymbol(args?.symbol ?? "");
  if (!symbol) throw new Error("symbol 不可為空");
  const timeframe = args?.timeframe ?? "5";
  const r = await fugle(env, `/intraday/candles/${encodeURIComponent(symbol)}`, { timeframe });
  const candles = (r.data || []).map((c) => ({
    time: c.date,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    average: c.average,
  }));
  return {
    source: "富果 Fugle MarketData API",
    symbol: r.symbol ?? symbol,
    date: r.date,
    timeframe: `${timeframe} 分`,
    count: candles.length,
    candles,
  };
}

async function getMarketOverview(env) {
  return getQuotes(env, { symbols: Object.keys(INDEX_SYMBOLS) });
}

async function getDailyHistory(env, args) {
  const symbol = normalizeSymbol(args?.symbol ?? "");
  if (!symbol) throw new Error("symbol 不可為空");
  const days = Math.min(Math.max(parseInt(args?.days ?? 10, 10) || 10, 1), 60);
  // 多抓一些日曆日，涵蓋假日
  const to = new Date(Date.now() + 8 * 3600 * 1000);
  const from = new Date(to.getTime() - (days * 2 + 14) * 86400 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const r = await fugle(env, `/historical/candles/${encodeURIComponent(symbol)}`, {
    from: fmt(from),
    to: fmt(to),
    timeframe: "D",
  });
  const rows = (r.data || [])
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, days)
    .map((c) => ({
      date: c.date,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      amplitudePercent: pct(c.high, c.low),
    }));
  return { source: "富果 Fugle MarketData API", symbol: r.symbol ?? symbol, days: rows.length, candles: rows };
}

// ---------------------------------------------------------------------------
// 證交所 OpenAPI（盤後資料，免金鑰）
// ---------------------------------------------------------------------------

const twseMemo = new Map(); // 同一個 isolate 內的記憶體快取：path → { at, data }

async function twse(path) {
  const hit = twseMemo.get(path);
  if (hit && Date.now() - hit.at < TWSE_CACHE_SECONDS * 1000) return hit.data;
  let res;
  try {
    res = await fetch(TWSE_BASE + path, {
      headers: { accept: "application/json", "user-agent": "tw-stock-mcp/" + SERVER_INFO.version },
      // 讓 Cloudflare 邊緣快取證交所回應，降低對證交所的請求
      cf: { cacheTtl: TWSE_CACHE_SECONDS, cacheEverything: true },
    });
  } catch (e) {
    throw new Error(`連不到證交所 OpenAPI（${path}）：${e.message}`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`證交所 OpenAPI 回應 ${res.status}（${path}）：${text.slice(0, 200)}`);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`證交所回傳的不是 JSON（${path}），可能暫時維護中：${text.slice(0, 120)}`);
  }
  if (!Array.isArray(data)) throw new Error(`證交所回傳格式不符（${path}）`);
  twseMemo.set(path, { at: Date.now(), data });
  return data;
}

// 民國日期 "1151019" 或 "115/10/19" → "2026-10-19"
function rocToIso(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{2,3})\/?(\d{2})\/?(\d{2})$/);
  if (!m) return String(s);
  return `${Number(m[1]) + 1911}-${m[2]}-${m[3]}`;
}

// "1,234" / "" / "-" → 數字或 null
function num(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/,/g, "").trim();
  if (s === "" || s === "-" || s === "--") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function symbolList(args, max = 30) {
  const symbols = Array.isArray(args?.symbols) ? args.symbols.map(normalizeSymbol).filter(Boolean) : [];
  if (symbols.length === 0) throw new Error("symbols 不可為空");
  if (symbols.length > max) throw new Error(`一次最多 ${max} 檔`);
  return [...new Set(symbols)];
}

function indexBy(rows, key) {
  const map = new Map();
  for (const r of rows) {
    const k = String(r?.[key] ?? "").trim();
    if (k) map.set(k, r);
  }
  return map;
}

const NOT_LISTED = "查無資料：可能不是上市股票（上櫃股票目前不支援），或證交所今天尚未公布";
const TWSE_SOURCE = "臺灣證券交易所 OpenAPI（盤後資料）";

async function getValuation(env, args) {
  const symbols = symbolList(args);
  const map = indexBy(await twse("/exchangeReport/BWIBBU_ALL"), "Code");
  return {
    source: TWSE_SOURCE,
    results: symbols.map((symbol) => {
      const r = map.get(symbol);
      if (!r) return { symbol, error: NOT_LISTED };
      return {
        symbol,
        name: r.Name,
        date: rocToIso(r.Date),
        peRatio: num(r.PEratio), // 虧損或無盈餘時為 null
        dividendYieldPercent: num(r.DividendYield),
        pbRatio: num(r.PBratio),
      };
    }),
  };
}

async function getMarginTrading(env, args) {
  const symbols = symbolList(args);
  const map = indexBy(await twse("/exchangeReport/MI_MARGN"), "股票代號");
  return {
    source: TWSE_SOURCE,
    unit: "張",
    results: symbols.map((symbol) => {
      const r = map.get(symbol);
      if (!r) return { symbol, error: NOT_LISTED + "；或該股不是信用交易標的" };
      const marginPrev = num(r["融資前日餘額"]);
      const marginNow = num(r["融資今日餘額"]);
      const shortPrev = num(r["融券前日餘額"]);
      const shortNow = num(r["融券今日餘額"]);
      const marginLimit = num(r["融資限額"]);
      return {
        symbol,
        name: r["股票名稱"],
        margin: {
          buy: num(r["融資買進"]),
          sell: num(r["融資賣出"]),
          cashRedemption: num(r["融資現金償還"]),
          previousBalance: marginPrev,
          balance: marginNow,
          change: marginNow != null && marginPrev != null ? marginNow - marginPrev : null,
          limit: marginLimit,
          utilizationPercent: marginNow != null && marginLimit ? Math.round((marginNow / marginLimit) * 10000) / 100 : null, // 融資使用率
        },
        short: {
          buy: num(r["融券買進"]),
          sell: num(r["融券賣出"]),
          stockRedemption: num(r["融券現券償還"]),
          previousBalance: shortPrev,
          balance: shortNow,
          change: shortNow != null && shortPrev != null ? shortNow - shortPrev : null,
          limit: num(r["融券限額"]),
        },
        shortToMarginRatioPercent:
          shortNow != null && marginNow ? Math.round((shortNow / marginNow) * 10000) / 100 : null, // 券資比
        offset: num(r["資券互抵"]), // 資券互抵（當沖）
        note: String(r["註記"] ?? "").trim() || null,
      };
    }),
  };
}

function cleanNotice(r) {
  return {
    symbol: String(r.Code).trim(),
    name: r.Name,
    date: rocToIso(r.Date),
    timesAnnounced: num(r.NumberOfAnnouncement),
    reason: String(r.TradingInfoForAttention ?? "").trim() || null,
    closingPrice: num(r.ClosingPrice),
    peRatio: num(r.PE),
  };
}

function cleanPunish(r) {
  return {
    symbol: String(r.Code).trim(),
    name: r.Name,
    announcedDate: rocToIso(r.Date),
    timesAnnounced: num(r.NumberOfAnnouncement),
    reason: String(r.ReasonsOfDisposition ?? "").trim() || null,
    period: String(r.DispositionPeriod ?? "").trim() || null,
    measures: String(r.DispositionMeasures ?? "").trim() || null,
    detail: String(r.Detail ?? "").trim() || null,
  };
}

// 去掉證交所用來表示「今天沒有資料」的空白列（Code 為空）
function validRows(rows) {
  return rows.filter((r) => String(r?.Code ?? "").trim() !== "");
}

async function loadAlerts() {
  const [notice, punish] = await Promise.all([
    twse("/announcement/notice"),
    twse("/announcement/punish"),
  ]);
  return { notice: validRows(notice).map(cleanNotice), punish: validRows(punish).map(cleanPunish) };
}

async function getDaytradeStatus(env, args) {
  const symbols = symbolList(args);
  const [daytradeRows, alerts] = await Promise.all([twse("/exchangeReport/TWTB4U"), loadAlerts()]);
  const daytrade = indexBy(daytradeRows, "Code");
  const listDate = rocToIso(daytradeRows[0]?.Date);
  return {
    source: TWSE_SOURCE,
    daytradeListDate: listDate,
    results: symbols.map((symbol) => {
      const d = daytrade.get(symbol);
      const notice = alerts.notice.filter((n) => n.symbol === symbol);
      const punish = alerts.punish.filter((p) => p.symbol === symbol);
      const suspension = String(d?.Suspension ?? "").trim();
      const warnings = [];
      if (!d) warnings.push("不在證交所可當沖名單（上櫃股票不在此名單，請另外確認）");
      if (suspension) warnings.push(`暫停先賣後買當沖：${suspension}`);
      if (punish.length) warnings.push("處置中：撮合方式與下單條件受限，當沖需特別小心");
      if (notice.length) warnings.push("被列為注意股");
      return {
        symbol,
        name: d?.Name ?? punish[0]?.name ?? notice[0]?.name ?? null,
        canDayTrade: Boolean(d),
        sellFirstSuspended: suspension ? suspension : false,
        isAttention: notice.length > 0,
        attention: notice,
        isDisposed: punish.length > 0,
        disposition: punish,
        warnings,
      };
    }),
  };
}

async function getAlertLists() {
  const alerts = await loadAlerts();
  return {
    source: TWSE_SOURCE,
    attentionCount: alerts.notice.length,
    attention: alerts.notice,
    dispositionCount: alerts.punish.length,
    disposition: alerts.punish,
  };
}

const HANDLERS = {
  get_quotes: getQuotes,
  get_intraday_candles: getIntradayCandles,
  get_market_overview: getMarketOverview,
  get_daily_history: getDailyHistory,
  get_valuation: getValuation,
  get_margin_trading: getMarginTrading,
  get_daytrade_status: getDaytradeStatus,
  get_alert_lists: getAlertLists,
};

// ---------------------------------------------------------------------------
// MCP JSON-RPC
// ---------------------------------------------------------------------------

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function handleRpc(env, msg) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg?.id, -32600, "Invalid Request");
  }
  const isNotification = msg.id === undefined || msg.id === null;
  const { id, method, params } = msg;

  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "台股行情。盤中即時（富果 API，每分鐘 60 次額度）：查價用 get_quotes；大盤背景用 get_market_overview；開盤後走勢與量能用 get_intraday_candles；近幾日量價用 get_daily_history。盤後資料（證交所 OpenAPI，僅上市股票，不吃富果額度）：當沖前先用 get_daytrade_status 確認可否當沖、是否注意／處置；籌碼用 get_margin_trading；估值用 get_valuation；全部注意／處置股用 get_alert_lists。所有時間為台北時間，成交量單位為張。",
      });
    }
    case "ping":
      return isNotification ? null : rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call": {
      const name = params?.name;
      const handler = HANDLERS[name];
      if (!handler) return rpcError(id, -32602, `Unknown tool: ${name}`);
      if (FUGLE_TOOLS.has(name) && !env.FUGLE_API_KEY) {
        return rpcResult(id, {
          content: [{ type: "text", text: "伺服器尚未設定 FUGLE_API_KEY（請在 Cloudflare 後台新增 Secret）。" }],
          isError: true,
        });
      }
      try {
        const data = await handler(env, params?.arguments ?? {});
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
      } catch (e) {
        return rpcResult(id, { content: [{ type: "text", text: `查詢失敗：${e.message}` }], isError: true });
      }
    }
    default:
      if (isNotification) return null; // notifications/initialized 等，不需回應
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

// 以固定時間比較字串，避免 timing attack
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // 記錄每個請求（不含 token），可在 Cloudflare 後台 Logs 查看
    const safePath = url.pathname.replace(/^\/(mcp|selftest)\/[^/]+/, "/$1/***");
    console.log(JSON.stringify({ method: request.method, path: safePath, ua: request.headers.get("user-agent") }));

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({ ok: true, server: SERVER_INFO });
    }

    // 診斷：只回報設定是否存在，不洩漏內容
    if (url.pathname === "/status") {
      return json({
        server: SERVER_INFO,
        fugleKeySet: Boolean(env.FUGLE_API_KEY),
        mcpTokenSet: Boolean(env.MCP_TOKEN),
        mcpTokenLongEnough: Boolean(env.MCP_TOKEN && env.MCP_TOKEN.length >= 16),
        mcpTokenLength: env.MCP_TOKEN ? env.MCP_TOKEN.length : 0,
      });
    }

    // 診斷：帶正確 token 才會實際呼叫富果一次
    const st = url.pathname.match(/^\/selftest\/([^/]+)\/?$/);
    if (st) {
      if (!env.MCP_TOKEN || !safeEqual(decodeURIComponent(st[1]), env.MCP_TOKEN)) {
        return json({ ok: false, reason: "token 不符或 MCP_TOKEN 未設定" });
      }
      const out = { ok: true };
      try {
        const r = await getQuotes(env, { symbols: ["2330"] });
        const sample = r.quotes[0];
        if (sample.error) throw Object.assign(new Error(sample.error), { status: "error" });
        out.fugle = { ok: true, tickerOk: sample.limitUpPrice != null, sample };
      } catch (e) {
        out.ok = false;
        out.fugle = { ok: false, status: e.status ?? "error", message: e.message };
      }
      try {
        const v = await getValuation(env, { symbols: ["2330"] });
        out.twse = { ok: true, sample: v.results[0] };
      } catch (e) {
        out.ok = false;
        out.twse = { ok: false, message: e.message };
      }
      return json(out);
    }

    // OAuth 探測一律回 404，代表這個伺服器不需要登入
    if (url.pathname.startsWith("/.well-known/")) {
      return json({ error: "Not found" }, 404);
    }

    const m = url.pathname.match(/^\/mcp\/([^/]+)\/?$/);
    if (!m) {
      if (request.method === "POST") {
        return json(rpcError(null, -32001, "網址錯誤：連接器網址必須是 /mcp/<MCP_TOKEN>"), 404);
      }
      return json({ error: "Not found" }, 404);
    }
    if (!env.MCP_TOKEN || env.MCP_TOKEN.length < 16) {
      return json({ error: "Server misconfigured: MCP_TOKEN 未設定或太短（至少 16 字元）" }, 500);
    }
    if (!safeEqual(decodeURIComponent(m[1]), env.MCP_TOKEN)) {
      return json({ error: "Not found" }, 404);
    }

    if (request.method === "GET") {
      // 無狀態伺服器，不提供 SSE 串流
      return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST, DELETE" } });
    }
    if (request.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
    }

    let body;
    try {
      body = await request.json();
      const methods = (Array.isArray(body) ? body : [body]).map((b) => b?.method);
      console.log(JSON.stringify({ rpc: methods, protocol: body?.params?.protocolVersion }));
    } catch {
      return json(rpcError(null, -32700, "Parse error"), 400);
    }

    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((msg) => handleRpc(env, msg)))).filter(Boolean);
      return out.length ? json(out) : new Response(null, { status: 202 });
    }
    const out = await handleRpc(env, body);
    return out ? json(out) : new Response(null, { status: 202 });
  },
};
