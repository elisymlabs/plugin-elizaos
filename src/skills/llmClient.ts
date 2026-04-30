/**
 * Plugin-level LLM facade.
 *
 * SDK 0.14 removed the bundled `createAnthropicClient`/`createOpenAIClient`
 * helpers in favour of a pluggable provider descriptor registry. This
 * module re-implements the historical factory shape on top of the local
 * registry so existing call sites keep working.
 */

import type { LlmClient } from '@elisym/sdk/skills';
import { getLlmProvider, getRegisteredProviderIds, type LlmKeyVerification } from './registry';

export type { LlmKeyVerification } from './registry';
export {
  getLlmProvider,
  getRegisteredProviderIds,
  listLlmProviders,
  registerLlmProvider,
} from './registry';

export type LlmProvider = string;

export interface LlmClientConfig {
  provider: LlmProvider;
  apiKey: string;
  model?: string;
  maxTokens?: number;
}

export function createLlmClient(config: LlmClientConfig): LlmClient {
  const descriptor = getLlmProvider(config.provider);
  if (!descriptor) {
    const known = getRegisteredProviderIds().join(', ') || '<none>';
    throw new Error(`Unknown LLM provider "${config.provider}". Registered: ${known}.`);
  }
  if (!config.apiKey) {
    throw new Error(`${descriptor.envVar} is required for skill runtime`);
  }
  return descriptor.createClient({
    apiKey: config.apiKey,
    model: config.model,
    maxTokens: config.maxTokens,
  });
}

export interface AnthropicClientFactoryConfig {
  apiKey: string;
  model?: string;
  maxTokens?: number;
}

export function createAnthropicClient(config: AnthropicClientFactoryConfig): LlmClient {
  return createLlmClient({ provider: 'anthropic', ...config });
}

export interface OpenAIClientFactoryConfig {
  apiKey: string;
  model?: string;
  maxTokens?: number;
}

export function createOpenAIClient(config: OpenAIClientFactoryConfig): LlmClient {
  return createLlmClient({ provider: 'openai', ...config });
}

export async function verifyLlmApiKey(
  provider: LlmProvider,
  apiKey: string,
  signal?: AbortSignal,
): Promise<LlmKeyVerification> {
  const descriptor = getLlmProvider(provider);
  if (!descriptor) {
    return {
      ok: false,
      reason: 'unavailable',
      error: `Unknown LLM provider "${provider}"`,
    };
  }
  return descriptor.verifyKey(apiKey, signal);
}

export async function verifyLlmApiKeyDeep(
  provider: LlmProvider,
  apiKey: string,
  model: string,
  signal?: AbortSignal,
): Promise<LlmKeyVerification> {
  const descriptor = getLlmProvider(provider);
  if (!descriptor) {
    return {
      ok: false,
      reason: 'unavailable',
      error: `Unknown LLM provider "${provider}"`,
    };
  }
  return descriptor.verifyKeyDeep(apiKey, model, signal);
}
