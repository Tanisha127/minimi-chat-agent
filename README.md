# minimi chat agent

A time-aware CLI chat agent in pure TypeScript/Node.js with **one tool (web search)** and a **SQLite memory** that answers questions like *"What did I ask you on 3 November? Is your answer still correct today?"* deterministically. Architecture: see [DESIGN.md](./DESIGN.md).

## Quick start

Requires **Node.js ≥ 22** (required by `better-sqlite3` 13; tested on 22).

```bash
npm install
cp .env.example .env        # then fill in the keys (see below)
npm run dev
```

`.env` needs:

| Variable | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes (default provider) | or set `LLM_PROVIDER=openai` and `OPENAI_API_KEY` |
| `TAVILY_API_KEY` | yes for live search | free key at https://app.tavily.com |
| `LLM_MODEL`, `DB_PATH`, `TIMEZONE`, `NOW_OVERRIDE`, … | optional | see `.env.example` |

Demo conversations (3 November, last Monday, last Tuesday) are seeded automatically on first start. Seeding is idempotent.

## Try the evaluation prompts

```
What did I ask you on 3 November? Is your answer still correct today?
On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?
Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?
```

Pin the date for a reproducible demo: `NOW_OVERRIDE=2026-11-10T14:00:00+05:30` in `.env`.

CLI commands: `/help` `/now` `/dates` `/history [YYYY-MM-DD]` `/plan <text>` `/seed` `/exit`.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | start the interactive agent |
| `npm test` | 37 unit/integration tests (planner, SQLite, search client, agent loop with a mock model) — no API keys needed |
| `npm run typecheck` | strict TypeScript check |
| `npm run seed` | create/seed the database and exit |

## Layout

```
src/index.ts               CLI loop + transparency output
src/config.ts              zod-validated environment
src/agent/planner.ts       deterministic temporal resolver, intent cues, search policy
src/agent/context.ts       memory retrieval + prompt/context assembly
src/agent/orchestrator.ts  agent loop, tool budget, fallbacks, persistence
src/memory/db.ts           better-sqlite3 schema and temporal queries
src/memory/seed.ts         idempotent demo fixtures
src/tools/search.ts        Tavily client, validation, retries, truncation
```

## Troubleshooting

- **`better-sqlite3` fails to install:** use Node 22+ (the package ships prebuilt binaries); on macOS run `xcode-select --install` if it falls back to compiling.
- **`ANTHROPIC_API_KEY is required`:** create `.env` from `.env.example`.
- **Wrong "today":** set `TIMEZONE` (e.g. `Asia/Kolkata`) or `NOW_OVERRIDE`.
