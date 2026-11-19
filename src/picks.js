/**
 * 週選股推播（Telegram）
 *
 * 晨報用 MCP 工具 announce_weekly_picks 送出三種訊息：
 *   new_picks     星期一的新推薦（含完整進出場計畫）
 *   daily_alerts  每日檢查有觸發時（進場、停損、目標、看錯條件、接近停損）
 *   daily_status  每個交易日的進度（收盤、距停損／目標、法人連買賣），不論有沒有觸發
 *   weekly_review 星期五的進度、結算與累計戰績
 *
 * 推播會送到 TELEGRAM_CHAT_ID 的所有收件者（可能包含公開頻道），
 * 所以欄位刻意不收部位金額、股數、成本等個人資訊。
 */

const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 }));
const pctTxt = (n) => (n == null ? "—" : `${n > 0 ? "+" : ""}${Number(n).toFixed(2)}%`);
const CODE_RE = /^[0-9A-Z]{4,6}$/;

function str(v, max, field, required = false) {
  const s = v == null ? "" : String(v).trim();
  if (required && !s) throw new Error(`${field} 必填`);
  return s.slice(0, max);
}

function list(v, maxItems, maxLen) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, maxItems).map((x) => x.slice(0, maxLen));
}

function pos(v, field, required = false) {
  if (v == null || v === "") {
    if (required) throw new Error(`${field} 必填`);
    return null;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${field} 必須是正數`);
  return n;
}

function numOrNull(v, field) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${field} 必須是數字`);
  return n;
}

function code(v, field) {
  const c = String(v ?? "").trim().toUpperCase();
  if (!CODE_RE.test(c)) throw new Error(`${field} 股票代號格式錯誤：${v}`);
  return c;
}

