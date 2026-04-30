/**
 * Pluggable LLM provider registry. Mirrors the CLI shape so adding a
 * provider is one descriptor file plus one registration call below.
 *
 * SDK 0.14+ removed the bundled clients; each consumer (CLI, plugin)
 * ships its own descriptors and only relies on the SDK for the
 * `LlmClient` interface and `LlmKeyVerification` shape.
 */

import type { LlmKeyVerification } from '@elisym/sdk/llm-health';
import type { LlmClient } from '@elisym/sdk/skills';
import { ANTHROPIC_PROVIDER } from './providers/anthropic';
import { OPENAI_PROVIDER } from './providers/openai';

export type { LlmKeyVerification } from '@elisym/sdk/llm-health';

export interface CreateLlmClientConfig {
  apiKey: string;
  model?: string;
  maxTokens?: number;
}

export interface LlmProviderDescriptor {
  id: string;
  displayName: string;
  envVar: string;
  defaultModel: string;
  fallbackModels: string[];
  fetchModels(apiKey: string, signal?: AbortSignal): Promise<string[]>;
  verifyKey(apiKey: string, signal?: AbortSignal): Promise<LlmKeyVerification>;
  verifyKeyDeep(apiKey: string, model: string, signal?: AbortSignal): Promise<LlmKeyVerification>;
  createClient(config: CreateLlmClientConfig): LlmClient;
  isReasoningModel?(model: string): boolean;
}

const REGISTRY = new Map<string, LlmProviderDescriptor>();

export function registerLlmProvider(descriptor: LlmProviderDescriptor): void {
  REGISTRY.set(descriptor.id, descriptor);
}

export function getLlmProvider(id: string): LlmProviderDescriptor | undefined {
  return REGISTRY.get(id);
}

export function listLlmProviders(): LlmProviderDescriptor[] {
  return Array.from(REGISTRY.values());
}

export function getRegisteredProviderIds(): string[] {
  return Array.from(REGISTRY.keys());
}

registerLlmProvider(ANTHROPIC_PROVIDER);
registerLlmProvider(OPENAI_PROVIDER);
