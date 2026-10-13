import * as neonJs from '@cityofzion/neon-js';
import { config } from '../config';
import { KnownAccountMetadata, normalizeScriptHash, resolveKnownAccount, tryGetAddressFromScriptHash, tryGetScriptHashFromAddress } from '../metadata/known-accounts';
import { logger } from '../utils/logger';
import { createRpcClient, isDefinitiveRpcRejection, isUnsupportedRpcMethodError, toRpcUrlList } from '../utils/rpc-client';
import { OperationAbortedError, RpcDeadlineError, SubmissionOutcomeUnknownError, withRpcDeadline } from '../utils/rpc-deadline';
import { RateLimitError, ValidationError } from '../utils/errors';
import { formatContractParameters } from '../utils/contract-params';
import type { NeonAccount, NeonRpcClient } from '../types/neon';
import { calculateNetworkFee, calculateSystemFee, formatDatosAsGas, parseGasAmountToDatos, prepareTransactionForSigning } from '../utils/transaction-preparation';
import { Nep17TransferEntry, Nep17TransfersResponse, Nep11BalanceEntry, Nep11BalancesResponse, Nep11TransfersResponse, StackItem, WalletInfo } from '../types/neo';
import { assertValidRpcUrl } from '../utils/rpc-url';
import { validatePassword, validateTokenAmount } from '../utils/validation';

/**
 * Supported Neo N3 networks
 */
export enum NeoNetwork {
  MAINNET = 'mainnet',
  TESTNET = 'testnet'
}

export const NEO_NETWORK_MAGIC: Readonly<Record<NeoNetwork, number>> = Object.freeze({
  [NeoNetwork.MAINNET]: 860833102,
  [NeoNetwork.TESTNET]: 894710606,
});

export const MAX_TRANSACTION_WAIT_TIMEOUT_MS = 120_000;
export const MIN_TRANSACTION_POLL_INTERVAL_MS = 250;
const DEFAULT_MAX_CONCURRENT_TRANSACTION_WAITS = 32;
const NEO_TOKEN_HASH = '0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5';
const GAS_TOKEN_HASH = '0xd2a4cff31913016155e38e474a2c06d08be276cf';

export interface TransactionWaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  includeApplicationLog?: boolean;
  signal?: AbortSignal;
}

export interface AccountBalanceResult {
  address: unknown;
  balance: Array<{
    asset?: string;
    asset_hash: unknown;
    asset_name: string;
    amount: unknown;
    last_updated_block?: unknown;
  }>;
}

export interface ContractInvocationResult extends Record<string, unknown> {
  state: string;
  gasconsumed?: string;
  stack?: unknown[];
  exception?: string | null;
}

export interface FeeEstimate {
  networkFeeDatos: string;
  systemFeeDatos: string;
  networkFeeGas: string;
  systemFeeGas: string;
}

export interface PreparedNeoTransaction {
  rawTransaction: string;
  txid: string;
  validUntilBlock: number;
}

/**
 * Service for interacting with the Neo N3 blockchain
 */
export class NeoService {
  private rpcClient: NeonRpcClient;
  private fetchRpcVersion!: () => Promise<unknown>;
  private networkMagic?: number;
  private networkMagicRequest?: Promise<number>;
  private network: NeoNetwork;
  private readonly rpcTimeoutMs: number;
  private readonly maxTransactionWaitMs: number;
  private readonly minTransactionPollIntervalMs: number;
  private readonly maxConcurrentTransactionWaits: number;
  private readonly maxTransactionFeeDatos: bigint;
  private readonly rpcUrls: readonly string[];
  private activeTransactionWaits = 0;

  /**
   * Create a new Neo service
   * @param rpcUrl One RPC URL, or an ordered list of URLs to fail over between.
   *   Reads advance to the next entry only when an endpoint does not answer;
   *   transaction submission never retries. See utils/rpc-client.ts.
   * @param network Network type (mainnet or testnet)
   * @param options Additional service options
   */
  constructor(
    rpcUrl: string | readonly string[],
    network: NeoNetwork = NeoNetwork.MAINNET,
    options: {
      rpcTimeoutMs?: number;
      maxTransactionWaitMs?: number;
      minTransactionPollIntervalMs?: number;
      maxConcurrentTransactionWaits?: number;
      allowInsecureRpc?: boolean;
      maxTransactionFeeGas?: string;
    } = {}
  ) {
    const rpcUrls = toRpcUrlList(rpcUrl);
    if (rpcUrls.length === 0) {
      throw new Error('RPC URL is required');
    }
    this.rpcUrls = rpcUrls;

    const rpcTimeoutMs = options.rpcTimeoutMs ?? config.rpcTimeoutMs;
    if (!Number.isSafeInteger(rpcTimeoutMs) || rpcTimeoutMs <= 0) {
      throw new Error(`Invalid RPC timeout: ${rpcTimeoutMs}. Must be a positive integer.`);
    }

    try {
      // Every entry is validated, not just the first: an unusable URL in position
      // three would otherwise stay hidden until the seeds ahead of it go down.
      for (const url of rpcUrls) {
        assertValidRpcUrl(url, {
          allowInsecureRemote: options.allowInsecureRpc ?? config.allowInsecureRpc,
        });
      }
      this.rpcClient = createRpcClient(rpcUrls, rpcTimeoutMs);
      const executeRpc = this.rpcClient.execute.bind(this.rpcClient);
      this.fetchRpcVersion = () => executeRpc(
        new neonJs.rpc.Query({ method: 'getversion', params: [] })
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to initialize Neo RPC client: ${errorMessage}`);
    }

    // Validate network
    if (!Object.values(NeoNetwork).includes(network)) {
      throw new Error(`Invalid network: ${network}. Must be one of: ${Object.values(NeoNetwork).join(', ')}`);
    }

    this.network = network;
    this.rpcTimeoutMs = rpcTimeoutMs;
    this.maxTransactionWaitMs = this.requirePositiveInteger(
      options.maxTransactionWaitMs ?? MAX_TRANSACTION_WAIT_TIMEOUT_MS,
      'maxTransactionWaitMs'
    );
    this.minTransactionPollIntervalMs = this.requirePositiveInteger(
      options.minTransactionPollIntervalMs ?? MIN_TRANSACTION_POLL_INTERVAL_MS,
      'minTransactionPollIntervalMs'
    );
    this.maxConcurrentTransactionWaits = this.requirePositiveInteger(
      options.maxConcurrentTransactionWaits ?? DEFAULT_MAX_CONCURRENT_TRANSACTION_WAITS,
      'maxConcurrentTransactionWaits'
    );
    this.maxTransactionFeeDatos = parseGasAmountToDatos(
      options.maxTransactionFeeGas ?? config.maxTransactionFeeGas
    );
  }

  /**
   * Get essential blockchain information
   * @returns Object containing blockchain height and network
   */
  async getBlockchainInfo() {
    try {
      // The height and the validator set are independent reads. Awaiting them one
      // after the other made this tool cost the sum of two RPC budgets, so a single
      // slow seed was paid for twice; overlapping them costs the slower of the two.
      const [blockCount, validators] = await Promise.all([
        this.withRpcDeadline(() => this.rpcClient.getBlockCount()),
        this.getValidatorsOrEmpty(),
      ]);

      return {
        blockCount,
        height: Math.max(0, blockCount - 1),
        validators,
        network: this.network
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to get blockchain info: ${errorMessage}`);
    }
  }

