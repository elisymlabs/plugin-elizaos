/**
 * Per-skill LLM resolution + health monitor wiring.
 *
 * SKILL.md frontmatter may declare a per-skill `provider`/`model`/`max_tokens`
 * override (SDK 0.13+). The runtime resolves each `mode: 'llm'` skill into a
 * concrete (provider, model, maxTokens) triple, instantiates one `LlmClient`
 * per unique triple, and registers each with `LlmHealthMonitor` so the
 * incoming-job preflight can refuse jobs against an exhausted key before the
 * customer pays (SDK 0.15).
 */

import { LlmHealthMonitor, type LlmKeyVerification } from '@elisym/sdk/llm-health';
import type { LlmClient, Skill, SkillLlmOverride } from '@elisym/sdk/skills';
import { logger } from '../lib/logger';
import {
  createLlmClient,
  getLlmProvider,
  verifyLlmApiKeyDeep,
  type LlmProvider,
} from './llmClient';

export interface AgentDefaultLlm {
  provider: LlmProvider;
  model?: string;
  maxTokens?: number;
}

export interface ResolvedTriple {
  provider: LlmProvider;
  model: string;
  maxTokens: number;
}

export interface SkillLlmResolution {
  defaultClient: LlmClient | undefined;
  defaultTriple: ResolvedTriple | undefined;
  getLlm: (override?: SkillLlmOverride) => LlmClient | undefined;
  monitor: LlmHealthMonitor;
}

const DEFAULT_MAX_TOKENS = 4096;

function tripleKey(triple: ResolvedTriple): string {
  return `${triple.provider}::${triple.model}::${triple.maxTokens}`;
}

function resolveSkillTriple(
  skill: Skill,
  agentDefault: AgentDefaultLlm | undefined,
): ResolvedTriple | { error: string } {
  const override = skill.llmOverride;
  let provider: string | undefined;
  let model: string | undefined;
  let maxTokens: number | undefined;

  if (override?.provider !== undefined && override?.model !== undefined) {
    provider = override.provider;
    model = override.model;
  } else if (agentDefault) {
    provider = agentDefault.provider;
    model = agentDefault.model ?? getLlmProvider(agentDefault.provider)?.defaultModel;
  }

  maxTokens = override?.maxTokens ?? agentDefault?.maxTokens ?? DEFAULT_MAX_TOKENS;

  if (!provider) {
    return {
      error: `skill "${skill.name}" needs an LLM provider but none is configured (set ANTHROPIC_API_KEY or declare provider/model in SKILL.md)`,
    };
  }
  const descriptor = getLlmProvider(provider);
  if (!descriptor) {
    return { error: `skill "${skill.name}": unknown LLM provider "${provider}"` };
  }
  if (!model) {
    model = descriptor.defaultModel;
  }
  return { provider, model, maxTokens };
}

export interface SkillLlmResolverInput {
  skills: readonly Skill[];
  agentDefault: AgentDefaultLlm | undefined;
  apiKeys: ReadonlyMap<string, string>;
}

/**
 * Build LLM clients for every (provider, model, maxTokens) triple referenced
 * by the loaded skills, register and seed the health monitor with deep
 * verification, and return a `getLlm(override)` lookup the runtime can pass
 * through `SkillContext`.
 *
 * Skills whose required provider has no API key are reported via the returned
 * `errors` list; they will fail when the runtime asks for their client. We
 * still build the resolution for the rest so non-LLM skills and skills
 * targeting a configured provider keep working.
 */
