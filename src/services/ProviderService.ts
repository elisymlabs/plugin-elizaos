import {
  KIND_APP_HANDLER,
  KIND_JOB_REQUEST,
  type ElisymClient,
  type ElisymIdentity,
  type SubCloser,
} from '@elisym/sdk';
import { startLlmHeartbeat } from '@elisym/sdk/llm-health';
import { Service, type IAgentRuntime, type ServiceTypeName } from '@elizaos/core';
import type { Event, Filter } from 'nostr-tools';
import type { LimitFunction } from 'p-limit';
import pLimit from 'p-limit';
import { MAX_CONCURRENT_INCOMING_JOBS, SERVICE_TYPES } from '../constants';
import type { ElisymConfig, ProviderProduct } from '../environment';
import { handleIncomingJob } from '../handlers/incomingJobHandler';
import { logger } from '../lib/logger';
import { resolveAgentMeta, resolveProducts } from '../lib/providerProducts';
import { SkillRegistry, getLlmProvider, loadSkillsFromDir } from '../skills';
import { buildSkillLlmResolution, type AgentDefaultLlm } from '../skills/resolver';
import { getState } from '../state';
import type { ElisymService } from './ElisymService';

async function awaitService<T>(runtime: IAgentRuntime, type: string): Promise<T> {
  const instance = await runtime.getServiceLoadPromise(type as ServiceTypeName);
  return instance as T;
}

interface ProductCard {
  name: string;
  description: string;
  capabilities: string[];
  static?: true;
  payment: {
    chain: 'solana';
    network: ElisymConfig['network'];
    address: string;
    job_price: number;
    token: string;
    mint?: string;
    decimals: number;
    symbol: string;
  };
}

export class ProviderService extends Service {
  static override serviceType = SERVICE_TYPES.PROVIDER;

  override capabilityDescription =
    'Accepts incoming elisym jobs and routes them to ElizaOS actions';

  private sub?: SubCloser;
  private publishedCards: ProductCard[] = [];
  private unregisterResetListener?: () => void;

  static override async start(runtime: IAgentRuntime): Promise<ProviderService> {
    const service = new ProviderService(runtime);
    await service.initialize();
    return service;
  }

  private async initialize(): Promise<void> {
    const { config } = getState(this.runtime);

    // ElizaOS 1.7 registers plugin services in parallel, so a sync
    // getService() here races with ElisymService/WalletService init.
    // Await their load promises instead of throwing on a null lookup.
    const [elisym, walletService] = await Promise.all([
      awaitService<ElisymService>(this.runtime, SERVICE_TYPES.ELISYM),
      awaitService<{ address: string }>(this.runtime, SERVICE_TYPES.WALLET),
    ]);

    const client = elisym.getClient();
    const identity = elisym.getIdentity();
    const address = walletService.address;

    const meta = resolveAgentMeta(this.runtime.character);

    try {
      await client.discovery.publishProfile(identity, meta.name, meta.about);
    } catch (error) {
      logger.warn({ err: error }, 'kind:0 profile publish failed (non-fatal)');
    }

    const pluginState = getState(this.runtime);
    if (config.providerSkillsDir) {
      const loaded = loadSkillsFromDir(config.providerSkillsDir);
      if (loaded.length > 0) {
        const registry = new SkillRegistry();
        for (const skill of loaded) {
          registry.register(skill);
        }
        pluginState.skills = registry;
        logger.info(
          {
            dir: config.providerSkillsDir,
            count: loaded.length,
            skills: loaded.map((skill) => skill.name),
            modes: loaded.map((skill) => skill.mode),
          },
          'loaded skills from directory',
        );
        await this.armSkillLlms(loaded);
      } else {
        logger.warn({ dir: config.providerSkillsDir }, 'skills directory had no loadable skills');
      }
    }

    const skillList = pluginState.skills?.all() ?? [];
    const products = resolveProducts(config, this.runtime.character, skillList);
    if (products.length === 0) {
      throw new Error('Provider mode requires at least one product');
    }
    const cards = products.map((product) => buildCard(product, address, config.network, skillList));

    for (const card of cards) {
      try {
        await client.discovery.publishCapability(identity, card, [KIND_JOB_REQUEST]);
        this.publishedCards.push(card);
        logger.info(
          {
            name: card.name,
            capabilities: card.capabilities,
            priceSubunits: card.payment.job_price,
            token: card.payment.token,
            symbol: card.payment.symbol,
            static: card.static === true,
          },
          'provider capability card published',
        );
      } catch (error) {
        logger.warn({ err: error, name: card.name }, 'publishCapability failed');
      }
    }

    await this.removeStaleCards(client, identity, new Set(cards.map((c) => c.name)));

    // Bound concurrent in-flight jobs so a traffic spike or abusive
    // customer cannot exhaust LLM quota / RPC rate / memory. Once the
    // limiter is saturated, new events queue inside p-limit; we reject
    // with an error feedback when the queue itself overflows.
    const limit = pLimit(MAX_CONCURRENT_INCOMING_JOBS);
    this.openJobSubscription(client, identity, limit);

    // NostrPool.reset() (fired by the watchdog on relay failure) closes every
    // tracked subscription. Re-open the job-request sub on the new pool, or
    // the provider silently stops accepting jobs.
    this.unregisterResetListener = client.pool.onReset(() => {
      logger.info('pool reset observed; re-subscribing to job requests');
      this.openJobSubscription(client, identity, limit);
    });
  }

