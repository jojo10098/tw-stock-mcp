// 重大事件推播（announce_market_events）測試
import { validateEventsMessage, formatEventsMessage } from "../src/events.js";

let failed = 0;
const check = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failed++; };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

check("沒有 events → 錯誤", throws(() => validateEventsMessage({ date: "2026-11-19", events: [] })));
check("日期格式錯誤 → 錯誤", throws(() => validateEventsMessage({ date: "11/19", events: [{ title: "x" }] })));
check("缺 title → 錯誤", throws(() => validateEventsMessage({ date: "2026-11-19", events: [{ detail: "x" }] })));
check("含股數成本 → 拒絕", throws(() => validateEventsMessage({ date: "2026-11-19", events: [{ title: "川習會", detail: "統一 2,000 股成本 75.59" }] })));
check("股價、股東等字不誤擋", !throws(() => validateEventsMessage({ date: "2026-11-19", events: [{ title: "央行理監事會", detail: "股市波動；股東會旺季" }] })));

const m = validateEventsMessage({
  date: "2026-11-19",
  headline: "今天下午川習普會，留意台海與關稅議題",
  events: [
    { title: "川習普會（深圳 APEC）", when: "下午", impact: "high", topics: ["台海", "關稅", "烏克蘭"], detail: "三方首次同桌；議題含核武管制與兩場戰事", watch: "外資對半導體與出口族群的情緒", source: "Bloomberg、TVBS" },
    { title: "美國初領失業金", date: "2026-11-20", when: "21:30", impact: "low" },
  ],
  note: "結果出來前不預測方向",
});
const t = formatEventsMessage(m);
console.log("---- 重大事件推播預覽 ----\n" + t + "\n------------------");
check("標題與總結", t.startsWith("🌏 11/19（四） 重大事件提醒\n今天下午川習普會"));
check("每件一個區塊、影響程度圖示", t.includes("━━━━━━━━━━\n🔴 川習普會（深圳 APEC）\n🕒 下午\n議題：台海、關稅、烏克蘭"));
check("detail 依分號拆行", t.includes("· 三方首次同桌\n· 議題含核武管制與兩場戰事"));
check("非今天的事件顯示日期", t.includes("⚪ 美國初領失業金\n🕒 11/20（五） 21:30"));
check("預設送全部收件者", m.privateOnly === false);
check("privateOnly", validateEventsMessage({ date: "2026-11-19", privateOnly: true, events: [{ title: "x" }] }).privateOnly === true);

if (failed) { console.log(`${failed} events tests failed`); process.exit(1); }
console.log("all events tests passed");
