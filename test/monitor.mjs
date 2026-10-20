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
    quoteCalls++;
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
      { symbol: "2409", name: "友達", prevClose: 20, invalidBelow: 19.5, note: "量縮不追", entries: [{ id: "fl", when: "flat", label: "開平突破 20.3", priceAbove: 20.3, holdMinutes: 2 }, { id: "hi", when: "high", label: "開高站穩 20.5", priceAbove: 20.5, holdMinutes: 3, minVolumeRatio: 1.3, abandonBelow: 20.2 }] },
      { symbol: "2002", name: "中鋼", prevClose: 22, invalidBelow: 21.6, entries: [{ id: "fl", when: "flat", label: "開平突破 22.2", priceAbove: 22.2 }] },
    ] };
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
check("中鋼跌破失效價 → 失效通知", sent.length === 3 && sent[2].text.startsWith("🔴 失效｜2002"));
const callsBefore = quoteCalls;
await runMonitorTick(env, at("10:01"), deps);
check("失效的標的不再查價（只剩 1 檔）", quoteCalls === callsBefore + 1 && sent.length === 3);
await runMonitorTick(env, at("13:15"), deps);
check("13:15 平倉提醒", sent.length === 4 && sent[3].text.includes("平倉提醒") && sent[3].text.includes("友達"));
await runMonitorTick(env, at("13:16"), deps);
check("平倉提醒只發一次", sent.length === 4);
check("13:26 之後不執行", (await runMonitorTick(env, at("13:26"), deps)).skipped === "outside_session");

Date.now = () => at("13:20").getTime();
const status = await watchStatus(env, at("13:20"));
check("量能基準：友達用分時曲線、中鋼退回線性", /實際分時/.test(status.items[0].volumeBaseline) && /線性/.test(status.items[1].volumeBaseline));
check("分 K 每天每檔只查一次", minuteCalls === 2);
check("watchStatus 狀態正確", status.activeToday && status.items[0].entries[0].status.startsWith("已觸發 09:07") && status.items[1].invalidated && status.notifications.length === 4);
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
check("/notify-test 錯誤 token 拒絕", (await (await worker.fetch(new Request(`https://x.dev/notify-test/wrong`), env)).json()).ok === false);
const noTg = await runMonitorTick({ ...env, TELEGRAM_BOT_TOKEN: undefined }, at("13:00"), deps);
check("未設定 Telegram 時不會出錯", noTg.ran === true);
Date.now = realNow;

process.exit(failed ? 1 : 0);