function mdOf(date) {
  const d = new Date(`${date}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${"日一二三四五六"[d.getUTCDay()]}）`;
}

const TIER = { "mid-large": "中大型", "small-mid": "中小型" };
const ALERT = {
  entry: "✅ 進入進場區間",
  stop: "🔴 跌破停損",
  target: "🎯 觸及目標",
  invalidated: "⚠️ 看錯條件成立",
  nearStop: "⚠️ 接近停損",
};
const VERDICTS = ["成立", "部分成立", "失敗", "未進場"];
const THESIS = ["成立中", "動搖", "被推翻"];

export function validatePicksMessage(input) {
  const kind = input?.kind;
  if (!["new_picks", "daily_alerts", "daily_status", "weekly_review"].includes(kind)) {
    throw new Error("kind 只能是 new_picks／daily_alerts／daily_status／weekly_review");
  }
  const date = String(input?.date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date 必須是 YYYY-MM-DD（台北日期）");
  const base = {
    kind,
    date,
    week: str(input?.week, 12, "week"),
    strategyVersion: input?.strategyVersion == null ? null : parseInt(input.strategyVersion, 10) || null,
    note: str(input?.note, 300, "note"),
  };

  if (kind === "new_picks") {
    const picks = Array.isArray(input?.picks) ? input.picks : [];
    if (!picks.length) throw new Error("new_picks 至少要有一檔 picks");
    if (picks.length > 4) throw new Error("new_picks 一次最多 4 檔");
    base.picks = picks.map((p, i) => {
      const f = `picks[${i}]`;
      const out = {
        code: code(p?.code, `${f}.code`),
        name: str(p?.name, 20, `${f}.name`),
        tier: TIER[p?.tier] ? p.tier : null,
        thesisType: str(p?.thesisType, 12, `${f}.thesisType`),
        refPrice: pos(p?.refPrice, `${f}.refPrice`, true),
        entryLow: pos(p?.entryLow, `${f}.entryLow`, true),
        entryHigh: pos(p?.entryHigh, `${f}.entryHigh`, true),
        stop: pos(p?.stop, `${f}.stop`, true),
        target: pos(p?.target, `${f}.target`, true),
        horizon: str(p?.horizon, 20, `${f}.horizon`),
        settleBy: str(p?.settleBy, 10, `${f}.settleBy`),
        thesis: list(p?.thesis, 5, 160),
        risks: list(p?.risks, 3, 140),
        invalidatedIf: str(p?.invalidatedIf, 200, `${f}.invalidatedIf`),
      };
      if (out.entryLow > out.entryHigh) throw new Error(`${out.code} entryLow 不可高於 entryHigh`);
      if (out.stop >= out.entryLow) throw new Error(`${out.code} 停損 ${out.stop} 必須低於進場區間下緣 ${out.entryLow}`);
      if (out.target <= out.entryHigh) throw new Error(`${out.code} 目標 ${out.target} 必須高於進場區間上緣 ${out.entryHigh}`);
      if (out.settleBy && !/^\d{4}-\d{2}-\d{2}$/.test(out.settleBy)) throw new Error(`${out.code} settleBy 必須是 YYYY-MM-DD`);
      return out;
    });
  }

  if (kind === "daily_alerts") {
    const alerts = Array.isArray(input?.alerts) ? input.alerts : [];
    if (!alerts.length) throw new Error("daily_alerts 至少要有一筆 alerts（沒有觸發就不需要推播）");
    base.alerts = alerts.slice(0, 10).map((a, i) => {
      const f = `alerts[${i}]`;
      if (!ALERT[a?.type]) throw new Error(`${f}.type 只能是 entry／stop／target／invalidated／nearStop`);
      const s = a?.settlement;
      return {
        code: code(a?.code, `${f}.code`),
        name: str(a?.name, 20, `${f}.name`),
        type: a.type,
        close: pos(a?.close, `${f}.close`),
        note: str(a?.note, 200, `${f}.note`),
        settlement: s
          ? {
              verdict: VERDICTS.includes(s.verdict) ? s.verdict : null,
              planPnlPct: numOrNull(s.planPnlPct, `${f}.settlement.planPnlPct`),
            }
          : null,
      };
    });
  }

  if (kind === "daily_status") {
    const items = Array.isArray(input?.items) ? input.items : [];
    if (!items.length) throw new Error("daily_status 至少要有一檔 items（全部結算後就不需要推播）");
    base.items = items.slice(0, 10).map((x, i) => {
      const f = `items[${i}]`;
      const settleBy = str(x?.settleBy, 10, `${f}.settleBy`);
      if (settleBy && !/^\d{4}-\d{2}-\d{2}$/.test(settleBy)) throw new Error(`${f}.settleBy 必須是 YYYY-MM-DD`);
      const streak = (v) => (v == null || v === "" ? null : parseInt(v, 10) || 0);
      return {
        code: code(x?.code, `${f}.code`),
        name: str(x?.name, 20, `${f}.name`),
        lastPrice: pos(x?.lastPrice, `${f}.lastPrice`),
        changePct: numOrNull(x?.changePct, `${f}.changePct`),
        pctFromRef: numOrNull(x?.pctFromRef, `${f}.pctFromRef`),
        entryFilled: x?.entryFilled === true ? true : x?.entryFilled === false ? false : null,
        toStopPct: numOrNull(x?.toStopPct, `${f}.toStopPct`),
        toTargetPct: numOrNull(x?.toTargetPct, `${f}.toTargetPct`),
        foreignStreak: streak(x?.foreignStreak),
        trustStreak: streak(x?.trustStreak),
        thesisStatus: THESIS.includes(x?.thesisStatus) ? x.thesisStatus : null,
        settleBy,
        note: str(x?.note, 160, `${f}.note`),
      };
    });
  }

  if (kind === "weekly_review") {
    const items = Array.isArray(input?.items) ? input.items : [];
    base.items = items.slice(0, 10).map((x, i) => {
      const f = `items[${i}]`;
      const status = x?.status === "settled" ? "settled" : "open";
      return {
        code: code(x?.code, `${f}.code`),
        name: str(x?.name, 20, `${f}.name`),
        status,
        lastPrice: pos(x?.lastPrice, `${f}.lastPrice`),
        pctFromRef: numOrNull(x?.pctFromRef, `${f}.pctFromRef`),
        thesisStatus: THESIS.includes(x?.thesisStatus) ? x.thesisStatus : null,
        weeksLeft: x?.weeksLeft == null ? null : Math.max(0, parseInt(x.weeksLeft, 10) || 0),
        verdict: VERDICTS.includes(x?.verdict) ? x.verdict : null,
        planPnlPct: numOrNull(x?.planPnlPct, `${f}.planPnlPct`),
        early: x?.early === true,
        note: str(x?.note, 160, `${f}.note`),
      };
    });
    const r = input?.record;
    base.record = r
      ? {
          success: Math.max(0, parseInt(r.success, 10) || 0),
          partial: Math.max(0, parseInt(r.partial, 10) || 0),
          fail: Math.max(0, parseInt(r.fail, 10) || 0),
          noEntry: Math.max(0, parseInt(r.noEntry, 10) || 0),
          avgPnlPct: numOrNull(r.avgPnlPct, "record.avgPnlPct"),
          enteredCount: r.enteredCount == null ? null : Math.max(0, parseInt(r.enteredCount, 10) || 0),
        }
      : null;
    base.strategyNote = str(input?.strategyNote, 300, "strategyNote");
    if (!base.items.length && !base.record) throw new Error("weekly_review 需要 items 或 record");
  }
  return base;
}

function cut(text) {
  return text.length > 4000 ? text.slice(0, 3990) + "\n…（過長截斷）" : text; // Telegram 單則上限 4096 字
}

// 手機上一行約 18–22 個全形字，太長會在 Telegram 擠成一大塊。
// 晨報傳來的 note 常用「；」或「，」串很多事，這裡拆成一行一件。
const SEP = "━━━━━━━━━━";
function noteLines(note, bullet = "· ") {
  if (!note) return [];
  return String(note)
    .split(/[；;。\n]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => bullet + t);
}
const streakTxt = (label, n) => (n == null ? null : n === 0 ? `${label}無連續` : `${label}連 ${Math.abs(n)} ${n > 0 ? "買" : "賣"}`);
const join = (arr, sep = "　") => arr.filter(Boolean).join(sep);

export function formatPicksMessage(m) {
  const md = mdOf(m.date);
  const ver = m.strategyVersion ? `（策略 v${m.strategyVersion}）` : "";
  const lines = [];
  const block = (...rows) => lines.push("", SEP, ...rows.flat().filter((r) => r != null && r !== ""));

  if (m.kind === "new_picks") {
    lines.push(`📈 ${md} 本週選股${m.week ? ` ${m.week}` : ""}${ver}`);
    lines.push(...noteLines(m.note));
    m.picks.forEach((p, i) => {
      const mid = (p.entryLow + p.entryHigh) / 2;
      const stopPct = ((p.stop / mid - 1) * 100).toFixed(1);
      const tgtPct = ((p.target / mid - 1) * 100).toFixed(1);
      const tags = join([TIER[p.tier], p.thesisType], "・");
      block(
        `${i + 1}) ${p.code} ${p.name}`.trim(),
        tags || null,
        `基準價 ${fmt(p.refPrice)}`,
        `進場 ${fmt(p.entryLow)}–${fmt(p.entryHigh)}`,
        `停損 ${fmt(p.stop)}（${stopPct}%，收盤跌破）`,
        `目標 ${fmt(p.target)}（+${tgtPct}%）`,
        join([p.horizon ? `持有 ${p.horizon}` : null, p.settleBy ? `${mdOf(p.settleBy)}結算` : null]) || null,
        p.thesis.length ? ["", "看多理由", ...p.thesis.map((t) => `· ${t}`)] : [],
        p.risks.length ? ["", "風險", ...p.risks.map((t) => `· ${t}`)] : [],
        p.invalidatedIf ? ["", "看錯條件", `· ${p.invalidatedIf}`] : [],
      );
    });
    lines.push("", "之後每個交易日檢查，觸發時會再通知。", "⚠️ 2–6 週的波段計畫，不是買賣建議。");
    return cut(lines.join("\n"));
  }

  if (m.kind === "daily_alerts") {
    lines.push(`🔔 ${md} 週選股觸發通知`);
    lines.push(...noteLines(m.note));
    for (const a of m.alerts) {
      const settled = a.settlement
        ? `已提前結算：${a.settlement.verdict ?? "—"}${a.settlement.planPnlPct != null ? `，照計畫 ${pctTxt(a.settlement.planPnlPct)}` : "（未進場）"}`
        : null;
      block(ALERT[a.type], `${a.code} ${a.name}`.trim(), a.close != null ? `收盤 ${fmt(a.close)}` : null, noteLines(a.note), settled);
    }
    lines.push("", "⚠️ 週選股計畫的條件通知，不是買賣建議。");
    return cut(lines.join("\n"));
  }

  if (m.kind === "daily_status") {
    lines.push(`📋 ${md} 週選股每日進度`);
    lines.push(...noteLines(m.note));
    for (const x of m.items) {
      block(
        `${x.code} ${x.name}`.trim(),
        x.lastPrice != null ? `收盤 ${fmt(x.lastPrice)}${x.changePct != null ? `（${pctTxt(x.changePct)}）` : ""}` : null,
        join([x.entryFilled == null ? null : x.entryFilled ? "已進場" : "未進場", x.thesisStatus ? `理由${x.thesisStatus}` : null]) || null,
        join([x.toStopPct != null ? `距停損 ${pctTxt(x.toStopPct)}` : null, x.toTargetPct != null ? `距目標 ${pctTxt(x.toTargetPct)}` : null]) || null,
        x.pctFromRef != null ? `相對基準 ${pctTxt(x.pctFromRef)}` : null,
        join([streakTxt("外資", x.foreignStreak), streakTxt("投信", x.trustStreak)]) || null,
        x.settleBy ? `${mdOf(x.settleBy)}結算` : null,
        noteLines(x.note),
      );
    }
    lines.push("", "⚠️ 週選股計畫的每日追蹤，不是買賣建議。");
    return cut(lines.join("\n"));
  }

  // weekly_review
  lines.push(`📊 ${md} 週選股週報${ver}`);
  lines.push(...noteLines(m.note));
  const open = m.items.filter((x) => x.status === "open");
  const settled = m.items.filter((x) => x.status === "settled");
  for (const x of open) {
    block(
      `▶️ 進行中｜${x.code} ${x.name}`.trim(),
      x.lastPrice != null ? `收盤 ${fmt(x.lastPrice)}` : null,
      x.pctFromRef != null ? `相對基準 ${pctTxt(x.pctFromRef)}` : null,
      join([x.thesisStatus ? `理由${x.thesisStatus}` : null, x.weeksLeft != null ? (x.weeksLeft === 0 ? "本週結算" : `距結算 ${x.weeksLeft} 週`) : null]) || null,
      noteLines(x.note),
    );
  }
  for (const x of settled) {
    block(
      `🏁 已結算｜${x.code} ${x.name}`.trim(),
      `${x.verdict ?? "—"}${x.early ? "（提前結算）" : ""}`,
      x.planPnlPct != null ? `照計畫 ${pctTxt(x.planPnlPct)}` : "未進場",
      noteLines(x.note),
    );
  }
  if (m.record) {
    const r = m.record;
    const total = r.success + r.partial + r.fail + r.noEntry;
    block(
      "累計戰績",
      `成立 ${r.success}　部分成立 ${r.partial}`,
      `失敗 ${r.fail}　未進場 ${r.noEntry}`,
      r.avgPnlPct != null ? `有進場平均 ${pctTxt(r.avgPnlPct)}${r.enteredCount != null ? `（${r.enteredCount} 檔）` : ""}` : null,
      total < 10 ? "（樣本數仍小，不足以下結論）" : null,
    );
  }
  if (m.strategyNote) block("策略", ...noteLines(m.strategyNote));
  lines.push("", "⚠️ 週選股計畫的檢討紀錄，不是買賣建議。");
  return cut(lines.join("\n"));
}
