/**
 * 重大事件推播（announce_market_events）
 *
 * 晨報每天搜尋當天／本週的重大國際事件（峰會、央行、關稅與晶片管制、兩岸與地緣政治、
 * 重要財報），有事件時用這個工具推到 Telegram。內容是公開資訊，可以送頻道；
 * 欄位不收部位、股數、成本或金額。
 */

const IMPACT = { high: "🔴", medium: "🟠", low: "⚪" };

function str(v, max) {
  return v == null ? "" : String(v).trim().slice(0, max);
}

function mdOf(date) {
  const d = new Date(`${date}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${"日一二三四五六"[d.getUTCDay()]}）`;
}

// 個資保護：拒絕看起來像部位資訊的內容（股數、成本、損益金額）
const PRIVATE_RE = /(\d[\d,]*\s*股(?!價|東|市|票|利|息|本))|成本|均價|未實現|損益\s*[+-]?\d|持股\s*\d/;

export function validateEventsMessage(input) {
  const date = String(input?.date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date 必須是 YYYY-MM-DD（台北日期）");
  const events = Array.isArray(input?.events) ? input.events : [];
  if (!events.length) throw new Error("events 至少要有一筆（沒有重大事件就不需要推播）");
  if (events.length > 8) throw new Error("events 一次最多 8 筆");
  const out = {
    date,
    headline: str(input?.headline, 80),
    note: str(input?.note, 200),
    privateOnly: input?.privateOnly === true,
    events: events.map((e, i) => {
      const title = str(e?.title, 60);
      if (!title) throw new Error(`events[${i}].title 必填`);
      const when = str(e?.when, 40);
      if (e?.date && !/^\d{4}-\d{2}-\d{2}$/.test(String(e.date))) throw new Error(`events[${i}].date 必須是 YYYY-MM-DD`);
      return {
        date: e?.date ? String(e.date) : null,
        when,
        title,
        impact: IMPACT[e?.impact] ? e.impact : "medium",
        topics: (Array.isArray(e?.topics) ? e.topics : []).map((t) => str(t, 20)).filter(Boolean).slice(0, 6),
        detail: str(e?.detail, 200),
        watch: str(e?.watch, 160),
        source: str(e?.source, 40),
      };
    }),
  };
  const all = [out.headline, out.note, ...out.events.flatMap((e) => [e.title, e.detail, e.watch])].join(" ");
  if (PRIVATE_RE.test(all)) throw new Error("內容看起來含有部位、股數、成本或損益，重大事件推播可能送到公開頻道，請移除");
  return out;
}

const lines = (s) => String(s || "").split(/[；;。\n]+/).map((t) => t.trim()).filter(Boolean);

export function formatEventsMessage(m) {
  const out = [`🌏 ${mdOf(m.date)} 重大事件提醒`];
  if (m.headline) out.push(m.headline);
  for (const e of m.events) {
    out.push("", "━━━━━━━━━━", `${IMPACT[e.impact]} ${e.title}`);
    const when = [e.date && e.date !== m.date ? mdOf(e.date) : null, e.when].filter(Boolean).join(" ");
    if (when) out.push(`🕒 ${when}`);
    if (e.topics.length) out.push(`議題：${e.topics.join("、")}`);
    out.push(...lines(e.detail).map((t) => `· ${t}`));
    if (e.watch) out.push(`留意：${e.watch}`);
    if (e.source) out.push(`來源：${e.source}`);
  }
  if (m.note) out.push("", ...lines(m.note).map((t) => `· ${t}`));
  out.push("", "⚠️ 公開資訊整理，結果未出前不預測方向，不是買賣建議。");
  const text = out.join("\n");
  return text.length > 4000 ? text.slice(0, 3990) + "\n…（過長截斷）" : text;
}
