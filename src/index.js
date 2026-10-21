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
import { WatchMonitor, validateWatchlist, kvGet, kvPut, formatWatchlistAnnouncement, runMonitorTick, watchStatus, armMonitor, setMonitorDeps, sendTelegram, taipeiParts, telegramChatIds } from "./monitor.js";

export { WatchMonitor };
setMonitorDeps({ getQuotes, getDailyHistory, getMinuteHistory });

const SERVER_INFO = { name: "tw-stock-mcp", version: "0.5.0" };
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
      "查詢台股個股或指數的即時報價（上市上櫃都支援），一次最多 10 檔。回傳開盤價、最新成交價、最高、最低、昨收、漲跌、漲跌幅、開盤跳空幅度（openGapPercent）、均價、累計成交張數（tradeVolume，單位：張）、成交金額（元）、最佳五檔、漲跌停價、距漲停／跌停 %、是否觸及漲跌停；個股另附當天的可否現沖（canDayTrade）、只能先買後賣（canBuyFirstDayTradeOnly）、平盤下可否融券、注意股（isAttention）、處置股（isDisposition）、撮合循環秒數（matchingIntervalSeconds，非 0 代表分盤撮合）。時段：盤中為即時資料；開盤前（09:00 前）或休市日查詢會回傳最近一個交易日的收盤資料，請以每檔的 isToday／date 判斷，不要把它當成今天的價格。指數代號：IX0001 加權指數、IX0043 櫃買指數（指數沒有漲跌停）。額度：每檔 1 次，個股當天第一次查詢多 1 次（漲跌停等資料快取一整天）。",
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
      "查詢單一個股或指數今日盤中的分時 K 線（上市上櫃都支援），用來判斷開盤後的走勢、量能是否放大、是否站上或跌破某價位。個股 volume 單位為「張」；指數改回傳 tradeValue（成交金額，元）。時段：開盤前或休市日會回傳最近一個交易日的分 K，請看 isToday 判斷。額度 1 次。",
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
      "一次查詢大盤背景：加權指數（IX0001）與櫃買指數（IX0043）的即時點數、漲跌、漲跌幅、成交金額與資料時間。開盤前查詢回傳的是最近一個交易日收盤（看 isToday）。額度 2 次。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_daily_history",
    description:
      "查詢個股或指數最近 N 個交易日的日 K（上市上櫃都支援），新到舊排序（candles[0] 為最近一個交易日）。每天回傳開高低收、成交張數（volume，單位：張，已由股換算）、漲跌幅（changePercent），以及已算好的振幅（amplitudePercent ＝（最高 − 最低）÷ 前一日收盤），不需要自行換算。可用來計算均線、近 N 日均量、前高前低。時段：盤後約 16:30 才會更新當天資料，盤中查詢通常只到前一個交易日（看 includesToday）。額度 1 次（歷史行情另計，每分鐘 60 次）。",
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
      "【證交所 OpenAPI，僅上市股票，不吃富果額度】查詢個股最新的本益比、殖利率（%）、股價淨值比，資料為證交所最近一個交易日盤後公布（回傳 date）。虧損或無盈餘時本益比為 null。上櫃股票會回傳查無資料。一次最多 30 檔。",
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
      "【證交所 OpenAPI，僅上市股票，不吃富果額度】查詢個股最近一個交易日的融資融券（單位：張）：融資買賣、餘額與增減、融資使用率、融券買賣、餘額與增減、券資比、資券互抵。用來判斷散戶槓桿與軋空潛力。只有個股資料，沒有全市場彙總。上櫃股票或非信用交易標的會回傳查無資料。一次最多 30 檔。",
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
      "【證交所 OpenAPI，僅上市股票，不吃富果額度】當沖前檢查（依證交所最新公布、通常為前一交易日盤後的名單）：個股是否為可當沖標的（canDayTrade）、是否暫停「先賣後買」（sellFirstSuspended）、是否被列為注意股（isAttention）、是否在處置期間（isDisposed，含處置原因、期間與措施，例如人工撮合、預收款券），並彙整成 warnings。上櫃股票不在證交所名單中，請改看 get_quotes 回傳的 canDayTrade／isAttention／isDisposition。一次最多 30 檔。",
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
      "【證交所 OpenAPI，僅上市股票，不吃富果額度】列出證交所最新公布的全部注意股（含原因）與處置股（含處置期間與措施），用來避開被處置的標的或找出異常熱門股。不含上櫃股票。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_daytrade_watchlist",
    description:
      "【盤中監控】寫入今天的當沖監控清單（覆蓋前一份）。寫入後，伺服器會在台北時間 09:01–13:25 每數秒（依檔數自動調整，3 檔約 6 秒）查一次即時報價，條件成立時用 Telegram 通知使用者；每個條件只通知一次。最多 5 檔。每檔包含：symbol、name、prevClose（前一日收盤）、invalidBelow（失效價：現價跌到此價以下就通知失效並停止監控該檔）、entries（進場條件陣列）。每個 entry：id、label（給人看的一句話，例如「開平突破 1,270」）、when（適用開盤情境：high=跳空 +1% 以上／flat=±1% 以內／low=跳空 -1% 以下／any）、priceAbove（觸發價：現價 ≥ 此價才算成立）、holdMinutes（需連續成立幾分鐘，預設 1，建議 2–3 以減少假突破）、minVolumeRatio（選填：今日累計成交量 ÷ 近 5 日「同一時刻」的平均累計量（依實際分時量能分布，已反映開盤爆量），需 ≥ 此倍數；建議 1.3）、abandonBelow（選填：該劇本的放棄價，例如開高走低跌破某價就放棄）。另可設 noNewEntryAfter（HH:MM，預設 12:30，之後不再發進場通知）。開盤後若個股變成處置、分盤撮合或不可當沖，會自動通知失效。可附上選股條件 criteria、每檔入選理由 reason、條件檢核 checks、tier（次級觀察），會一起推播。寫入成功後會立即把今日清單推播到 Telegram（同一天重寫會標示「更新」；items 為空時推播「今日無標的」）；不想推播可設 announce=false。",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "台北日期 YYYY-MM-DD，必須是要監控的那一天" },
        noNewEntryAfter: { type: "string", description: "HH:MM，預設 12:30" },
        announce: { type: "boolean", description: "寫入後是否推播今日清單到 Telegram，預設 true" },
        criteria: { type: "array", maxItems: 10, items: { type: "string" }, description: "今天實際採用的選股條件（一條一句，含門檻數字），例如「前一日收盤 ≤ 250 元」「成交金額前 50 名」「近 5 日平均振幅 ≥ 3%」。會列在推播最上方" },
        noPickReason: { type: "string", description: "items 為空時：哪一項條件沒過、為何今天沒有標的" },
        items: {
          type: "array",
          maxItems: 5,
          items: {
            type: "object",
            properties: {
              symbol: { type: "string" },
              name: { type: "string" },
              prevClose: { type: "number" },
              invalidBelow: { type: "number" },
              note: { type: "string", description: "無法自動判斷的文字條件，一句話" },
              reason: { type: "string", description: "入選理由：具體催化事件＋資料時間，一到兩句" },
              checks: { type: "array", maxItems: 8, items: { type: "string" }, description: "逐項條件檢核，每項含實際數值與 ✅／⚠️，例如「收盤 41.3 ✅」「成交金額第 18 名 ✅」「5 日均振幅 3.4% ✅」「當沖比 56% ⚠️ 超標」「注意股 ⚠️」" },
              tier: { type: "string", enum: ["main", "secondary"], description: "secondary＝有條件超標而降級的次級觀察" },
              entries: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    label: { type: "string" },
                    when: { type: "string", enum: ["high", "flat", "low", "any"] },
                    priceAbove: { type: "number" },
                    holdMinutes: { type: "integer", minimum: 1, maximum: 30 },
                    minVolumeRatio: { type: "number" },
                    abandonBelow: { type: "number" },
                  },
                  required: ["when", "priceAbove"],
                },
              },
            },
            required: ["symbol", "entries"],
          },
        },
      },
      required: ["date", "items"],
    },
  },
  {
    name: "get_daytrade_watchlist",
    description:
      "【盤中監控】查看目前的當沖監控清單與今日狀態：每個條件是監控中、已觸發（時間與價格）或已放棄，哪些標的已失效，以及已送出的通知紀錄與 Telegram 是否設定完成。",
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
    // Durable Object（盤中秒級監控）內可能不支援 Cache API；失敗就略過快取，只用記憶體快取
    const hit = await cache.match(cacheKey).catch(() => null);
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
    })).catch(() => null);
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
  const today = taipeiToday();
  for (const q of results) {
    if (!q.error) q.isToday = q.date === today;
  }
  const stale = results.some((q) => !q.error && q.date && q.date !== today);
  return {
    source: "富果 Fugle MarketData API",
    unit: "tradeVolume 為成交張數；tradeValue 為成交金額（元）",
    ...(stale ? { note: `部分報價的 date 不是今天（${today}）：今天可能尚未開盤或休市，這些是最近一個交易日的收盤資料` } : {}),
    quotes: results,
  };
}

