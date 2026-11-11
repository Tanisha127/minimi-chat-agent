import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatOutcome, TavilyClient, truncateSnippet, webSearch } from '../src/tools/search.js';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const noSleep = async (): Promise<void> => {};

test('truncateSnippet respects the limit and ends cleanly', () => {
  const long = 'Sentence one is here. '.repeat(100);
  const out = truncateSnippet(long, 100);
  assert.ok(out.length <= 101);
  assert.ok(out.endsWith('.') || out.endsWith('…'));
});

test('invalid input is rejected without a network call', async () => {
  let calls = 0;
  const client = new TavilyClient({ apiKey: 'k', fetchImpl: (async () => (calls++, json({}))) as typeof fetch });
  const out = await webSearch({ query: 'x' }, client);
  assert.equal(out.status, 'error');
  assert.equal(calls, 0);
});

test('missing API key degrades gracefully', async () => {
  const out = await webSearch({ query: 'hubspot pricing' }, null);
  assert.equal(out.status, 'error');
  assert.match(formatOutcome(out), /SEARCH FAILED/);
});

test('sends date window, parses results, dedupes URLs', async () => {
  let body: Record<string, unknown> = {};
  const client = new TavilyClient({
    apiKey: 'k',
    fetchImpl: (async (_u: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return json({
        results: [
          { title: 'A', url: 'https://x.com/a/', content: 'alpha', published_date: '2026-11-09T10:00:00Z' },
          { title: 'A again', url: 'https://x.com/a', content: 'dup' },
        ],
      });
    }) as typeof fetch,
  });
  const out = await webSearch({ query: 'hubspot pricing', since: '2026-11-09', until: '2026-11-10' }, client);
  assert.equal(body.start_date, '2026-11-09');
  assert.equal(body.end_date, '2026-11-10');
  assert.equal(out.status, 'ok');
  if (out.status === 'ok') {
    assert.equal(out.hits.length, 1);
    assert.equal(out.hits[0]?.publishedDate, '2026-11-09');
    assert.equal(out.windowRelaxed, false);
  }
});

test('empty dated window falls back to an un-windowed search and says so', async () => {
  let n = 0;
  const client = new TavilyClient({
    apiKey: 'k',
    fetchImpl: (async () => json({ results: n++ === 0 ? [] : [{ title: 'Old', url: 'https://y.com', content: 'older news' }] })) as typeof fetch,
  });
  const out = await webSearch({ query: 'pipedrive pricing', since: '2026-11-09' }, client);
  assert.equal(out.status, 'ok');
  assert.match(formatOutcome(out), /may PREDATE/);
});

test('retries transient 5xx once, then succeeds', async () => {
  let n = 0;
  const client = new TavilyClient({
    apiKey: 'k',
    sleep: noSleep,
    fetchImpl: (async () => (n++ === 0 ? json({}, 503) : json({ results: [{ title: 't', url: 'https://z.com', content: 'c' }] }))) as typeof fetch,
  });
  assert.equal((await webSearch({ query: 'neon postgres pricing' }, client)).status, 'ok');
  assert.equal(n, 2);
});

test('auth errors are not retried and mention the key', async () => {
  let n = 0;
  const client = new TavilyClient({ apiKey: 'bad', sleep: noSleep, fetchImpl: (async () => (n++, json({}, 401))) as typeof fetch });
  const out = await webSearch({ query: 'neon postgres pricing' }, client);
  assert.equal(out.status, 'error');
  assert.equal(n, 1);
  assert.match(formatOutcome(out), /TAVILY_API_KEY/);
});

test('timeouts surface as retryable errors', async () => {
  const client = new TavilyClient({
    apiKey: 'k',
    timeoutMs: 20,
    maxRetries: 0,
    // A ref'd timer stands in for the open socket a real fetch would hold (AbortSignal.timeout timers are unref'd).
    fetchImpl: ((_u: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        const keepAlive = setTimeout(() => rej(new Error('never aborted')), 2000);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(keepAlive);
          rej(new Error('aborted'));
        });
      })) as typeof fetch,
  });
  const out = await webSearch({ query: 'slow query here' }, client);
  assert.equal(out.status, 'error');
  if (out.status === 'error') assert.match(out.message, /timed out/);
});

test('totally empty results → status empty', async () => {
  const client = new TavilyClient({ apiKey: 'k', fetchImpl: (async () => json({ results: [] })) as typeof fetch });
  assert.equal((await webSearch({ query: 'nothing matches this' }, client)).status, 'empty');
});
