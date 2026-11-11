import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import type { AppConfig } from '../config.js';

export function createModel(config: Pick<AppConfig, 'provider' | 'apiKey' | 'model'>): LanguageModel {
  return config.provider === 'anthropic'
    ? createAnthropic({ apiKey: config.apiKey })(config.model)
    : createOpenAI({ apiKey: config.apiKey })(config.model);
}