  private async armSkillLlms(skills: readonly import('@elisym/sdk/skills').Skill[]): Promise<void> {
    const pluginState = getState(this.runtime);
    const llmSkills = skills.filter((skill) => skill.mode === 'llm');
    if (llmSkills.length === 0) {
      logger.info('no LLM skills loaded; skipping LLM key check');
      return;
    }

    const apiKeys = this.collectApiKeys(llmSkills);
    const agentDefault = this.resolveAgentDefaultLlm(apiKeys);

    const { resolution, errors } = await buildSkillLlmResolution({
      skills: llmSkills,
      agentDefault,
      apiKeys,
    });

    for (const message of errors) {
      logger.warn({ message }, 'LLM resolver reported a problem');
    }

    pluginState.agentDefaultLlm = agentDefault;
    pluginState.defaultSkillLlm = resolution.defaultClient;
    pluginState.getLlm = resolution.getLlm;
    pluginState.llmHealthMonitor = resolution.monitor;

    pluginState.llmHeartbeat = startLlmHeartbeat({
      monitor: resolution.monitor,
      log: (msg: string) => logger.info({ event: 'llm_heartbeat' }, msg),
    });
    logger.info('LLM health monitor armed; heartbeat started');
  }

  /**
   * Walk the loaded LLM skills, collect the unique providers they reference
   * (via `llmOverride.provider` or fall back to the agent default), and pull
   * the matching API key from runtime settings / env.
   */
  private collectApiKeys(
    skills: readonly import('@elisym/sdk/skills').Skill[],
  ): Map<string, string> {
    const keys = new Map<string, string>();
    const providers = new Set<string>();
    for (const skill of skills) {
      if (skill.llmOverride?.provider) {
        providers.add(skill.llmOverride.provider);
      }
    }
    // Always probe Anthropic/OpenAI envs so a skill without an override but
    // with the agent default works out of the box.
    providers.add('anthropic');
    providers.add('openai');

    for (const provider of providers) {
      const descriptor = getLlmProvider(provider);
      if (!descriptor) {
        continue;
      }
      const value = this.runtime.getSetting?.(descriptor.envVar);
      if (typeof value === 'string' && value.length > 0) {
        keys.set(provider, value);
      }
    }
    return keys;
  }

  /**
   * Pick the agent-level default LLM. Anthropic is preferred when its key is
   * set (back-compat with the previous behaviour); otherwise fall back to the
   * first provider whose key is configured.
   */
  private resolveAgentDefaultLlm(
    apiKeys: ReadonlyMap<string, string>,
  ): AgentDefaultLlm | undefined {
    const anthropicKey = apiKeys.get('anthropic');
    if (anthropicKey) {
      const modelSetting = this.runtime.getSetting?.('ANTHROPIC_LARGE_MODEL');
      return {
        provider: 'anthropic',
        model:
          typeof modelSetting === 'string' && modelSetting.length > 0 ? modelSetting : undefined,
      };
    }
    const openaiKey = apiKeys.get('openai');
    if (openaiKey) {
      return { provider: 'openai' };
    }
    return undefined;
  }

