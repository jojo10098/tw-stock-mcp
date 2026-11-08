// 盤中監控測試：用假的 Durable Object、假報價、假 Telegram 模擬一個交易日
import worker from "../src/index.js";
import {
  WatchMonitor, validateWatchlist, evaluateItem, newSymbolState, exitLevels, tickSize,
  scenarioOf, runMonitorTick, watchStatus, taipeiParts, buildVolumeProfile, expectedVolume, formatEvent,
} from "../src/monitor.js";

let failed = 0;
const check = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failed++; };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

// 台北 2026-10-21（三）hh:mm → Date
const at = (hhmm, day = "2026-10-21") => new Date(`${day}T${hhmm}:00+08:00`);

// ---------- 升降單位與出場價 ----------
check("tickSize", tickSize(9.9) === 0.01 && tickSize(45) === 0.05 && tickSize(78) === 0.1 && tickSize(152) === 0.5 && tickSize(844) === 1 && tickSize(1250) === 5);
const l1 = exitLevels(1250);
check("出場價 1250 → 停損 1240／目標 1260", l1.stop === 1240 && l1.target === 1260);
const l2 = exitLevels(152.5);
check("出場價 152.5 → 停損 151／目標 153.5", l2.stop === 151 && l2.target === 153.5);
const l3 = exitLevels(41.3);
check("出場價 41.3 → 停損 40.9／目標 41.55", l3.stop === 40.9 && l3.target === 41.55);
check("停損虧損不超過 1%", (1250 - l1.stop) / 1250 <= 0.01 && (152.5 - l2.stop) / 152.5 <= 0.01);
check("開盤情境", scenarioOf(1.2) === "high" && scenarioOf(0.3) === "flat" && scenarioOf(-1) === "low" && scenarioOf(null) === null);

// ---------- 清單驗證 ----------
check("缺 date → 錯誤", throws(() => validateWatchlist({ items: [] })));
check("超過 5 檔 → 錯誤", throws(() => validateWatchlist({ date: "2026-10-21", items: Array.from({ length: 6 }, (_, i) => ({ symbol: `11${i}0`, entries: [{ when: "any", priceAbove: 1 }] })) })));
check("缺 priceAbove → 錯誤", throws(() => validateWatchlist({ date: "2026-10-21", items: [{ symbol: "2409", entries: [{ when: "flat" }] }] })));
check("when 不合法 → 錯誤", throws(() => validateWatchlist({ date: "2026-10-21", items: [{ symbol: "2409", entries: [{ when: "up", priceAbove: 20 }] }] })));
const wl = validateWatchlist({
  date: "2026-10-21",
  items: [
    { symbol: "2409", name: "友達", prevClose: 20.0, invalidBelow: 19.5,
      entries: [
        { id: "hi", when: "high", label: "開高站穩 20.4", priceAbove: 20.4, holdMinutes: 2, abandonBelow: 20.1 },
        { id: "fl", when: "flat", label: "開平突破 20.3", priceAbove: 20.3, holdMinutes: 2, minVolumeRatio: 1.2 },
      ] },
    { symbol: "2002", name: "中鋼", prevClose: 22.0, invalidBelow: 21.6,
      entries: [{ id: "fl", when: "flat", label: "開平突破 22.2", priceAbove: 22.2 }] },
  ],
});
check("清單驗證通過、預設值", wl.items.length === 2 && wl.noNewEntryAfter === "12:30" && wl.items[1].entries[0].holdMinutes === 1);

// ---------- 條件判斷 ----------
{
  const st = newSymbolState();
  const it = wl.items[0];
  const ctx = (hhmm) => ({ minute: taipeiParts(at(hhmm)).minute, hhmm, noNewEntryMin: 750, avgVol5: 54000 });
  const q = (price, vol, gap = 0.5) => ({ lastPrice: price, tradeVolume: vol, openGapPercent: gap, isToday: true, canDayTrade: true, matchingIntervalSeconds: 0 });
  // 09:30 經過 30 分鐘 → 預期量 54000*30/270=6000；需 ≥1.2 倍＝7200
  let ev = evaluateItem(it, q(20.35, 8000), st, ctx("09:30"));
  check("開平：第 1 分鐘成立但需連續 2 分鐘 → 不通知", ev.length === 0 && st.holdSince.fl != null);
  ev = evaluateItem(it, q(20.35, 8100), st, ctx("09:31"));
  check("開平：連續 2 分鐘 → 通知進場", ev.length === 1 && ev[0].type === "entry" && ev[0].entry.id === "fl");
  check("進場附量比", ev[0].volRatio > 1.2);
  ev = evaluateItem(it, q(20.4, 9000), st, ctx("09:32"));
  check("同一條件只通知一次", ev.length === 0);
  check("開平時不判斷開高劇本", !st.fired.hi && !st.abandoned.hi);
}
{
  const st = newSymbolState();
  const it = wl.items[0];
  const ctx = { minute: 600, hhmm: "10:00", noNewEntryMin: 750, avgVol5: 54000 };
  const base = { tradeVolume: 99999, openGapPercent: 0.2, isToday: true, canDayTrade: true, matchingIntervalSeconds: 0 };
  let ev = evaluateItem(it, { ...base, lastPrice: 20.35 }, st, { ...ctx, avgVol5: 10_000_000 });
  check("量能不足 → 不成立", ev.length === 0 && st.holdSince.fl == null);
  ev = evaluateItem(it, { ...base, lastPrice: 19.5 }, st, ctx);
  check("跌破失效價 → 失效通知", ev.length === 1 && ev[0].type === "invalid" && st.invalidated);
  ev = evaluateItem(it, { ...base, lastPrice: 21 }, st, ctx);
  check("失效後不再監控", ev.length === 0);
}
{
  const st = newSymbolState();
  const it = wl.items[0];
  const ctx = { minute: 560, hhmm: "09:20", noNewEntryMin: 750, avgVol5: null };
  const base = { tradeVolume: 5000, openGapPercent: 2.0, isToday: true, canDayTrade: true, matchingIntervalSeconds: 0 };
  let ev = evaluateItem(it, { ...base, lastPrice: 20.05 }, st, ctx);
  check("開高走低跌破放棄價 → 放棄通知", ev.length === 1 && ev[0].type === "abandon" && st.abandoned.hi);
  ev = evaluateItem(it, { ...base, lastPrice: 20.5 }, st, { ...ctx, minute: 561 });
  check("放棄後即使站回也不通知", ev.length === 0);
}
{
  const st = newSymbolState();
  const ev = evaluateItem(wl.items[1], { lastPrice: 22.3, openGapPercent: 0, isToday: true, isDisposition: true }, st, { minute: 600, hhmm: "10:00", noNewEntryMin: 750 });
  check("盤中變處置股 → 失效", ev.length === 1 && ev[0].type === "invalid" && /處置/.test(ev[0].reason));
  const st2 = newSymbolState();
  const ev2 = evaluateItem(wl.items[1], { lastPrice: 22.3, openGapPercent: 0, isToday: true, canDayTrade: true, matchingIntervalSeconds: 0 }, st2, { minute: 760, hhmm: "12:40", noNewEntryMin: 750 });
  check("超過 noNewEntryAfter → 不發進場", ev2.length === 0);
  const ev3 = evaluateItem(wl.items[1], { lastPrice: 22.3, openGapPercent: 0, isToday: false }, newSymbolState(), { minute: 600, hhmm: "10:00", noNewEntryMin: 750 });
  check("非今日報價 → 不判斷", ev3.length === 0);
}