async function getIntradayCandles(env, args) {
  const symbol = normalizeSymbol(args?.symbol ?? "");
  if (!symbol) throw new Error("symbol 不可為空");
  const timeframe = args?.timeframe ?? "5";
  const r = await fugle(env, `/intraday/candles/${encodeURIComponent(symbol)}`, { timeframe });
  const isIndex = /^IX\d+$/.test(symbol);
  // 富果分 K：個股 volume 為「張」；指數的 volume 欄位其實是成交金額（元）
  const candles = (r.data || []).map((c) => ({
    time: c.date,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    ...(isIndex ? { tradeValue: c.volume ?? null } : { volume: c.volume ?? null }),
    average: c.average,
  }));
  const today = taipeiToday();
  return {
    source: "富果 Fugle MarketData API",
    symbol: r.symbol ?? symbol,
    date: r.date,
    isToday: r.date === today,
    timeframe: `${timeframe} 分`,
    unit: isIndex ? "tradeValue 為成交金額（元）" : "volume 為成交張數",
    count: candles.length,
    candles,
    ...(r.date && r.date !== today ? { note: `這是 ${r.date} 的資料，不是今天（${today}）；今天可能尚未開盤或休市` } : {}),
  };
}

async function getMarketOverview(env) {
  return getQuotes(env, { symbols: Object.keys(INDEX_SYMBOLS) });
}

