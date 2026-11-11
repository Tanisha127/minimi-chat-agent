import { generateText, isStepCount, type LanguageModel, type ModelMessage, tool } from 'ai';
import { z } from 'zod';
import type { MemoryStore, StoredMessage } from '../memory/db.js';
import {
  formatOutcome,
  type SearchOutcome,
  type TavilyClient,
  webSearch,
} from '../tools/search.js';
import { describeNow } from '../util/time.js';
import { buildSystemPrompt, formatTurn, type RetrievedMemory, retrieveMemory } from './context.js';
import {
  decideSearchPolicy,
  describeReferences,
  enrichQuery,
  planTurn,
  type SearchPolicy,
  type TemporalPlan,
} from './planner.js';

/* ───────────────────────────── public types ───────────────────────────── */

export interface AgentEvents {
  onPlan?(plan: TemporalPlan, policy: SearchPolicy): void;
  onMemory?(memory: RetrievedMemory): void;
  onSearchStart?(info: { query: string; since: string | undefined; attempt: number }): void;
  onSearchEnd?(outcome: SearchOutcome): void;
  onNotice?(message: string): void;
}

export interface SearchRecord {
  query: string;
  since: string | undefined;
  status: SearchOutcome['status'];
  resultCount: number;
}

export interface AgentReply {
  text: string;
  plan: TemporalPlan;
  retrievedTurns: number;
  searches: SearchRecord[];
  /** True when the answer was produced without the model (deterministic fallback). */
  degraded: boolean;
}

export interface AgentDeps {
  store: MemoryStore;
  model: LanguageModel;
  search: TavilyClient | null;
  timeZone: string;
  maxSearchesPerTurn: number;
  turnTimeoutMs: number;
  events?: AgentEvents;
  /** Injectable clock — tests and `NOW_OVERRIDE` pin time through this. */
  clock?: () => Date;
  sessionId: string;
}

const HISTORY_TURNS = 12;

/* ──────────────────────────────── agent ───────────────────────────────── */

export class ChatAgent {
  constructor(private readonly deps: AgentDeps) {}

  get sessionId(): string {
    return this.deps.sessionId;
  }

  /** Resolve → retrieve → decide → (search) → synthesise → persist. */
  async respond(userInput: string, signal?: AbortSignal): Promise<AgentReply> {
    const { store, events, timeZone } = this.deps;
    const now = describeNow((this.deps.clock ?? (() => new Date()))(), timeZone);

    // 1. Deterministic temporal resolution (no LLM).
    const plan = planTurn(userInput, now);

    // 2. Relational retrieval of the turns on the referenced dates — *before* logging this message.
    const memory = retrieveMemory(store, plan, this.sessionId);
    const policy = decideSearchPolicy(plan, memory.turns.length);
    events?.onPlan?.(plan, policy);
    events?.onMemory?.(memory);

    // 3. Persist the user turn immediately so a crash later never loses it.
    store.append({ sessionId: this.sessionId, role: 'user', content: userInput, createdAt: new Date(now.iso) });

    // 4. Agentic loop with a budgeted, date-aware search tool.
    const searches: SearchRecord[] = [];
    const turnSignal = combineSignals(signal, AbortSignal.timeout(this.deps.turnTimeoutMs));
    let text = '';
    let degraded = false;

    try {
      text = await this.runModel(plan, memory, policy, searches, turnSignal);
    } catch (error) {
      degraded = true;
      const reason = signal?.aborted ? 'cancelled' : describeError(error);
      events?.onNotice?.(`Model call failed (${reason}); using deterministic fallback.`);
      text = renderFallback(plan, memory, timeZone, reason);
    }

    // 5. Persist the answer with an audit trail of what the agent did.
    store.append({
      sessionId: this.sessionId,
      role: 'assistant',
      content: text,
      createdAt: new Date((this.deps.clock ?? (() => new Date()))().getTime()),
      metadata: {
        degraded,
        searches,
        references: plan.references.map((r) => ({ phrase: r.phrase, start: r.start, end: r.end })),
        policy,
      },
    });

    return { text, plan, retrievedTurns: memory.turns.length, searches, degraded };
  }

