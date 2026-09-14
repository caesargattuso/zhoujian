'use strict';
/**
 * ISO-8601 周工具。本文件同时被主进程引用。
 * 周键格式：YYYY-Www，例如 2026-W37
 */

const DAY = 86400000;

/** 取某天所属的 ISO 周（周一为一周开始，周四定年份） */
function isoWeekOf(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;             // 周一=1 ... 周日=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);     // 挪到本周四
  const year = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((d - yearStart) / DAY + 1) / 7);
  return { year, week };
}

function pad2(n) { return String(n).padStart(2, '0'); }

/** Date -> "2026-W37" */
function weekKey(date = new Date()) { return keyOf(isoWeekOf(date)); }

function keyOf({ year, week }) { return `${year}-W${pad2(week)}`; }

/** "2026-W37" -> {year:2026, week:37}，非法返回 null */
function parseKey(key) {
  const m = /^(\d{4})-W(\d{2})$/.exec(String(key || ''));
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  return { year, week };
}

/**
 * 周键 -> 起止日期（本地时间，周一 00:00 ~ 周日 23:59:59）
 * 返回 {start: Date, end: Date}
 */
function rangeOf(key) {
  const p = parseKey(key);
  if (!p) return null;
  // 该年第 week 周的周一：先定位到第 week 个周四，再回退 3 天
  const yearStart = new Date(Date.UTC(p.year, 0, 1));
  // ISO 第 1 周的周四
  const firstThu = new Date(yearStart);
  firstThu.setUTCDate(1 + ((4 - (yearStart.getUTCDay() || 7)) + 7) % 7);
  const targetThu = new Date(firstThu.getTime() + (p.week - 1) * 7 * DAY);
  targetThu.setUTCDate(targetThu.getUTCDate() - 3); // 周一
  const start = new Date(targetThu.getUTCFullYear(), targetThu.getUTCMonth(), targetThu.getUTCDate(), 0, 0, 0, 0);
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

/** 周键偏移，delta 为周数 */
function shiftKey(key, delta) {
  const p = parseKey(key);
  if (!p) return key;
  const r = rangeOf(key);
  return weekKey(new Date(r.start.getTime() + delta * 7 * DAY + 12 * 3600000));
}

function fmtDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function fmtDot(d) { return `${d.getMonth() + 1}/${d.getDate()}`; }

/** 人类可读的周信息 */
function describe(key) {
  const r = rangeOf(key);
  const p = parseKey(key) || { year: 0, week: 0 };
  if (!r) return { key, title: key, range: '', start: '', end: '' };
  return {
    key,
    year: p.year,
    week: p.week,
    title: `${p.year} 年第 ${p.week} 周`,
    range: `${fmtDot(r.start)} – ${fmtDot(r.end)}`,
    start: fmtDate(r.start),
    end: fmtDate(r.end)
  };
}

/** 某年共有多少 ISO 周（用于"下一周"边界判断） */
function weeksInYear(year) {
  const d = new Date(Date.UTC(year, 11, 28));
  return isoWeekOf(d).week;
}

module.exports = { weekKey, keyOf, parseKey, rangeOf, shiftKey, describe, fmtDate, fmtDot, weeksInYear, isoWeekOf };