/**
 * 監控用：取最近約 10 個日曆日的 1 分 K（不含今天），用來建立分時量能曲線。
 * 富果分 K 的 volume 上市櫃為「張」；date 為 ISO 時間（+08:00）。不是 MCP 工具。
 */
async function getMinuteHistory(env, { symbol, today }) {
  const sym = normalizeSymbol(symbol ?? "");
  if (!sym) throw new Error("symbol 不可為空");
  const end = new Date(`${today}T00:00:00+08:00`);
  const fmt = (d) => new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const r = await fugle(env, `/historical/candles/${encodeURIComponent(sym)}`, {
    from: fmt(new Date(end.getTime() - 10 * 86400 * 1000)),
    to: fmt(new Date(end.getTime() - 86400 * 1000)),
    timeframe: "1",
    fields: "volume",
  });
  return { candles: r.data || [] };
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
  // 新到舊；多保留一天，用來算最舊那天的振幅（需要前一日收盤）
  const sorted = (r.data || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1));
  const rows = sorted.slice(0, days).map((c, i) => {
    const prevClose = sorted[i + 1]?.close ?? null;
    return {
      date: c.date,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      // 富果日 K 的 volume 是「股」，統一換算成「張」（1 張 = 1,000 股）
      volume: c.volume == null ? null : Math.round(c.volume / 1000),
      changePercent: pct(c.close, prevClose),
      // 台股慣例：振幅 =（最高 − 最低）÷ 前一日收盤
      amplitudePercent:
        prevClose && c.high != null && c.low != null ? Math.round(((c.high - c.low) / prevClose) * 10000) / 100 : null,
    };
  });
  const today = taipeiToday();
  return {
    source: "富果 Fugle MarketData API",
    symbol: r.symbol ?? symbol,
    unit: "volume 為成交張數（已由股換算）",
    order: "新到舊（candles[0] 為最近一個交易日）",
    latestDate: rows[0]?.date ?? null,
    includesToday: rows[0]?.date === today,
    days: rows.length,
    candles: rows,
  };
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

async function setDaytradeWatchlist(env, args) {
  if (!env.MONITOR) throw new Error("伺服器尚未設定 MONITOR（Durable Object）綁定");
  const wl = validateWatchlist(args);
  const today = taipeiParts().date;
  if (wl.date < today) throw new Error(`date ${wl.date} 已經過去（今天是 ${today}）`);
  const prev = await kvGet(env, "watchlist");
  await kvPut(env, "watchlist", wl);
  await kvPut(env, `state:${wl.date}`, null);
  await armMonitor(env).catch(() => null); // 盤中改清單時立即接手秒級檢查

  // 寫入後把今日清單推播到 Telegram（私訊／頻道）；同一天再次寫入會標示「更新」
  let announced = null;
  if (args?.announce !== false) {
    const isUpdate = prev?.date === wl.date;
    announced = await sendTelegram(env, formatWatchlistAnnouncement(wl, { isUpdate }));
  }
  return {
    ok: true,
    announced: announced == null ? "未推播（announce=false）" : announced.ok ? `已推播到 ${announced.sentTo} 個收件者` : `推播失敗：${announced.reason}`,
    date: wl.date,
    items: wl.items.map((it) => `${it.symbol} ${it.name}：${it.entries.length} 個條件，失效價 ${it.invalidBelow ?? "未設"}`),
    noNewEntryAfter: wl.noNewEntryAfter,
    telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
    note: "監控時段為台北 09:01–13:25，每數秒檢查一次；進場通知後會追蹤停損（-1%）、第一目標（+0.6%）與保本；13:15 會對未出場的標的發平倉提醒。",
  };
}