// ---------- 分時量能曲線 ----------
// 模擬「開盤爆量」：09:00 那一分鐘 3000 張，之後每分鐘 100 張，13:30 收盤集合 1000 張
const mkDay = (day, scale = 1) => {
  const rows = [];
  for (let m = 540; m <= 810; m++) {
    const hh = String(Math.floor(m / 60)).padStart(2, "0"), mm = String(m % 60).padStart(2, "0");
    if (m > 805 && m < 810) continue; // 13:26–13:29 無成交
    const v = m === 540 ? 3000 : m === 810 ? 1000 : 100;
    rows.push({ date: `${day}T${hh}:${mm}:00.000+08:00`, volume: v * scale });
  }
  return rows;
};
{
  const candles = [...mkDay("2026-10-14"), ...mkDay("2026-10-15"), ...mkDay("2026-10-16", 2), ...mkDay("2026-10-19"), ...mkDay("2026-10-20"), ...mkDay("2026-10-21", 9)];
  const p = buildVolumeProfile(candles, "2026-10-21", 5);
  check("曲線：排除今天、取最近 5 天", p.method === "profile" && p.days === 5 && !p.dates.includes("2026-10-21"));
  // 平均：4 天 ×1 + 1 天 ×2 → 1.2 倍
  // 09:01 檢查：只含 09:00 那根 = 3000×1.2 = 3600
  check("09:01 預期量已含開盤爆量（3600 張）", expectedVolume(p, 541) === 3600);
  // 09:31：09:00 + 30 根 100 = 6000 ×1.2 = 7200
  check("09:31 預期量 7200 張", expectedVolume(p, 571) === 7200);
  const lin = { method: "linear", avgVol5: p.cum.at(-1) };
  check("同一天的開盤時段，線性估算明顯偏低", expectedVolume(lin, 541) < expectedVolume(p, 541) / 10);
  check("分 K 不足 3 天 → null", buildVolumeProfile(mkDay("2026-10-20"), "2026-10-21") === null);
  check("無資料 → null", buildVolumeProfile([], "2026-10-21") === null && expectedVolume(null, 600) === null);

  // 量比判斷：09:01 累計 3000 張，對曲線（3600）只有 0.83 倍 → 不成立；線性會誤判為大爆量
  const it = validateWatchlist({ date: "2026-10-21", items: [{ symbol: "2409", entries: [{ id: "fl", when: "flat", priceAbove: 20, minVolumeRatio: 1.3 }] }] }).items[0];
  const q = (vol) => ({ lastPrice: 20.1, tradeVolume: vol, openGapPercent: 0, isToday: true, canDayTrade: true, matchingIntervalSeconds: 0 });
  let ev = evaluateItem(it, q(3000), newSymbolState(), { minute: 541, hhmm: "09:01", noNewEntryMin: 750, volBase: p });
  check("開盤正常爆量（0.83 倍）→ 依分時曲線不成立", ev.length === 0);
  ev = evaluateItem(it, q(3000), newSymbolState(), { minute: 541, hhmm: "09:01", noNewEntryMin: 750, volBase: lin });
  check("同樣的量用線性估算會誤判成立（舊行為）", ev.length === 1);
  ev = evaluateItem(it, q(5000), newSymbolState(), { minute: 541, hhmm: "09:01", noNewEntryMin: 750, volBase: p });
  check("真的放量（1.4 倍）→ 成立，並標示依分時", ev.length === 1 && ev[0].volMethod === "profile" && ev[0].volDays === 5);
  const txt = formatEvent({ symbol: "2409", name: "友達" }, { tradeVolume: 5000, changePercent: 0.5 }, ev[0], "09:01");
  check("通知文字說明量比基準", txt.includes("近 5 日同時段實際累計量") && txt.includes("1.4 倍"));
}

// ---------- 端到端：模擬一個交易日 ----------
const store = new Map();
const monitor = new WatchMonitor({ storage: {
  get: async (k) => (store.has(k) ? structuredClone(store.get(k)) : undefined),
  put: async (k, v) => { store.set(k, structuredClone(v)); },
} });
const MONITOR = { idFromName: () => "main", get: () => ({ fetch: (u, init) => monitor.fetch(new Request(u, init)) }) };
const TOKEN = "test-token-1234567890";
const env = { MCP_TOKEN: TOKEN, FUGLE_API_KEY: "dummy", MONITOR, TELEGRAM_BOT_TOKEN: "bot123", TELEGRAM_CHAT_ID: "42" };

const sent = [];
let prices = { "2409": 20.0, "2002": 22.0 };
let gap = { "2409": 0.5, "2002": 0.0 };
let quoteCalls = 0;
const deps = {
  getQuotes: async (_env, { symbols }) => {
    if (symbols.some((x) => x === "2409" || x === "2002")) quoteCalls++; // 只計標的查價（不含大盤保護）
    return { quotes: symbols.map((s) => ({ symbol: s, name: s, lastPrice: prices[s], tradeVolume: 50000, openGapPercent: gap[s], changePercent: 1.0, isToday: true, canDayTrade: true, matchingIntervalSeconds: 0 })) };
  },
  getDailyHistory: async (_env, { symbol }) => ({ candles: [{ date: "2026-10-20", volume: 54000 }, { date: "2026-10-19", volume: 54000 }] }),
  // 友達有分 K；中鋼模擬富果 404 → 退回線性估算
  getMinuteHistory: async (_env, { symbol, today }) => {
    minuteCalls++;
    if (symbol === "2002") throw new Error("404");
    return { candles: [...mkDay("2026-10-16"), ...mkDay("2026-10-19"), ...mkDay("2026-10-20")] };
  },
};
let minuteCalls = 0;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://api.telegram.org/")) {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true }));
  }
  return new Response("nope", { status: 404 });
};

