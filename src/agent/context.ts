import type { MemoryStore, StoredMessage } from '../memory/db.js';
import { localTimeOf } from '../util/time.js';
import type { TemporalPlan } from './planner.js';

export interface RetrievedMemory {
  /** Turns found on the dates the user referred to (deduplicated, chronological). */
  turns: StoredMessage[];
  /** References that resolved to a date with no stored turns. */
  emptyReferences: string[];
  /** Dates that do have stored turns — lets the agent say "nothing on X, but there is Y". */
  activeDates: Array<{ date: string; dayOfWeek: string; turns: number }>;
  /** Set when no explicit date was given and we fell back to recent earlier sessions. */
  usedRecentFallback: boolean;
}

const MAX_TURNS = 24;
const MAX_TURN_CHARS = 700;

/**
 * Memory lookup driven by the plan: every resolved date/range becomes an indexed SQL query.
 * The current session is excluded — it is already in the model's message history.
 */
export function retrieveMemory(store: MemoryStore, plan: TemporalPlan, sessionId: string): RetrievedMemory {
  const seen = new Set<number>();
  const turns: StoredMessage[] = [];
  const emptyReferences: string[] = [];

  for (const ref of plan.references) {
    if (ref.relation === 'future') continue;
    const found = store.getByRange(ref.start, ref.end, { excludeSessionId: sessionId, limit: MAX_TURNS });
    if (found.length === 0) emptyReferences.push(`${ref.phrase} (${ref.label})`);
    for (const msg of found) {
      if (!seen.has(msg.id)) {
        seen.add(msg.id);
        turns.push(msg);
      }
    }
  }

  let usedRecentFallback = false;
  const wantsMemory = plan.cues.recall || plan.cues.since;
  if (plan.references.length === 0 && wantsMemory) {
    usedRecentFallback = true;
    for (const msg of store.getRecent(8, { excludeSessionId: sessionId })) {
      if (!seen.has(msg.id)) {
        seen.add(msg.id);
        turns.push(msg);
      }
    }
  }

  turns.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id - b.id));
  return {
    turns: turns.slice(0, MAX_TURNS),
    emptyReferences,
    activeDates: store.listActiveDates(10),
    usedRecentFallback,
  };
}

export function formatTurn(msg: StoredMessage, timeZone: string): string {
  const time = localTimeOf(new Date(msg.createdAt), timeZone);
  const body = msg.content.length > MAX_TURN_CHARS ? `${msg.content.slice(0, MAX_TURN_CHARS).trimEnd()}…` : msg.content;
  return `[${msg.localDate} ${msg.dayOfWeek} ${time} · ${msg.role}] ${body}`;
}

/** The temporal + memory block injected into the system prompt. */
export function buildTemporalContext(plan: TemporalPlan, memory: RetrievedMemory): string {
  const { now } = plan;
  const lines: string[] = [
    `CURRENT DATE/TIME: ${now.weekday}, ${now.localDate} ${now.localTime} (${now.timeZone}). Treat this as "today" and "now".`,
  ];

  if (plan.references.length > 0) {
    lines.push('', 'DATE REFERENCES IN THE USER MESSAGE (already resolved — do not recompute):');
    for (const r of plan.references) lines.push(`- "${r.phrase}" = ${r.label} [${r.relation}]`);
  }
  if (plan.anchorDate) {
    lines.push(
      '',
      `CHANGE WINDOW: "since then" / "since <date>" means after ${plan.anchorDate} (${plan.anchorDate} → ${now.localDate}).`,
    );
  }

  lines.push('', 'STORED CONVERSATION TURNS FROM THOSE DATES (ground truth for what was said earlier):');
  if (memory.turns.length > 0) {
    if (memory.usedRecentFallback) lines.push('(no explicit date was given; these are the most recent earlier turns)');
    for (const msg of memory.turns) lines.push(formatTurn(msg, now.timeZone));
  } else {
    lines.push('(none)');
  }
  if (memory.emptyReferences.length > 0) {
    lines.push(
      '',
      `NO stored turns exist for: ${memory.emptyReferences.join('; ')}.`,
      'Say so plainly; do not guess what was discussed.',
    );
    if (memory.activeDates.length > 0) {
      lines.push(
        'Dates that DO have stored turns: ' +
          memory.activeDates.map((d) => `${d.date} (${d.dayOfWeek}, ${d.turns})`).join(', ') +
          '.',
      );
    }
  }

  if (plan.searchWindow) {
    const w = plan.searchWindow;
    lines.push(
      '',
      'SEARCH GUIDANCE:',
      `- Freshness window: ${w.since ?? 'no explicit start'} → ${w.until}. The web_search tool applies this window automatically.`,
      `- Put month/year tokens in queries to bias toward recent pages: ${w.freshnessTerms.join(' / ')}.`,
      '- Search for each named product/vendor separately when the question covers several (e.g. one query per CRM tool).',
    );
  }
  return lines.join('\n');
}

export const SYSTEM_PROMPT = `You are a precise, time-aware assistant. You have ONE tool, web_search, and a persistent conversation memory.

RULES
1. Time: the CURRENT DATE/TIME block below is authoritative. Never assume a date from your training data.
2. Memory: STORED CONVERSATION TURNS are what the user and you actually said on those dates. Quote or summarise them faithfully. If none exist for a requested date, say so — never invent a past conversation.
3. Changes over time: to answer "has X changed since <date>?" or "is your earlier answer still correct today?", (a) restate what was said earlier from the stored turns, (b) call web_search for current facts, (c) compare, and (d) report what is new, what is unchanged, and what you could not verify.
4. Evidence: base claims about the present on search results only. Cite sources as plain URLs and mention publish dates when they matter. If results predate the change window, or search returns nothing or fails, say that clearly — do not fabricate changes, prices or announcements. Prices and plans must come from results, never from memory.
5. Efficiency: prefer one focused query per entity; do not repeat a query; stop searching once you can answer. Answer directly, without searching, when the question is only about past conversation.
6. Style: concise, structured, no filler. Lead with the answer. Use short bullet lists for per-item findings. End with a one-line confidence/limits note when evidence is partial.`;

export function buildSystemPrompt(plan: TemporalPlan, memory: RetrievedMemory): string {
  return `${SYSTEM_PROMPT}\n\n${buildTemporalContext(plan, memory)}`;
}
