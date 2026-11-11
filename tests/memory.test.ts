import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryStore } from '../src/memory/db.js';
import { buildSeedConversations, seedDemoData } from '../src/memory/seed.js';
import { localToUtc } from '../src/util/time.js';

const TZ = 'Asia/Kolkata';

function store(): MemoryStore {
  return new MemoryStore(':memory:', TZ);
}
const at = (date: string, time = '10:00'): Date => localToUtc(date, time, TZ);

test('stores ISO timestamp, local date and weekday', () => {
  const s = store();
  const m = s.append({ sessionId: 'a', role: 'user', content: 'hi', createdAt: at('2026-11-03', '00:30') });
  assert.equal(m?.localDate, '2026-11-03'); // 19:00 UTC on Nov 2 is already Nov 3 in IST
  assert.equal(m?.dayOfWeek, 'Tuesday');
  assert.match(m?.createdAt ?? '', /^2026-11-02T19:00:00\.000Z$/);
});

test('exact-date, range, relative-days and weekday-offset queries', () => {
  const s = store();
  s.append({ sessionId: 'a', role: 'user', content: 'tue', createdAt: at('2026-11-03') });
  s.append({ sessionId: 'a', role: 'user', content: 'mon', createdAt: at('2026-11-09') });
  s.append({ sessionId: 'b', role: 'user', content: 'today', createdAt: at('2026-11-10') });

  assert.deepEqual(s.getByDate('2026-11-03').map((m) => m.content), ['tue']);
  assert.deepEqual(s.getByRange('2026-11-03', '2026-11-09').map((m) => m.content), ['tue', 'mon']);
  assert.deepEqual(s.getByRelativeDays(1, '2026-11-10').map((m) => m.content), ['mon']);
  assert.deepEqual(s.getByWeekdayOffset('Tuesday', '2026-11-10').map((m) => m.content), ['tue']);
  assert.deepEqual(s.getByDate('2026-11-03', { excludeSessionId: 'a' }), []);
  assert.throws(() => s.getByWeekdayOffset('Funday', '2026-11-10'), RangeError);
});

test('session history is chronological and bounded', () => {
  const s = store();
  for (let i = 0; i < 5; i++) s.append({ sessionId: 'x', role: i % 2 ? 'assistant' : 'user', content: `m${i}` });
  assert.deepEqual(s.getBySession('x', 3).map((m) => m.content), ['m2', 'm3', 'm4']);
});

test('seeding is idempotent and produces the evaluator dates', () => {
  const s = store();
  const first = seedDemoData(s, '2026-11-10', TZ);
  assert.ok(first >= 6);
  assert.equal(seedDemoData(s, '2026-11-10', TZ), 0);
  assert.equal(s.getByDate('2026-11-03').length, 2); // 3 Nov / last Tuesday share one conversation
  assert.equal(s.getByDate('2026-11-09').length, 2); // Monday CRM shortlist
  assert.ok(s.getByDate('2026-11-09')[0]?.content.includes('HubSpot'));
});

test('seed fixtures never land on or after today', () => {
  for (const c of buildSeedConversations('2026-11-10')) assert.ok(c.date < '2026-11-10');
  for (const c of buildSeedConversations('2026-11-03')) assert.ok(c.date < '2026-11-03');
});

test('LIKE search escapes wildcards', () => {
  const s = store();
  s.append({ sessionId: 'a', role: 'user', content: '100% sure' });
  s.append({ sessionId: 'a', role: 'user', content: 'nothing' });
  assert.equal(s.searchText('%').length, 1);
});