// 先透過 MCP 寫入清單（測試 Worker 路由）
const realNow = Date.now;
Date.now = () => at("06:05").getTime();
const lastArgs = {
    date: "2026-10-21",
    items: [
      { symbol: "2409", name: "友達", prevClose: 20, invalidBelow: 19.5, note: "量縮不追", reason: "面板報價 10 月下旬翻揚（集邦 10/20），前一日爆量 2.1 倍", checks: ["收盤 20.0 ✅", "成交金額第 18 名 ✅", "5 日均振幅 3.4% ✅", "當沖比 32% ✅"], entries: [{ id: "fl", when: "flat", label: "開平突破 20.3", priceAbove: 20.3, holdMinutes: 2 }, { id: "hi", when: "high", label: "開高站穩 20.5", priceAbove: 20.5, holdMinutes: 3, minVolumeRatio: 1.3, abandonBelow: 20.2 }] },
      { symbol: "2002", name: "中鋼", prevClose: 22, invalidBelow: 21.6, tier: "secondary", checks: ["當沖比 56% ⚠️ 超標"], entries: [{ id: "fl", when: "flat", label: "開平突破 22.2", priceAbove: 22.2 }] },
    ],
    criteria: ["前一日收盤 ≤ 250 元", "成交金額前 50 名", "近 5 日平均振幅 ≥ 3%", "當沖比 20%–50%", "有明確催化", "排除處置／注意／不可當沖"] };
const setRes = await worker.fetch(new Request(`https://x.dev/mcp/${TOKEN}`, { method: "POST", body: JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "set_daytrade_watchlist", arguments: {
    date: "2026-10-21",
    items: [
      { symbol: "2409", name: "友達", prevClose: 20, invalidBelow: 19.5, entries: [{ id: "fl", when: "flat", label: "開平突破 20.3", priceAbove: 20.3, holdMinutes: 2 }] },
      { symbol: "2002", name: "中鋼", prevClose: 22, invalidBelow: 21.6, entries: [{ id: "fl", when: "flat", label: "開平突破 22.2", priceAbove: 22.2 }] },
    ] } } }) }), env);
const setBody = await setRes.json();
check("MCP set_daytrade_watchlist 成功", !setBody.result.isError && JSON.parse(setBody.result.content[0].text).ok === true);
const pastRes = await (await worker.fetch(new Request(`https://x.dev/mcp/${TOKEN}`, { method: "POST", body: JSON.stringify({
  jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "set_daytrade_watchlist", arguments: { date: "2026-10-20", items: [] } } }) }), env)).json();
check("寫入過去日期 → 錯誤", pastRes.result.isError === true);
check("寫入後推播今日清單", sent.length === 1 && sent[0].text.startsWith("📋 10/21（三）當沖監控清單") && sent[0].text.includes("2409 友達") && sent[0].text.includes("失效價 19.5") && /已推播到 1 個/.test(setBody.result.content[0].text));
console.log("---- 公告預覽 ----\n" + sent[0].text + "\n------------------");
{
  const again = await (await worker.fetch(new Request(`https://x.dev/mcp/${TOKEN}`, { method: "POST", body: JSON.stringify({
    jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "set_daytrade_watchlist", arguments: JSON.parse(JSON.stringify({ ...lastArgs })) } }) }), env)).json();
  check("推播含選股條件、入選理由、檢核、次級標記", sent[1].text.includes("🔎 選股條件") && sent[1].text.includes("① 前一日收盤 ≤ 250 元") && sent[1].text.includes("入選理由：面板報價") && sent[1].text.includes("條件檢核：收盤 20.0 ✅｜") && sent[1].text.includes("次級觀察"));
  console.log("---- 公告預覽（完整） ----\n" + sent[1].text + "\n------------------");
  check("同一天重寫 → 標示更新", sent.length === 2 && sent[1].text.includes("（更新）") && !again.result.isError);
  await worker.fetch(new Request(`https://x.dev/mcp/${TOKEN}`, { method: "POST", body: JSON.stringify({
    jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "set_daytrade_watchlist", arguments: { ...lastArgs, announce: false } } }) }), env);
  check("announce=false 不推播", sent.length === 2);
}
sent.length = 0;
Date.now = realNow;

check("開盤前不執行", (await runMonitorTick(env, at("08:59"), deps)).skipped === "outside_session");
check("週末不執行", (await runMonitorTick(env, at("10:00", "2026-10-24"), deps)).skipped === "weekend");
check("清單不是今天 → 不執行", (await runMonitorTick(env, at("10:00", "2026-10-22"), deps)).skipped === "no_watchlist_today");

await runMonitorTick(env, at("09:05"), deps);
check("價格未到 → 無通知", sent.length === 0);
prices["2409"] = 20.35; prices["2002"] = 22.25;
await runMonitorTick(env, at("09:06"), deps);
check("中鋼 holdMinutes=1 → 立即通知；友達需連續 2 分鐘", sent.length === 1 && sent[0].text.includes("2002 中鋼"));
await runMonitorTick(env, at("09:07"), deps);
check("友達第 2 分鐘 → 通知", sent.length === 2 && sent[1].text.includes("2409 友達") && sent[1].chat_id === "42");
check("通知含停損與目標", /停損 20\.15/.test(sent[1].text) && /第一目標 20\.5/.test(sent[1].text));
prices["2002"] = 21.5;
await runMonitorTick(env, at("10:00"), deps);
check("中鋼進場後跌破停損 → 停損通知，同時跌破失效價 → 失效通知", sent.length === 4 && sent[2].text.startsWith("🛑 跌破停損｜2002") && /停損 22\.05/.test(sent[2].text) && sent[3].text.startsWith("🔴 失效｜2002"));
const callsBefore = quoteCalls;
await runMonitorTick(env, at("10:01"), deps);
check("失效且已出場的標的不再查價（只剩 1 檔）", quoteCalls === callsBefore + 1 && sent.length === 4);
await runMonitorTick(env, at("13:15"), deps);
check("13:15 平倉提醒（只列未出場的友達）", sent.length === 5 && sent[4].text.includes("平倉提醒") && sent[4].text.includes("友達") && !sent[4].text.includes("中鋼"));
await runMonitorTick(env, at("13:16"), deps);
check("平倉提醒只發一次", sent.length === 5);
check("13:26 之後不執行", (await runMonitorTick(env, at("13:26"), deps)).skipped === "outside_session");