  /**
   * Read the validator set, tolerating nodes that expose neither query.
   *
   * Missing validators are not a failure of getBlockchainInfo: the height is the
   * part callers depend on, so this never rejects and reports an empty set
   * instead. Keeping that swallowing here (rather than at the call site) is what
   * lets the read run alongside the height read without the two failure modes
   * getting tangled.
   * @returns The validator set, or an empty array if it cannot be read
   */
  private async getValidatorsOrEmpty(): Promise<unknown[]> {
    try {
      let validatorsResult: unknown = undefined;
      try {
        // Try execute method first
        validatorsResult = await this.withRpcDeadline(
          () => this.rpcClient.execute(new neonJs.rpc.Query({ method: 'getvalidators', params: [] }))
        );
      } catch (executeError) {
        if (!isUnsupportedRpcMethodError(executeError)) {
          throw executeError;
        }
        // Fallback to getnextblockvalidators
        try {
          validatorsResult = await this.withRpcDeadline(
            () => this.rpcClient.execute(new neonJs.rpc.Query({ method: 'getnextblockvalidators', params: [] }))
          );
        } catch (nextError) {
          logger.warn('All validator query methods failed; continuing without validators', { network: this.network, error: nextError instanceof Error ? nextError.message : String(nextError) });
        }
      }
      return Array.isArray(validatorsResult) ? validatorsResult : [];
    } catch (validatorError) {
      logger.warn('Failed to get validators; continuing without validators', { network: this.network, error: validatorError instanceof Error ? validatorError.message : String(validatorError) });
      // Continue without validators
      return [];
    }
  }

