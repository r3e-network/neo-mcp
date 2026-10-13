/**
 * `summarize_account_activity` — what an address did in a time window, computed on the server.
 *
 * The four reads are the same ones the existing `get_nep17_transfers`, `get_unclaimed_gas` and
 * block tools already make, so this tool reaches nothing new: it aggregates, it does not add a
 * data source. Every total is summed by
 * {@link module:utils/account-activity-summary.buildAccountActivitySummary}; the model is never
 * asked to add transfers, and any figure the underlying data cannot support is reported as
 * unavailable rather than estimated.
 */

import {
  buildAccountActivitySummary,
  normalizeAssetHash,
  type AccountDescription,
  type DecimalsResolution,
  type RawTransferHistory,
  type RawTransferRow,
} from '../utils/account-activity-summary';
import { resolveKnownAccount } from '../metadata/known-accounts';
import { ValidationError } from '../utils/errors';
import { validateAddress } from '../utils/validation';

/** The Neo N3 native tokens NEO and GAS both carry 8 decimals. A protocol constant, not a guess. */
const NATIVE_TOKEN_DECIMALS = 8;
const MAX_TOP_COUNTERPARTIES = 25;
const MIN_TOP_COUNTERPARTIES = 1;
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;

export const ACCOUNT_ACTIVITY_TOOLS = new Set(['summarize_account_activity']);

/** The reads the summary needs. `NeoService` satisfies this structurally. */
export interface AccountActivitySources {
  getNep17Transfers(
    address: string,
    options: { fromTimestampMs?: number; toTimestampMs?: number },
  ): Promise<unknown>;
  getUnclaimedGas(address: string): Promise<unknown>;
  getBlockCount(): Promise<number>;
  getBlock(height: number): Promise<Record<string, unknown>>;
}

function fail(message: string): never {
  throw new ValidationError(message);
}

function readTimestamp(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_TIMESTAMP_MS) {
    fail(`${field} must be a non-negative integer Unix timestamp in milliseconds`);
  }
  return value;
}

function readTopCounterparties(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < MIN_TOP_COUNTERPARTIES
    || value > MAX_TOP_COUNTERPARTIES
  ) {
    fail(`topCounterparties must be an integer between ${MIN_TOP_COUNTERPARTIES} and ${MAX_TOP_COUNTERPARTIES}`);
  }
  return value;
}

function readNetwork(value: unknown): 'mainnet' | 'testnet' | null {
  if (value === undefined || value === null) return null;
  if (value !== 'mainnet' && value !== 'testnet') {
    fail('network must be "mainnet" or "testnet"');
  }
  return value;
}

function readPositiveInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return null;
  return value;
}

function readBlockTime(value: unknown): number | null {
  const raw = typeof value === 'string' && /^\d+$/.test(value) ? Number.parseInt(value, 10) : value;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0 || raw > MAX_TIMESTAMP_MS) return null;
  return raw;
}

/** Reject a payload that is not a `getnep17transfers` shape instead of reading it as "no activity". */
function readHistory(payload: unknown): RawTransferHistory {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Failed to summarize account activity: transfer history unreadable');
  }
  const record = payload as Record<string, unknown>;
  const history: RawTransferHistory = {};
  for (const direction of ['sent', 'received'] as const) {
    const list = record[direction];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) {
      throw new Error(`Failed to summarize account activity: transfer history ${direction} list unreadable`);
    }
    history[direction] = list as RawTransferRow[];
  }
  return history;
}

/** The node's claimable-GAS figure, passed through unrescaled. */
function readGasClaims(payload: unknown): { available: boolean; unclaimedGas: string | null; source: string | null; reason?: string } {
  const source = 'rpc:getunclaimedgas';
  if (typeof payload === 'string') {
    return { available: true, unclaimedGas: payload, source };
  }
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const value = typeof record.unclaimedGas === 'string'
      ? record.unclaimedGas
      : (typeof record.unclaimed === 'string' ? record.unclaimed : null);
    if (value !== null) return { available: true, unclaimedGas: value, source };
  }
  return { available: false, unclaimedGas: null, source: null, reason: 'gas_claims_unreadable' };
}

