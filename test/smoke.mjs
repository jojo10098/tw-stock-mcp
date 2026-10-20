// 離線冒煙測試：用假的 fetch 模擬富果回應，驗證 MCP 協定與工具輸出
import worker from "../src/index.js";

const TOKEN = "test-token-1234567890";
const env = { FUGLE_API_KEY: "dummy", MCP_TOKEN: TOKEN };

// 證交所 OpenAPI 假資料（欄位名稱取自實際回應）
const TWSE = {
  "/v1/exchangeReport/BWIBBU_ALL": [
    { Date: "1151019", Code: "1101", Name: "台泥", PEratio: "", DividendYield: "2.95", PBratio: "0.88" },
    { Date: "1151019", Code: "2330", Name: "台積電", PEratio: "22.10", DividendYield: "1.35", PBratio: "6.50" },
  ],
  "/v1/exchangeReport/MI_MARGN": [
    { "股票代號": "2330", "股票名稱": "台積電", "融資買進": "1,200", "融資賣出": "800", "融資現金償還": "10",
      "融資前日餘額": "20000", "融資今日餘額": "20390", "融資限額": "6,483,000", "融券買進": "50", "融券賣出": "150",
      "融券現券償還": "", "融券前日餘額": "300", "融券今日餘額": "400", "融券限額": "6,483,000", "資券互抵": "33", "註記": " " },
  ],
  "/v1/exchangeReport/TWTB4U": [
    { Date: "1151019", Code: "2330", Name: "台積電", Suspension: "" },
    { Date: "1151019", Code: "2344", Name: "華邦電", Suspension: "Y" },
  ],
  "/v1/announcement/notice": [
    { Number: "1", Code: "2344", Name: "華邦電", NumberOfAnnouncement: "2", TradingInfoForAttention: "最近六個營業日累積收盤價漲幅達32%", Date: "1151019", ClosingPrice: "45.6", PE: "30.1" },
  ],
  "/v1/announcement/punish": [
    { Number: "1", Date: "1151014", Code: "2344", Name: "華邦電", NumberOfAnnouncement: "1", ReasonsOfDisposition: "連續三次",
      DispositionPeriod: "115/10/15～115/10/21", DispositionMeasures: "第一次處置", Detail: "約每五分鐘撮合一次", LinkInformation: "" },
  ],
};
const EMPTY_NOTICE = [{ Number: "0", Code: "", Name: "", NumberOfAnnouncement: "0", TradingInfoForAttention: "", Date: "", ClosingPrice: "0", PE: "0" }];
let twseCalls = 0;
const tickerCalls = [];
let noticeEmpty = false;

