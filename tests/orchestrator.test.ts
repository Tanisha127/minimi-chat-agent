import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockLanguageModelV4 } from 'ai/test';
import { ChatAgent, toModelMessages } from '../src/agent/orchestrator.js';
import { MemoryStore } from '../src/memory/db.js';
import { seedDemoData } from '../src/memory/seed.js';
import { TavilyClient } from '../src/tools/search.js';

const TZ = 'Asia/Kolkata';
const NOW = new Date('2026-11-10T08:30:00Z'); // Tuesday 2026-11-10 14:00 IST

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }], finishReason: { unified: 'stop' as const, raw: undefined }, usage, warnings: [] };
}
function toolCallResult(input: object) {
  return {
    content: [{ type: 'tool-call' as const, toolCallId: 'call-1', toolName: 'web_search', input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls' as const, raw: undefined },
    usage,
    warnings: [],
  };
}

function setup(model: MockLanguageModelV4, fetchImpl?: typeof fetch) {
  const store = new MemoryStore(':memory:', TZ);
  seedDemoData(store, '2026-11-10', TZ);
  const events: string[] = [];
  const agent = new ChatAgent({
    store,
    model,
    search: fetchImpl ? new TavilyClient({ apiKey: 'k', fetchImpl }) : null,
    timeZone: TZ,
    maxSearchesPerTurn: 3,
    turnTimeoutMs: 10_000,
    clock: () => NOW,
    sessionId: 'test-session',
    events: {
      onSearchStart: ({ query, since }) => events.push(`search:${query}|${since}`),
      onNotice: (m) => events.push(`notice:${m}`),
    },
  });
  return { store, agent, events };
}

const tavily = (async () =>
  new Response(JSON.stringify({ results: [{ title: 'HubSpot pricing', url: 'https://hubspot.com/pricing', content: 'Plans and prices.' }] }), {
    status: 200,
  })) as typeof fetch;

test('freshness question: first step forces the tool, window + month-year are injected, answer is stored', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [toolCallResult({ query: 'HubSpot Sales Hub pricing changes' }), textResult('Nothing verified changed since Monday.')],
  });
  const { agent, events, store } = setup(model, tavily);

  const reply = await agent.respond('On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?');

  assert.equal(reply.text, 'Nothing verified changed since Monday.');
  assert.equal(reply.degraded, false);
  assert.equal(reply.retrievedTurns, 2); // Monday's seeded user + assistant turn
  assert.deepEqual(events, ['search:HubSpot Sales Hub pricing changes November 2026|2026-11-09']);

  const first = model.doGenerateCalls[0];
  assert.deepEqual(first?.toolChoice, { type: 'required' });
  const system = JSON.stringify(first?.prompt);
  assert.match(system, /Tuesday, 2026-11-10/);
  assert.match(system, /Monday 2026-11-09/);
  assert.match(system, /HubSpot Sales Hub/);

  const saved = store.getBySession('test-session', 10);
  assert.deepEqual(saved.map((m) => m.role), ['user', 'assistant']);
  assert.equal(saved[1]?.metadata.degraded, false);
});

test('pure recall question: tools are disabled on step 0 and memory answers it', async () => {
  const model = new MockLanguageModelV4({ doGenerate: [textResult('You asked about managed Postgres hosting.')] });
  const { agent } = setup(model, tavily);
  const reply = await agent.respond('What did I ask you on 3 November?');
  assert.equal(reply.searches.length, 0);
  assert.deepEqual(model.doGenerateCalls[0]?.toolChoice, { type: 'none' });
  assert.match(JSON.stringify(model.doGenerateCalls[0]?.prompt), /Neon/);
});

test('missing stored turns are called out explicitly', async () => {
  const model = new MockLanguageModelV4({ doGenerate: [textResult('Nothing stored for that day.')] });
  const { agent } = setup(model);
  await agent.respond('What did I ask you on 1 November?');
  assert.match(JSON.stringify(model.doGenerateCalls[0]?.prompt), /NO stored turns exist for/);
});

test('model outage degrades to a deterministic, memory-backed answer', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      throw new Error('provider down');
    },
  });
  const { agent, events } = setup(model);
  const reply = await agent.respond('What did I ask you on 3 November?');
  assert.equal(reply.degraded, true);
  assert.match(reply.text, /Postgres hosting/);
  assert.ok(events.some((e) => e.startsWith('notice:')));
});

test('search failure is surfaced to the model, not thrown', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [toolCallResult({ query: 'Pipedrive pricing' }), textResult('I could not verify current pricing.')],
  });
  const failing = (async () => new Response('{}', { status: 401 })) as typeof fetch;
  const { agent } = setup(model, failing);
  const reply = await agent.respond('Has Pipedrive pricing changed since Monday?');
  assert.equal(reply.degraded, false);
  assert.equal(reply.searches[0]?.status, 'error');
  assert.match(JSON.stringify(model.doGenerateCalls[1]?.prompt), /SEARCH FAILED/);
});

test('toModelMessages merges consecutive roles and drops degraded answers', () => {
  const base = { sessionId: 's', createdAt: '', localDate: '', dayOfWeek: '' };
  const out = toModelMessages([
    { ...base, id: 1, role: 'user', content: 'a', metadata: {} },
    { ...base, id: 2, role: 'assistant', content: 'x', metadata: { degraded: true } },
    { ...base, id: 3, role: 'user', content: 'b', metadata: {} },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.content, 'a\n\nb');
});
