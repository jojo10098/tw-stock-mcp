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
let twseCalls = 0;
globalThis.TPEX_MODE = "ok"; // ok｜budget（模擬 Cloudflare subrequest 上限）｜down（三種網址都失敗）

function t86Row(code, name, f, t, d) {
  const tot = f + t + d;
  const s = (x) => x.toLocaleString("en-US");
  return [code, name, s(Math.max(f, 0) + 1000), s(Math.max(-f, 0) + 1000), s(f), "0", "0", "0", s(Math.max(t, 0)), s(Math.max(-t, 0)), s(t),
    s(d), "0", "0", s(d), "0", "0", "0", s(tot)];
}

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.hostname === "www.twse.com.tw") {
    twseCalls++;
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
    if (globalThis.TPEX_MODE === "budget") throw new Error("Too many subrequests by single Worker invocation. To configure this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits");
    if (globalThis.TPEX_MODE === "down") return new Response("down", { status: 500 });
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

// --- 三大法人存進 Durable Object：第二次呼叫只重查還沒公布的今天 ---
{
  const ikv = new Map();
  const istore = { get: async (k) => ikv.get(k) ?? null, put: async (k, v) => ikv.set(k, structuredClone(v)) };
  const a = await import("../src/chips.js?inst-cache-1");
  const first = await a.getInstitutionalTrades({}, { symbols: ["2330", "8046"], days: 5 }, istore);
  assert.equal(first.results[0].daily.length, 5);
  assert.ok(ikv.get("inst:TWSE") && ikv.get("inst:TPEX"), "兩個市場都寫進快取");
  assert.ok(ikv.get("inst:TWSE").none[holiday], "休市日記為沒有資料");
  assert.equal(ikv.get("inst:TWSE").none[days[0]], undefined, "今天還沒公布，不能記成沒有資料");

  const b = await import("../src/chips.js?inst-cache-2"); // 新的 isolate：記憶體清空
  const tw0 = twseCalls, tp0 = tpexCalls;
  const second = await b.getInstitutionalTrades({}, { symbols: ["2330", "8046"], days: 5 }, istore);
  assert.deepEqual(second.results[0].daily, first.results[0].daily, "快取與來源結果相同");
  assert.deepEqual(second.results[1].daily, first.results[1].daily);
  assert.equal(second.results[0].foreignStreak, first.results[0].foreignStreak);
  assert.equal(twseCalls - tw0, 1, `證交所只重查今天（實際 ${twseCalls - tw0} 次）`);
  assert.ok(tpexCalls - tp0 <= 2, `櫃買只探測今天（實際 ${tpexCalls - tp0} 次）`);
  const rk = await b.getInstitutionalRanking({}, { top: 5 }, istore);
  assert.equal(rk.foreignSell[0].code, "2344", "排行可用快取資料");
  console.log("✓ 三大法人 Durable Object 快取");
}

// --- 不帶快取時也只抓湊滿天數所需的日期 ---
{
  const c = await import("../src/chips.js?inst-minimal");
  const tw0 = twseCalls;
  await c.getInstitutionalTrades({}, { symbols: ["2330"], days: 3 });
  // 今天未公布＋第 2 天休市，所以要抓 5 天才湊滿 3 天；舊版會一次抓 7 天
  assert.equal(twseCalls - tw0, 5, `證交所呼叫次數 ${twseCalls - tw0}`);
}

// --- Cloudflare subrequest 上限：不換網址重試、不逐日重試、不記住錯誤 ---
{
  const m = await import("../src/chips.js?inst-budget");
  globalThis.TPEX_MODE = "budget";
  const tp0 = tpexCalls;
  const r = await m.getInstitutionalTrades({}, { symbols: ["2330", "8046"], days: 5 });
  assert.equal(tpexCalls - tp0, 1, `額度用完後只試一次（實際 ${tpexCalls - tp0} 次）`);
  assert.match(r.sourceErrors.TPEX, /Cloudflare 上限/);
  assert.equal(r.results[0].market, "上市", "上市資料不受影響");
  assert.ok(r.results[1].error);
  globalThis.TPEX_MODE = "ok";
  const again = await m.getInstitutionalTrades({}, { symbols: ["8046"], days: 2 });
  assert.equal(again.results[0].market, "上櫃", "下一個請求立刻恢復，不會沿用 10 分鐘前的錯誤");
  console.log("✓ subrequest 上限處理");
}

// --- 櫃買三種網址都失敗：只探測一天，不會 3 種 × 每天 ---
{
  const m = await import("../src/chips.js?inst-down");
  globalThis.TPEX_MODE = "down";
  const tp0 = tpexCalls;
  const r = await m.getInstitutionalTrades({}, { symbols: ["8046"], days: 5 });
  assert.equal(tpexCalls - tp0, 3, `櫃買失敗時只探測一天（實際 ${tpexCalls - tp0} 次）`);
  assert.match(r.sourceErrors.TPEX, /櫃買中心三大法人抓取失敗/);
  globalThis.TPEX_MODE = "ok";
  console.log("✓ 櫃買故障不逐日重試");
}

function r(x) {
  return Math.round(x * 100) / 100;
}
console.log("chips tests passed");
