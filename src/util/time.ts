import { addDays, format, parseISO } from 'date-fns';

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** A calendar date as `YYYY-MM-DD`. All date arithmetic in the planner works on these strings. */
export type DateString = string;

export interface NowInfo {
  /** UTC instant, ISO-8601. */
  iso: string;
  /** Calendar date in the user's time zone. */
  localDate: DateString;
  weekday: string;
  /** `HH:mm` in the user's time zone. */
  localTime: string;
  timeZone: string;
}

export function resolveTimeZone(requested?: string): string {
  const system = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  if (!requested) return system;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: requested });
    return requested;
  } catch {
    return system;
  }
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

export function localDateOf(date: Date, timeZone: string): DateString {
  const p = zonedParts(date, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

export function localTimeOf(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** Weekday name of a pure calendar date (time-zone independent). */
export function weekdayOfDate(date: DateString): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? 'Sunday';
}

export function describeNow(date: Date, timeZone: string): NowInfo {
  const localDate = localDateOf(date, timeZone);
  return {
    iso: date.toISOString(),
    localDate,
    weekday: weekdayOfDate(localDate),
    localTime: localTimeOf(date, timeZone),
    timeZone,
  };
}

/** Offset (ms) such that `utc + offset = wall-clock time in the zone`. */
function offsetMs(utcMs: number, timeZone: string): number {
  const p = zonedParts(new Date(utcMs), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Converts a wall-clock date + `HH:mm` in `timeZone` to the corresponding UTC instant. */
export function localToUtc(date: DateString, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = offsetMs(guess, timeZone);
  let result = guess - first;
  const second = offsetMs(result, timeZone);
  if (second !== first) result = guess - second;
  return new Date(result);
}

export function addDaysToDate(date: DateString, days: number): DateString {
  return format(addDays(parseISO(date), days), 'yyyy-MM-dd');
}

/**
 * Most recent occurrence of `weekday` (0 = Sunday) strictly before `today`.
 * `weeksBack = 2` steps one further week into the past.
 */
export function lastWeekdayBefore(today: DateString, weekday: number, weeksBack = 1): DateString {
  const todayIdx = WEEKDAYS.indexOf(weekdayOfDate(today) as (typeof WEEKDAYS)[number]);
  const delta = ((todayIdx - weekday + 7) % 7 || 7) + 7 * (weeksBack - 1);
  return addDaysToDate(today, -delta);
}

export function isValidDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
