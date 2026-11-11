import {
  addDays,
  addMonths,
  addWeeks,
  addYears,
  endOfMonth,
  format,
  isValid,
  parseISO,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import { type DateString, type NowInfo, WEEKDAYS, weekdayOfDate } from '../util/time.js';

/**
 * Deterministic temporal planner.
 *
 * No LLM is involved: relative expressions ("last Tuesday", "3 days ago", "3 November") are resolved
 * to exact ISO calendar dates with plain date arithmetic, so the same input always yields the same
 * plan, it costs ~0 ms, and it can be unit-tested. The model receives *resolved* dates; it is never
 * asked to do calendar maths.
 */

export type ReferenceKind = 'day' | 'range';
export type Relation = 'past' | 'today' | 'future';

export interface ResolvedReference {
  /** The text the user wrote, lower-cased. */
  phrase: string;
  kind: ReferenceKind;
  /** Inclusive calendar dates. For `day`, start === end. */
  start: DateString;
  end: DateString;
  /** Human-readable, e.g. "Monday 2026-11-09". */
  label: string;
  relation: Relation;
}

export type SearchPolicy = 'required' | 'auto' | 'none';

export interface SearchWindow {
  /** First day that counts as "new". `null` when the user gave no anchor. */
  since: DateString | null;
  until: DateString;
  /** Month-year tokens to bias queries toward fresh pages, e.g. ["November 2026"]. */
  freshnessTerms: string[];
}

export interface TemporalPlan {
  input: string;
  now: NowInfo;
  references: ResolvedReference[];
  /** Earliest past date the user refers to — the baseline for "has anything changed since then?". */
  anchorDate: DateString | null;
  cues: { recall: boolean; since: boolean; freshness: boolean };
  searchPolicy: SearchPolicy;
  searchWindow: SearchWindow | null;
}

/* ───────────────────────────── vocabulary ───────────────────────────── */

const MONTH_PATTERN =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WEEKDAY_PATTERN = '(sunday|monday|tuesday|wednesday|thursday|friday|saturday)';
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
const NUMBER_PATTERN = `(\\d{1,3}|${Object.keys(NUMBER_WORDS).join('|')})`;

const monthIndex = (token: string): number =>
  ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(
    token.slice(0, 3).toLowerCase(),
  );

const fmt = (d: Date): DateString => format(d, 'yyyy-MM-dd');
const parse = (s: DateString): Date => parseISO(s);

function relationOf(start: DateString, end: DateString, today: DateString): Relation {
  if (start > today) return 'future';
  if (end < today) return 'past';
  return start === today && end === today ? 'today' : 'past';
}

function makeDay(phrase: string, date: DateString, today: DateString): ResolvedReference {
  return {
    phrase,
    kind: 'day',
    start: date,
    end: date,
    label: `${weekdayOfDate(date)} ${date}`,
    relation: relationOf(date, date, today),
  };
}

function makeRange(phrase: string, start: DateString, end: DateString, today: DateString): ResolvedReference {
  return {
    phrase,
    kind: 'range',
    start,
    end,
    label: `${start} to ${end}`,
    relation: relationOf(start, end, today),
  };
}

/** Builds a calendar date, rejecting impossible ones like 31 February. */
function buildDate(year: number, month0: number, day: number): DateString | null {
  const d = new Date(year, month0, day);
  if (!isValid(d) || d.getFullYear() !== year || d.getMonth() !== month0 || d.getDate() !== day) return null;
  return fmt(d);
}

/** A year-less "3 November" means its most recent occurrence that is not in the future. */
function inferYear(month0: number, day: number, today: DateString): DateString | null {
  const thisYear = parse(today).getFullYear();
  const candidate = buildDate(thisYear, month0, day);
  if (!candidate) return null;
  return candidate > today ? buildDate(thisYear - 1, month0, day) : candidate;
}

/* ────────────────────────── reference extraction ───────────────────────── */

interface Rule {
  re: RegExp;
  resolve: (m: RegExpExecArray, today: DateString) => ResolvedReference | null;
}

const RULES: Rule[] = [
  // 2026-11-03
  {
    re: /\b(\d{4})-(\d{2})-(\d{2})\b/g,
    resolve: (m, today) => {
      const date = buildDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return date ? makeDay(m[0], date, today) : null;
    },
  },
  // 03/11/2026 — day-first (DD/MM/YYYY), the convention used in the challenge brief ("3 November")
  {
    re: /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/g,
    resolve: (m, today) => {
      const date = buildDate(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
      return date ? makeDay(m[0], date, today) : null;
    },
  },
  // 3 November [2026] / 3rd of Nov
  {
    re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_PATTERN}\\b(?:,?\\s+(\\d{4})\\b)?`, 'g'),
    resolve: (m, today) => {
      const day = Number(m[1]);
      const month0 = monthIndex(m[2] ?? '');
      const date = m[3] ? buildDate(Number(m[3]), month0, day) : inferYear(month0, day, today);
      return date ? makeDay(m[0], date, today) : null;
    },
  },
  // November 3[, 2026]
  {
    re: new RegExp(`\\b${MONTH_PATTERN}\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4})\\b)?`, 'g'),
    resolve: (m, today) => {
      const day = Number(m[2]);
      const month0 = monthIndex(m[1] ?? '');
      const date = m[3] ? buildDate(Number(m[3]), month0, day) : inferYear(month0, day, today);
      return date ? makeDay(m[0], date, today) : null;
    },
  },
  // 3 days ago / a week ago / two months ago
  {
    re: new RegExp(`\\b${NUMBER_PATTERN}\\s+(day|week|month|year)s?\\s+ago\\b`, 'g'),
    resolve: (m, today) => {
      const raw = (m[1] ?? '').toLowerCase();
      const n = NUMBER_WORDS[raw] ?? Number(raw);
      const base = parse(today);
      const unit = m[2];
      const target =
        unit === 'day' ? addDays(base, -n) : unit === 'week' ? addWeeks(base, -n) : unit === 'month' ? addMonths(base, -n) : addYears(base, -n);
      return makeDay(m[0], fmt(target), today);
    },
  },
  {
    re: /\bthe day before yesterday\b/g,
    resolve: (m, today) => makeDay(m[0], fmt(addDays(parse(today), -2)), today),
  },
  { re: /\byesterday\b/g, resolve: (m, today) => makeDay(m[0], fmt(addDays(parse(today), -1)), today) },
  { re: /\btoday\b/g, resolve: (m, today) => makeDay(m[0], today, today) },
  // last week / this week  (ISO weeks: Monday → Sunday)
  {
    re: /\b(last|previous|this)\s+week\b/g,
    resolve: (m, today) => {
      const monday = startOfWeek(parse(today), { weekStartsOn: 1 });
      if (m[1] === 'this') return makeRange(m[0], fmt(monday), today, today);
      const lastMonday = addWeeks(monday, -1);
      return makeRange(m[0], fmt(lastMonday), fmt(addDays(lastMonday, 6)), today);
    },
  },
  // last month / this month
  {
    re: /\b(last|previous|this)\s+month\b/g,
    resolve: (m, today) => {
      const base = parse(today);
      if (m[1] === 'this') return makeRange(m[0], fmt(startOfMonth(base)), today, today);
      const prev = addMonths(base, -1);
      return makeRange(m[0], fmt(startOfMonth(prev)), fmt(endOfMonth(prev)), today);
    },
  },
  // [last|this|next] [on] Monday   (negative lookahead: "monday.com" is a CRM, not a day)
  {
    re: new RegExp(`\\b(?:(last|previous|this|next)\\s+)?(?:on\\s+)?${WEEKDAY_PATTERN}\\b(?!\\.com)`, 'g'),
    resolve: (m, today) => {
      const modifier = m[1];
      const targetIdx = WEEKDAYS.findIndex((w) => w.toLowerCase() === m[2]);
      const base = parse(today);
      const todayIdx = base.getDay();
      let date: Date;
      if (modifier === 'next') {
        date = addDays(base, ((targetIdx - todayIdx + 7) % 7) || 7);
      } else if (modifier === 'this') {
        date = addDays(startOfWeek(base, { weekStartsOn: 1 }), (targetIdx + 6) % 7);
      } else {
        // "last Tuesday" and bare "Tuesday" (past tense in conversation): most recent one strictly before today.
        date = addDays(base, -(((todayIdx - targetIdx + 7) % 7) || 7));
      }
      return makeDay(m[0], fmt(date), today);
    },
  },
];

/**
 * Finds every resolvable date expression. Each matched span is blanked out before the next rule runs,
 * so "last Tuesday" is not re-read as a bare "Tuesday", and "3 November" is not re-read as "November 3".
 */
export function extractReferences(text: string, today: DateString): ResolvedReference[] {
  let masked = text.toLowerCase();
  const found: Array<{ index: number; ref: ResolvedReference }> = [];

  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    for (const m of [...masked.matchAll(re)] as RegExpExecArray[]) {
      const ref = rule.resolve(m, today);
      if (!ref) continue;
      found.push({ index: m.index ?? 0, ref });
      const start = m.index ?? 0;
      masked = masked.slice(0, start) + ' '.repeat(m[0].length) + masked.slice(start + m[0].length);
    }
  }
  return found.sort((a, b) => a.index - b.index).map((f) => f.ref);
}

/* ─────────────────────────────── intent cues ───────────────────────────── */

const RECALL_PATTERNS: RegExp[] = [
  /\b(what|which|when|did|do)\b[^?.!]*\b(i|we)\b[^?.!]*\b(ask|asked|say|said|tell|told|mention|mentioned|discuss|discussed|decide|decided|shortlist|shortlisted)\b/i,
  /\bremind me\b/i,
  /\bwhat (was|were) (my|our)\b/i,
  /\b(our|my) (last|previous|earlier) (chat|conversation|question|session)\b/i,
];

const FRESHNESS_RE =
  /\b(since|still|changed?|changes|changing|updated?|latest|newest|currently|up[- ]to[- ]date|as of|pricing|prices?|released?|shipped|ships?|launch(?:ed)?|announced?|news|deprecated|outdated|anything new|has any)\b/i;

const SINCE_RE = /\bsince\b/i;

export function detectCues(text: string): TemporalPlan['cues'] {
  return {
    recall: RECALL_PATTERNS.some((re) => re.test(text)),
    since: SINCE_RE.test(text),
    freshness: FRESHNESS_RE.test(text),
  };
}

/* ───────────────────────────────── planning ────────────────────────────── */

const monthYear = (date: DateString): string => format(parse(date), 'MMMM yyyy');

export function planTurn(input: string, now: NowInfo): TemporalPlan {
  const today = now.localDate;
  const references = extractReferences(input, today);
  const cues = detectCues(input);

  // The baseline for "what changed since…": the earliest past date the user mentioned.
  const pastStarts = references.filter((r) => r.relation === 'past').map((r) => r.start).sort();
  const anchorDate = pastStarts[0] ?? null;

  const searchPolicy: SearchPolicy = cues.freshness
    ? 'required'
    : cues.recall && references.length > 0
      ? 'none'
      : 'auto';

  const searchWindow: SearchWindow | null =
    searchPolicy === 'none'
      ? null
      : {
          since: anchorDate,
          until: today,
          freshnessTerms: [...new Set([...(anchorDate ? [monthYear(anchorDate)] : []), monthYear(today)])].slice(-2),
        };

  return { input, now, references, anchorDate, cues, searchPolicy, searchWindow };
}

/**
 * Final decision on whether the first model step must call the search tool.
 * A "required" search is pointless if the user referred to a date and memory holds nothing from it:
 * there is no earlier claim to verify, so let the model decide (usually: say so).
 */
export function decideSearchPolicy(plan: TemporalPlan, retrievedTurns: number): SearchPolicy {
  if (plan.searchPolicy === 'required' && plan.references.length > 0 && retrievedTurns === 0) return 'auto';
  return plan.searchPolicy;
}

/**
 * Deterministic query optimisation: when the question is about freshness and the model's query carries
 * no year, append the current month-year so engines rank recent pages first.
 */
export function enrichQuery(query: string, plan: TemporalPlan): string {
  if (!plan.searchWindow || !plan.cues.freshness) return query;
  if (/\b20\d{2}\b/.test(query)) return query;
  const term = plan.searchWindow.freshnessTerms.at(-1);
  return term ? `${query} ${term}` : query;
}

/** Compact one-line summary used by the CLI's transparency output. */
export function describeReferences(plan: TemporalPlan): string[] {
  return plan.references.map((r) => `"${r.phrase}" → ${r.label}`);
}

