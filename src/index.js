/**
 * tw-stock-mcp — 台股即時行情遠端 MCP server（Cloudflare Workers）
 *
 * 資料來源：富果 Fugle MarketData API v1.0
 * 傳輸方式：MCP Streamable HTTP（無狀態，每個 POST 直接回 JSON）
 *
 * 需要的 Secrets（在 Cloudflare 後台設定，不要寫進程式碼）：
 *   FUGLE_API_KEY  富果行情 API 金鑰
 *   MCP_TOKEN      自訂的隨機字串；連接器網址為 https://<worker>/mcp/<MCP_TOKEN>
 */

const FUGLE_BASE = "https://api.fugle.tw/marketdata/v1.0/stock";
const SERVER_INFO = { name: "tw-stock-mcp", version: "0.1.0" };
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

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
      "查詢台股個股或指數的即時報價（盤中）。一次最多 10 檔。回傳開盤價、最新成交價、最高、最低、昨收（參考價）、漲跌、漲跌幅、開盤跳空幅度、累計成交量、漲跌停價、是否觸及漲跌停，以及資料時間（台北時間）。指數代號：IX0001 加權指數、IX0043 櫃買指數。",
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
];

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

function summarizeQuote(q) {
  const prev = q.previousClose ?? q.referencePrice ?? null;
  const total = q.total || {};
  return {
    symbol: q.symbol,
    name: q.name ?? INDEX_SYMBOLS[q.symbol] ?? null,
    date: q.date,
    lastPrice: q.lastPrice ?? q.closePrice ?? null,
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
    limitUpPrice: q.limitUpPrice ?? null,
    limitDownPrice: q.limitDownPrice ?? null,
    isLimitUp: Boolean(q.isLimitUpPrice || q.isLimitUpBid),
    isLimitDown: Boolean(q.isLimitDownPrice || q.isLimitDownAsk),
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
      try {
        const q = await fugle(env, `/intraday/quote/${encodeURIComponent(symbol)}`);
        return summarizeQuote(q);
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

const HANDLERS = {
  get_quotes: getQuotes,
  get_intraday_candles: getIntradayCandles,
  get_market_overview: getMarketOverview,
  get_daily_history: getDailyHistory,
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
          "台股即時行情（富果 API）。盤中查價用 get_quotes；大盤背景用 get_market_overview；開盤後走勢與量能用 get_intraday_candles；近幾日量價用 get_daily_history。所有時間為台北時間，成交量單位為張。",
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
      if (!env.FUGLE_API_KEY) {
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

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, server: SERVER_INFO });
    }

    const m = url.pathname.match(/^\/mcp\/([^/]+)\/?$/);
    if (!m) return json({ error: "Not found" }, 404);
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
