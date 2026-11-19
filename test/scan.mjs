// 波段掃描（scan_swing）測試
import { tick, computeSwingMetrics, computeMarketFilter, scanSwing, SCAN_MAX_SYMBOLS } from "../src/scan.js";

let failed = 0;
const check = (name, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); if (!cond) failed++; };
const throwsAsync = async (fn) => { try { await fn(); return false; } catch { return true; } };

check("升降單位", tick(9.99) === 0.01 && tick(10) === 0.05 && tick(50) === 0.1 && tick(100) === 0.5 && tick(500) === 1 && tick(1000) === 5);

// 75 根：前 65 根穩定上漲，最後 10 根小幅拉回到 20 日線附近，最後一天收紅
function makeRows({ lastOpen, lastClose, lastLow, vol = 20000 } = {}) {
  const rows = [];
  let p = 50;
  for (let i = 0; i < 75; i++) {
    if (i < 65) p += 0.3;
    else p -= 0.25;
    const d = new Date(Date.UTC(2026, 7, 1) + i * 86400000).toISOString().slice(0, 10);
    rows.push({ date: d, open: p - 0.1, high: p + 0.4, low: p - 0.4, close: p, volume: vol });
  }
  const last = rows.at(-1);
  if (lastOpen != null) last.open = lastOpen;
  if (lastClose != null) last.close = lastClose;
  if (lastLow != null) last.low = lastLow;
  last.high = Math.max(last.high, last.close, last.open);
  return rows;
}

{
  const rows = makeRows();
  const m = computeSwingMetrics(rows);
  const closes = rows.map((r) => r.close);
  const ma20 = closes.slice(-20).reduce((a, b) => a + b) / 20;
  check("ma20 計算正確", Math.abs(m.ma20 - Math.round(ma20 * 100) / 100) < 1e-9);
  check("上升 60 日線且站上 → trend", m.trend === true && m.ma60Up === true);
  check("20 日均成交金額（收盤 × 張 × 1000）", Math.abs(m.turnover20e8 - Math.round(((closes.slice(-20).reduce((a, b) => a + b) / 20) * 20000 * 1000 / 1e8) * 100) / 100) < 0.011);
}
{
  // 最後一天：低點碰 20 日線、收紅
  const base = makeRows();
  const ma20 = base.map((r) => r.close).slice(-20).reduce((a, b) => a + b) / 20;
  const rows = makeRows({ lastOpen: ma20 - 0.2, lastClose: ma20 + 0.3, lastLow: ma20 - 0.5 });
  const m = computeSwingMetrics(rows, { totalCapital: 250000 });
  check("拉回形態成立", m.pullShape === true && m.setup && m.setup.type === "pull");
  const h = rows.at(-1).high;
  check("觸發價＝最高＋1 檔", m.setup.trigger === Math.round((h + tick(h)) * 100) / 100);
  const low5 = Math.min(...rows.slice(-5).map((r) => r.low));
  check("停損取較高者", m.setup.stop >= Math.round((low5 - tick(low5)) * 100) / 100 - 1e-9);
  check("股數不超過 1% 風險與 20% 上限", m.setup.qty * m.setup.R <= 2500 + 1e-6 && m.setup.qty * m.setup.trigger <= 50000 + 1e-6);
  check("流動性足夠 → valid", m.setup.valid === true);
  const thin = computeSwingMetrics(makeRows({ lastOpen: ma20 - 0.2, lastClose: ma20 + 0.3, lastLow: ma20 - 0.5, vol: 10 }));
  check("流動性不足 → 標示原因", thin.setup && thin.setup.valid === false && thin.setup.rejectedBy.includes("流動性不足"));
  const black = computeSwingMetrics(makeRows({ lastOpen: ma20 + 0.6, lastClose: ma20 + 0.3, lastLow: ma20 - 0.5 }));
  check("收黑 → 沒有設定", black.pullShape === false && black.setup === null);
}
check("資料不足 70 根 → ok false", computeSwingMetrics(makeRows().slice(-60)).ok === false);
{
  const up = makeRows().map((r, i) => ({ ...r, close: 1000 + i * 10 }));
  const f = computeMarketFilter(up);
  check("多頭排列 → 濾網成立", f.filterOk === true && f.aboveMa20 && f.ma20AboveMa60);
  const down = makeRows().map((r, i) => ({ ...r, close: 2000 - i * 10 }));
  const g = computeMarketFilter(down);
  check("空頭 → 濾網不成立，差距為負", g.filterOk === false && g.closeVsMa20Pct < 0 && g.ma20VsMa60Pct < 0);
}
{
  const calls = [];
  const fetchDaily = async (s, days) => {
    calls.push([s, days]);
    if (s === "9999") throw new Error("查無資料");
    const rows = s === "IX0001" ? makeRows().map((r, i) => ({ ...r, close: 1000 + i })) : makeRows();
    return { candles: rows.slice().reverse() }; // 工具回傳新到舊
  };
  const r = await scanSwing({ symbols: ["2330", "9999", "2330"], holdings: ["2330"] }, fetchDaily);
  check("去重、含指數、每檔 75 日", calls.length === 3 && calls.every(([, d]) => d === 75) && calls.some(([s]) => s === "IX0001"));
  check("失敗的代號列在 failed", r.failed?.length === 1 && r.failed[0].symbol === "9999" && r.counts.ok === 1);
  check("每檔一行 csv", r.rows.split("\n").length === 1 && r.rows.startsWith("2330,") && r.columns.startsWith("symbol,date"));
  check("market 回傳濾網", r.market.ok && typeof r.market.filterOk === "boolean");
  const r2 = await scanSwing({ symbols: ["2330"], includeIndex: false }, fetchDaily);
  check("includeIndex=false 不算指數", r2.market === null);
  check("超過 25 檔 → 錯誤", await throwsAsync(() => scanSwing({ symbols: Array.from({ length: SCAN_MAX_SYMBOLS + 1 }, (_, i) => String(1100 + i)) }, fetchDaily)));
  check("代號格式錯誤 → 錯誤", await throwsAsync(() => scanSwing({ symbols: ["abc!"] }, fetchDaily)));
}

if (failed) { console.log(`${failed} scan tests failed`); process.exit(1); }
console.log("all scan tests passed");