  private async runModel(
    plan: TemporalPlan,
    memory: RetrievedMemory,
    policy: SearchPolicy,
    searches: SearchRecord[],
    signal: AbortSignal,
  ): Promise<string> {
    const { model, events } = this.deps;
    const system = buildSystemPrompt(plan, memory);
    const messages = toModelMessages(this.deps.store.getBySession(this.sessionId, HISTORY_TURNS));

    const cache = new Map<string, string>();
    let executed = 0;

    const webSearchTool = tool({
      description:
        'Search the live web. Use for anything that may have changed recently (pricing, releases, news). ' +
        'Write specific queries (product + topic). The date window for "since <date>" questions is applied automatically; ' +
        'pass `since` (YYYY-MM-DD) only to override it. Use topic "news" for announcements.',
      inputSchema: z.object({
        query: z.string().describe('Focused search query, e.g. "HubSpot Sales Hub pricing change"'),
        topic: z.enum(['general', 'news']).optional(),
        since: z.string().optional().describe('Only results on/after this date, YYYY-MM-DD'),
        maxResults: z.number().int().min(1).max(8).optional(),
      }),
      execute: async (input) => {
        const since = input.since ?? plan.searchWindow?.since ?? undefined;
        const query = enrichQuery(input.query, plan);
        const key = `${query}|${since ?? ''}|${input.topic ?? ''}`;
        const cached = cache.get(key);
        if (cached) return `${cached}\n(duplicate query — result reused)`;

        if (executed >= this.deps.maxSearchesPerTurn) {
          return 'SEARCH BUDGET EXHAUSTED for this turn. Answer now with what you have and state what remains unverified.';
        }
        executed += 1;

        events?.onSearchStart?.({ query, since, attempt: executed });
        const outcome = await webSearch(
          { ...input, query, ...(since ? { since, until: plan.now.localDate } : {}) },
          this.deps.search,
          signal,
        );
        events?.onSearchEnd?.(outcome);
        searches.push({
          query,
          since,
          status: outcome.status,
          resultCount: outcome.status === 'ok' ? outcome.hits.length : 0,
        });
        const rendered = formatOutcome(outcome);
        cache.set(key, rendered);
        return rendered;
      },
    });

    const result = await generateText({
      model,
      instructions: system,
      messages,
      tools: { web_search: webSearchTool },
      // Step 0 may be forced (freshness questions) or forbidden (pure recall); later steps are free.
      prepareStep: ({ stepNumber }) => ({
        toolChoice: stepNumber === 0 ? policy : 'auto',
      }),
      stopWhen: isStepCount(this.deps.maxSearchesPerTurn + 2),
      temperature: 0.2,
      maxRetries: 2,
      abortSignal: signal,
    });

    if (result.text.trim().length > 0) return result.text.trim();

    // Guard: the loop ended on a tool call (step budget hit). Force a tool-free synthesis.
    const final = await generateText({
      model,
      instructions: system,
      messages: [...messages, ...result.response.messages],
      toolChoice: 'none',
      tools: { web_search: webSearchTool },
      temperature: 0.2,
      abortSignal: signal,
    });
    const text = final.text.trim();
    if (!text) throw new Error('model returned an empty response');
    return text;
  }
}

/* ─────────────────────────────── helpers ──────────────────────────────── */

/** Stored turns → model messages. Failed (degraded) answers are dropped; consecutive same-role turns merge. */
export function toModelMessages(history: StoredMessage[]): ModelMessage[] {
  const merged: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const msg of history) {
    if (msg.role === 'assistant' && msg.metadata.degraded === true) continue;
    const last = merged.at(-1);
    if (last && last.role === msg.role) last.content += `\n\n${msg.content}`;
    else merged.push({ role: msg.role, content: msg.content });
  }
  while (merged[0]?.role === 'assistant') merged.shift();
  return merged;
}

function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  return a ? AbortSignal.any([a, b]) : b;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Last-resort answer when the model is unreachable. For memory questions it is still *useful*,
 * because the retrieval was deterministic and never needed the model.
 */
export function renderFallback(
  plan: TemporalPlan,
  memory: RetrievedMemory,
  timeZone: string,
  reason: string,
): string {
  const lines = [`I couldn't reach the language model (${reason}), so here is what I can say without it.`, ''];
  if (plan.references.length > 0) {
    lines.push(`Resolved dates: ${describeReferences(plan).join('; ')}.`);
  }
  if (memory.turns.length > 0) {
    lines.push('', 'Stored conversation turns for those dates:');
    for (const msg of memory.turns) lines.push(`- ${formatTurn(msg, timeZone)}`);
  } else if (plan.references.length > 0) {
    lines.push('', 'I have no stored turns for those dates.');
  }
  if (plan.searchPolicy === 'required') {
    lines.push('', 'I could not check the live web, so I cannot say whether anything has changed since then.');
  }
  return lines.join('\n');
}
