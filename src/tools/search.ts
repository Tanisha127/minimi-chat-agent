import { z } from 'zod';

/* ────────────────────────────── input contract ────────────────────────────── */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** What the model is allowed to ask for. Validated again at runtime — model output is untrusted input. */
export const SearchInputSchema = z.object({
  query: z.string().trim().min(3, 'query too short').max(300, 'query too long'),
  topic: z.enum(['general', 'news']).optional(),
  since: z.string().regex(DATE_RE, 'since must be YYYY-MM-DD').optional(),
  until: z.string().regex(DATE_RE, 'until must be YYYY-MM-DD').optional(),
  maxResults: z.number().int().min(1).max(8).optional(),
});
export type SearchInput = z.infer<typeof SearchInputSchema>;

/* ────────────────────────────── outcome types ─────────────────────────────── */

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
}

export type SearchOutcome =
  | {
      status: 'ok';
      query: string;
      hits: SearchHit[];
      window: { since?: string; until?: string };
      /** True when the dated search came back empty and results come from an un-windowed retry. */
      windowRelaxed: boolean;
    }
  | { status: 'empty'; query: string; window: { since?: string; until?: string } }
  | { status: 'error'; query: string; message: string; retryable: boolean };

/* ──────────────────────────────── client ──────────────────────────────────── */

const TavilyResponseSchema = z.object({
  results: z
    .array(
      z.object({
        title: z.string().nullish(),
        url: z.string(),
        content: z.string().nullish(),
        published_date: z.string().nullish(),
        score: z.number().nullish(),
      }),
    )
    .default([]),
});

export interface TavilyOptions {
  apiKey: string;
  timeoutMs?: number;
  /** Extra attempts after the first one, for transient failures only. */
  maxRetries?: number;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

class SearchHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'SearchHttpError';
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal, dependency-free Tavily client: timeouts, bounded retries, validated responses. */
export class TavilyClient {
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: TavilyOptions) {
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.maxRetries = options.maxRetries ?? 1;
    this.endpoint = options.endpoint ?? 'https://api.tavily.com/search';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** One logical search with retry on timeouts, network errors, 429 and 5xx. */
  async search(
    params: { query: string; topic: 'general' | 'news'; maxResults: number; since?: string; until?: string },
    signal?: AbortSignal,
  ): Promise<SearchHit[]> {
    let lastError: SearchHttpError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (signal?.aborted) throw new SearchHttpError('search cancelled', undefined, false);
      try {
        return await this.once(params, signal);
      } catch (error) {
        const err =
          error instanceof SearchHttpError ? error : new SearchHttpError(describeError(error), undefined, true);
        lastError = err;
        if (!err.retryable || attempt === this.maxRetries) break;
        await this.sleep(400 * 2 ** attempt);
      }
    }
    throw lastError ?? new SearchHttpError('search failed', undefined, false);
  }