async function getDaytradeWatchlist(env) {
  if (!env.MONITOR) throw new Error("伺服器尚未設定 MONITOR（Durable Object）綁定");
  return watchStatus(env);
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
  set_daytrade_watchlist: setDaytradeWatchlist,
  get_daytrade_watchlist: getDaytradeWatchlist,
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
          "台股行情。富果 API（上市上櫃皆可，每分鐘 60 次額度）：查價、漲跌停與可否現沖用 get_quotes；大盤背景用 get_market_overview；開盤後走勢與量能用 get_intraday_candles；近 N 日量價、振幅、均線用 get_daily_history。證交所 OpenAPI（前一交易日盤後資料，僅上市股票，不吃富果額度）：當沖前先用 get_daytrade_status 確認可否當沖、是否注意／處置；個股融資融券用 get_margin_trading；估值用 get_valuation；全部注意／處置股用 get_alert_lists。注意時段：開盤前或休市日，盤中工具回傳的是最近一個交易日資料，請看 isToday／date。盤中監控：set_daytrade_watchlist 寫入當日當沖條件後，伺服器每數秒自動檢查並以 Telegram 通知（含進場後的停損、第一目標與保本通知）；get_daytrade_watchlist 查看狀態。所有工具的個股成交量單位一律為「張」，成交金額為「元」；所有時間為台北時間。",
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
  // Cron 每分鐘一次：只當看門狗，確保 Durable Object 的秒級 alarm 在盤中持續運作；
  // 實際檢查由 WatchMonitor.alarm() 每 N 秒執行（N 依檔數自動調整，見 checkIntervalSeconds）
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      armMonitor(env)
        .then((r) => console.log(JSON.stringify({ monitorArm: r })))
        .catch((e) => console.log(JSON.stringify({ monitorArmError: e.message })))
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    // 記錄每個請求（不含 token），可在 Cloudflare 後台 Logs 查看
    const safePath = url.pathname.replace(/^\/(mcp|selftest|notify-test|announce-test|watch)\/[^/]+/, "/$1/***");
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
        telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
        telegramRecipients: telegramChatIds(env).length,
        monitorBound: Boolean(env.MONITOR),
      });
    }

    // 診斷：帶正確 token 才會實際呼叫富果一次
    // 通知測試：帶正確 token 才會送一則 Telegram 測試訊息
    const nt = url.pathname.match(/^\/notify-test\/([^/]+)\/?$/);
    if (nt) {
      if (!env.MCP_TOKEN || !safeEqual(decodeURIComponent(nt[1]), env.MCP_TOKEN)) {
        return json({ ok: false, reason: "token 不符或 MCP_TOKEN 未設定" });
      }
      const r = await sendTelegram(env, `✅ tw-stock-mcp 通知測試成功（${taipeiParts().hhmm} 台北時間）\n之後當沖監控條件成立時，會在這裡通知你。`);
      return json(r);
    }

    // 推播預覽：/announce-test/<token>?wl=<base64url(JSON)>
    // 只格式化並推播一份清單（標示「測試」），不寫入監控、不影響當日清單；不帶 wl 時重發目前儲存的清單
    const at = url.pathname.match(/^\/announce-test\/([^/]+)\/?$/);
    if (at) {
      if (!env.MCP_TOKEN || !safeEqual(decodeURIComponent(at[1]), env.MCP_TOKEN)) {
        return json({ ok: false, reason: "token 不符或 MCP_TOKEN 未設定" });
      }
      try {
        let wl;
        const raw = url.searchParams.get("wl");
        if (raw) {
          const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
          const bytes = Uint8Array.from(atob(b64 + "===".slice((b64.length + 3) % 4)), (c) => c.charCodeAt(0));
          wl = validateWatchlist(JSON.parse(new TextDecoder().decode(bytes)));
        } else {
          wl = env.MONITOR ? await kvGet(env, "watchlist") : null;
          if (!wl) return json({ ok: false, reason: "目前沒有儲存的清單，請帶 wl 參數" });
        }
        const r = await sendTelegram(env, formatWatchlistAnnouncement(wl, { test: true }));
        return json({ ...r, date: wl.date, items: wl.items.map((i) => i.symbol) });
      } catch (e) {
        return json({ ok: false, reason: `清單格式錯誤：${e.message}` });
      }
    }

    // 監控狀態：帶正確 token 才回傳
    const wt = url.pathname.match(/^\/watch\/([^/]+)\/?$/);
    if (wt) {
      if (!env.MCP_TOKEN || !safeEqual(decodeURIComponent(wt[1]), env.MCP_TOKEN)) {
        return json({ ok: false, reason: "token 不符或 MCP_TOKEN 未設定" });
      }
      if (!env.MONITOR) return json({ ok: false, reason: "MONITOR 未綁定" });
      return json(await watchStatus(env));
    }

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