Date.now = () => at("13:20").getTime();
const status = await watchStatus(env, at("13:20"));
check("量能基準：友達用分時曲線、中鋼退回線性", /實際分時/.test(status.items[0].volumeBaseline) && /線性/.test(status.items[1].volumeBaseline));
check("分 K 每天每檔只查一次", minuteCalls === 2);
check("watchStatus 狀態正確", status.activeToday && status.items[0].entries[0].status.startsWith("已觸發 09:07") && status.items[1].invalidated && status.notifications.length === 5 && /停損/.test(status.items[1].positions[0].status) && /持有中/.test(status.items[0].positions[0].status));
const getRes = await (await worker.fetch(new Request(`https://x.dev/mcp/${TOKEN}`, { method: "POST", body: JSON.stringify({
  jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_daytrade_watchlist", arguments: {} } }) }), env)).json();
check("MCP get_daytrade_watchlist", JSON.parse(getRes.result.content[0].text).items.length === 2);
const nt = await (await worker.fetch(new Request(`https://x.dev/notify-test/${TOKEN}`), env)).json();
check("/notify-test 送出測試訊息", nt.ok === true && sent.at(-1).text.includes("通知測試成功"));
{
  const before = sent.length;
  const multi = await (await worker.fetch(new Request(`https://x.dev/notify-test/${TOKEN}`), { ...env, TELEGRAM_CHAT_ID: "42, -1004373470716，42" })).json();
  const ids = sent.slice(before).map((m) => m.chat_id);
  check("多個 chat id：各發一次、自動去重", multi.ok === true && ids.length === 2 && ids.includes("42") && ids.includes("-1004373470716"));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const b = JSON.parse(init.body);
    if (b.chat_id === "-1") return new Response(JSON.stringify({ ok: false, description: "Forbidden" }), { status: 403 });
    return realFetch(url, init);
  };
  const part = await (await worker.fetch(new Request(`https://x.dev/notify-test/${TOKEN}`), { ...env, TELEGRAM_CHAT_ID: "42,-1" })).json();
  check("其中一個失敗不影響其他，並回報哪個失敗", part.ok === false && sent.at(-1).chat_id === "42" && JSON.stringify(part).includes("-1"));
  globalThis.fetch = realFetch;
  const st = await (await worker.fetch(new Request(`https://x.dev/status`), { ...env, TELEGRAM_CHAT_ID: "42,-100" })).json();
  check("/status 顯示收件者數量", st.telegramRecipients === 2 || st.monitor?.telegramRecipients === 2 || JSON.stringify(st).includes('"telegramRecipients":2'));
}
{
  const before = sent.length;
  const wlB64 = Buffer.from(JSON.stringify({ date: "2026-10-20", criteria: ["成交金額前 50 名"], items: [{ symbol: "3037", name: "欣興", prevClose: 1120, invalidBelow: 1040, entries: [{ id: "flat", when: "flat", label: "開平突破 1,132", priceAbove: 1132, holdMinutes: 2 }] }] })).toString("base64url");
  const r = await (await worker.fetch(new Request(`https://x.dev/announce-test/${TOKEN}?wl=${wlB64}`), env)).json();
  check("/announce-test 依參數推播測試清單", r.ok === true && sent.length === before + 1 && sent.at(-1).text.startsWith("🧪 測試推播") && sent.at(-1).text.includes("3037 欣興"));
  const wlNow = await (await worker.fetch(new Request(`https://x.dev/mcp/${TOKEN}`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "get_daytrade_watchlist", arguments: {} } }) }), env)).json();
  check("/announce-test 不覆蓋監控清單", JSON.parse(wlNow.result.content[0].text).items.length === 2);
  const bad = await (await worker.fetch(new Request(`https://x.dev/announce-test/wrong?wl=${wlB64}`), env)).json();
  check("/announce-test 錯誤 token 拒絕", bad.ok === false && sent.length === before + 1);
}
check("/notify-test 錯誤 token 拒絕", (await (await worker.fetch(new Request(`https://x.dev/notify-test/wrong`), env)).json()).ok === false);
const noTg = await runMonitorTick({ ...env, TELEGRAM_BOT_TOKEN: undefined }, at("13:00"), deps);
check("未設定 Telegram 時不會出錯", noTg.ran === true);
Date.now = realNow;

// ---------- 秒級檢查與部位追蹤 ----------
{
  const { checkIntervalSeconds, setMonitorDeps } = await import("../src/monitor.js");
  check("間隔：1 檔 5 秒、3 檔 6 秒、5 檔 10 秒", checkIntervalSeconds({}, 1) === 5 && checkIntervalSeconds({}, 3) === 6 && checkIntervalSeconds({}, 5) === 10);
  check("間隔可用環境變數調整", checkIntervalSeconds({ MONITOR_INTERVAL_SECONDS: "15" }, 3) === 15 && checkIntervalSeconds({ MONITOR_QUOTA_PER_MIN: "45" }, 3) === 5);

  const it = validateWatchlist({ date: "2026-10-21", items: [{ symbol: "2409", invalidBelow: 19, entries: [{ id: "flat", when: "flat", priceAbove: 20, holdMinutes: 2 }] }] }).items[0];
  const q = (p) => ({ lastPrice: p, tradeVolume: 1, openGapPercent: 0, isToday: true, canDayTrade: true, matchingIntervalSeconds: 0 });
  const st = newSymbolState();
  const c = (sec) => ({ minute: Math.floor(sec / 60), sec, hhmm: "x", noNewEntryMin: 750 });
  const T = 600 * 60; // 10:00:00
  check("連續 2 分鐘：第 0 秒成立不觸發", evaluateItem(it, q(20.1), st, c(T)).length === 0);
  check("連續 2 分鐘：第 54 秒仍不觸發", evaluateItem(it, q(20.1), st, c(T + 54)).length === 0);
  let ev = evaluateItem(it, q(20.1), st, c(T + 60));
  check("連續 2 分鐘：滿 60 秒觸發進場並建立部位", ev.length === 1 && ev[0].type === "entry" && st.positions.flat.stop === 19.9 && st.positions.flat.target === 20.25);
  ev = evaluateItem(it, q(20.25), st, c(T + 66));
  check("達第一目標 → 🎯 通知", ev.length === 1 && ev[0].type === "target" && formatEvent({ symbol: "2409", name: "友達" }, {}, ev[0], "10:01:06").startsWith("🎯 達第一目標"));
  check("目標只通知一次", evaluateItem(it, q(20.3), st, c(T + 72)).length === 0);
  ev = evaluateItem(it, q(20.1), st, c(T + 78));
  check("達標後跌回進場價 → 保本通知", ev.length === 1 && ev[0].type === "breakeven");
  check("保本後不再通知", evaluateItem(it, q(19.5), st, c(T + 84)).length === 0);

  const st2 = newSymbolState();
  evaluateItem(it, q(20.1), st2, c(T)); evaluateItem(it, q(20.1), st2, c(T + 60));
  ev = evaluateItem(it, q(18.9), st2, c(T + 66));
  check("進場後急殺：停損與失效同時通知，失效訊息不再說還在追蹤（已出場）", ev.length === 2 && ev[0].type === "stop" && ev[1].type === "invalid" && !ev[1].tracking);
  const st3 = newSymbolState();
  const it3 = validateWatchlist({ date: "2026-10-21", items: [{ symbol: "2409", invalidBelow: 20.05, entries: [{ id: "flat", when: "flat", priceAbove: 20.5 }] }] }).items[0];
  evaluateItem(it3, q(20.5), st3, c(T));
  ev = evaluateItem(it3, q(20.4), st3, { ...c(T + 6), }); // 未破停損 20.3
  ev = evaluateItem(it3, { ...q(20.4), isDisposition: true }, st3, c(T + 12));
  check("進場後變處置 → 失效但持續追蹤部位", ev.length === 1 && ev[0].type === "invalid" && ev[0].tracking === true);
  ev = evaluateItem(it3, q(20.3), st3, c(T + 18));
  check("失效後仍會發停損通知", ev.length === 1 && ev[0].type === "stop");

  // Durable Object alarm 流程（假 storage）
  const mem = new Map(); let alarmAt = null;
  const doObj = new WatchMonitor({ storage: {
    get: async (k) => (mem.has(k) ? structuredClone(mem.get(k)) : undefined),
    put: async (k, v) => { mem.set(k, structuredClone(v)); },
    getAlarm: async () => alarmAt, setAlarm: async (t) => { alarmAt = t; },
  } }, env);
  mem.set("watchlist", validateWatchlist({ date: "2026-10-21", marketGuard: { enabled: false }, items: [{ symbol: "2409", name: "友達", invalidBelow: 19, entries: [{ id: "flat", when: "flat", priceAbove: 20.3, holdMinutes: 1 }] }] }));
  let calls = 0;
  setMonitorDeps({ getQuotes: async (_e, { symbols }) => { calls++; return { quotes: symbols.map((s) => ({ symbol: s, lastPrice: 20.4, tradeVolume: 1, openGapPercent: 0, isToday: true, canDayTrade: true, matchingIntervalSeconds: 0 })) }; }, getDailyHistory: async () => ({ candles: [] }) });
  const rn = Date.now;
  Date.now = () => at("10:00").getTime();
  const armRes = await (await doObj.fetch(new Request("https://monitor/arm", { method: "POST" }))).json();
  check("Cron 看門狗：盤中有清單 → 排 alarm", armRes.armed === true && alarmAt != null && armRes.intervalSeconds === 5);
  const before = sent.length;
  await doObj.alarm();
  check("alarm 執行檢查並排下一次（5 秒後）", calls === 1 && sent.length === before + 1 && sent.at(-1).text.startsWith("🟢") && alarmAt === at("10:00").getTime() + 5000);
  Date.now = () => at("13:25").getTime() + 58000;
  alarmAt = null; await doObj.alarm();
  check("13:25 之後不再排 alarm", alarmAt === null);
  Date.now = () => at("08:30").getTime();
  check("盤前看門狗不排程", (await (await doObj.fetch(new Request("https://monitor/arm", { method: "POST" }))).json()).armed === false);
  Date.now = rn;
}

// ---------- 保護條件：大盤、同業 ----------
{
  const { evalMarketGuard, evalPeerGuard, guardSymbols, guardRefreshSeconds, formatWatchlistAnnouncement: fa } = await import("../src/monitor.js");
  const wlg = validateWatchlist({ date: "2026-10-21", items: [{ symbol: "3037", name: "欣興", peers: ["8046", "3189"], entries: [{ id: "flat", when: "flat", priceAbove: 100 }] }] });
  check("預設啟用大盤保護（加權、台積電 1.5%）", wlg.marketGuard.enabled && wlg.marketGuard.symbols.join() === "IX0001,2330" && wlg.marketGuard.dropPercent === 1.5);
  check("同業預設門檻 2%", wlg.items[0].peers.join() === "8046,3189" && wlg.items[0].peerDropPercent === 2);
  check("保護條件要查的代號（去重、不含標的）", guardSymbols(wlg).join() === "IX0001,2330,8046,3189");
  check("保護條件查價間隔：4 檔 30 秒、10 檔 40 秒", guardRefreshSeconds(4) === 30 && guardRefreshSeconds(10) === 40 && guardRefreshSeconds(0) === 0);
  check("peers 格式錯誤 → 錯誤", throws(() => validateWatchlist({ date: "2026-10-21", items: [{ symbol: "3037", peers: ["南電"], entries: [{ when: "any", priceAbove: 1 }] }] })));
  check("marketGuard 可關閉", validateWatchlist({ date: "2026-10-21", marketGuard: { enabled: false }, items: [] }).marketGuard.enabled === false);

  const Q = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { name: k, changePercent: v, isToday: true }]));
  let r = evalMarketGuard(wlg.marketGuard, Q({ IX0001: -0.8, 2330: -1.2 }), false);
  check("大盤 -0.8%、台積電 -1.2% → 不暫停", !r.paused && !r.changed);
  r = evalMarketGuard(wlg.marketGuard, Q({ IX0001: -1.1, 2330: -1.6 }), false);
  check("台積電 -1.6% → 暫停", r.paused && r.changed);
  r = evalMarketGuard(wlg.marketGuard, Q({ IX0001: -0.9, 2330: -1.2 }), true);
  check("回到 -1.2% 還不恢復（需回升 0.5 個百分點）", r.paused && !r.changed);
  r = evalMarketGuard(wlg.marketGuard, Q({ IX0001: -0.5, 2330: -0.9 }), true);
  check("回到 -0.9% → 恢復", !r.paused && r.changed);
  check("查不到報價 → 維持原狀", evalMarketGuard(wlg.marketGuard, {}, true).paused === true);

  let p = evalPeerGuard(wlg.items[0], Q({ 8046: -3, 3189: -1.5 }), false);
  check("同業平均 -2.25% → 暫停", p.paused && p.changed && p.avg === -2.25);
  p = evalPeerGuard(wlg.items[0], Q({ 8046: -1, 3189: -1 }), true);
  check("同業回到 -1% → 恢復", !p.paused && p.changed);

  // 保護中不發進場、不累計連續時間；部位仍追蹤
  const it = wlg.items[0];
  const st = newSymbolState();
  const q = (px) => ({ lastPrice: px, openGapPercent: 0, isToday: true, canDayTrade: true, matchingIntervalSeconds: 0 });
  check("保護中：條件成立也不進場", evaluateItem(it, q(101), st, { minute: 600, sec: 36000, hhmm: "x", noNewEntryMin: 750, blockEntries: true }).length === 0 && st.holdSince.flat == null);
  check("解除後立即可進場", evaluateItem(it, q(101), st, { minute: 600, sec: 36006, hhmm: "x", noNewEntryMin: 750 }).length === 1);
  const ev = evaluateItem(it, q(99), st, { minute: 600, sec: 36012, hhmm: "x", noNewEntryMin: 750, blockEntries: true });
  check("保護中已進場部位仍發停損", ev.length === 1 && ev[0].type === "stop");

  const txt = fa(wlg);
  check("公告列出大盤保護與同業保護", txt.includes("🛡 大盤保護：加權指數或台積電跌逾 1.5%") && txt.includes("同業保護：8046、3189 平均跌逾 2%"));

  // 端到端：大盤轉弱 → 推播暫停、阻擋進場；回穩 → 推播恢復
  const mem = new Map(); let alarmAt = null;
  const doObj = new WatchMonitor({ storage: {
    get: async (k) => (mem.has(k) ? structuredClone(mem.get(k)) : undefined),
    put: async (k, v) => { mem.set(k, structuredClone(v)); },
    getAlarm: async () => alarmAt, setAlarm: async (t) => { alarmAt = t; },
  } }, env);
  mem.set("watchlist", validateWatchlist({ date: "2026-10-21", items: [{ symbol: "3037", name: "欣興", peers: ["8046"], entries: [{ id: "flat", when: "flat", priceAbove: 100 }] }] }));
  const px = { 3037: 99, IX0001: -0.3, 2330: -1.8, 8046: 0.5 };
  const { setMonitorDeps } = await import("../src/monitor.js");
  let guardCalls = 0;
  setMonitorDeps({ getDailyHistory: async () => ({ candles: [] }), getQuotes: async (_e, { symbols }) => {
    if (symbols.includes("IX0001")) guardCalls++;
    return { quotes: symbols.map((x) => x === "3037"
      ? { symbol: x, name: "欣興", lastPrice: px[x], openGapPercent: 0, changePercent: 0.2, isToday: true, canDayTrade: true, matchingIntervalSeconds: 0 }
      : { symbol: x, name: x === "IX0001" ? "加權指數" : x === "2330" ? "台積電" : "南電", changePercent: px[x], isToday: true }) };
  } });
  const rn = Date.now; const base = sent.length;
  Date.now = () => at("10:00").getTime(); await doObj.alarm();
  check("台積電 -1.8% → 推播「大盤轉弱，暫停進場」", sent.length === base + 1 && sent.at(-1).text.startsWith("⚠️ 大盤轉弱") && sent.at(-1).text.includes("台積電 -1.80%"));
  px[3037] = 101;
  Date.now = () => at("10:00").getTime() + 6000; await doObj.alarm();
  check("暫停中站上觸發價 → 不發進場；保護報價 30 秒內沿用不重查", sent.length === base + 1 && guardCalls === 1);
  px[2330] = -0.7;
  Date.now = () => at("10:00").getTime() + 31000; await doObj.alarm();
  check("30 秒後重查：台積電回到 -0.7% → 推播恢復，並同一輪發出進場", guardCalls === 2 && sent.at(-2).text.startsWith("✅ 大盤回穩") && sent.at(-1).text.startsWith("🟢"));
  const stt = await watchStatus({ ...env, MONITOR: { idFromName: () => "x", get: () => ({ fetch: (u, i) => doObj.fetch(new Request(u, i)) }) } }, at("10:01"));
  check("watchStatus 顯示大盤保護狀態", stt.marketGuard.enabled && stt.marketGuard.paused === false && stt.items[0].peers[0] === "8046");
  Date.now = rn;
}