  private async once(
    params: { query: string; topic: 'general' | 'news'; maxResults: number; since?: string; until?: string },
    outerSignal?: AbortSignal,
  ): Promise<SearchHit[]> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = outerSignal ? AbortSignal.any([outerSignal, timeout]) : timeout;

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.options.apiKey}` },
        body: JSON.stringify({
          query: params.query,
          topic: params.topic,
          search_depth: 'basic',
          max_results: params.maxResults,
          include_answer: false,
          include_raw_content: false,
          ...(params.since ? { start_date: params.since } : {}),
          ...(params.until ? { end_date: params.until } : {}),
        }),
        signal,
      });
    } catch (error) {
      if (outerSignal?.aborted) throw new SearchHttpError('search cancelled', undefined, false);
      const timedOut = timeout.aborted;
      throw new SearchHttpError(
        timedOut ? `search timed out after ${this.timeoutMs}ms` : describeError(error),
        undefined,
        true,
      );
    }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      const hint =
        response.status === 401 || response.status === 403 ? ' (check TAVILY_API_KEY)' : '';
      throw new SearchHttpError(`search provider returned HTTP ${response.status}${hint}`, response.status, retryable);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new SearchHttpError('search provider returned invalid JSON', response.status, true);
    }
    const parsed = TavilyResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new SearchHttpError('search provider returned an unexpected payload', response.status, false);
    }
    return parsed.data.results.map((r) => ({
      title: (r.title ?? r.url).trim(),
      url: r.url,
      snippet: r.content ?? '',
      ...(r.published_date ? { publishedDate: r.published_date.slice(0, 10) } : {}),
    }));
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ─────────────────────────── orchestrated search ──────────────────────────── */

export const MAX_SNIPPET_CHARS = 450;
export const MAX_OUTPUT_CHARS = 6000;

/** Collapses whitespace and cuts at a sentence / word boundary so snippets stay token-cheap and readable. */
export function truncateSnippet(text: string, max = MAX_SNIPPET_CHARS): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const slice = clean.slice(0, max);
  const sentenceEnd = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
  const cut = sentenceEnd > max * 0.5 ? sentenceEnd + 1 : slice.lastIndexOf(' ');
  return `${slice.slice(0, cut > 0 ? cut : max).trimEnd()}…`;
}

function dedupeByUrl(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = hit.url.replace(/[#?].*$/, '').replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Runs a validated search with graceful degradation:
 *   1. dated window (if requested)  →  2. un-windowed retry if the window yields nothing / is rejected.
 * Never throws: every failure is converted into a `SearchOutcome` the model can reason about.
 */
export async function webSearch(
  rawInput: unknown,
  client: TavilyClient | null,
  signal?: AbortSignal,
): Promise<SearchOutcome> {
  const parsed = SearchInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const query = typeof (rawInput as { query?: unknown } | null)?.query === 'string' ? String((rawInput as { query: string }).query) : '';
    return {
      status: 'error',
      query,
      message: `invalid search input: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      retryable: false,
    };
  }
  const input = parsed.data;
  const window = {
    ...(input.since ? { since: input.since } : {}),
    ...(input.until ? { until: input.until } : {}),
  };

  if (!client) {
    return {
      status: 'error',
      query: input.query,
      message: 'web search is not configured (TAVILY_API_KEY is missing)',
      retryable: false,
    };
  }

  const base = { query: input.query, topic: input.topic ?? 'general', maxResults: input.maxResults ?? 5 } as const;
  const hasWindow = Boolean(input.since ?? input.until);

  try {
    let hits: SearchHit[] = [];
    let relaxed = false;

    if (hasWindow) {
      try {
        hits = await client.search({ ...base, ...window }, signal);
      } catch (error) {
        // A rejected date filter (HTTP 400/422) should degrade to an un-windowed search, not fail the turn.
        const status = error instanceof SearchHttpError ? error.status : undefined;
        if (status !== 400 && status !== 422) throw error;
      }
      if (hits.length === 0) {
        hits = await client.search(base, signal);
        relaxed = hits.length > 0;
      }
    } else {
      hits = await client.search(base, signal);
    }

    const cleaned = dedupeByUrl(hits)
      .filter((h) => h.snippet.trim().length > 0 || h.title.length > 0)
      .map((h) => ({ ...h, snippet: truncateSnippet(h.snippet) }));

    if (cleaned.length === 0) return { status: 'empty', query: input.query, window };
    return { status: 'ok', query: input.query, hits: cleaned, window, windowRelaxed: relaxed };
  } catch (error) {
    const retryable = error instanceof SearchHttpError ? error.retryable : true;
    return { status: 'error', query: input.query, message: describeError(error), retryable };
  }
}

/** Renders an outcome as compact markdown for the model, hard-capped for token efficiency. */
export function formatOutcome(outcome: SearchOutcome, maxChars = MAX_OUTPUT_CHARS): string {
  const windowText = (w: { since?: string; until?: string }): string =>
    w.since || w.until ? `${w.since ?? '…'} → ${w.until ?? 'today'}` : 'none';

  switch (outcome.status) {
    case 'error':
      return [
        `SEARCH FAILED for "${outcome.query}": ${outcome.message}.`,
        outcome.retryable
          ? 'This looks transient — you may retry once with a simpler query.'
          : 'Do not retry. Tell the user live data is unavailable and answer only from what is already known, clearly labelled as unverified.',
      ].join('\n');
    case 'empty':
      return [
        `NO RESULTS for "${outcome.query}" (date window: ${windowText(outcome.window)}).`,
        'Do not invent findings. Either try one differently-worded query, or tell the user nothing verifiable was found.',
      ].join('\n');
    case 'ok': {
      const lines: string[] = [
        `Search: "${outcome.query}" | date window: ${windowText(outcome.window)} | ${outcome.hits.length} result(s)`,
      ];
      if (outcome.windowRelaxed) {
        lines.push(
          'NOTE: nothing matched inside the date window, so these are broader results that may PREDATE it. ' +
            'Check each published date before claiming that anything changed.',
        );
      }
      outcome.hits.forEach((hit, i) => {
        const host = safeHost(hit.url);
        const published = hit.publishedDate ? ` (published ${hit.publishedDate})` : ' (publish date unknown)';
        lines.push(`\n[${i + 1}] ${hit.title} — ${host}${published}\n${hit.url}\n${hit.snippet}`);
      });
      const text = lines.join('\n');
      return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1).trimEnd()}…`;
    }
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
