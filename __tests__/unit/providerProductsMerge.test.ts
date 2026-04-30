import { NATIVE_SOL, USDC_SOLANA_DEVNET } from '@elisym/sdk';
import { describe, expect, it } from 'vitest';
import type { ElisymConfig, ProviderProduct } from '../../src/environment';
import { resolveProducts } from '../../src/lib/providerProducts';
import type { Skill } from '../../src/skills';

function fakeSkill(
  name: string,
  capabilities: string[],
  priceSubunits: bigint,
  asset = NATIVE_SOL,
): Skill {
  return {
    name,
    description: `${name} description`,
    capabilities,
    priceSubunits,
    asset,
    mode: 'llm',
    async execute() {
      return { data: '' };
    },
  };
}

function baseConfig(overrides: Partial<ElisymConfig> = {}): ElisymConfig {
  return {
    network: 'devnet',
    mode: 'provider',
    signerKind: 'local',
    ...overrides,
  } as unknown as ElisymConfig;
}

describe('resolveProducts with skills', () => {
  it('returns skill-derived products when no explicit config is set', () => {
    const skills = [fakeSkill('yt', ['youtube-summary'], 2_000_000n)];
    const products = resolveProducts(baseConfig(), undefined, skills);
    expect(products).toEqual([
      {
        name: 'yt',
        description: 'yt description',
        capabilities: ['youtube-summary'],
        priceSubunits: 2_000_000n,
        asset: NATIVE_SOL,
      },
    ]);
  });

  it('carries the USDC asset through skill-derived products', () => {
    const skills = [fakeSkill('summary', ['summarization'], 10_000n, USDC_SOLANA_DEVNET)];
    const products = resolveProducts(baseConfig(), undefined, skills);
    expect(products).toEqual([
      {
        name: 'summary',
        description: 'summary description',
        capabilities: ['summarization'],
        priceSubunits: 10_000n,
        asset: USDC_SOLANA_DEVNET,
      },
    ]);
  });

  it('merges explicit products with skill-derived ones on distinct names', () => {
    const explicit: ProviderProduct = {
      name: 'explicit',
      description: 'x',
      capabilities: ['a'],
      priceSubunits: 1_000n,
      asset: NATIVE_SOL,
    };
    const skills = [fakeSkill('skill-one', ['b'], 3_000n)];
    const products = resolveProducts(
      baseConfig({ providerProducts: [explicit] }),
      undefined,
      skills,
    );
    expect(products.map((product) => product.name).sort()).toEqual(['explicit', 'skill-one']);
  });

  it('explicit wins on name collision (skill-derived is dropped with a warn)', () => {
    const explicit: ProviderProduct = {
      name: 'collide',
      description: 'explicit',
      capabilities: ['a'],
      priceSubunits: 1_000n,
      asset: NATIVE_SOL,
    };
    const skills = [fakeSkill('collide', ['b'], 2_000n)];
    const products = resolveProducts(
      baseConfig({ providerProducts: [explicit] }),
      undefined,
      skills,
    );
    expect(products).toHaveLength(1);
    expect(products[0]?.description).toBe('explicit');
    expect(products[0]?.priceSubunits).toBe(1_000n);
  });

  it('returns legacy single product + skills when legacy vars are set', () => {
    const config = baseConfig({
      providerCapabilities: ['legacy-cap'],
      providerPriceSubunits: 500n,
      providerPriceAsset: NATIVE_SOL,
      providerName: 'legacy',
    });
    const skills = [fakeSkill('yt', ['youtube-summary'], 2_000n)];
    const products = resolveProducts(config, undefined, skills);
    expect(products.map((product) => product.name).sort()).toEqual(['legacy', 'yt']);
  });
});