globalThis.fetch = async (url) => {
  const u = new URL(url);
  if (u.hostname === "openapi.twse.com.tw") {
    twseCalls++;
    if (noticeEmpty && u.pathname === "/v1/announcement/notice") return new Response(JSON.stringify(EMPTY_NOTICE));
    const data = TWSE[u.pathname];
    return data ? new Response(JSON.stringify(data)) : new Response("<html>404</html>", { status: 404 });
  }
  const sym = u.pathname.split("/").pop();
  if (u.pathname.includes("/intraday/ticker/")) {
    tickerCalls.push(sym);
    if (sym === "FAIL") return new Response("rate limited", { status: 429 });
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    return new Response(JSON.stringify({
      date: today, symbol: sym, name: "測試股", referencePrice: 100, previousClose: 100,
      limitUpPrice: 110, limitDownPrice: 90, canDayTrade: sym !== "2344", canBuyDayTrade: true,
      canBelowFlatMarginShortSell: true, isAttention: sym === "2344", isDisposition: sym === "2344",
      matchingInterval: sym === "2344" ? 300 : 0, securityStatus: "NORMAL",
    }));
  }
  if (u.pathname.includes("/intraday/quote/")) {
    return new Response(JSON.stringify({
      date: "2026-10-17", symbol: sym, name: sym === "IX0001" ? undefined : "測試股",
      openPrice: 101, highPrice: 103, lowPrice: 100, lastPrice: 102, previousClose: 100,
      change: 2, changePercent: 2, total: { tradeVolume: 12345, tradeValue: 1.2e9 },
      limitUpPrice: 110, limitDownPrice: 90, lastUpdated: 1760923800000000,
    }));
  }
  if (u.pathname.includes("/intraday/candles/")) {
    return new Response(JSON.stringify({ symbol: sym, date: "2026-10-17",
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
check("tools/list 有 8 個工具", list.body.result.tools.length === 8);
const q = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_quotes", arguments: { symbols: ["2330", "IX0001"] } } });
const qd = JSON.parse(q.body.result.content[0].text);
check("get_quotes 跳空 1%", qd.quotes[0].openGapPercent === 1);
check("get_quotes 台北時間", /\(UTC\+8\)$/.test(qd.quotes[0].lastUpdated));
check("指數名稱", qd.quotes[1].name === "加權指數（上市）");
check("漲跌停價（來自 ticker）", qd.quotes[0].limitUpPrice === 110 && qd.quotes[0].limitDownPrice === 90);
check("距漲停 %", qd.quotes[0].toLimitUpPercent === 7.84 && qd.quotes[0].toLimitDownPercent === -11.76);
check("個股附可否現沖", qd.quotes[0].canDayTrade === true && qd.quotes[0].isDisposition === false);
check("指數不查 ticker", !tickerCalls.includes("IX0001") && qd.quotes[1].canDayTrade === undefined);
await call({ jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "get_quotes", arguments: { symbols: ["2330"] } } });
check("ticker 當天快取", tickerCalls.filter((s) => s === "2330").length === 1);
const q2 = JSON.parse((await call({ jsonrpc: "2.0", id: 32, method: "tools/call", params: { name: "get_quotes", arguments: { symbols: ["2344", "FAIL"] } } })).body.result.content[0].text);
check("處置股：只能先買後賣、分盤撮合", q2.quotes[0].canBuyFirstDayTradeOnly === true && q2.quotes[0].matchingIntervalSeconds === 300);
check("ticker 失敗仍回報價", q2.quotes[1].lastPrice === 102 && q2.quotes[1].limitUpPrice === null && /漲跌停價暫時取不到/.test(q2.quotes[1].tickerError));
const c = await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_intraday_candles", arguments: { symbol: "2330" } } });
check("get_intraday_candles", JSON.parse(c.body.result.content[0].text).count === 1);
const h = await call({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_daily_history", arguments: { symbol: "2330", days: 5 } } });
const hd = JSON.parse(h.body.result.content[0].text);
check("get_daily_history 新到舊", hd.candles[0].date === "2026-10-17");
check("日 K 成交量 股→張", hd.candles[0].volume === 20 && hd.candles[1].volume === 18);
check("振幅 ÷ 前一日收盤", hd.candles[0].amplitudePercent === 4.08 && hd.candles[0].changePercent === 2.04);
check("最舊一天無前收 → null", hd.candles[1].amplitudePercent === null);
check("includesToday 欄位", hd.includesToday === false && hd.latestDate === "2026-10-17");
const ci = JSON.parse((await call({ jsonrpc: "2.0", id: 41, method: "tools/call", params: { name: "get_intraday_candles", arguments: { symbol: "IX0001" } } })).body.result.content[0].text);
check("指數分 K 改回傳 tradeValue", ci.candles[0].tradeValue === 800 && ci.candles[0].volume === undefined);
check("過期分 K 有 note", ci.isToday === false && /不是今天/.test(ci.note));
check("報價 isToday 與 note", qd.quotes[0].isToday === false && /不是今天/.test(qd.note));
const o = await call({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "get_market_overview", arguments: {} } });
check("get_market_overview", JSON.parse(o.body.result.content[0].text).quotes.length === 2);

// --- 證交所 OpenAPI 工具 ---
const tool = async (name, args) => {
  const r = await call({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name, arguments: args } });
  return { isError: r.body.result.isError, data: r.body.result.isError ? r.body.result.content[0].text : JSON.parse(r.body.result.content[0].text) };
};

const v = await tool("get_valuation", { symbols: ["2330", "1101", "6488"] });
check("valuation 數值", v.data.results[0].peRatio === 22.1 && v.data.results[0].dividendYieldPercent === 1.35);
check("valuation 民國轉西元", v.data.results[0].date === "2026-10-19");
check("valuation 空本益比 → null", v.data.results[1].peRatio === null);
check("valuation 上櫃/查無 → error", typeof v.data.results[2].error === "string");

const mg = await tool("get_margin_trading", { symbols: ["2330.TW"] });
const m0 = mg.data.results[0];
check("margin 千分位與增減", m0.margin.buy === 1200 && m0.margin.change === 390 && m0.short.change === 100);
check("margin 券資比", m0.shortToMarginRatioPercent === 1.96);
check("margin 空字串 → null", m0.short.stockRedemption === null && m0.note === null);

const dt = await tool("get_daytrade_status", { symbols: ["2330", "2344", "9999"] });
const [tsmc, wb, none] = dt.data.results;
check("daytrade 正常股", tsmc.canDayTrade && !tsmc.isDisposed && !tsmc.isAttention && tsmc.warnings.length === 0);
check("daytrade 暫停先賣後買+注意+處置", wb.sellFirstSuspended === "Y" && wb.isAttention && wb.isDisposed && wb.warnings.length === 3);
check("daytrade 處置期間", wb.disposition[0].period === "115/10/15～115/10/21");
check("daytrade 不在名單", none.canDayTrade === false && none.warnings.length === 1);

const callsBefore = twseCalls;
await tool("get_valuation", { symbols: ["2330"] });
check("證交所記憶體快取", twseCalls === callsBefore);

const al = await tool("get_alert_lists", {});
check("alert_lists", al.data.attentionCount === 1 && al.data.dispositionCount === 1);

check("證交所工具不需富果金鑰", await (async () => {
  const res = await worker.fetch(new Request(`https://x.dev/mcp/${TOKEN}`, { method: "POST", body: JSON.stringify(
    { jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: "get_valuation", arguments: { symbols: ["2330"] } } }) }),
    { MCP_TOKEN: TOKEN });
  return !(await res.json()).result.isError;
})());

const bad = await tool("get_valuation", { symbols: [] });
check("空 symbols → isError", bad.isError === true);

check("錯誤 token → 404", (await call({ jsonrpc: "2.0", id: 7, method: "tools/list" }, "/mcp/wrong")).status === 404);

process.exit(failed ? 1 : 0);
