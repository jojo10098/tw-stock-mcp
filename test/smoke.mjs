// 離線冒煙測試：用假的 fetch 模擬富果回應，驗證 MCP 協定與工具輸出
import worker from "../src/index.js";

const TOKEN = "test-token-1234567890";
const env = { FUGLE_API_KEY: "dummy", MCP_TOKEN: TOKEN };

globalThis.fetch = async (url) => {
  const u = new URL(url);
  const sym = u.pathname.split("/").pop();
  if (u.pathname.includes("/intraday/quote/")) {
    return new Response(JSON.stringify({
      date: "2026-10-20", symbol: sym, name: sym === "IX0001" ? undefined : "測試股",
      openPrice: 101, highPrice: 103, lowPrice: 100, lastPrice: 102, previousClose: 100,
      change: 2, changePercent: 2, total: { tradeVolume: 12345, tradeValue: 1.2e9 },
      limitUpPrice: 110, limitDownPrice: 90, lastUpdated: 1760923800000000,
    }));
  }
  if (u.pathname.includes("/intraday/candles/")) {
    return new Response(JSON.stringify({ symbol: sym, date: "2026-10-20",
      data: [{ date: "2026-10-20T09:00:00.000+08:00", open: 101, high: 102, low: 100, close: 101.5, volume: 800, average: 101.2 }] }));
  }
  if (u.pathname.includes("/historical/candles/")) {
    return new Response(JSON.stringify({ symbol: sym,
      data: [{ date: "2026-10-17", open: 98, high: 101, low: 97, close: 100, volume: 20000 },
             { date: "2026-10-16", open: 97, high: 99, low: 96, close: 98, volume: 18000 }] }));
  }
  return new Response("nope", { status: 404 });
};

async function call(body, path = `/mcp/${TOKEN}`) {
  const res = await worker.fetch(new Request("https://x.dev" + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), env);
  return { status: res.status, body: res.status === 202 ? null : await res.json() };
}

let failed = 0;
const check = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failed++; };

const init = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
check("initialize", init.body.result?.serverInfo?.name === "tw-stock-mcp");
check("notification → 202", (await call({ jsonrpc: "2.0", method: "notifications/initialized" })).status === 202);
const list = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
check("tools/list 有 4 個工具", list.body.result.tools.length === 4);
const q = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_quotes", arguments: { symbols: ["2330", "IX0001"] } } });
const qd = JSON.parse(q.body.result.content[0].text);
check("get_quotes 跳空 1%", qd.quotes[0].openGapPercent === 1);
check("get_quotes 台北時間", /\(UTC\+8\)$/.test(qd.quotes[0].lastUpdated));
check("指數名稱", qd.quotes[1].name === "加權指數（上市）");
const c = await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_intraday_candles", arguments: { symbol: "2330" } } });
check("get_intraday_candles", JSON.parse(c.body.result.content[0].text).count === 1);
const h = await call({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_daily_history", arguments: { symbol: "2330", days: 5 } } });
check("get_daily_history 新到舊", JSON.parse(h.body.result.content[0].text).candles[0].date === "2026-10-17");
const o = await call({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "get_market_overview", arguments: {} } });
check("get_market_overview", JSON.parse(o.body.result.content[0].text).quotes.length === 2);
check("錯誤 token → 404", (await call({ jsonrpc: "2.0", id: 7, method: "tools/list" }, "/mcp/wrong")).status === 404);

process.exit(failed ? 1 : 0);