  private openJobSubscription(
    client: ElisymClient,
    identity: ElisymIdentity,
    limit: LimitFunction,
  ): void {
    const MAX_QUEUE = MAX_CONCURRENT_INCOMING_JOBS * 4;
    this.sub = client.marketplace.subscribeToJobRequests(
      identity,
      [KIND_JOB_REQUEST],
      (event: Event) => {
        if (limit.activeCount + limit.pendingCount >= MAX_QUEUE) {
          logger.warn(
            { jobId: event.id, queued: limit.pendingCount, active: limit.activeCount },
            'incoming job queue full; rejecting with error feedback',
          );
          client.marketplace
            .submitErrorFeedback(identity, event, 'Provider is currently overloaded, retry later')
            .catch((error) =>
              logger.debug({ err: error }, 'overload error feedback publish failed'),
            );
          return;
        }
        limit(() =>
          handleIncomingJob({ runtime: this.runtime, client, identity, event }).catch(
            (error: unknown) => {
              logger.error({ err: error, jobId: event.id }, 'incoming job handler crashed');
            },
          ),
        );
      },
    );
  }

  private async removeStaleCards(
    client: ReturnType<ElisymService['getClient']>,
    identity: ReturnType<ElisymService['getIdentity']>,
    keepNames: Set<string>,
  ): Promise<void> {
    try {
      const filter: Filter = {
        kinds: [KIND_APP_HANDLER],
        authors: [identity.publicKey],
        '#t': ['elisym'],
      };
      const events = await client.pool.querySync(filter);
      for (const event of events) {
        let cardName: string | undefined;
        try {
          const parsed = JSON.parse(event.content) as { name?: unknown };
          if (typeof parsed.name === 'string') {
            cardName = parsed.name;
          }
        } catch {
          continue;
        }
        if (!cardName || keepNames.has(cardName)) {
          continue;
        }
        try {
          await client.discovery.deleteCapability(identity, cardName);
          logger.info({ name: cardName }, 'removed stale capability card');
        } catch (error) {
          logger.warn({ err: error, name: cardName }, 'stale card removal failed');
        }
      }
    } catch (error) {
      logger.debug({ err: error }, 'stale-card query failed (non-fatal)');
    }
  }

  override async stop(): Promise<void> {
    if (this.unregisterResetListener) {
      this.unregisterResetListener();
      this.unregisterResetListener = undefined;
    }
    try {
      const pluginState = getState(this.runtime);
      pluginState.llmHeartbeat?.stop();
      pluginState.llmHeartbeat = undefined;
      pluginState.skills = undefined;
      pluginState.defaultSkillLlm = undefined;
      pluginState.getLlm = undefined;
      pluginState.llmHealthMonitor = undefined;
      pluginState.agentDefaultLlm = undefined;
    } catch {
      // state not initialized - nothing to clear
    }
    try {
      this.sub?.close('provider stopping');
    } catch (error) {
      logger.warn({ err: error }, 'provider subscription close failed');
    }
    if (this.publishedCards.length > 0) {
      const elisym = this.runtime.getService<ElisymService>(SERVICE_TYPES.ELISYM);
      if (elisym) {
        const client = elisym.getClient();
        const identity = elisym.getIdentity();
        for (const card of this.publishedCards) {
          try {
            await client.discovery.deleteCapability(identity, card.name);
          } catch (error) {
            logger.warn({ err: error, name: card.name }, 'capability card retraction failed');
          }
        }
      }
      this.publishedCards = [];
    }
  }
}

function buildCard(
  product: ProviderProduct,
  address: string,
  network: ElisymConfig['network'],
  skills: readonly import('@elisym/sdk/skills').Skill[],
): ProductCard {
  // Match the skill that produced this product (by name) to surface its
  // `mode`. Static modes hint the webapp to hide its input box.
  const matchingSkill = skills.find((skill) => skill.name === product.name);
  const isStatic = matchingSkill?.mode === 'static-file' || matchingSkill?.mode === 'static-script';
  return {
    name: product.name,
    description: product.description,
    capabilities: [...product.capabilities],
    ...(isStatic ? { static: true as const } : {}),
    payment: {
      chain: 'solana',
      network,
      address,
      job_price: Number(product.priceSubunits),
      token: product.asset.token,
      ...(product.asset.mint ? { mint: product.asset.mint } : {}),
      decimals: product.asset.decimals,
      symbol: product.asset.symbol,
    },
  };
}
