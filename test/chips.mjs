// 離線測試：籌碼工具（三大法人、法人排行、集保大戶），假資料模擬證交所／櫃買／集保回應
import assert from "node:assert/strict";
import { getInstitutionalTrades, getInstitutionalRanking, getMajorHolders, recentWeekdays, mapInstFields } from "../src/chips.js";

const T86_FIELDS = ["證券代號", "證券名稱", "外陸資買進股數(不含外資自營商)", "外陸資賣出股數(不含外資自營商)", "外陸資買賣超股數(不含外資自營商)",
  "外資自營商買進股數", "外資自營商賣出股數", "外資自營商買賣超股數", "投信買進股數", "投信賣出股數", "投信買賣超股數",
  "自營商買賣超股數", "自營商買進股數(自行買賣)", "自營商賣出股數(自行買賣)", "自營商買賣超股數(自行買賣)",
  "自營商買進股數(避險)", "自營商賣出股數(避險)", "自營商買賣超股數(避險)", "三大法人買賣超股數"];

const days = recentWeekdays(12);
const holiday = days[1]; // 假裝第 2 個平日是休市
let tpexCalls = 0;

function t86Row(code, name, f, t, d) {
  const tot = f + t + d;
  const s = (x) => x.toLocaleString("en-US");
  return [code, name, s(Math.max(f, 0) + 1000), s(Math.max(-f, 0) + 1000), s(f), "0", "0", "0", s(Math.max(t, 0)), s(Math.max(-t, 0)), s(t),
    s(d), "0", "0", s(d), "0", "0", "0", s(tot)];
}

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.hostname === "www.twse.com.tw") {
    const ymd = u.searchParams.get("date");
    const date = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}`;
    const i = days.indexOf(date);
    if (i === 0 || date === holiday) return new Response(JSON.stringify({ stat: "很抱歉，沒有符合條件的資料!" }));
    // 台積電：外資連買（每天 +2,000 張），投信前兩天賣、之前買
    return new Response(JSON.stringify({
      stat: "OK", fields: T86_FIELDS,
      data: [
        t86Row("2330", "台積電", 2000000, i <= 3 ? -300000 : 100000, 50000),
        t86Row("2344", "華邦電", -5000000, 800000, -10000),
        t86Row("0050", "元大台灣50", 9000000, 0, 0),
      ],
    }));
  }
  if (u.hostname === "www.tpex.org.tw") {
    tpexCalls++;
    if (u.pathname.startsWith("/www/") && (init.method ?? "GET") === "GET") return new Response("<html>blocked</html>", { status: 403 });
    if (u.pathname.startsWith("/www/")) {
      // POST 新版：tables[0]，欄位名稱與上市不同
      const params = new URLSearchParams(init.body);
      const date = params.get("date").replace(/\//g, "-");
      if (days.indexOf(date) === 0 || date === holiday) return new Response(JSON.stringify({ stat: "ok", tables: [{ data: [], fields: [] }] }));
      const fields = ["代號", "名稱", "外資及陸資(不含外資自營商)-買進股數", "外資及陸資(不含外資自營商)-賣出股數", "外資及陸資(不含外資自營商)-買賣超股數",
        "外資自營商-買進股數", "外資自營商-賣出股數", "外資自營商-買賣超股數", "外資及陸資-買進股數", "外資及陸資-賣出股數", "外資及陸資-買賣超股數",
        "投信-買進股數", "投信-賣出股數", "投信-買賣超股數", "自營商(自行買賣)-買進股數", "自營商(自行買賣)-賣出股數", "自營商(自行買賣)-買賣超股數",
        "自營商(避險)-買進股數", "自營商(避險)-賣出股數", "自營商(避險)-買賣超股數", "自營商-買進股數", "自營商-賣出股數", "自營商-買賣超股數", "三大法人買賣超股數合計"];
      const row = ["8046", "南電", "3,000,000", "1,000,000", "2,000,000", "0", "0", "0", "3,000,000", "1,000,000", "2,000,000",
        "500,000", "0", "500,000", "0", "0", "0", "0", "0", "0", "0", "0", "-1,000", "2,499,000"];
      return new Response(JSON.stringify({ stat: "ok", tables: [{ fields, data: [row] }] }));
    }
    return new Response("legacy should not be needed", { status: 500 });
  }
  if (u.hostname === "opendata.tdcc.com.tw") {
    const lines = ["資料日期,證券代號,持股分級,人數,股數,占集保庫存數比例%"];
    for (const [code, big] of [["2330", 84.67], ["2344", 40.5]]) {
      for (let t = 1; t <= 17; t++) {
        const pct = t === 15 ? big : t === 17 ? 100 : t === 1 ? 1.13 : t === 12 ? 2 : 0.5;
        const holders = t === 17 ? 3080236 : t === 15 ? 1475 : 10;
        lines.push(`${globalThis.TDCC_DATE},${code},${t},${holders},1000,${pct.toFixed(2)}`);
      }
    }
    return new Response(lines.join("\r\n"));
  }
  return new Response("nope", { status: 404 });
};

// --- 個股三大法人 ---
const inst = await getInstitutionalTrades({}, { symbols: ["2330", "8046", "9999"], days: 3 });
const tsmc = inst.results[0];
assert.equal(tsmc.market, "上市");
assert.equal(tsmc.daily.length, 3);
assert.equal(tsmc.daily[0].date, days[2], "跳過今天未公布與休市日");
assert.equal(tsmc.daily[0].foreignNet, 2000);
assert.equal(tsmc.foreignStreak, 3);
assert.equal(tsmc.trustStreak, -2, "投信最近兩天賣超");
assert.equal(tsmc.periodNet.foreign, 6000);
assert.equal(tsmc.daily[0].dealerNet, 50, "自營商取合計欄，不是自行買賣");
const nd = inst.results[1];
assert.equal(nd.market, "上櫃");
assert.equal(nd.daily[0].foreignNet, 2000, "上櫃外資取不含外資自營商");
assert.equal(nd.daily[0].trustNet, 500);
assert.equal(nd.daily[0].dealerNet, -1);
assert.equal(nd.daily[0].totalNet, 2499);
assert.ok(inst.results[2].error);
console.log("✓ get_institutional_trades", JSON.stringify(inst.dataDates));

// TPEx 第一次探測後就記住 POST 版，不會每天都試三種
const before = tpexCalls;
await getInstitutionalTrades({}, { symbols: ["8046"], days: 5 });
assert.ok(tpexCalls - before <= 9, `櫃買呼叫次數 ${tpexCalls - before}`);

// --- 排行 ---
const rank = await getInstitutionalRanking({}, { top: 5 });
assert.deepEqual(rank.foreignBuy.map((r) => r.code).sort(), ["2330", "8046"], "排除 0050，上市櫃合併");
assert.equal(rank.foreignSell[0].code, "2344");
assert.equal(rank.foreignSell[0].net, -5000);
assert.equal(rank.trustBuy[0].code, "2344");
const rankEtf = await getInstitutionalRanking({}, { top: 5, includeEtf: true });
assert.equal(rankEtf.foreignBuy[0].code, "0050");
console.log("✓ get_institutional_ranking");

// --- 欄位對應 ---
const idx = mapInstFields(T86_FIELDS);
assert.equal(idx.dealerNet, 11);
assert.equal(idx.foreignNet, 4);

// --- 集保大戶：第一週沒有週增減，第二週有 ---
const kv = new Map();
const store = { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v) };
globalThis.TDCC_DATE = "20261030";
let mh = await getMajorHolders({}, { symbols: ["2330", "XXXX"] }, store);
assert.equal(mh.latestDate, "2026-10-30");
assert.equal(mh.results[0].bigHolder1000Pct, 84.67);
assert.equal(mh.results[0].bigHolder1000Count, 1475);
assert.equal(mh.results[0].holders, 3080236);
assert.equal(mh.results[0].retailUnder50Pct, r(1.13 + 0.5 * 7));
assert.equal(mh.results[0].bigHolder400Pct, r(2 + 0.5 * 2 + 84.67));
assert.equal(mh.results[0].weekOverWeek, null);
assert.ok(mh.note);
assert.ok(mh.results[1].error);

// 下一週：強制重新檢查（清掉 meta 與記憶體）
globalThis.TDCC_DATE = "20261106";
kv.set("tdcc:meta", { date: "2026-10-30", checkedAt: 0 });
const mod = await import("../src/chips.js?second");
mh = await mod.getMajorHolders({}, { symbols: ["2330"] }, store);
assert.equal(mh.latestDate, "2026-11-06");
assert.equal(mh.weeksAvailable, 2);
assert.equal(mh.results[0].weekOverWeek.prevDate, "2026-10-30");
assert.equal(mh.results[0].weekOverWeek.bigHolder1000PctChange, 0);
assert.deepEqual(kv.get("tdcc:dates"), ["2026-11-06", "2026-10-30"]);
console.log("✓ get_major_holders");

function r(x) {
  return Math.round(x * 100) / 100;
}
console.log("chips tests passed");