// ---------- 空方（先賣後買） ----------
{
  const { evalMarketGuard, evalPeerGuard, formatWatchlistAnnouncement: fa, setMonitorDeps } = await import("../src/monitor.js");
  const ls = exitLevels(98.4, "short");
  check("空方出場價 98.4 → 停損 99.3（+1% 往下取）／目標 97.8", ls.stop === 99.3 && ls.target === 97.8);
  check("空方停損虧損不超過 1%、目標獲利至少 0.6%", (ls.stop - 98.4) / 98.4 <= 0.01 && (98.4 - ls.target) / 98.4 >= 0.006);
  check("空方用 priceAbove → 錯誤", throws(() => validateWatchlist({ date: "2026-10-21", items: [{ symbol: "2303", side: "short", entries: [{ when: "flat", priceAbove: 97 }] }] })));
  check("空方用 invalidBelow → 錯誤", throws(() => validateWatchlist({ date: "2026-10-21", items: [{ symbol: "2303", side: "short", invalidBelow: 90, entries: [{ when: "flat", priceBelow: 97 }] }] })));
  check("多方用 priceBelow → 錯誤", throws(() => validateWatchlist({ date: "2026-10-21", items: [{ symbol: "2303", entries: [{ when: "flat", priceAbove: 97, priceBelow: 96 }] }] })));
  check("side 不合法 → 錯誤", throws(() => validateWatchlist({ date: "2026-10-21", items: [{ symbol: "2303", side: "sell", entries: [{ when: "flat", priceBelow: 97 }] }] })));
  const wls = validateWatchlist({ date: "2026-10-21", marketGuard: { risePercent: 1.2 }, items: [
    { symbol: "6770", name: "力積電", prevClose: 52.9, invalidBelow: 51.5, entries: [{ id: "flat", when: "flat", priceAbove: 54.3, holdMinutes: 2 }] },
    { symbol: "2303", name: "聯電", side: "short", prevClose: 98.4, invalidAbove: 100, peers: ["6770"], peerDropPercent: 1,
      reason: "外資賣超 29,248 張（11/5）", checks: ["券資比 0.55% ✅", "未暫停先賣後買 ✅"],
      entries: [{ id: "low", when: "low", label: "開低跌破 93", priceBelow: 93, holdMinutes: 3, abandonAbove: 96 }, { id: "flat", when: "flat", label: "開平跌破 97.4", priceBelow: 97.4, holdMinutes: 2 }] },
  ] });
  const sh = wls.items[1];
  check("空方驗證：side、invalidAbove、priceBelow、risePercent", sh.side === "short" && sh.invalidAbove === 100 && sh.invalidBelow === null && sh.entries[0].priceBelow === 93 && sh.entries[0].abandonAbove === 96 && wls.marketGuard.risePercent === 1.2 && wls.items[0].side === "long");

  const q = (p, extra = {}) => ({ lastPrice: p, tradeVolume: 1, openGapPercent: 0, isToday: true, canDayTrade: true, matchingIntervalSeconds: 0, ...extra });
  const c = (sec) => ({ minute: Math.floor(sec / 60), sec, hhmm: "x", noNewEntryMin: 750 });
  const T = 600 * 60;
  const st = newSymbolState();
  check("空方開平：價格在觸發價之上 → 不成立", evaluateItem(sh, q(97.6), st, c(T)).length === 0);
  evaluateItem(sh, q(97.3), st, c(T + 6));
  let ev = evaluateItem(sh, q(97.2), st, c(T + 66));
  check("空方開平：跌破 97.4 連續 2 分鐘 → 放空通知", ev.length === 1 && ev[0].type === "entry" && st.positions.flat.side === "short" && st.positions.flat.stop === 98.1 && st.positions.flat.target === 96.6);
  const txt = formatEvent(sh, { tradeVolume: 1, changePercent: -1.2 }, ev[0], "10:01:06");
  check("放空通知文字", txt.startsWith("🔻 放空條件成立｜🔻2303 聯電") && txt.includes("停損 98.1（+1%）") && txt.includes("第一目標 96.6（-0.6%）") && txt.includes("回補"));
  ev = evaluateItem(sh, q(96.6), st, c(T + 72));
  check("空方跌到目標 → 🎯 先回補一半", ev.length === 1 && ev[0].type === "target" && formatEvent(sh, {}, ev[0], "x").includes("先回補一半"));
  ev = evaluateItem(sh, q(97.2), st, c(T + 78));
  check("空方達標後反彈到放空價 → 保本回補", ev.length === 1 && ev[0].type === "breakeven");

  const st2 = newSymbolState();
  evaluateItem(sh, q(97.3), st2, c(T)); evaluateItem(sh, q(97.3), st2, c(T + 60));
  ev = evaluateItem(sh, q(98.2), st2, c(T + 66));
  check("空方漲破停損 → 🛑 漲破停損", ev.length === 1 && ev[0].type === "stop" && formatEvent(sh, {}, ev[0], "x").startsWith("🛑 漲破停損"));
  const st3 = newSymbolState();
  evaluateItem(sh, q(97.3), st3, c(T)); evaluateItem(sh, q(97.3), st3, c(T + 60));
  ev = evaluateItem(sh, q(97.5, { toLimitUpPercent: 1.8, limitUpPrice: 99.3 }), st3, c(T + 66));
  check("空單逼近漲停 → 🚨 立刻回補（只提醒一次）", ev.length === 1 && ev[0].type === "nearLimitUp" && formatEvent(sh, {}, ev[0], "x").startsWith("🚨 逼近漲停")
    && evaluateItem(sh, q(97.5, { toLimitUpPercent: 1.5 }), st3, c(T + 72)).length === 0);
  const st4 = newSymbolState();
  ev = evaluateItem(sh, q(100), st4, c(T));
  check("空方漲破失效價 → 失效", ev.length === 1 && ev[0].type === "invalid" && /漲破失效價 100/.test(ev[0].reason));
  const st5 = newSymbolState();
  ev = evaluateItem(sh, q(97, { canBuyFirstDayTradeOnly: true }), st5, c(T));
  check("盤中變成只能先買後賣 → 空方失效", ev.length === 1 && ev[0].type === "invalid" && /先賣後買/.test(ev[0].reason));
  const st6 = newSymbolState();
  ev = evaluateItem(wls.items[0], q(55, { canBuyFirstDayTradeOnly: true }), st6, c(T));
  check("只能先買後賣不影響多方", !ev.some((e) => e.type === "invalid"));
  const st7 = newSymbolState();
  ev = evaluateItem(sh, q(92.8, { openGapPercent: -2 }), st7, c(T));
  ev = evaluateItem(sh, q(96.1, { openGapPercent: -2 }), st7, c(T + 30));
  check("空方開低走高漲破放棄價 → 放棄", ev.length === 1 && ev[0].type === "abandon" && formatEvent(sh, {}, ev[0], "x").includes("漲破 96"));

  const Q = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { name: k, changePercent: v, isToday: true }]));
  let r = evalMarketGuard(wls.marketGuard, Q({ IX0001: 1.3, 2330: 0.8 }), false, "short");
  check("大盤 +1.3%（門檻 1.2%）→ 暫停做空", r.paused && r.changed);
  check("同樣行情不暫停做多", !evalMarketGuard(wls.marketGuard, Q({ IX0001: 1.3, 2330: 0.8 }), false).paused);
  r = evalMarketGuard(wls.marketGuard, Q({ IX0001: 0.6, 2330: 0.5 }), true, "short");
  check("漲幅回落到 0.6% → 恢復做空", !r.paused && r.changed);
  let pg = evalPeerGuard(sh, Q({ 6770: 1.5 }), false);
  check("空方同業平均漲 1.5%（門檻 1%）→ 暫停放空", pg.paused && pg.changed);
  check("空方同業下跌不暫停", !evalPeerGuard(sh, Q({ 6770: -3 }), false).paused);

  const ann = fa(wls);
  check("公告分多空兩區、空方標示與保護", ann.includes("🟢 多方") && ann.includes("🔻 空方（先賣後買）") && ann.includes("🔻2303 聯電") && ann.includes("漲破 100 失效") && ann.includes("≤ 97.4") && ann.includes("漲破 96 放棄") && ann.includes("平均漲逾 1% 時暫停放空") && ann.includes("漲逾 1.2% 時暫停做空進場") && ann.includes("借券"));
  console.log("---- 多空公告預覽 ----\n" + ann + "\n------------------");

  // 端到端：大盤急漲只暫停空方，多方照常進場
  const mem = new Map(); let alarmAt = null;
  const doObj = new WatchMonitor({ storage: {
    get: async (k) => (mem.has(k) ? structuredClone(mem.get(k)) : undefined),
    put: async (k, v) => { mem.set(k, structuredClone(v)); },
    getAlarm: async () => alarmAt, setAlarm: async (t) => { alarmAt = t; },
  } }, env);
  mem.set("watchlist", validateWatchlist({ date: "2026-10-21", items: [
    { symbol: "6770", name: "力積電", invalidBelow: 50, entries: [{ id: "flat", when: "flat", priceAbove: 54.3 }] },
    { symbol: "2303", name: "聯電", side: "short", invalidAbove: 100, entries: [{ id: "flat", when: "flat", priceBelow: 97.4 }] },
  ] }));
  const px = { 6770: 54.5, 2303: 97, IX0001: 1.8, 2330: 0.9 };
  setMonitorDeps({ getDailyHistory: async () => ({ candles: [] }), getQuotes: async (_e, { symbols }) => ({ quotes: symbols.map((x) =>
    x === "IX0001" || x === "2330" ? { symbol: x, name: x === "IX0001" ? "加權指數" : "台積電", changePercent: px[x], isToday: true }
      : { symbol: x, name: x, lastPrice: px[x], openGapPercent: 0, changePercent: 0, isToday: true, canDayTrade: true, matchingIntervalSeconds: 0 }) }) });
  const rn = Date.now; const base = sent.length;
  Date.now = () => at("10:00").getTime(); await doObj.alarm();
  const got = sent.slice(base).map((m) => m.text);
  check("大盤 +1.8%：推播暫停做空、多方照常發進場、空方不發", got.some((t) => t.startsWith("⚠️ 大盤急漲，暫停做空進場")) && got.some((t) => t.startsWith("🟢 當沖條件成立｜6770")) && !got.some((t) => t.startsWith("🔻 放空條件成立")));
  const stt = await watchStatus({ ...env, MONITOR: { idFromName: () => "x", get: () => ({ fetch: (u, i) => doObj.fetch(new Request(u, i)) }) } }, at("10:01"));
  check("watchStatus 顯示空方欄位與暫停狀態", stt.items[1].side === "short" && stt.items[1].invalidAbove === 100 && stt.items[1].entries[0].priceBelow === 97.4 && stt.marketGuard.pausedShort === true);
  Date.now = rn;
}

