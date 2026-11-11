import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  addDaysToDate,
  type DateString,
  lastWeekdayBefore,
  localDateOf,
  WEEKDAYS,
  weekdayOfDate,
} from '../util/time.js';

export type Role = 'user' | 'assistant';

export interface StoredMessage {
  id: number;
  sessionId: string;
  role: Role;
  content: string;
  /** UTC instant, ISO-8601 (`...Z`) — lexicographic order == chronological order. */
  createdAt: string;
  /** Calendar date in the user's time zone. The index every temporal query hits. */
  localDate: DateString;
  dayOfWeek: string;
  metadata: Record<string, unknown>;
}

export interface NewMessage {
  sessionId: string;
  role: Role;
  content: string;
  /** Defaults to "now". Seeds and tests pass explicit instants. */
  createdAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface QueryOptions {
  role?: Role;
  limit?: number;
  /** Exclude one session (used to look at *earlier* conversations only). */
  excludeSessionId?: string;
}

interface MessageRow {
  id: number;
  session_id: string;
  role: Role;
  content: string;
  created_at: string;
  local_date: string;
  day_of_week: string;
  metadata: string;
}

const DEFAULT_LIMIT = 50;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT    NOT NULL,
  role        TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT    NOT NULL,
  created_at  TEXT    NOT NULL,              -- ISO-8601 UTC instant
  local_date  TEXT    NOT NULL,              -- YYYY-MM-DD in the user's time zone
  day_of_week TEXT    NOT NULL,              -- 'Monday' ... 'Sunday'
  metadata    TEXT    NOT NULL DEFAULT '{}'  -- JSON
);
CREATE INDEX IF NOT EXISTS idx_messages_local_date ON messages (local_date, id);
CREATE INDEX IF NOT EXISTS idx_messages_session    ON messages (session_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_dow        ON messages (day_of_week, local_date);
-- Idempotent fixtures: a seed row is identified by metadata.seedKey and can only be inserted once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_seed_key
  ON messages (json_extract(metadata, '$.seedKey'))
  WHERE json_extract(metadata, '$.seedKey') IS NOT NULL;
`;

/**
 * Relational conversation memory.
 *
 * Temporal questions ("on 3 November", "last Tuesday", "since Monday") are *calendar* questions,
 * so they are answered with indexed equality / range predicates on `local_date` — exact,
 * explainable and sub-millisecond — rather than approximate similarity search.
 */
export class MemoryStore {
  private readonly db: Database.Database;

  constructor(
    dbPath: string,
    private readonly timeZone: string,
  ) {
    if (dbPath !== ':memory:') mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);
  }

  // ───────────────────────────── writes ─────────────────────────────

  /** Inserts a message. Returns `null` if it was an already-present seed row. */
  append(message: NewMessage): StoredMessage | null {
    const createdAt = message.createdAt ?? new Date();
    const localDate = localDateOf(createdAt, this.timeZone);
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages
           (session_id, role, content, created_at, local_date, day_of_week, metadata)
         VALUES (@sessionId, @role, @content, @createdAt, @localDate, @dayOfWeek, @metadata)`,
      )
      .run({
        sessionId: message.sessionId,
        role: message.role,
        content: message.content,
        createdAt: createdAt.toISOString(),
        localDate,
        dayOfWeek: weekdayOfDate(localDate),
        metadata: JSON.stringify(message.metadata ?? {}),
      });
    if (result.changes === 0) return null;
    return this.getById(Number(result.lastInsertRowid));
  }

  // ───────────────────────── temporal retrieval ─────────────────────

  /** Every turn on one exact calendar date. */
  getByDate(date: DateString, options: QueryOptions = {}): StoredMessage[] {
    return this.getByRange(date, date, options);
  }

  /** Every turn between two calendar dates, inclusive on both ends. */
  getByRange(start: DateString, end: DateString, options: QueryOptions = {}): StoredMessage[] {
    const [from, to] = start <= end ? [start, end] : [end, start];
    return this.query('local_date BETWEEN @from AND @to', { from, to }, options);
  }

  /** "N days ago", resolved against `today`. */
  getByRelativeDays(daysAgo: number, today: DateString, options: QueryOptions = {}): StoredMessage[] {
    return this.getByDate(addDaysToDate(today, -daysAgo), options);
  }

  /**
   * "Last Tuesday" style lookups: the `weeksBack`-th most recent `weekday` strictly before `today`.
   * `weekday` accepts a name ("Tuesday") or an index (0 = Sunday).
   */
  getByWeekdayOffset(
    weekday: string | number,
    today: DateString,
    weeksBack = 1,
    options: QueryOptions = {},
  ): StoredMessage[] {
    const index =
      typeof weekday === 'number'
        ? weekday
        : WEEKDAYS.findIndex((w) => w.toLowerCase() === weekday.toLowerCase());
    if (index < 0 || index > 6) throw new RangeError(`Unknown weekday: ${String(weekday)}`);
    return this.getByDate(lastWeekdayBefore(today, index, weeksBack), options);
  }

  // ───────────────────────── session & fallback retrieval ───────────

  /** The last `limit` turns of one session, oldest first. */
  getBySession(sessionId: string, limit = 20): StoredMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?')
      .all(sessionId, limit) as MessageRow[];
    return rows.reverse().map(toMessage);
  }

  /** Most recent turns across all sessions, oldest first. */
  getRecent(limit = 10, options: QueryOptions = {}): StoredMessage[] {
    const exclude = options.excludeSessionId;
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
          WHERE (@exclude IS NULL OR session_id != @exclude)
            AND (@role IS NULL OR role = @role)
          ORDER BY id DESC LIMIT @limit`,
      )
      .all({ exclude: exclude ?? null, role: options.role ?? null, limit }) as MessageRow[];
    return rows.reverse().map(toMessage);
  }

  /** Plain substring match, used only as a bounded topical fallback. */
  searchText(term: string, limit = 10): StoredMessage[] {
    const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE content LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?`,
      )
      .all(`%${escaped}%`, limit) as MessageRow[];
    return rows.reverse().map(toMessage);
  }

  /** Dates that have stored turns (newest first) — lets the agent say "nothing on X, but there is Y". */
  listActiveDates(limit = 14): Array<{ date: DateString; dayOfWeek: string; turns: number }> {
    const rows = this.db
      .prepare(
        `SELECT local_date AS date, day_of_week AS dayOfWeek, COUNT(*) AS turns
           FROM messages GROUP BY local_date ORDER BY local_date DESC LIMIT ?`,
      )
      .all(limit) as Array<{ date: string; dayOfWeek: string; turns: number }>;
    return rows;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }

  // ───────────────────────────── internals ──────────────────────────

  private getById(id: number): StoredMessage | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
    return row ? toMessage(row) : null;
  }

  private query(
    where: string,
    params: Record<string, string | number>,
    options: QueryOptions,
  ): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
          WHERE ${where}
            AND (@role IS NULL OR role = @role)
            AND (@exclude IS NULL OR session_id != @exclude)
          ORDER BY created_at ASC, id ASC
          LIMIT @limit`,
      )
      .all({
        ...params,
        role: options.role ?? null,
        exclude: options.excludeSessionId ?? null,
        limit: options.limit ?? DEFAULT_LIMIT,
      }) as MessageRow[];
    return rows.map(toMessage);
  }
}

function toMessage(row: MessageRow): StoredMessage {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.metadata);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      metadata = parsed as Record<string, unknown>;
    }
  } catch {
    /* corrupt metadata must never break retrieval */
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    localDate: row.local_date,
    dayOfWeek: row.day_of_week,
    metadata,
  };
}
