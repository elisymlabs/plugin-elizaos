import type { ElisymIdentity } from '@elisym/sdk';
import type { HeartbeatHandle, LlmHealthMonitor } from '@elisym/sdk/llm-health';
import type { LlmClient, SkillLlmOverride } from '@elisym/sdk/skills';
import type { ElisymConfig } from './environment';
import type { SkillRegistry } from './skills';
import type { AgentDefaultLlm } from './skills/resolver';

export type ElisymNetwork = 'devnet' | 'mainnet';

export interface ElisymState {
  config: ElisymConfig;
  identity?: ElisymIdentity;
  shuttingDown?: boolean;
  skills?: SkillRegistry;
  /**
   * Agent-level LLM default. Used as a fallback when a skill does not declare
   * its own provider/model override.
   */
  agentDefaultLlm?: AgentDefaultLlm;
  /** Default `LlmClient` for skills that do not declare their own override. */
  defaultSkillLlm?: LlmClient;
  /**
   * Resolves a skill's `LlmClient` from its optional `SkillLlmOverride`. Pass
   * via `SkillContext.getLlm` so the SDK runtime can route per-skill overrides.
   */
  getLlm?: (override?: SkillLlmOverride) => LlmClient | undefined;
  /** TTL-cached LLM key health monitor armed with `verifyKeyDeep` per triple. */
  llmHealthMonitor?: LlmHealthMonitor;
  /** Periodic re-verification handle returned by `startLlmHeartbeat`. */
  llmHeartbeat?: HeartbeatHandle;
}

export type { ElisymConfig };
export type { ElisymIdentity } from '@elisym/sdk';