  /**
   * Get block details by height or hash
   * @param hashOrHeight Block height or hash
   * @returns Block details
   */
  async getBlock(hashOrHeight: string | number): Promise<Record<string, unknown>> {
    try {
      // Use dedicated method
      return await this.withRpcDeadline(
        () => this.rpcClient.getBlock(hashOrHeight, 1)
      ) as unknown as Record<string, unknown>;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to get block ${hashOrHeight}: ${errorMessage}`);
    }
  }

  /**
   * Read the StateService root for one block together with the current
   * StateValidator boundary. The two independent RPCs run concurrently so an
   * evidence-rich block lookup costs one upstream round-trip window.
   */
  async getStateRootValidation(blockHeight: number): Promise<Record<string, unknown>> {
    if (!Number.isSafeInteger(blockHeight) || blockHeight < 0) {
      throw new ValidationError('Block height must be a non-negative safe integer');
    }

    try {
      const [root, stateHeight] = await Promise.all([
        this.withRpcDeadline(
          () => this.rpcClient.execute(new neonJs.rpc.Query({
            method: 'getstateroot',
            params: [blockHeight],
          }))
        ),
        this.withRpcDeadline(
          () => this.rpcClient.execute(new neonJs.rpc.Query({
            method: 'getstateheight',
            params: [],
          }))
        ),
      ]);

      const heightResult = stateHeight as Record<string, unknown> | null;
      if (!root || typeof root !== 'object' || Array.isArray(root)) {
        throw new Error('getstateroot returned an invalid result');
      }
      const rootResult = root as Record<string, unknown>;
      const parseIndex = (value: unknown, field: string): number => {
        if (
          (typeof value !== 'number' && typeof value !== 'string')
          || (typeof value === 'string' && !/^\d+$/.test(value))
        ) {
          throw new Error(`${field} is not a non-negative integer`);
        }
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 0) {
          throw new Error(`${field} is not a non-negative safe integer`);
        }
        return parsed;
      };

      const rootIndex = parseIndex(rootResult.index, 'getstateroot index');
      const validatedRootIndex = parseIndex(
        heightResult?.validatedrootindex,
        'getstateheight validatedrootindex',
      );
      const localRootIndex = parseIndex(
        heightResult?.localrootindex,
        'getstateheight localrootindex',
      );
      if (rootIndex !== blockHeight) {
        throw new Error(`getstateroot returned index ${rootIndex} for requested block ${blockHeight}`);
      }
      if (
        typeof rootResult.roothash !== 'string'
        || !/^0x[0-9a-f]{64}$/i.test(rootResult.roothash)
      ) {
        throw new Error('getstateroot returned an invalid roothash');
      }

      return {
        blockHeight,
        root: rootResult,
        localRootIndex,
        validatedRootIndex,
        validated: blockHeight <= validatedRootIndex,
        network: this.network,
      };
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to validate state root at block ${blockHeight}: ${errorMessage}`);
    }
  }


  private enrichKnownParty(reference: string | null | undefined): { address?: string; scriptHash?: string; displayName?: string; name?: string; logo?: string; kind?: KnownAccountMetadata['kind']; knownAccount?: KnownAccountMetadata } | null {
    const scriptHash = normalizeScriptHash(reference) ?? tryGetScriptHashFromAddress(reference);
    const address = (reference && !normalizeScriptHash(reference) ? reference : null) ?? tryGetAddressFromScriptHash(scriptHash);
    const knownAccount = resolveKnownAccount(reference ?? scriptHash ?? undefined, this.network) ?? (scriptHash ? resolveKnownAccount(scriptHash, this.network) : null);

    if (!address && !scriptHash && !knownAccount) {
      return null;
    }

    return {
      ...(address ? { address } : {}),
      ...(scriptHash ? { scriptHash } : {}),
      ...((knownAccount || address || scriptHash)
        ? { displayName: knownAccount?.name ?? address ?? scriptHash ?? undefined }
        : {}),
      ...(knownAccount?.name ? { name: knownAccount.name } : {}),
      ...(knownAccount?.logo ? { logo: knownAccount.logo } : {}),
      ...(knownAccount?.kind ? { kind: knownAccount.kind } : {}),
      ...(knownAccount ? { knownAccount } : {}),
    };
  }

  private normalizeHash160FromStackItem(item: StackItem): string | null {
    if (!item || typeof item !== 'object') {
      return null;
    }

    const value = typeof item.value === 'string' ? item.value.trim() : '';
    if (!value) {
      return null;
    }

    if (item.type === 'Hash160') {
      return normalizeScriptHash(value);
    }

    if (item.type === 'ByteString' || item.type === 'ByteArray') {
      const unprefixedHex = value.replace(/^0x/i, '');
      if (/^[0-9a-fA-F]{40}$/.test(unprefixedHex)) {
        return normalizeScriptHash(Buffer.from(unprefixedHex, 'hex').reverse().toString('hex'));
      }

      try {
        const bytes = Buffer.from(value, 'base64');
        if (bytes.length === 20) {
          return normalizeScriptHash(Buffer.from(bytes).reverse().toString('hex'));
        }

        const decodedText = bytes.toString('utf8');
        return normalizeScriptHash(decodedText) ?? tryGetScriptHashFromAddress(decodedText);
      } catch {
        return null;
      }
    }

    if (item.type === 'String') {
      return tryGetScriptHashFromAddress(value) ?? normalizeScriptHash(value);
    }

    return null;
  }

  private parseTransferParticipant(item: StackItem) {
    if (!item || item.type === 'Any' || item.type === 'Null') {
      return null;
    }

    const scriptHash = this.normalizeHash160FromStackItem(item);
    if (scriptHash) {
      return this.enrichKnownParty(scriptHash) ?? { scriptHash };
    }

    if (typeof item.value === 'string') {
      return this.enrichKnownParty(item.value) ?? { value: item.value };
    }

    return null;
  }

  private parseTransferAmount(item: StackItem): string | null {
    if (!item || typeof item !== 'object') {
      return null;
    }

    if (item.type === 'Integer') {
      return String(item.value);
    }

    if ((item.type === 'ByteString' || item.type === 'ByteArray') && typeof item.value === 'string') {
      try {
        return Buffer.from(item.value, 'base64').toString('utf8');
      } catch {
        return String(item.value);
      }
    }

    if (item.value !== undefined && item.value !== null) {
      return String(item.value);
    }

    return null;
  }

  private parseTokenId(item: StackItem): string | null {
    if (!item || typeof item !== 'object' || item.value === undefined || item.value === null) {
      return null;
    }
    if ((item.type === 'ByteString' || item.type === 'ByteArray') && typeof item.value === 'string') {
      try {
        return Buffer.from(item.value, 'base64').toString('hex');
      } catch {
        return item.value;
      }
    }
    return String(item.value);
  }

  private buildAssetDescriptor(reference: string | null | undefined) {
    const scriptHash = normalizeScriptHash(reference);
    const knownAccount = resolveKnownAccount(reference ?? scriptHash ?? undefined, this.network) ?? (scriptHash ? resolveKnownAccount(scriptHash, this.network) : null);
    const address = tryGetAddressFromScriptHash(scriptHash);

    return {
      ...(scriptHash ? { scriptHash } : {}),
      ...(address ? { address } : {}),
      ...(knownAccount?.symbol ? { symbol: knownAccount.symbol } : {}),
      name: knownAccount?.name ?? scriptHash ?? undefined,
      ...(knownAccount?.logo ? { logo: knownAccount.logo } : {}),
      ...(knownAccount ? { knownAccount } : {}),
    };
  }

  private buildTransferHistoryEntry(entry: Nep17TransferEntry, accountAddress: string, direction: 'sent' | 'received') {
    if (!entry || typeof entry !== 'object') {
      return entry;
    }

    const selfParty = this.enrichKnownParty(accountAddress) ?? { address: accountAddress };
    const counterparty = this.enrichKnownParty(entry.transferaddress) ?? (entry.transferaddress ? { address: entry.transferaddress } : null);
    const from = direction === 'sent' ? selfParty : counterparty;
    const to = direction === 'sent' ? counterparty : selfParty;
    const timestampMs = typeof entry.timestamp === 'number'
      ? entry.timestamp
      : (typeof entry.timestamp === 'string' && /^\d+$/.test(entry.timestamp) ? Number.parseInt(entry.timestamp, 10) : null);

    return {
      ...entry,
      direction,
      ...(timestampMs !== null && Number.isFinite(timestampMs)
        ? { timestampIso: new Date(timestampMs).toISOString() }
        : {}),
      ...(entry.assethash ? { asset: this.buildAssetDescriptor(entry.assethash) } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(counterparty ? { counterparty } : {}),
    };
  }

  private enrichNep17Transfers(transfers: Nep17TransfersResponse, accountAddress: string) {
    if (!transfers || typeof transfers !== 'object') {
      return transfers;
    }

    return {
      ...transfers,
      sent: Array.isArray(transfers.sent)
        ? transfers.sent.map((entry: Nep17TransferEntry) => this.buildTransferHistoryEntry(entry, accountAddress, 'sent'))
        : transfers.sent,
      received: Array.isArray(transfers.received)
        ? transfers.received.map((entry: Nep17TransferEntry) => this.buildTransferHistoryEntry(entry, accountAddress, 'received'))
        : transfers.received,
    };
  }

  private buildNep11BalanceEntry(entry: Nep11BalanceEntry) {
    if (!entry || typeof entry !== 'object') {
      return entry;
    }

    return {
      ...entry,
      ...(entry.assethash ? { asset: this.buildAssetDescriptor(entry.assethash) } : {}),
      ...(Array.isArray(entry.tokens) ? { tokenCount: entry.tokens.length } : {}),
    };
  }

  private enrichNep11Balances(balances: Nep11BalancesResponse) {
    if (!balances || typeof balances !== 'object') {
      return balances;
    }

    return {
      ...balances,
      balance: Array.isArray(balances.balance)
        ? balances.balance.map((entry: Nep11BalanceEntry) => this.buildNep11BalanceEntry(entry))
        : balances.balance,
    };
  }

  private enrichNep11Transfers(transfers: Nep11TransfersResponse, accountAddress: string) {
    if (!transfers || typeof transfers !== 'object') {
      return transfers;
    }

    return {
      ...transfers,
      sent: Array.isArray(transfers.sent)
        ? transfers.sent.map((entry: Nep17TransferEntry) => this.buildTransferHistoryEntry(entry, accountAddress, 'sent'))
        : transfers.sent,
      received: Array.isArray(transfers.received)
        ? transfers.received.map((entry: Nep17TransferEntry) => this.buildTransferHistoryEntry(entry, accountAddress, 'received'))
        : transfers.received,
    };
  }

  private enrichNotification(notification: Record<string, unknown>): Record<string, unknown> {
    if (!notification || typeof notification !== 'object') {
      return notification;
    }

    const eventName = notification.eventname ?? notification.eventName;
    const notifState = notification.state as Record<string, unknown> | undefined;
    const stateValues = Array.isArray(notifState?.value) ? notifState.value as StackItem[] : null;
    if (eventName !== 'Transfer' || !stateValues || stateValues.length < 3) {
      return notification;
    }

    const contractOrHash = notification.contract ?? notification.scriptHash;
    const contractReference = typeof contractOrHash === 'string' ? contractOrHash : undefined;
    const isNep11Transfer = stateValues.length >= 4;
    const parsed = {
      type: isNep11Transfer ? 'nep11_transfer' : 'nep17_transfer',
      contract: this.enrichKnownParty(contractReference) ?? { ...(normalizeScriptHash(contractReference) ? { scriptHash: normalizeScriptHash(contractReference) } : {}) },
      asset: this.buildAssetDescriptor(contractReference),
      from: this.parseTransferParticipant(stateValues[0]),
      to: this.parseTransferParticipant(stateValues[1]),
      amount: this.parseTransferAmount(stateValues[2]),
      ...(isNep11Transfer ? { tokenId: this.parseTokenId(stateValues[3]) } : {}),
    };

    return {
      ...notification,
      parsed,
    };
  }

  private enrichApplicationLog(applicationLog: Record<string, unknown>) {
    if (!applicationLog || typeof applicationLog !== 'object' || !Array.isArray(applicationLog.executions)) {
      return applicationLog;
    }

    return {
      ...applicationLog,
      executions: (applicationLog.executions as Record<string, unknown>[]).map((execution: Record<string, unknown>) => ({
        ...execution,
        notifications: Array.isArray(execution?.notifications)
          ? (execution.notifications as Record<string, unknown>[]).map((notification: Record<string, unknown>) => this.enrichNotification(notification))
          : execution?.notifications,
      })),
    };
  }

  private enrichTransaction(transaction: Record<string, unknown>) {
    if (!transaction || typeof transaction !== 'object') {
      return transaction;
    }

    const senderInfo = typeof transaction.sender === 'string'
      ? this.enrichKnownParty(transaction.sender)
      : null;

    return senderInfo
      ? {
          ...transaction,
          senderInfo,
        }
      : transaction;
  }

  /**
   * Get transaction details by hash
   * @param txid Transaction hash
   * @returns Transaction details
   */
  async getTransaction(txid: string) {
    try {
      try {
        return this.enrichTransaction(await this.withRpcDeadline(
          () => this.rpcClient.getRawTransaction(txid, true)
        ) as unknown as Record<string, unknown>);
      } catch (directError) {
        if (!isUnsupportedRpcMethodError(directError)) {
          throw directError;
        }
        logger.warn('Direct getRawTransaction failed; trying query fallback', { txid, error: directError instanceof Error ? directError.message : String(directError) });
        return this.enrichTransaction(await this.withRpcDeadline(
          () => this.rpcClient.execute(new neonJs.rpc.Query({ method: 'getrawtransaction', params: [txid, 1] }))
        ) as Record<string, unknown>);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to get transaction ${txid}: ${errorMessage}`);
    }
  }

  /**
   * Get the application log for a transaction.
   * @param txid Transaction hash
   * @returns Application log payload
   */
  async getApplicationLog(txid: string) {
    try {
      return this.enrichApplicationLog(await this.withRpcDeadline(
        () => this.rpcClient.getApplicationLog(txid)
      ) as unknown as Record<string, unknown>);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to get application log for ${txid}: ${errorMessage}`);
    }
  }

  /**
   * Get the amount of claimable GAS for an address.
   * @param address Neo N3 address
   * @returns Unclaimed GAS summary
   */
  async getUnclaimedGas(address: string) {
    try {
      const unclaimedGas = await this.withRpcDeadline(() => this.rpcClient.getUnclaimedGas(address));
      return {
        address,
        unclaimedGas: typeof unclaimedGas === 'string' ? unclaimedGas : String(unclaimedGas),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to get unclaimed GAS for ${address}: ${errorMessage}`);
    }
  }

  /**
   * Get NEP-17 transfer history for an address.
   * @param address Neo N3 address
   * @param options Optional timestamp filters in Unix epoch milliseconds
   * @returns Transfer history payload from RPC with additive enrichment
   */
  async getNep17Transfers(
    address: string,
    options: {
      fromTimestampMs?: number,
      toTimestampMs?: number,
    } = {}
  ) {
    try {
      if (!address || typeof address !== 'string') {
        throw new Error('Invalid address format');
      }

      if (options.fromTimestampMs !== undefined && (!Number.isInteger(options.fromTimestampMs) || options.fromTimestampMs < 0)) {
        throw new Error(`Invalid fromTimestampMs: ${options.fromTimestampMs}`);
      }

      if (options.toTimestampMs !== undefined && (!Number.isInteger(options.toTimestampMs) || options.toTimestampMs < 0)) {
        throw new Error(`Invalid toTimestampMs: ${options.toTimestampMs}`);
      }

      if (options.fromTimestampMs !== undefined && options.toTimestampMs !== undefined && options.fromTimestampMs > options.toTimestampMs) {
        throw new Error('fromTimestampMs must be less than or equal to toTimestampMs');
      }

      const params: Array<string | number> = [address];
      if (options.fromTimestampMs !== undefined) {
        params.push(options.fromTimestampMs);
      }
      if (options.toTimestampMs !== undefined) {
        if (options.fromTimestampMs === undefined) {
          params.push(0);
        }
        params.push(options.toTimestampMs);
      }

      const transfers = await this.withRpcDeadline(
        () => this.rpcClient.execute(new neonJs.rpc.Query({
          method: 'getnep17transfers',
          params,
        }))
      );

      return this.enrichNep17Transfers(transfers as Nep17TransfersResponse, address);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to get NEP-17 transfers for address ${address}: ${errorMessage}`);
    }
  }

  /**
   * Get NEP-11 balances for an address.
   * @param address Neo N3 address
   * @returns NFT balance payload from RPC with additive enrichment
   */
  async getNep11Balances(address: string) {
    try {
      if (!address || typeof address !== 'string') {
        throw new Error('Invalid address format');
      }

      const balances = await this.withRpcDeadline(
        () => this.rpcClient.execute(new neonJs.rpc.Query({
          method: 'getnep11balances',
          params: [address],
        }))
      );

      return this.enrichNep11Balances(balances as Nep11BalancesResponse);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to get NEP-11 balances for address ${address}: ${errorMessage}`);
    }
  }

  /**
   * Get NEP-11 transfer history for an address.
   * @param address Neo N3 address
   * @param options Optional timestamp filters in Unix epoch milliseconds
   * @returns NFT transfer history payload from RPC with additive enrichment
   */
  async getNep11Transfers(
    address: string,
    options: {
      fromTimestampMs?: number,
      toTimestampMs?: number,
    } = {}
  ) {
    try {
      if (!address || typeof address !== 'string') {
        throw new Error('Invalid address format');
      }

      if (options.fromTimestampMs !== undefined && (!Number.isInteger(options.fromTimestampMs) || options.fromTimestampMs < 0)) {
        throw new Error(`Invalid fromTimestampMs: ${options.fromTimestampMs}`);
      }

      if (options.toTimestampMs !== undefined && (!Number.isInteger(options.toTimestampMs) || options.toTimestampMs < 0)) {
        throw new Error(`Invalid toTimestampMs: ${options.toTimestampMs}`);
      }

      if (options.fromTimestampMs !== undefined && options.toTimestampMs !== undefined && options.fromTimestampMs > options.toTimestampMs) {
        throw new Error('fromTimestampMs must be less than or equal to toTimestampMs');
      }

      const params: Array<string | number> = [address];
      if (options.fromTimestampMs !== undefined) {
        params.push(options.fromTimestampMs);
      }
      if (options.toTimestampMs !== undefined) {
        if (options.fromTimestampMs === undefined) {
          params.push(0);
        }
        params.push(options.toTimestampMs);
      }

      const transfers = await this.withRpcDeadline(
        () => this.rpcClient.execute(new neonJs.rpc.Query({
          method: 'getnep11transfers',
          params,
        }))
      );

      return this.enrichNep11Transfers(transfers as Nep11TransfersResponse, address);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to get NEP-11 transfers for address ${address}: ${errorMessage}`);
    }
  }

  /**
   * Poll for a transaction to be confirmed on-chain.
   * @param txid Transaction hash
   * @param options Polling options
   * @returns Confirmation status and transaction details
   */
  async waitForTransaction(
    txid: string,
    options: TransactionWaitOptions = {}
  ) {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const pollIntervalMs = options.pollIntervalMs ?? 1_000;
    const includeApplicationLog = options.includeApplicationLog ?? false;
    const signal = options.signal;
    this.validateTransactionWaitOptions(timeoutMs, pollIntervalMs);
    if (signal?.aborted) {
      throw new OperationAbortedError();
    }
    if (this.activeTransactionWaits >= this.maxConcurrentTransactionWaits) {
      throw new RateLimitError('Too many concurrent transaction wait requests', { retryAfter: 1 });
    }

    this.activeTransactionWaits += 1;
    try {
      return await this.pollForTransaction(txid, timeoutMs, pollIntervalMs, includeApplicationLog, signal);
    } finally {
      this.activeTransactionWaits -= 1;
    }
  }

  private async pollForTransaction(
    txid: string,
    timeoutMs: number,
    pollIntervalMs: number,
    includeApplicationLog: boolean,
    signal?: AbortSignal
  ) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() <= deadline) {
      if (signal?.aborted) {
        throw new OperationAbortedError();
      }
      try {
        const blockHeight = await this.withRpcDeadline(
          () => this.rpcClient.getTransactionHeight(txid),
          Math.min(this.rpcTimeoutMs, deadline - Date.now()),
          signal
        );
        const result: Record<string, unknown> = {
          txid,
          confirmed: true,
          blockHeight,
        };

        try {
          result.transaction = await this.withRpcDeadline(
            () => this.getTransaction(txid),
            Math.min(this.rpcTimeoutMs, deadline - Date.now()),
            signal
          );
        } catch (error) {
          if (!(error instanceof RpcDeadlineError)) {
            throw error;
          }
          result.transactionError = 'Transaction details were not available before the timeout';
        }

        if (includeApplicationLog) {
          try {
            result.applicationLog = await this.withRpcDeadline(
              () => this.getApplicationLog(txid),
              Math.min(this.rpcTimeoutMs, deadline - Date.now()),
              signal
            );
          } catch (error) {
            result.applicationLogError = error instanceof RpcDeadlineError
              ? 'Application log was not available before the timeout'
              : 'Application log unavailable';
          }
        }

        return result;
      } catch (error) {
        if (error instanceof OperationAbortedError) {
          throw error;
        }
        if (error instanceof RpcDeadlineError) {
          if (Date.now() >= deadline) {
            break;
          }
        } else {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const retryable = /unknown|not found|pending|mempool|missing/i.test(errorMessage);
          if (!retryable) {
            throw new Error(`Failed while waiting for transaction ${txid}: ${errorMessage}`);
          }
        }
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      await this.waitForPollInterval(Math.min(pollIntervalMs, remainingMs), signal);
    }

    return {
      txid,
      confirmed: false,
      timeoutMs,
      pollIntervalMs,
    };
  }

  private validateTransactionWaitOptions(timeoutMs: number, pollIntervalMs: number): void {
    this.requirePositiveInteger(timeoutMs, 'timeoutMs');
    this.requirePositiveInteger(pollIntervalMs, 'pollIntervalMs');
    if (timeoutMs > this.maxTransactionWaitMs) {
      throw new RangeError(`timeoutMs must not exceed ${this.maxTransactionWaitMs}`);
    }
    if (pollIntervalMs < this.minTransactionPollIntervalMs) {
      throw new RangeError(`pollIntervalMs must be at least ${this.minTransactionPollIntervalMs}`);
    }
  }

  private requirePositiveInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive integer`);
    }
    return value;
  }

  private waitForPollInterval(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new OperationAbortedError());
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, delayMs);
      const onAbort = () => {
        clearTimeout(timeout);
        reject(new OperationAbortedError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async withRpcDeadline<T>(
    operation: () => Promise<T>,
    timeoutMs = this.rpcTimeoutMs,
    signal?: AbortSignal
  ): Promise<T> {
    await this.getNetworkMagic();
    return await withRpcDeadline(operation, timeoutMs, signal);
  }

  /**
   * Get account balance for a specific address
   * @param address Neo N3 address
   * @returns Balance information
   */
  async getBalance(address: string): Promise<AccountBalanceResult> {
    try {
      if (!address || typeof address !== 'string') {
        throw new Error('Invalid address format');
      }

      try {
        // Try to use execute method for getNep17Balances
        const query = new neonJs.rpc.Query({ method: 'getnep17balances', params: [address] });
        const balanceResultRaw = await this.withRpcDeadline(() => this.rpcClient.execute(query));
        const balanceResult = balanceResultRaw as Record<string, unknown> | undefined;
        if (balanceResult && balanceResult.balance) {
          return {
            address: balanceResult.address,
            balance: (balanceResult.balance as Record<string, unknown>[]).map((item: Record<string, unknown>) => ({
              asset_hash: item.assethash,
              amount: item.amount,
              asset_name: typeof item.assethash === 'string' ? this.getAssetNameByHash(item.assethash) : '',
              last_updated_block: item.lastupdatedblock
            }))
          };
        }
      } catch (nep17Error) {
        if (!isUnsupportedRpcMethodError(nep17Error)) {
          throw nep17Error;
        }
        logger.warn('getnep17balances failed; trying alternative balance lookup', { address, error: nep17Error instanceof Error ? nep17Error.message : String(nep17Error) });

        // Try to get NEO and GAS balances directly
        try {
          const neoHash = '0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5'; // NEO hash
          const gasHash = '0xd2a4cff31913016155e38e474a2c06d08be276cf'; // GAS hash

          // Create a script to get NEO balance
          const neoScript = neonJs.sc.createScript({
            scriptHash: neoHash,
            operation: 'balanceOf',
            args: [neonJs.sc.ContractParam.hash160(address)]
          });

          // Create a script to get GAS balance
          const gasScript = neonJs.sc.createScript({
            scriptHash: gasHash,
            operation: 'balanceOf',
            args: [neonJs.sc.ContractParam.hash160(address)]
          });

          // Execute the scripts together: the two balances are independent reads,
          // and this is already the slow fallback path, so paying two RPC budgets
          // in sequence is the difference between a usable answer and a timeout.
          const [neoResult, gasResult] = await Promise.all([
            this.withRpcDeadline(
              () => this.rpcClient.invokeScript(neonJs.u.HexString.fromHex(neoScript), [])
            ),
            this.withRpcDeadline(
              () => this.rpcClient.invokeScript(neonJs.u.HexString.fromHex(gasScript), [])
            ),
          ]);

          // Extract balances from results
          const extractBalance = (result: typeof neoResult, asset: string): string => {
            const value = result.stack?.[0]?.value;
            if (result.state !== 'HALT'
              || (typeof value !== 'string' && typeof value !== 'number')
              || !/^\d+$/.test(String(value))) {
              throw new Error(`Neo RPC returned an invalid ${asset} balance response`);
            }
            return String(value);
          };
          const neoBalance = extractBalance(neoResult, 'NEO');
          const gasBalance = extractBalance(gasResult, 'GAS');

          return {
            address,
            balance: [
              {
                asset: 'NEO',
                asset_hash: neoHash,
                asset_name: 'NEO',
                amount: neoBalance
              },
              {
                asset: 'GAS',
                asset_hash: gasHash,
                asset_name: 'GAS',
                amount: gasBalance
              }
            ]
          };
        } catch (invokeError) {
          throw new Error(`Invoke script approach also failed: ${invokeError instanceof Error ? invokeError.message : String(invokeError)}`);
        }
      }

      throw new Error(`No balance data returned for address ${address}`);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to get balance for address ${address}: ${errorMessage}`);
    }
  }

  /**
   * Get asset name by hash
   * @param assetHash Asset hash
   * @returns Asset name or hash if not found
   */
  private getAssetNameByHash(assetHash: string): string {
    // Common NEO and GAS asset hashes (same for mainnet and testnet)
    const assetNames: Record<string, string> = {
      '0xd2a4cff31913016155e38e474a2c06d08be276cf': 'GAS',
      '0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5': 'NEO'
    };

    return assetNames[assetHash.toLowerCase()] || assetHash;
  }

  private assertNoAdditionalTransactionAttributes(additionalScriptAttributes: unknown[]): void {
    if (additionalScriptAttributes.length > 0) {
      throw new Error('Additional transaction attributes are not supported');
    }
  }

  private scaleTokenAmount(amount: string, decimals: number): string {
    if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
      throw new Error(`Invalid token decimals: ${decimals}`);
    }
    const amountText = validateTokenAmount(amount);

    const [whole, fraction = ''] = amountText.split('.');
    if (fraction.length > decimals) {
      throw new Error(`Transfer amount has more than ${decimals} decimal places`);
    }

    const scaledAmount = BigInt(`${whole}${fraction.padEnd(decimals, '0')}`);
    if (scaledAmount <= 0n) {
      throw new Error(`Invalid transfer amount: ${amount}`);
    }
    if (scaledAmount > (1n << 255n) - 1n) {
      throw new Error('Scaled transfer amount exceeds the Neo VM integer range');
    }

    return scaledAmount.toString();
  }

  private async buildNep17TransferScript(
    fromAddress: string,
    toAddress: string,
    asset: string,
    amount: string
  ) {
    if (!this.isValidNeoAddress(fromAddress)) {
      throw new Error(`Invalid sender address format: ${fromAddress}`);
    }
    if (!this.isValidNeoAddress(toAddress)) {
      throw new Error(`Invalid recipient address format: ${toAddress}`);
    }
    const contractHash = normalizeScriptHash(asset) ?? this.getAssetHash(asset);
    const contractHashHex = neonJs.u.HexString.fromHex(this.stripHexPrefix(contractHash));
    const networkMagic = await this.getNetworkMagic();
    let decimals: number;
    if (contractHash.toLowerCase() === NEO_TOKEN_HASH) {
      decimals = 0;
    } else if (contractHash.toLowerCase() === GAS_TOKEN_HASH) {
      decimals = 8;
    } else {
      const decimalsResult = await this.withRpcDeadline(
        () => this.rpcClient.invokeFunction(contractHash, 'decimals', [])
      );
      const decimalsValue = decimalsResult.stack?.[0]?.value;
      decimals = typeof decimalsValue === 'number'
        ? decimalsValue
        : typeof decimalsValue === 'string' && /^\d+$/.test(decimalsValue)
          ? Number(decimalsValue)
          : Number.NaN;
      if (decimalsResult.state !== 'HALT' || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
        throw new Error(`Failed to determine token decimals for ${contractHash}`);
      }
    }
    const scaledAmount = this.scaleTokenAmount(amount, decimals);
    const builder = new neonJs.sc.ScriptBuilder();
    builder.emitAppCall(contractHashHex, 'transfer', [
      neonJs.u.HexString.fromHex(neonJs.wallet.getScriptHashFromAddress(fromAddress)),
      neonJs.u.HexString.fromHex(neonJs.wallet.getScriptHashFromAddress(toAddress)),
      neonJs.sc.ContractParam.integer(scaledAmount),
      neonJs.sc.ContractParam.any(null),
    ]);
    builder.emit(neonJs.sc.OpCode.ASSERT);

    return {
      networkMagic,
      script: neonJs.u.HexString.fromHex(builder.build()),
    };
  }

  private async prepareSignedTransaction(
    account: NeonAccount,
    script: ReturnType<typeof neonJs.u.HexString.fromHex>,
    providedNetworkMagic?: number
  ): Promise<PreparedNeoTransaction> {
    if (!this.isValidNeoAddress(account.address)) {
      throw new ValidationError(`Invalid sender address: ${account.address}`);
    }
    const networkMagic = providedNetworkMagic ?? await this.getNetworkMagic();
    const transaction = new neonJs.tx.Transaction();
    transaction.script = script;
    transaction.addSigner({
      account: account.scriptHash || neonJs.wallet.getScriptHashFromAddress(account.address),
      scopes: neonJs.tx.WitnessScope.CalledByEntry,
    });
    await prepareTransactionForSigning(transaction, account, this.rpcClient, {
      maxTransactionFeeDatos: this.maxTransactionFeeDatos,
    });
    transaction.sign(account, networkMagic);

    const transactionHash = transaction.hash();
    const txid = transactionHash.startsWith('0x')
      ? transactionHash
      : `0x${transactionHash}`;
    return {
      rawTransaction: transaction.serialize(true),
      txid,
      validUntilBlock: transaction.validUntilBlock,
    };
  }

  async submitPreparedTransaction(prepared: PreparedNeoTransaction): Promise<string> {
    if (!/^[0-9a-fA-F]+$/.test(prepared.rawTransaction) || prepared.rawTransaction.length % 2 !== 0) {
      throw new ValidationError('Prepared transaction must contain even-length hexadecimal bytes');
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(prepared.txid)) {
      throw new ValidationError('Prepared transaction ID must be a 32-byte hash');
    }
    try {
      const submittedTxid = await this.withRpcDeadline(
        () => this.rpcClient.sendRawTransaction(neonJs.u.HexString.fromHex(prepared.rawTransaction))
      );
      const normalizedSubmittedTxid = typeof submittedTxid === 'string'
        ? (submittedTxid.startsWith('0x') ? submittedTxid : `0x${submittedTxid}`).toLowerCase()
        : '';
      if (normalizedSubmittedTxid !== prepared.txid.toLowerCase()) {
        throw new SubmissionOutcomeUnknownError(prepared.txid, 'inconsistent_response');
      }
      return prepared.txid;
    } catch (error) {
      if (error instanceof SubmissionOutcomeUnknownError || error instanceof ValidationError) {
        throw error;
      }
      if (error instanceof RpcDeadlineError) {
        throw new SubmissionOutcomeUnknownError(prepared.txid, this.rpcTimeoutMs);
      }
      if (isDefinitiveRpcRejection(error)) {
        throw error;
      }
      throw new SubmissionOutcomeUnknownError(prepared.txid, 'transport_error');
    }
  }

  private async signAndSubmitTransaction(
    account: NeonAccount,
    script: ReturnType<typeof neonJs.u.HexString.fromHex>,
    providedNetworkMagic?: number
  ): Promise<string> {
    return await this.submitPreparedTransaction(
      await this.prepareSignedTransaction(account, script, providedNetworkMagic)
    );
  }

  async prepareTransferTransaction(
    fromAccount: NeonAccount,
    toAddress: string,
    asset: string,
    amount: string
  ): Promise<PreparedNeoTransaction> {
    const { networkMagic, script } = await this.buildNep17TransferScript(
      fromAccount.address,
      toAddress,
      asset,
      amount
    );
    return await this.prepareSignedTransaction(fromAccount, script, networkMagic);
  }

  async prepareInvokeTransaction(
    fromAccount: NeonAccount,
    scriptHash: string,
    operation: string,
    args: unknown[] = []
  ): Promise<PreparedNeoTransaction> {
    if (!scriptHash) throw new ValidationError('Script hash is required');
    if (!operation) throw new ValidationError('Operation is required');
    const script = neonJs.sc.createScript({
      scriptHash,
      operation,
      args: formatContractParameters(args),
    });
    return await this.prepareSignedTransaction(fromAccount, neonJs.u.HexString.fromHex(script));
  }

  /**
   * Transfer assets between addresses
   * @param fromAccount Sender account
   * @param toAddress Recipient address
   * @param asset Asset hash or symbol (e.g., 'NEO', 'GAS')
   * @param amount Amount to transfer
   * @param additionalScriptAttributes Additional script attributes
   * @returns Transaction details
   */
  async transferAssets(
    fromAccount: NeonAccount,
    toAddress: string,
    asset: string,
    amount: string,
    additionalScriptAttributes: unknown[] = []
  ) {
    try {
      this.assertNoAdditionalTransactionAttributes(additionalScriptAttributes);

      if (!fromAccount || !fromAccount.address) {
        throw new Error('Invalid sender account: missing address');
      }

      if (!toAddress) {
        throw new Error('Recipient address is required');
      }

      // Ensure addresses are strings, not objects
      const fromAddress = typeof fromAccount.address === 'string'
        ? fromAccount.address
        : String(fromAccount.address);

      if (!this.isValidNeoAddress(fromAddress)) {
        throw new Error(`Invalid sender address format: ${fromAddress}`);
      }

      if (!this.isValidNeoAddress(toAddress)) {
        throw new Error(`Invalid recipient address format: ${toAddress}`);
      }

      const prepared = await this.prepareTransferTransaction(fromAccount, toAddress, asset, amount);
      const txid = await this.submitPreparedTransaction(prepared);
      return { txid };
    } catch (error) {
      if (error instanceof SubmissionOutcomeUnknownError || error instanceof ValidationError) {
        throw error;
      }
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to transfer assets: ${errorMessage}`);
    }
  }

  /**
   * Invoke a smart contract method for READ-ONLY operations.
   * Uses invokeScript RPC method.
   * @param scriptHash Contract script hash
   * @param operation Method name
   * @param args Method arguments
   * @returns The result of the invokeScript call (state, gasconsumed, stack, etc.)
   */
  async invokeReadContract(
    scriptHash: string,
    operation: string,
    args: unknown[] = []
  ): Promise<ContractInvocationResult> {
    try {
      if (!scriptHash) throw new Error('Script hash is required');
      if (!operation) throw new Error('Operation is required');

      const script = neonJs.sc.createScript({
        scriptHash,
        operation,
        args: formatContractParameters(args),
      });
      const scriptHexString = neonJs.u.HexString.fromHex(script);

      // Use invokeScript for read-only calls, explicitly pass empty signers
      const result = await this.withRpcDeadline(
        () => this.rpcClient.invokeScript(scriptHexString, [])
      ) as unknown as ContractInvocationResult;
      if (result.state !== 'HALT') {
        throw new Error(`VM execution ${result.state}: ${JSON.stringify({
          exception: result.exception ?? null,
          gasconsumed: result.gasconsumed,
          stack: result.stack,
        })}`);
      }
      return result;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to invoke read contract', { scriptHash, operation, error: errorMessage });
      throw new Error(`Failed to invoke read contract ${scriptHash}.${operation}: ${errorMessage}`);
    }
  }

  /**
   * Simulate a contract call via the node's `invokefunction` RPC in TEST mode.
   *
   * This is a READ-ONLY preview: it never signs and never calls
   * `sendrawtransaction`. It supports witness-scoped `signers` so callers can
   * preview transfers and other CheckWitness-gated methods. Used to attach a
   * dry-run preview to UNSIGNED transaction proposals.
   *
   * @param scriptHash Contract script hash (0x-prefixed).
   * @param operation  Method name.
   * @param params     Contract parameters, already in ContractParam JSON form ({type, value}).
   * @param signers    RPC signer objects ([{account: '0x..', scopes: 'CalledByEntry'}]).
   * @returns The raw invokefunction result (state, gasconsumed, exception, stack).
   */
  async testInvoke(
    scriptHash: string,
    operation: string,
    params: unknown[] = [],
    signers: unknown[] = []
  ): Promise<ContractInvocationResult> {
    if (!scriptHash) throw new ValidationError('Script hash is required');
    if (!operation) throw new ValidationError('Operation is required');
    const result = await this.withRpcDeadline(
      () => this.rpcClient.execute(new neonJs.rpc.Query({
        method: 'invokefunction',
        params: [scriptHash, operation, params, signers],
      }))
    ) as unknown as ContractInvocationResult;
    return result;
  }

  /**
   * Invoke a smart contract method for WRITE operations.
   * Requires a signing account.
   * @param fromAccount Account to sign the transaction
   * @param scriptHash Contract script hash
   * @param operation Method name
   * @param args Method arguments
   * @param additionalScriptAttributes Additional script attributes
   * @returns { txid, tx } Transaction details
   */
  async invokeContract(
    fromAccount: NeonAccount,
    scriptHash: string,
    operation: string,
    args: unknown[] = [],
    additionalScriptAttributes: unknown[] = []
  ) {
    try {
      this.assertNoAdditionalTransactionAttributes(additionalScriptAttributes);

      if (!scriptHash) throw new Error('Script hash is required');
      if (!operation) throw new Error('Operation is required');

      if (!fromAccount || !fromAccount.address) throw new Error('Invalid sender account: missing address');
      const txid = await this.submitPreparedTransaction(
        await this.prepareInvokeTransaction(fromAccount, scriptHash, operation, args)
      );
      return { txid };

    } catch (error) {
      if (error instanceof SubmissionOutcomeUnknownError) {
        throw error;
      }
      if (error instanceof ValidationError) {
        throw error;
      }
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to invoke write contract', { scriptHash, operation, error: errorMessage });
      throw new Error(`Failed to invoke write contract ${scriptHash}.${operation}: ${errorMessage}`);
    }
  }

  /**
   * Get the blockchain's block count (latest block height plus one).
   * @returns The current block count.
   */
  async getBlockCount(): Promise<number> {
    try {
      return await this.withRpcDeadline(() => this.rpcClient.getBlockCount());
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to get block count: ${errorMessage}`);
    }
  }

  /**
   * Calculate the network and system fees for a transfer operation.
   * @param fromAddress Sender address
   * @param toAddress Recipient address
   * @param asset Asset hash or symbol
   * @param amount Amount to transfer
   * @returns Object containing networkFee and systemFee
   */
  async calculateTransferFee(
    fromAddress: string,
    toAddress: string,
    asset: string,
    amount: string
  ): Promise<FeeEstimate> {
    try {
      const { script } = await this.buildNep17TransferScript(
        fromAddress,
        toAddress,
        asset,
        amount
      );

      const signer = new neonJs.tx.Signer({
        account: neonJs.wallet.getScriptHashFromAddress(fromAddress),
        scopes: neonJs.tx.WitnessScope.CalledByEntry,
      });
      const networkFeeTransaction = this.createNetworkFeeEstimationTransaction(script);

      const systemFee = await calculateSystemFee(script, [signer], this.rpcClient);
      const networkFee = await this.withRpcDeadline(
        () => calculateNetworkFee(networkFeeTransaction, this.rpcClient)
      );

      return this.createFeeEstimate(networkFee.toString(), systemFee.toString());

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to calculate transfer fee: ${errorMessage}`);
    }
  }

  /**
   * Calculate the network and system fees for a contract invocation.
   * @param fromAddress Signer address
   * @param scriptHash Contract script hash
   * @param operation Method name
   * @param args Method arguments
   * @returns Object containing networkFee and systemFee
   */
  async calculateInvokeFee(
    fromAddress: string,
    scriptHash: string,
    operation: string,
    args: unknown[] = []
  ): Promise<FeeEstimate> {
    try {
      if (!this.isValidNeoAddress(fromAddress)) {
        throw new ValidationError(`Invalid signer address: ${fromAddress}`);
      }
      const script = neonJs.sc.createScript({ scriptHash, operation, args: formatContractParameters(args) });
      const signer = new neonJs.tx.Signer({
        account: neonJs.wallet.getScriptHashFromAddress(fromAddress),
        scopes: neonJs.tx.WitnessScope.CalledByEntry,
      });
      const scriptHex = neonJs.u.HexString.fromHex(script);
      const networkFeeTransaction = this.createNetworkFeeEstimationTransaction(scriptHex);

      await this.getNetworkMagic();
      const systemFee = await calculateSystemFee(scriptHex, [signer], this.rpcClient);
      const networkFee = await this.withRpcDeadline(
        () => calculateNetworkFee(networkFeeTransaction, this.rpcClient)
      );

      return this.createFeeEstimate(networkFee.toString(), systemFee.toString());

    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to calculate invoke fee: ${errorMessage}`);
    }
  }

  private createNetworkFeeEstimationTransaction(
    script: ReturnType<typeof neonJs.u.HexString.fromHex>
  ): InstanceType<typeof neonJs.tx.Transaction> {
    const dummyAccount = new neonJs.wallet.Account();
    const transaction = new neonJs.tx.Transaction();
    transaction.script = script;
    transaction.addSigner({
      account: dummyAccount.scriptHash,
      scopes: neonJs.tx.WitnessScope.CalledByEntry,
    });
    transaction.addWitness(new neonJs.tx.Witness({
      invocationScript: '',
      verificationScript: neonJs.u.HexString.fromBase64(dummyAccount.contract.script).toString(),
    }));
    return transaction;
  }

  private createFeeEstimate(networkFeeDatos: string, systemFeeDatos: string): FeeEstimate {
    if (!/^\d+$/.test(networkFeeDatos) || !/^\d+$/.test(systemFeeDatos)) {
      throw new Error('Neo RPC returned an invalid fee estimate');
    }
    return {
      networkFeeDatos,
      systemFeeDatos,
      networkFeeGas: formatDatosAsGas(BigInt(networkFeeDatos)),
      systemFeeGas: formatDatosAsGas(BigInt(systemFeeDatos)),
    };
  }

  /**
   * Claim GAS for a given account.
   * @param fromAccount Account to claim GAS for and sign the transaction.
   * @returns Transaction details { txid, tx }
   */
  async claimGas(fromAccount: NeonAccount): Promise<{ txid: string }> {
    try {
      if (!fromAccount || !fromAccount.address) {
        throw new Error('Invalid account for claiming GAS: missing address');
      }
      const fromAddress = typeof fromAccount.address === 'string' ? fromAccount.address : String(fromAccount.address);
      if (!this.isValidNeoAddress(fromAddress)) {
        throw new Error(`Invalid address format for claiming GAS: ${fromAddress}`);
      }

      const rawNeoBalance = await this.readClaimableNeoBalance(fromAddress);

      const prepared = await this.prepareClaimGasTransaction(fromAccount, rawNeoBalance);
      const txid = await this.submitPreparedTransaction(prepared);
      return { txid };

    } catch (error) {
      if (error instanceof SubmissionOutcomeUnknownError || error instanceof ValidationError) {
        throw error;
      }
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Failed to claim GAS', { address: fromAccount?.address ?? null, error: errorMessage });
      throw new Error(`Failed to claim GAS: ${errorMessage}`);
    }
  }

  /**
   * Check that a GAS claim is worth making and return the NEO balance it moves.
   *
   * Claiming GAS is a self-transfer of the whole NEO balance, so both the
   * unclaimed amount and that balance are needed, and neither depends on the
   * other. They are read together: in sequence the claim cost two RPC budgets,
   * which one slow seed was enough to turn into a timeout.
   * @param fromAddress Address claiming the GAS
   * @returns The raw (integer) NEO balance to be self-transferred
   * @throws ValidationError if the claim is below the minimum or the balance is unusable
   */
  private async readClaimableNeoBalance(fromAddress: string): Promise<string> {
    const unclaimedGasRead = this.withRpcDeadline(
      () => this.rpcClient.getUnclaimedGas(fromAddress)
    );
    const neoBalanceRead = this.withRpcDeadline(
      () => this.rpcClient.invokeFunction(
        this.getAssetHash('NEO'),
        'balanceOf',
        [neonJs.sc.ContractParam.hash160(fromAddress)]
      )
    );
    // The minimum-claim guard below decides first, so a below-minimum claim still
    // reports exactly that. Marking the balance read as handled keeps an
    // incidental failure on it from surfacing as an unhandled rejection in that
    // case; the await further down is what actually reports it when it matters.
    void neoBalanceRead.catch(() => undefined);

    const unclaimedGas = await unclaimedGasRead;
    if (!/^\d+$/.test(unclaimedGas) || BigInt(unclaimedGas) < 50_000_000n) {
      throw new ValidationError('Minimum claim value is 0.5 GAS');
    }

    const balanceResult = await neoBalanceRead;
    const balanceValue = balanceResult.stack?.[0]?.value;
    const rawNeoBalance = typeof balanceValue === 'string' || typeof balanceValue === 'number'
      ? String(balanceValue)
      : '';
    if (balanceResult.state !== 'HALT' || !/^\d+$/.test(rawNeoBalance) || BigInt(rawNeoBalance) <= 0n) {
      throw new ValidationError('Failed to determine the NEO balance required to claim GAS');
    }
    return rawNeoBalance;
  }

  async prepareClaimGasTransaction(
    fromAccount: NeonAccount,
    knownNeoBalance?: string
  ): Promise<PreparedNeoTransaction> {
    if (!fromAccount || !fromAccount.address) {
      throw new ValidationError('Invalid account for claiming GAS: missing address');
    }
    const fromAddress = String(fromAccount.address);
    const rawNeoBalance = knownNeoBalance ?? await this.readClaimableNeoBalance(fromAddress);
    const { networkMagic, script } = await this.buildNep17TransferScript(
        fromAddress,
        fromAddress,
        'NEO',
        rawNeoBalance
      );
    return await this.prepareSignedTransaction(fromAccount, script, networkMagic);
  }

  /**
   * Create a new wallet
   * @param password Password for encrypting the wallet
   * @returns New wallet account
   */
  async createWallet(password: string): Promise<WalletInfo> {
    try {
      validatePassword(password);
      const account = new neonJs.wallet.Account();
      return {
        address: account.address,
        publicKey: account.publicKey,
        encryptedPrivateKey: await neonJs.wallet.encrypt(account.WIF, password),
      };
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      throw new Error('Failed to create wallet');
    }
  }

  /**
   * Import a wallet from WIF or encrypted key
   * @param key WIF or encrypted private key
   * @param password Password for decrypting the key (if encrypted)
   * @returns Wallet account
   */
  async importWallet(key: string, password?: string): Promise<WalletInfo> {
    try {
      let account: NeonAccount;

      if (password) {
        validatePassword(password);
        if (!neonJs.wallet.isNEP2(key)) {
          throw new Error('Invalid encrypted wallet key');
        }
        const privateKey = await neonJs.wallet.decrypt(key, password);
        account = new neonJs.wallet.Account(privateKey);
      } else {
        if (!(neonJs.wallet.isWIF(key) || neonJs.wallet.isPrivateKey(key))) {
          throw new Error('Invalid WIF or private key');
        }
        account = new neonJs.wallet.Account(key);
      }

      return {
        address: account.address,
        publicKey: account.publicKey,
      };
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      throw new Error(password
        ? 'Failed to import wallet: invalid encrypted key or password'
        : 'Failed to import wallet: invalid WIF or private key');
    }
  }

  /**
   * Get asset hash from symbol based on the current network
   * @param symbol Asset symbol (e.g., 'NEO', 'GAS')
   * @returns Asset hash
   */
  private async getNetworkMagic(): Promise<number> {
    if (this.networkMagic !== undefined) {
      return this.networkMagic;
    }
    if (this.networkMagicRequest) {
      return await this.networkMagicRequest;
    }

    this.networkMagicRequest = withRpcDeadline(
      this.fetchRpcVersion,
      this.rpcTimeoutMs,
    ).then((versionRaw) => {
      const version = versionRaw as Record<string, unknown>;
      const versionProtocol = version?.protocol as Record<string, unknown> | undefined;
      const networkMagicRaw = versionProtocol?.network;
      if (!Number.isInteger(networkMagicRaw)) {
        throw new Error('Failed to determine network magic from RPC getversion');
      }
      const networkMagic = networkMagicRaw as number;
      const expectedNetworkMagic = NEO_NETWORK_MAGIC[this.network];
      if (networkMagic !== expectedNetworkMagic) {
        throw new Error(
          `RPC network mismatch for ${this.network}: expected magic ${expectedNetworkMagic}, ` +
          `but endpoint reported ${networkMagic}`
        );
      }

      this.networkMagic = networkMagic;
      return networkMagic;
    }).finally(() => {
      this.networkMagicRequest = undefined;
    });
    return await this.networkMagicRequest;
  }

  private stripHexPrefix(value: string): string {
    return value.startsWith('0x') ? value.slice(2) : value;
  }

  private isValidNeoAddress(value: string): boolean {
    return typeof value === 'string'
      && neonJs.wallet.isAddress(value, neonJs.CONST.DEFAULT_ADDRESS_VERSION);
  }

  private getAssetHash(symbol: string): string {
    if (!symbol) {
      throw new Error('Asset symbol is required');
    }

    // Asset hashes for different networks
    // Note: In Neo N3, NEO and GAS use the same contract hashes on both mainnet and testnet
    const assets: Record<NeoNetwork, Record<string, string>> = {
      [NeoNetwork.MAINNET]: {
        NEO: '0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5',
        GAS: '0xd2a4cff31913016155e38e474a2c06d08be276cf',
      },
      [NeoNetwork.TESTNET]: {
        NEO: '0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5',  // Same as mainnet in Neo N3
        GAS: '0xd2a4cff31913016155e38e474a2c06d08be276cf',  // Same as mainnet in Neo N3
      }
    };

    // Check if the network is supported
    if (!assets[this.network]) {
      throw new Error(`Unsupported network: ${this.network}`);
    }

    const networkAssets = assets[this.network];
    const symbolUpper = symbol.toUpperCase();

    if (!networkAssets[symbolUpper]) {
      const availableAssets = Object.keys(networkAssets).join(', ');
      throw new Error(`Unknown asset: "${symbol}" on network "${this.network}". Available assets: ${availableAssets}`);
    }

    return networkAssets[symbolUpper];
  }

  /**
   * Get the current network
   * @returns The current network
   */
  getNetwork(): NeoNetwork {
    return this.network;
  }

  /**
   * Get the RPC endpoints this service reads from, in failover order.
   * @returns The configured endpoints; index 0 is the one tried first.
   */
  getRpcUrls(): readonly string[] {
    return this.rpcUrls;
  }

}
