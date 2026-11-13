// 波段盤中通知測試
import { validateSwingList, evaluateSwingItem, runSwingTick, formatSwingEvent, swingStatus } from "../src/swing.js";
import { WatchMonitor, setMonitorDeps, telegramChatIds } from "../src/monitor.js";

let failed = 0;
const check = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failed++; };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const at = (hhmm, day = "2026-11-16") => new Date(`${day}T${hhmm}:00+08:00`);

check("缺 alerts → 錯誤", throws(() => validateSwingList({ date: "2026-11-16", items: [{ symbol: "1216" }] })));
check("priceAbove 與 priceBelow 都給 → 錯誤", throws(() => validateSwingList({ date: "2026-11-16", items: [{ symbol: "1216", alerts: [{ priceAbove: 1, priceBelow: 2 }] }] })));
check("超過 12 檔 → 錯誤", throws(() => validateSwingList({ date: "2026-11-16", items: Array.from({ length: 13 }, (_, i) => ({ symbol: `11${String(i).padStart(2, "0")}`, alerts: [{ priceAbove: 1 }] })) })));
const list = validateSwingList({
  date: "2026-11-16",
  items: [
    { symbol: "1216", name: "統一", role: "holding", alerts: [{ id: "stop", kind: "stop", label: "跌破停損 69.5", priceBelow: 69.5 }, { id: "tgt", kind: "target", priceAbove: 83, holdMinutes: 1 }] },
    { symbol: "2412", name: "中華電", alerts: [{ id: "in", kind: "entry", label: "站上 165＋量比 1.3", priceAbove: 165, minVolumeRatio: 1.3 }] },
  ],
});
check("預設值：role candidate、holdMinutes 2", list.items[1].role === "candidate" && list.items[0].alerts[0].holdMinutes === 2 && list.items[0].alerts[1].holdMinutes === 1);

{
  const st = { fired: {}, holdSince: {} };
  const it = list.items[0];
  const q = (p) => ({ lastPrice: p, isToday: true, tradeVolume: 100 });
  let ev = evaluateSwingItem(it, q(69.4), st, { minute: 600, sec: 36000, hhmm: "10:00:00" });
  check("跌破停損第 1 分鐘：不通知", ev.length === 0);
  ev = evaluateSwingItem(it, q(69.3), st, { minute: 601, sec: 36060, hhmm: "10:01:00" });
  check("連續 2 分鐘：通知停損", ev.length === 1 && ev[0].alert.id === "stop");
  ev = evaluateSwingItem(it, q(69.0), st, { minute: 602, sec: 36120, hhmm: "10:02:00" });
  check("每天只通知一次", ev.length === 0);
  check("前一日報價（isToday false）不判斷", evaluateSwingItem(it, { lastPrice: 90, isToday: false }, st, { minute: 602, sec: 36120 }).length === 0);
  const txt = formatSwingEvent(it, { changePercent: -2.1, tradeVolume: 100 }, ev.length ? ev[0] : { alert: it.alerts[0], price: 69.3 }, "10:01:00");
  check("停損通知提醒以收盤為準", txt.startsWith("🛑 波段停損價位到了｜1216 統一") && txt.includes("以收盤價為準"));
}
{
  const st = { fired: {}, holdSince: {} };
  const it = list.items[1];
  const base = { method: "linear", avgVol5: 27000 }; // 10:00 → 預期 27000*60/270=6000
  let ev = evaluateSwingItem(it, { lastPrice: 166, isToday: true, tradeVolume: 7000 }, st, { minute: 600, sec: 36000, hhmm: "x", volBase: base });
  ev = evaluateSwingItem(it, { lastPrice: 166, isToday: true, tradeVolume: 7100 }, st, { minute: 601, sec: 36060, hhmm: "x", volBase: { method: "linear", avgVol5: 27000 } });
  check("價到但量比不足（1.17）→ 不通知", ev.length === 0);
  ev = evaluateSwingItem(it, { lastPrice: 166, isToday: true, tradeVolume: 9000 }, st, { minute: 602, sec: 36120, hhmm: "x", volBase: base });
  ev = evaluateSwingItem(it, { lastPrice: 166, isToday: true, tradeVolume: 9500 }, st, { minute: 603, sec: 36180, hhmm: "x", volBase: base });
  check("價量都到位、連續 2 分鐘 → 通知", ev.length === 1 && ev[0].volRatio > 1.3);
}

// 端到端：Durable Object、私訊過濾、節流、盤前預約
{
  const sent = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ok: true })); }
    return new Response("nope", { status: 404 });
  };
  const env = { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "8656980423,-1004373470716" };
  check("chat id 解析", telegramChatIds(env).length === 2);
  const mem = new Map(); let alarmAt = null;
  const doObj = new WatchMonitor({ storage: {
    get: async (k) => (mem.has(k) ? structuredClone(mem.get(k)) : undefined),
    put: async (k, v) => { mem.set(k, structuredClone(v)); },
    getAlarm: async () => alarmAt, setAlarm: async (t) => { alarmAt = t; },
  } }, env);
  mem.set("swing", list);
  let px = { 1216: 69.0, 2412: 160 };
  let quoteCalls = 0;
  setMonitorDeps({
    getQuotes: async (_e, { symbols }) => { quoteCalls++; return { quotes: symbols.map((s) => ({ symbol: s, lastPrice: px[s], isToday: true, tradeVolume: 1, changePercent: -1 })) }; },
    getDailyHistory: async () => ({ candles: [] }),
    getMinuteHistory: async () => ({ candles: [] }),
  });
  const rn = Date.now;
  Date.now = () => at("07:00").getTime();
  const pre = await (await doObj.fetch(new Request("https://monitor/arm", { method: "POST" }))).json();
  check("只有波段清單、開盤前 → 預約 09:01", pre.armed && pre.preOpen && alarmAt === at("09:01").getTime());
  Date.now = () => at("09:01").getTime(); await doObj.alarm();
  check("09:01 第一次檢查、下一次 60 秒後", quoteCalls === 1 && alarmAt === at("09:02").getTime());
  Date.now = () => at("09:01").getTime() + 20000; await doObj.alarm();
  check("60 秒內不重複查價（節流）", quoteCalls === 1);
  Date.now = () => at("09:02").getTime(); await doObj.alarm();
  check("持股停損通知只送私訊（不送頻道）", sent.length === 1 && sent[0].chat_id === "8656980423" && sent[0].text.startsWith("🛑"));
  const st = mem.get("swingstate:2026-11-16");
  const status = swingStatus(mem.get("swing"), st, at("09:03"));
  check("狀態：停損已通知、其他監控中", status.items[0].alerts[0].status.startsWith("已通知") && status.items[1].alerts[0].status === "監控中");
  Date.now = rn;
}

if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
console.log("all swing tests passed");
