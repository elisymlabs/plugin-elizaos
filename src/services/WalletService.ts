import type { Signer } from '@elisym/sdk';
import { Service, type IAgentRuntime } from '@elizaos/core';
import type { Rpc, SolanaRpcApi } from '@solana/kit';
import { SERVICE_TYPES } from '../constants';
import { logger } from '../lib/logger';
import { createSigner, type SignerHandle, type SignerKind } from '../lib/signers';
import { createRpc, getBalanceLamports, resolveRpcUrl } from '../lib/solana';
import { getState } from '../state';

export class WalletService extends Service {
  static override serviceType = SERVICE_TYPES.WALLET;

  override capabilityDescription = 'Solana wallet for the elisym provider agent';

  private signerRef?: Signer;
  private signerKindRef?: SignerKind;
  private addressRef?: string;
  private rpcRef?: Rpc<SolanaRpcApi>;
  private rpcUrlRef?: string;

  static override async start(runtime: IAgentRuntime): Promise<WalletService> {
    const service = new WalletService(runtime);
    await service.initialize();
    return service;
  }

  private async initialize(): Promise<void> {
    const { config } = getState(this.runtime);
    this.rpcUrlRef = resolveRpcUrl(config.network, config.solanaRpcUrl);
    this.rpcRef = createRpc(this.rpcUrlRef);

    if (config.solanaPaymentAddress) {
      this.addressRef = config.solanaPaymentAddress;
      this.signerKindRef = 'external';
      logger.info(
        { network: config.network, address: this.addressRef, mode: 'public-only' },
        'WalletService ready (address-only mode; no private key in plugin)',
      );
      return;
    }

    const handle = await this.resolveSigner(config.signerKind, config.solanaPrivateKeyBase58);
    this.signerRef = handle.signer;
    this.signerKindRef = handle.kind;
    this.addressRef = handle.signer.address;
    if (handle.source === 'generated') {
      logger.warn(
        { network: config.network, address: handle.signer.address, kind: handle.kind },
        'generated new elisym Solana wallet and persisted it to agent memory; fund this address with SOL before advertising paid capabilities, and back up the key if you need cross-machine access',
      );
    } else {
      logger.info(
        {
          network: config.network,
          address: handle.signer.address,
          source: handle.source,
          kind: handle.kind,
        },
        'WalletService ready',
      );
    }
  }

  private async resolveSigner(
    kind: SignerKind,
    fromConfig: string | undefined,
  ): Promise<SignerHandle> {
    return createSigner(kind, { runtime: this.runtime, fromConfig });
  }

  override async stop(): Promise<void> {
    // @solana/kit RPC clients are stateless HTTP handles; nothing to close.
  }

  get signer(): Signer {
    if (!this.signerRef) {
      throw new Error(
        'WalletService is in address-only mode (ELISYM_SOLANA_PAYMENT_ADDRESS set); ' +
          'no signer is available. Provider flow does not require Solana signing - ' +
          'configure ELISYM_SOLANA_PRIVATE_KEY instead if you need outbound transactions.',
      );
    }
    return this.signerRef;
  }

  get hasSigner(): boolean {
    return this.signerRef !== undefined;
  }

  get signerKind(): SignerKind {
    if (!this.signerKindRef) {
      throw new Error('WalletService not initialized');
    }
    return this.signerKindRef;
  }

  get rpc(): Rpc<SolanaRpcApi> {
    if (!this.rpcRef) {
      throw new Error('WalletService not initialized');
    }
    return this.rpcRef;
  }

  get rpcUrl(): string {
    if (!this.rpcUrlRef) {
      throw new Error('WalletService not initialized');
    }
    return this.rpcUrlRef;
  }

  get address(): string {
    if (!this.addressRef) {
      throw new Error('WalletService not initialized');
    }
    return this.addressRef;
  }

  async getBalance(): Promise<bigint> {
    return getBalanceLamports(this.rpc, this.address);
  }
}