// ---------- MCP：空方寫入時檢查暫停先賣後買 ----------
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.hostname === "openapi.twse.com.tw") {
      if (u.pathname.endsWith("/exchangeReport/TWTB4U")) return new Response(JSON.stringify([
        { Date: "1151020", Code: "2303", Name: "聯電", Suspension: "" },
        { Date: "1151020", Code: "2344", Name: "華邦電", Suspension: "Y" },
      ]));
      return new Response("[]");
    }
    return realFetch(url, init);
  };
  const rn = Date.now; Date.now = () => at("06:05").getTime();
  const call = async (args) => (await (await worker.fetch(new Request(`https://x.dev/mcp/${TOKEN}`, { method: "POST", body: JSON.stringify({
    jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "set_daytrade_watchlist", arguments: args } }) }), env)).json()).result;
  const bad = await call({ date: "2026-10-21", items: [{ symbol: "2344", name: "華邦電", side: "short", invalidAbove: 130, entries: [{ when: "flat", priceBelow: 118 }] }] });
  check("暫停先賣後買的上市股放空 → 拒絕寫入", bad.isError === true && bad.content[0].text.includes("暫停先賣後買") && bad.content[0].text.includes("2344"));
  const before = sent.length;
  const good = await call({ date: "2026-10-21", criteria: ["空方：暫停先賣後買排除"], items: [{ symbol: "2303", name: "聯電", side: "short", invalidAbove: 100, entries: [{ id: "flat", when: "flat", label: "開平跌破 97.4", priceBelow: 97.4, holdMinutes: 2 }] }] });
  check("可先賣後買的上市股放空 → 寫入並推播", !good.isError && JSON.parse(good.content[0].text).items[0].startsWith("🔻 2303") && sent.length === before + 1 && sent.at(-1).text.includes("🔻 空方（先賣後買）"));
  Date.now = rn;
  globalThis.fetch = realFetch;
}

