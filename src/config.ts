import 'dotenv/config';
import { z } from 'zod';
import { resolveTimeZone } from './util/time.js';

/** Empty strings in `.env` (e.g. `LLM_MODEL=`) are treated as "not set". */
const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalString = z.preprocess(blankToUndefined, z.string().optional());
const positiveInt = (fallback: number) =>
  z.preprocess(blankToUndefined, z.coerce.number().int().positive().default(fallback));

const EnvSchema = z.object({
  LLM_PROVIDER: z.preprocess(blankToUndefined, z.enum(['anthropic', 'openai']).default('anthropic')),
  ANTHROPIC_API_KEY: optionalString,
  OPENAI_API_KEY: optionalString,
  LLM_MODEL: optionalString,
  TAVILY_API_KEY: optionalString,
  DB_PATH: z.preprocess(blankToUndefined, z.string().default('./data/agent.db')),
  TIMEZONE: optionalString,
  NOW_OVERRIDE: optionalString,
  SEARCH_TIMEOUT_MS: positiveInt(8000),
  TURN_TIMEOUT_MS: positiveInt(60000),
  MAX_SEARCHES_PER_TURN: positiveInt(3),
});

export interface AppConfig {
  provider: 'anthropic' | 'openai';
  apiKey: string;
  model: string;
  tavilyApiKey: string | undefined;
  dbPath: string;
  timeZone: string;
  nowOverride: Date | undefined;
  searchTimeoutMs: number;
  turnTimeoutMs: number;
  maxSearchesPerTurn: number;
}

const DEFAULT_MODELS = { anthropic: 'claude-sonnet-5-5', openai: 'gpt-4.1' } as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Validates the environment once, at startup, so misconfiguration fails fast with a readable message. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid environment configuration:\n${details}\nSee .env.example.`);
  }
  const e = parsed.data;

  const apiKey = e.LLM_PROVIDER === 'anthropic' ? e.ANTHROPIC_API_KEY : e.OPENAI_API_KEY;
  if (!apiKey) {
    const keyName = e.LLM_PROVIDER === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
    throw new ConfigError(
      `${keyName} is required when LLM_PROVIDER=${e.LLM_PROVIDER}.\n` +
        'Copy .env.example to .env and fill it in.',
    );
  }

  let nowOverride: Date | undefined;
  if (e.NOW_OVERRIDE) {
    nowOverride = new Date(e.NOW_OVERRIDE);
    if (Number.isNaN(nowOverride.getTime())) {
      throw new ConfigError(`NOW_OVERRIDE is not a valid ISO-8601 timestamp: "${e.NOW_OVERRIDE}"`);
    }
  }

  return {
    provider: e.LLM_PROVIDER,
    apiKey,
    model: e.LLM_MODEL ?? DEFAULT_MODELS[e.LLM_PROVIDER],
    tavilyApiKey: e.TAVILY_API_KEY,
    dbPath: e.DB_PATH,
    timeZone: resolveTimeZone(e.TIMEZONE),
    nowOverride,
    searchTimeoutMs: e.SEARCH_TIMEOUT_MS,
    turnTimeoutMs: e.TURN_TIMEOUT_MS,
    maxSearchesPerTurn: e.MAX_SEARCHES_PER_TURN,
  };
}
