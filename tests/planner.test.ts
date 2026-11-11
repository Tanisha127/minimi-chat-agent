import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideSearchPolicy, enrichQuery, extractReferences, planTurn } from '../src/agent/planner.js';
import { describeNow } from '../src/util/time.js';

// Tuesday 10 November 2026, 14:00 IST
const NOW = describeNow(new Date('2026-11-10T08:30:00Z'), 'Asia/Kolkata');
const TODAY = NOW.localDate;

test('now is resolved in the user time zone', () => {
  assert.equal(TODAY, '2026-11-10');
  assert.equal(NOW.weekday, 'Tuesday');
});

test('bare weekday = most recent one strictly before today', () => {
  const [ref] = extractReferences('On Monday we shortlisted 5 CRM tools', TODAY);
  assert.equal(ref?.start, '2026-11-09');
});

test('"last Tuesday" on a Tuesday is 7 days ago, not today', () => {
  const [ref] = extractReferences('Last Tuesday I asked you about Postgres hosting', TODAY);
  assert.equal(ref?.start, '2026-11-03');
  assert.equal(extractReferences('last tuesday', TODAY).length, 1);
});

test('explicit dates: "3 November", "November 3rd", ISO, DD/MM/YYYY', () => {
  for (const text of ['on 3 November', 'on November 3rd', 'on 2026-11-03', 'on 03/11/2026', 'on 3rd of Nov']) {
    assert.equal(extractReferences(text, TODAY)[0]?.start, '2026-11-03', text);
  }
});

test('year-less future dates roll back to the previous year', () => {
  assert.equal(extractReferences('on 25 December', TODAY)[0]?.start, '2025-12-25');
});

test('impossible dates are ignored', () => {
  assert.equal(extractReferences('on 31 February', TODAY).length, 0);
});

test('relative offsets', () => {
  assert.equal(extractReferences('3 days ago', TODAY)[0]?.start, '2026-11-07');
  assert.equal(extractReferences('two weeks ago', TODAY)[0]?.start, '2026-10-27');
  assert.equal(extractReferences('yesterday', TODAY)[0]?.start, '2026-11-09');
  assert.equal(extractReferences('the day before yesterday', TODAY)[0]?.start, '2026-11-08');
});

test('ranges: last week (Mon–Sun) and last month', () => {
  const week = extractReferences('what happened last week', TODAY)[0];
  assert.deepEqual([week?.start, week?.end], ['2026-11-02', '2026-11-08']);
  const month = extractReferences('last month', TODAY)[0];
  assert.deepEqual([month?.start, month?.end], ['2026-10-01', '2026-10-31']);
});

test('"monday.com" is a product, not a weekday', () => {
  assert.equal(extractReferences('compare monday.com and Pipedrive', TODAY).length, 0);
});

test('"last Tuesday" is not double-counted as a bare "Tuesday"', () => {
  assert.equal(extractReferences('Last Tuesday I asked about it', TODAY).length, 1);
});

test('brief case 1: CRM shortlist → search required, window starts Monday', () => {
  const plan = planTurn(
    'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
    NOW,
  );
  assert.equal(plan.anchorDate, '2026-11-09');
  assert.equal(plan.searchPolicy, 'required');
  assert.equal(plan.searchWindow?.since, '2026-11-09');
  assert.deepEqual(plan.searchWindow?.freshnessTerms, ['November 2026']);
});

test('brief case 2: pure recall needs no search, recall+"still correct today" does', () => {
  assert.equal(planTurn('What did I ask you on 3 November?', NOW).searchPolicy, 'none');
  const both = planTurn('What did I ask you on 3 November? Is your answer still correct today?', NOW);
  assert.equal(both.searchPolicy, 'required');
  assert.equal(both.anchorDate, '2026-11-03');
  assert.deepEqual(both.searchWindow?.freshnessTerms, ['November 2026']);
});

test('brief case 3: "last Tuesday … since then" anchors on 2026-11-03', () => {
  const plan = planTurn('Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?', NOW);
  assert.equal(plan.anchorDate, '2026-11-03');
  assert.equal(plan.searchPolicy, 'required');
  assert.ok(plan.cues.since);
});

test('"required" is downgraded when a referenced date has no stored turns', () => {
  const plan = planTurn('Has pricing changed since 3 November?', NOW);
  assert.equal(decideSearchPolicy(plan, 0), 'auto');
  assert.equal(decideSearchPolicy(plan, 2), 'required');
});

test('window spanning two months yields both freshness terms', () => {
  const plan = planTurn('Has anything changed since 28 October?', NOW);
  assert.deepEqual(plan.searchWindow?.freshnessTerms, ['October 2026', 'November 2026']);
});

test('enrichQuery appends month-year only for freshness questions without a year', () => {
  const plan = planTurn('Has HubSpot pricing changed since Monday?', NOW);
  assert.equal(enrichQuery('HubSpot pricing changes', plan), 'HubSpot pricing changes November 2026');
  assert.equal(enrichQuery('HubSpot pricing 2025', plan), 'HubSpot pricing 2025');
  assert.equal(enrichQuery('hello there', planTurn('hello there', NOW)), 'hello there');
});