// ---------- 週選股推播 ----------
{
  const { validatePicksMessage, formatPicksMessage } = await import("../src/picks.js");
  const pick = { code: "2412", name: "中華電", tier: "mid-large", thesisType: "獲利驅動", refPrice: 163.5, entryLow: 158, entryHigh: 161.5, stop: 146, target: 176,
    horizon: "2–6 週", settleBy: "2026-12-04", thesis: ["Q3 EPS 1.57 超出財測高標（11/4 法說）"], risks: ["本益比約 32 倍"], invalidatedIf: "收盤跌破 146" };
  check("週選股：kind 不合法 → 錯誤", throws(() => validatePicksMessage({ kind: "x", date: "2026-11-09" })));
  check("週選股：停損不低於進場區間 → 錯誤", throws(() => validatePicksMessage({ kind: "new_picks", date: "2026-11-09", picks: [{ ...pick, stop: 159 }] })));
  check("週選股：目標不高於進場區間 → 錯誤", throws(() => validatePicksMessage({ kind: "new_picks", date: "2026-11-09", picks: [{ ...pick, target: 160 }] })));
  check("週選股：daily_alerts 沒有觸發 → 錯誤", throws(() => validatePicksMessage({ kind: "daily_alerts", date: "2026-11-09", alerts: [] })));
  const t1 = formatPicksMessage(validatePicksMessage({ kind: "new_picks", date: "2026-11-09", week: "2026-W46", strategyVersion: 3, note: "市場濾網成立，本週只選一檔中大型", picks: [{ ...pick, shares: 155, sizeNote: "25,000 元" }] }));
  check("新推薦推播內容", t1.startsWith("📈 11/9（一） 本週選股（2026-W46）｜策略 v3") && t1.includes("2412 中華電｜中大型｜獲利驅動") && t1.includes("進場 158–161.5") && t1.includes("停損 146（收盤跌破，距進場中值 -8.6%）") && t1.includes("目標 176（+10.2%）") && t1.includes("12/4（五）結算") && t1.includes("看錯條件：收盤跌破 146"));
  check("新推薦不含部位等個人資訊", !t1.includes("155") && !t1.includes("25,000"));
  console.log("---- 週選股推播預覽 ----\n" + t1 + "\n------------------");
  const t2 = formatPicksMessage(validatePicksMessage({ kind: "daily_alerts", date: "2026-11-10", alerts: [
    { code: "2412", name: "中華電", type: "entry", close: 160, note: "最低 158.5 首次進入進場區間" },
    { code: "1101", name: "台泥", type: "stop", close: 24.8, note: "收盤跌破停損 24.9", settlement: { verdict: "失敗", planPnlPct: -8.33 } },
  ] }));
  check("每日檢查推播內容", t2.startsWith("🔔 11/10（二） 週選股每日檢查") && t2.includes("✅ 進入進場區間｜2412 中華電｜收 160") && t2.includes("🔴 跌破停損｜1101 台泥") && t2.includes("已提前結算：失敗，照計畫 -8.33%"));
  const t3 = formatPicksMessage(validatePicksMessage({ kind: "weekly_review", date: "2026-11-13", strategyVersion: 3, items: [
    { code: "2412", name: "中華電", status: "open", lastPrice: 162, pctFromRef: -0.92, thesisStatus: "成立中", weeksLeft: 3, note: "10 月營收年增 18%" },
    { code: "1101", name: "台泥", status: "settled", verdict: "失敗", planPnlPct: -8.33, early: true },
  ], record: { success: 0, partial: 0, fail: 5, noEntry: 1, avgPnlPct: -9.93, enteredCount: 5 }, strategyNote: "維持 v3 不變（本週僅累積觀察）" }));
  check("週報推播內容", t3.startsWith("📊 11/13（五） 週選股週報｜策略 v3") && t3.includes("2412 中華電｜收 162｜相對基準 -0.92%｜理由成立中｜距結算 3 週") && t3.includes("1101 台泥｜失敗｜照計畫 -8.33%（提前結算）") && t3.includes("累計戰績：成立 0、部分成立 0、失敗 5、未進場 1；有進場平均 -9.93%（5 檔）") && t3.includes("樣本數仍小") && t3.includes("策略：維持 v3"));
  const before = sent.length;
  const res = await (await worker.fetch(new Request(`https://x.dev/mcp/${TOKEN}`, { method: "POST", body: JSON.stringify({
    jsonrpc: "2.0", id: 30, method: "tools/call", params: { name: "announce_weekly_picks", arguments: { kind: "new_picks", date: "2026-11-09", picks: [pick] } } }) }), env)).json();
  check("MCP announce_weekly_picks 推播到 Telegram", !res.result.isError && JSON.parse(res.result.content[0].text).ok === true && sent.length === before + 1 && sent.at(-1).text.includes("2412 中華電"));
  const badRes = await (await worker.fetch(new Request(`https://x.dev/mcp/${TOKEN}`, { method: "POST", body: JSON.stringify({
    jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "announce_weekly_picks", arguments: { kind: "new_picks", date: "2026-11-09", picks: [{ ...pick, stop: 170 }] } } }) }), env)).json();
  check("MCP announce_weekly_picks 參數錯誤 → isError、不推播", badRes.result.isError === true && sent.length === before + 1);
}

process.exit(failed ? 1 : 0);