export async function buildSkillLlmResolution(
  input: SkillLlmResolverInput,
): Promise<{ resolution: SkillLlmResolution; errors: string[] }> {
  const errors: string[] = [];
  const llmSkills = input.skills.filter((skill) => skill.mode === 'llm');
  const cache = new Map<string, LlmClient>();
  const monitor = new LlmHealthMonitor();
  const triplesByKey = new Map<string, ResolvedTriple>();

  for (const skill of llmSkills) {
    const result = resolveSkillTriple(skill, input.agentDefault);
    if ('error' in result) {
      errors.push(result.error);
      continue;
    }
    triplesByKey.set(tripleKey(result), result);
  }

  let defaultTriple: ResolvedTriple | undefined;
  if (input.agentDefault) {
    const descriptor = getLlmProvider(input.agentDefault.provider);
    if (descriptor) {
      const model = input.agentDefault.model ?? descriptor.defaultModel;
      const maxTokens = input.agentDefault.maxTokens ?? DEFAULT_MAX_TOKENS;
      defaultTriple = { provider: input.agentDefault.provider, model, maxTokens };
    }
  }

  const verifications: Array<Promise<void>> = [];
  for (const triple of triplesByKey.values()) {
    const apiKey = input.apiKeys.get(triple.provider);
    if (!apiKey) {
      errors.push(
        `provider "${triple.provider}" has no API key set; LLM skills using it will fail`,
      );
      continue;
    }
    cache.set(
      tripleKey(triple),
      createLlmClient({
        provider: triple.provider,
        apiKey,
        model: triple.model,
        maxTokens: triple.maxTokens,
      }),
    );
    const descriptor = getLlmProvider(triple.provider);
    if (!descriptor) {
      continue;
    }
    const verifyFn = (signal?: AbortSignal): Promise<LlmKeyVerification> =>
      descriptor.verifyKeyDeep(apiKey, triple.model, signal);
    monitor.register({ provider: triple.provider, model: triple.model, verifyFn });
    verifications.push(
      (async () => {
        try {
          const verification = await verifyLlmApiKeyDeep(triple.provider, apiKey, triple.model);
          monitor.seed(triple.provider, triple.model, verification);
          if (!verification.ok) {
            const reason = verification.reason;
            const detail =
              reason === 'invalid' || reason === 'billing'
                ? (verification as { body?: string }).body?.slice(0, 200)
                : (verification as { error: string }).error;
            logger.warn(
              { provider: triple.provider, model: triple.model, reason, detail },
              'LLM key deep-verify reported a problem; jobs for this skill will be refused at the health gate',
            );
          }
        } catch (error) {
          logger.warn(
            { err: error, provider: triple.provider, model: triple.model },
            'LLM key deep-verify threw',
          );
        }
      })(),
    );
  }

  await Promise.all(verifications);

  if (defaultTriple && !cache.has(tripleKey(defaultTriple))) {
    const apiKey = input.apiKeys.get(defaultTriple.provider);
    if (apiKey) {
      cache.set(
        tripleKey(defaultTriple),
        createLlmClient({
          provider: defaultTriple.provider,
          apiKey,
          model: defaultTriple.model,
          maxTokens: defaultTriple.maxTokens,
        }),
      );
    }
  }

  const defaultClient =
    defaultTriple !== undefined ? cache.get(tripleKey(defaultTriple)) : undefined;

  const getLlm = (override?: SkillLlmOverride): LlmClient | undefined => {
    if (override?.provider !== undefined && override?.model !== undefined) {
      const key = tripleKey({
        provider: override.provider,
        model: override.model,
        maxTokens: override.maxTokens ?? input.agentDefault?.maxTokens ?? DEFAULT_MAX_TOKENS,
      });
      return cache.get(key);
    }
    // maxTokens-only override (SDK invariant: provider/model paired, maxTokens
    // independent). Reuse the agent default's provider/model but honor the
    // override's maxTokens against the per-triple cache.
    if (override?.maxTokens !== undefined && defaultTriple) {
      const key = tripleKey({
        provider: defaultTriple.provider,
        model: defaultTriple.model,
        maxTokens: override.maxTokens,
      });
      const cached = cache.get(key);
      if (cached) {
        return cached;
      }
    }
    return defaultClient;
  };

  return {
    resolution: { defaultClient, defaultTriple, getLlm, monitor },
    errors,
  };
}

export function resolveTripleForOverride(
  override: SkillLlmOverride | undefined,
  agentDefault: AgentDefaultLlm | undefined,
): ResolvedTriple | undefined {
  if (override?.provider !== undefined && override?.model !== undefined) {
    return {
      provider: override.provider,
      model: override.model,
      maxTokens: override.maxTokens ?? agentDefault?.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
  }
  if (!agentDefault) {
    return undefined;
  }
  const descriptor = getLlmProvider(agentDefault.provider);
  if (!descriptor) {
    return undefined;
  }
  return {
    provider: agentDefault.provider,
    model: agentDefault.model ?? descriptor.defaultModel,
    maxTokens: override?.maxTokens ?? agentDefault.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
}