async function readDataThrough(sources: AccountActivitySources) {
  let block: number | null = null;
  try {
    block = readPositiveInteger(await sources.getBlockCount());
    if (block !== null) block = block - 1;
  } catch {
    block = null;
  }
  if (block === null) {
    return {
      available: false,
      block: null as number | null,
      blockHash: null as string | null,
      blockTimeMs: null as number | null,
      reason: 'data_through_unavailable',
    };
  }

  let blockHash: string | null = null;
  let blockTimeMs: number | null = null;
  try {
    const header = await sources.getBlock(block);
    const hash = header?.hash;
    blockHash = typeof hash === 'string' && /^0x[0-9a-f]{64}$/i.test(hash) ? hash.toLowerCase() : null;
    blockTimeMs = readBlockTime(header?.time);
  } catch {
    // Height is already known; only the block's own fields are missing.
    blockHash = null;
    blockTimeMs = null;
  }
  return { available: true, block, blockHash, blockTimeMs, reason: null };
}

/**
 * Summarize one address's activity over a time window.
 *
 * @throws ValidationError for a bad argument set
 * @throws Error when the transfer history itself cannot be read — an unreadable history is a
 *   failed read, not zero activity
 */
export async function summarizeAccountActivity(
  input: Record<string, unknown>,
  sources: AccountActivitySources,
): Promise<Record<string, unknown>> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('Arguments must be an object.');
  }

  const address = validateAddress(typeof input.address === 'string' ? input.address : '');
  const network = readNetwork(input.network);
  const fromTimestampMs = readTimestamp(input.fromTimestampMs, 'fromTimestampMs');
  const toTimestampMs = readTimestamp(input.toTimestampMs, 'toTimestampMs');
  if (fromTimestampMs !== null && toTimestampMs !== null && fromTimestampMs > toTimestampMs) {
    fail('fromTimestampMs must be less than or equal to toTimestampMs');
  }
  const topCounterparties = readTopCounterparties(input.topCounterparties);

  const transferOptions: { fromTimestampMs?: number; toTimestampMs?: number } = {};
  if (fromTimestampMs !== null) transferOptions.fromTimestampMs = fromTimestampMs;
  if (toTimestampMs !== null) transferOptions.toTimestampMs = toTimestampMs;

  // The history read is not degraded: if it fails, the call fails. Claimable GAS and the
  // data-through block are reported as unavailable instead, so one slow read cannot invent
  // a zero for another.
  const history = readHistory(await sources.getNep17Transfers(address, transferOptions));

  let gasClaims: { available: boolean; unclaimedGas: string | null; source: string | null; reason?: string };
  try {
    gasClaims = readGasClaims(await sources.getUnclaimedGas(address));
  } catch {
    gasClaims = { available: false, unclaimedGas: null, source: null, reason: 'gas_claims_unavailable' };
  }

  const dataThrough = await readDataThrough(sources);

  // Known-account metadata is keyed by network. The built-in native tokens carry the same
  // script hash on both networks; anything else is left unresolved rather than assumed.
  const metadataNetwork = network === 'testnet' ? 'testnet' : 'mainnet';
  const describeAccount = (reference: string): AccountDescription | null => {
    const known = resolveKnownAccount(reference, metadataNetwork);
    return known ? { name: known.name, symbol: known.symbol ?? null } : null;
  };
  const decimalsFor = (reference: string): DecimalsResolution | null => {
    const hash = normalizeAssetHash(reference);
    if (hash === null) return null;
    const known = resolveKnownAccount(hash, metadataNetwork);
    if (!known || known.kind !== 'native_token') return null;
    return { decimals: NATIVE_TOKEN_DECIMALS, source: 'native_protocol' };
  };

  return buildAccountActivitySummary({
    address,
    network,
    fromTimestampMs,
    toTimestampMs,
    history,
    gasClaims,
    dataThrough,
    observedAtMs: Date.now(),
    options: {
      decimalsFor,
      describeAccount,
      ...(topCounterparties === undefined ? {} : { topCounterparties }),
    },
  }) as unknown as Record<string, unknown>;
}
