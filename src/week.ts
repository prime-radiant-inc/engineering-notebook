/**
 * Week math for weekly reports. Pure — no I/O, no clock access.
 *
 * Dates are `YYYY-MM-DD` strings and are treated as UTC noon internally to
 * sidestep daylight-saving edges. `startDay` is 0 (Sunday) through 6, and
 * defaults to 1 (Monday) so the default labelling matches ISO-8601.
 */

export type WeekRange = {
  /** ISO-style label, e.g. `2026-W31`. */
  label: string;
  /** First logical date of the week, inclusive. */
  start: string;
  /** Last logical date of the week, inclusive. */
  end: string;
};

const DAY_MS = 86_400_000;

function toDate(dateStr: string): Date {
  return new Date(dateStr + "T12:00:00Z");
}

function toStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function shift(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

/** Start of the week containing `date`, given a configurable first weekday. */
function weekStart(date: Date, startDay: number): Date {
  const delta = (date.getUTCDay() - startDay + 7) % 7;
  return shift(date, -delta);
}

/**
 * ISO-8601 week label. The week is numbered by the year containing its
 * Thursday, which is what makes 2026-01-01 fall in a week starting 2025-12-29.
 */
function isoLabel(start: Date): string {
  const thursday = shift(start, 3);
  const year = thursday.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1, 12));
  const week = Math.floor((thursday.getTime() - jan1.getTime()) / (7 * DAY_MS)) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function weekRangeForDate(date: string, startDay = 1): WeekRange {
  const start = weekStart(toDate(date), startDay);
  const end = shift(start, 6);
  return { label: isoLabel(start), start: toStr(start), end: toStr(end) };
}

export function weekRangeForLabel(label: string, startDay = 1): WeekRange {
  const m = /^(\d{4})-W(\d{2})$/.exec(label);
  if (!m) throw new Error(`Invalid week label "${label}" — expected YYYY-Www, e.g. 2026-W31`);
  const year = Number(m[1]);
  const week = Number(m[2]);

  // Anchor on the Thursday of ISO week 1, then step forward whole weeks.
  const jan4 = new Date(Date.UTC(year, 0, 4, 12));
  const week1Start = weekStart(jan4, startDay);
  const start = shift(week1Start, (week - 1) * 7);
  const end = shift(start, 6);
  return { label, start: toStr(start), end: toStr(end) };
}

export function lastCompletedWeek(today: string, startDay = 1): WeekRange {
  const thisWeek = weekRangeForDate(today, startDay);
  return weekRangeForDate(toStr(shift(toDate(thisWeek.start), -1)), startDay);
}

/** Monday of the week containing `date`. Kept for calendar.ts. */
export function weekMonday(date: string): string {
  return weekRangeForDate(date, 1).start;
}
