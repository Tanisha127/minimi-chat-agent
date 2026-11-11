# DESIGN.md — Time-aware chat agent with one tool (web search)

## 1. How it works

```
user input
   │
   ▼
[1] Temporal planner (pure TS, no LLM)      "last Tuesday" → 2026-11-03, "since then" → change window
   │    resolves dates • detects recall / freshness cues • picks search policy: required | auto | none
   ▼
[2] Relational memory (SQLite)              WHERE local_date BETWEEN ? AND ?   (indexed, exact)
   │    returns the real turns from those dates; reports dates with nothing stored
   ▼
[3] Prompt assembly                         current date/weekday + resolved dates + stored turns + search guidance
   ▼
[4] Agent loop (Vercel AI SDK, 1 tool)      step 0 toolChoice = policy;  web_search(query, since?) ≤ 3 calls
   │    tool: date window auto-applied • month-year appended to queries • Tavily • timeout/retry/fallback
   ▼
[5] Synthesis → answer → persisted with audit metadata (policy, queries, resolved dates)
```

Every turn is stored with `created_at` (UTC ISO-8601), `day_of_week`, `metadata` (JSON) and a `local_date` column (calendar date in the user's time zone) that all temporal queries hit. The CLI prints each decision (`[Resolved dates…]`, `[Memory…]`, `[Searching web for…]`), and `/plan <text>` dry-runs the planner.

## 2. Why it was built this way

- **Time is a calendar problem, not a similarity problem.** "On 3 November" or "last Tuesday" has exactly one correct answer; an indexed `local_date` predicate returns it deterministically in well under a millisecond. Embeddings cannot reliably tell Tuesday from Wednesday.
- **The LLM never does date arithmetic.** The planner resolves dates in code (unit-tested, incl. "monday.com is not a Monday"), so results are reproducible and the model only compares *facts*.
- **Search is decided by policy, enforced in code.** Freshness cues ("since", "still", "pricing") force a search on step 0; pure recall ("what did I ask…") forbids it, so recall costs one fast model call. If the referenced date has no stored turns, a forced search is downgraded — nothing to verify.
- **Freshness is injected deterministically.** The tool applies `start_date = anchor` / `end_date = today` and appends "November 2026" when the model's query has no year. If the window is empty, it retries un-windowed and labels the results as possibly predating the window.
- **Token efficiency:** only the referenced days are retrieved (≤24 turns, 700 chars each); snippets are cut at sentence boundaries (450 chars), tool output is capped at 6 000 chars, ≤3 searches/turn, duplicate queries are cached.
- **Fail-safes:** 8 s search timeout + 1 retry on 429/5xx/network, strict zod validation of both model input and provider output, missing-key and empty-result messages the model can act on, 60 s turn timeout, Ctrl-C cancellation, and a deterministic memory-only answer if the LLM is down.

## 3. What was considered and rejected

- **Pure vector / RAG memory:** approximate, blind to calendar semantics, needs an embedding model and index; wrong tool for "last Tuesday".
- **Letting the LLM resolve dates itself:** cheap to build, but off-by-one weekday errors are silent and untestable.
- **Multi-agent (planner / researcher / critic):** 3× latency and cost, more failure modes, and the "planner" is just deterministic code here.
- **Unbounded browsing / scraping:** slow, brittle, an injection and abuse surface; one budgeted search tool is easier to audit.
- **Storing UTC only:** "3 November" is a *local* calendar day; deriving it at query time would defeat the index and break near midnight.

## 4. What I'd do with another week

1. **Proactive monitors:** a cron job re-runs saved queries (e.g. the CRM shortlist) and stores *diffs* of pricing pages, so "what changed since Monday?" is answered from snapshots, not only from search snippets.
2. **Hybrid retrieval:** add local embeddings (e.g. sqlite-vec) *only* for topical lookups ("that Postgres thing"), always intersected with the deterministic date filter.
3. **Structured memory of claims:** extract entities and claims (tool, price, date, source URL) from answers so the comparison "then vs now" is a typed diff.
4. **Streaming output, per-source credibility ranking, and an eval harness** replaying the three challenge prompts against recorded search fixtures in CI.
