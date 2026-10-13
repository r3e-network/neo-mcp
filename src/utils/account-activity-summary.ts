/**
 * Deterministic aggregation of Neo N3 NEP-17 transfer history into an account activity summary.
 *
 * This module owns every number that reaches a summary surface. It performs no I/O and never
 * rounds: amounts are Neo N3 base units summed with `BigInt`, so a total is exact or it is
 * absent. The rules it enforces:
 *
 *   1. A total the data cannot support is not produced. A row that cannot be placed in the
 *      window, that carries no asset identity, or whose amount is not a non-negative integer
 *      is excluded from the sums, counted, and named in `truncation.reasons`.
 *   2. A human-scale value is emitted only when a `decimalsFor` resolver returns verified
 *      decimals for that asset. Otherwise the display fields are absent — never guessed.
 *   3. Different assets are different units. Nothing in the output sums across two assets, and
 *      counterparties are ranked by transfer count with the ranking basis named in the response.
 *   4. Anything that makes the summary incomplete sets `truncation.truncated` and names the
 *      reason, including a source that could not be read at all.
 *
 * Complexities: O(n log n) in the number of transfer rows (one sort for the row cap, one sort
 * per output list), O(n) additional memory.
 */

/** One row of a `getnep17transfers` `sent`/`received` list, still in RPC shape. */
export interface RawTransferRow {
  timestamp?: unknown;
  assethash?: unknown;
  transferaddress?: unknown;
  amount?: unknown;
  blockindex?: unknown;
  transfernotifyindex?: unknown;
  txhash?: unknown;
  [key: string]: unknown;
}

/** The `sent`/`received` half of a `getnep17transfers` response. */
export interface RawTransferHistory {
  sent?: RawTransferRow[];
  received?: RawTransferRow[];
}

/** The claimable GAS figure as reported by `getunclaimedgas`, unrescaled. */
export interface AccountActivityGasClaims {
  available: boolean;
  unclaimedGas: string | null;
  source: string | null;
  reason?: string | null;
}

/** The block the transfer data runs through. */
export interface AccountActivityDataThrough {
  available: boolean;
  block: number | null;
  blockHash: string | null;
  blockTimeMs: number | null;
  reason?: string | null;
}

/** Verified decimals for one asset. */
export interface DecimalsResolution {
  decimals: number;
  source: string;
}

export interface AccountDescription {
  name?: string | null;
  symbol?: string | null;
}

export interface AccountActivitySummaryOptions {
  /** How many counterparties to rank (default {@link DEFAULT_TOP_COUNTERPARTIES}). */
  topCounterparties?: number;
  /** Row cap for the sums (default {@link DEFAULT_MAX_TRANSFER_ROWS}). */
  maxTransferRows?: number;
  /** Verified decimals per asset; omit to report base units only. */
  decimalsFor?: (scriptHash: string) => DecimalsResolution | null;
  /** Known-account metadata for an asset script hash or a counterparty address. */
  describeAccount?: (reference: string) => AccountDescription | null;
}

export interface AccountActivitySummaryInput {
  address: string;
  network: string | null;
  fromTimestampMs: number | null;
  toTimestampMs: number | null;
  history: RawTransferHistory | null;
  gasClaims: AccountActivityGasClaims;
  dataThrough: AccountActivityDataThrough;
  observedAtMs: number;
  options?: AccountActivitySummaryOptions;
}

export interface AccountActivityAssetRow {
  asset: { scriptHash: string | null; name: string | null; symbol: string | null };
  decimals: number | null;
  decimalsSource: string;
  inRaw: string;
  outRaw: string;
  netRaw: string;
  inDisplay?: string;
  outDisplay?: string;
  netDisplay?: string;
  inCount: number;
  outCount: number;
  transferCount: number;
  firstTimestampMs: number | null;
  lastTimestampMs: number | null;
}

export interface AccountActivityCounterpartyAssetRow {
  assetScriptHash: string | null;
  inRaw: string;
  outRaw: string;
  transferCount: number;
}

export interface AccountActivityCounterpartyRow {
  address: string;
  label: string | null;
  transferCount: number;
  inCount: number;
  outCount: number;
  assets: AccountActivityCounterpartyAssetRow[];
  firstTimestampMs: number | null;
  lastTimestampMs: number | null;
}

export interface AccountActivitySummary {
  schemaVersion: 1;
  kind: 'neoos.account.activity.summary';
  readOnly: true;
  canSign: false;
  canBroadcast: false;
  address: string;
  network: string | null;
  amountUnit: 'base_units';
  scope: { standard: 'NEP-17'; excludes: string[] };
  window: { fromTimestampMs: number | null; toTimestampMs: number | null };
  freshness: {
    observedAt: string;
    observedAtMs: number;
    dataThroughBlock: number | null;
    dataThroughBlockHash: string | null;
    dataThroughBlockTimeMs: number | null;
    dataThroughBlockTimeIso: string | null;
    dataThroughAvailable: boolean;
  };
  coverage: {
    coveredFromTimestampMs: number | null;
    coveredThroughTimestampMs: number | null;
    windowClippedAtDataThrough: boolean;
  };
  transfers: {
    counted: number;
    inCount: number;
    outCount: number;
    rowsObserved: number;
    rowsSummarized: number;
    rowsExcluded: number;
    rowsDroppedByCap: number;
    distinctAssets: number;
    distinctCounterparties: number;
  };
  assets: AccountActivityAssetRow[];
  topCounterparties: AccountActivityCounterpartyRow[];
  topCounterpartiesRankedBy: 'transfer_count';
  topCounterpartiesLimit: number;
  gasClaims: {
    available: boolean;
    unclaimedGas: string | null;
    source: string | null;
    reason: string | null;
  };
  truncation: {
    truncated: boolean;
    reasons: string[];
    transferRowCap: number;
    rowsMissingTimestamp: number;
    rowsOutsideWindow: number;
    rowsAfterDataThrough: number;
    rowsMissingAssetHash: number;
    rowsMissingAmount: number;
  };
}

export const DEFAULT_TOP_COUNTERPARTIES = 5;
export const DEFAULT_MAX_TRANSFER_ROWS = 1000;

const MAX_TOP_COUNTERPARTIES = 25;
const MIN_TOP_COUNTERPARTIES = 1;
const SCRIPT_HASH_PATTERN = /^0x[0-9a-f]{40}$/;
const INTEGER_AMOUNT_PATTERN = /^\d+$/;

const REASON_TRANSFER_ROWS_CAPPED = 'transfer_rows_capped';
const REASON_WINDOW_CLIPPED = 'window_clipped_at_data_through';
const REASON_ROWS_MISSING_TIMESTAMP = 'rows_missing_timestamp';
const REASON_ROWS_OUTSIDE_WINDOW = 'rows_outside_window';
const REASON_ROWS_AFTER_DATA_THROUGH = 'rows_after_data_through';
const REASON_ROWS_MISSING_ASSET_HASH = 'rows_missing_asset_hash';
const REASON_ROWS_MISSING_AMOUNT = 'rows_missing_amount';
const REASON_DATA_THROUGH_UNAVAILABLE = 'data_through_unavailable';
const REASON_DATA_THROUGH_TIME_UNAVAILABLE = 'data_through_time_unavailable';
const REASON_GAS_CLAIMS_UNAVAILABLE = 'gas_claims_unavailable';

interface NormalizedRow {
  direction: 'sent' | 'received';
  timestampMs: number;
  assetHash: string;
  counterparty: string;
  amount: bigint;
  blockindex: number;
  transfernotifyindex: number;
  txhash: string;
}

interface ExclusionCounts {
  rowsMissingTimestamp: number;
  rowsOutsideWindow: number;
  rowsAfterDataThrough: number;
  rowsMissingAssetHash: number;
  rowsMissingAmount: number;
}

interface AssetAccumulator {
  scriptHash: string | null;
  inRaw: bigint;
  outRaw: bigint;
  inCount: number;
  outCount: number;
  transferCount: number;
  firstTimestampMs: number | null;
  lastTimestampMs: number | null;
}

interface CounterpartyAccumulator {
  address: string;
  transferCount: number;
  inCount: number;
  outCount: number;
  firstTimestampMs: number | null;
  lastTimestampMs: number | null;
  assets: Map<string, { inRaw: bigint; outRaw: bigint; transferCount: number }>;
}

/** Normalise a script hash to `0x` + 40 lowercase hex, or null when the value is not one. */
export function normalizeAssetHash(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  const body = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  return SCRIPT_HASH_PATTERN.test(body) ? body : null;
}

/** Exact decimal rendering of a base-unit integer, or null when the scaling is not verified. */
export function formatBaseUnits(raw: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new RangeError(`Unsupported decimals value: ${decimals}`);
  }
  const negative = raw < 0n;
  const magnitude = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = magnitude / scale;
  const fraction = (magnitude % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  const text = fraction.length > 0 ? `${whole}.${fraction}` : `${whole}`;
  return negative ? `-${text}` : text;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

function parseCount(value: unknown, fallback: number): number {
  const parsed = parseTimestamp(value);
  return parsed === null ? fallback : parsed;
}

/**
 * A row amount is accepted only as a non-negative integer. A float, a negative, a fraction or
 * anything non-numeric is not a figure the data supports, so it never reaches a total.
 */
function parseAmount(value: unknown): bigint | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!INTEGER_AMOUNT_PATTERN.test(trimmed)) return null;
    return BigInt(trimmed);
  }
  return null;
}

function parseCounterparty(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : 'unknown';
}

function minOrNull(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function clampTopCounterparties(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TOP_COUNTERPARTIES;
  return Math.min(MAX_TOP_COUNTERPARTIES, Math.max(MIN_TOP_COUNTERPARTIES, value));
}

function clampMaxTransferRows(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_TRANSFER_ROWS;
  return Math.max(1, Math.trunc(value));
}

/** Earliest rows first; a total order so the row cap is reproducible. */
function compareRows(a: NormalizedRow, b: NormalizedRow): number {
  if (a.timestampMs !== b.timestampMs) return a.timestampMs - b.timestampMs;
  if (a.blockindex !== b.blockindex) return a.blockindex - b.blockindex;
  if (a.transfernotifyindex !== b.transfernotifyindex) return a.transfernotifyindex - b.transfernotifyindex;
  if (a.direction !== b.direction) return a.direction === 'sent' ? -1 : 1;
  const byAmount = a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0;
  if (byAmount !== 0) return byAmount;
  if (a.txhash !== b.txhash) return a.txhash < b.txhash ? -1 : 1;
  if (a.assetHash !== b.assetHash) return a.assetHash < b.assetHash ? -1 : 1;
  return a.counterparty < b.counterparty ? -1 : a.counterparty > b.counterparty ? 1 : 0;
}

function collectRows(
  history: RawTransferHistory | null,
  window: { fromTimestampMs: number | null; toTimestampMs: number | null },
  dataThroughTimeMs: number | null,
): { rows: NormalizedRow[]; exclusions: ExclusionCounts; observed: number } {
  const exclusions: ExclusionCounts = {
    rowsMissingTimestamp: 0,
    rowsOutsideWindow: 0,
    rowsAfterDataThrough: 0,
    rowsMissingAssetHash: 0,
    rowsMissingAmount: 0,
  };
  const rows: NormalizedRow[] = [];
  let observed = 0;

  if (!history) return { rows, exclusions, observed };

  // Each row is attributed to exactly one exclusion reason, in this priority, so the counters
  // add up to the rows that were not summarised.
  for (const direction of ['sent', 'received'] as const) {
    const list = history[direction];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      observed += 1;
      const raw = (entry && typeof entry === 'object' ? entry : {}) as RawTransferRow;

      const timestampMs = parseTimestamp(raw.timestamp);
      if (timestampMs === null) {
        exclusions.rowsMissingTimestamp += 1;
        continue;
      }
      if (
        (window.fromTimestampMs !== null && timestampMs < window.fromTimestampMs)
        || (window.toTimestampMs !== null && timestampMs > window.toTimestampMs)
      ) {
        exclusions.rowsOutsideWindow += 1;
        continue;
      }
      if (dataThroughTimeMs !== null && timestampMs > dataThroughTimeMs) {
        exclusions.rowsAfterDataThrough += 1;
        continue;
      }

      const assetHash = normalizeAssetHash(raw.assethash);
      if (assetHash === null) {
        exclusions.rowsMissingAssetHash += 1;
        continue;
      }

      const amount = parseAmount(raw.amount);
      if (amount === null) {
        exclusions.rowsMissingAmount += 1;
        continue;
      }

      rows.push({
        direction,
        timestampMs,
        assetHash,
        counterparty: parseCounterparty(raw.transferaddress),
        amount,
        blockindex: parseCount(raw.blockindex, 0),
        transfernotifyindex: parseCount(raw.transfernotifyindex, 0),
        txhash: typeof raw.txhash === 'string' ? raw.txhash : '',
      });
    }
  }

  return { rows, exclusions, observed };
}

function toAssetRow(
  accumulator: AssetAccumulator,
  decimalsFor: (scriptHash: string) => DecimalsResolution | null,
  describeAccount: (reference: string) => AccountDescription | null,
): AccountActivityAssetRow {
  const description = accumulator.scriptHash === null ? null : describeAccount(accumulator.scriptHash);
  const resolution = accumulator.scriptHash === null ? null : decimalsFor(accumulator.scriptHash);
  const netRaw = accumulator.inRaw - accumulator.outRaw;
  const base: AccountActivityAssetRow = {
    asset: {
      scriptHash: accumulator.scriptHash,
      name: description?.name ?? null,
      symbol: description?.symbol ?? null,
    },
    decimals: resolution ? resolution.decimals : null,
    decimalsSource: resolution ? resolution.source : 'unresolved',
    inRaw: accumulator.inRaw.toString(),
    outRaw: accumulator.outRaw.toString(),
    netRaw: netRaw.toString(),
    inCount: accumulator.inCount,
    outCount: accumulator.outCount,
    transferCount: accumulator.transferCount,
    firstTimestampMs: accumulator.firstTimestampMs,
    lastTimestampMs: accumulator.lastTimestampMs,
  };
  if (!resolution) return base;
  return {
    ...base,
    inDisplay: formatBaseUnits(accumulator.inRaw, resolution.decimals),
    outDisplay: formatBaseUnits(accumulator.outRaw, resolution.decimals),
    netDisplay: formatBaseUnits(netRaw, resolution.decimals),
  };
}

/**
 * Aggregate a transfer history into the summary the tool returns.
 *
 * Pure: the same input always produces the same output, and no I/O, clock or network is read.
 */
export function buildAccountActivitySummary(input: AccountActivitySummaryInput): AccountActivitySummary {
  const options = input.options ?? {};
  const decimalsFor = options.decimalsFor ?? (() => null);
  const describeAccount = options.describeAccount ?? (() => null);
  const topCounterpartiesLimit = clampTopCounterparties(options.topCounterparties);
  const transferRowCap = clampMaxTransferRows(options.maxTransferRows);

  if (!Number.isFinite(input.observedAtMs)) {
    throw new RangeError('observedAtMs must be a finite timestamp in milliseconds');
  }

  const dataThroughTimeMs = input.dataThrough.available ? input.dataThrough.blockTimeMs : null;
  const { rows, exclusions, observed } = collectRows(
    input.history,
    { fromTimestampMs: input.fromTimestampMs, toTimestampMs: input.toTimestampMs },
    dataThroughTimeMs,
  );

  const ordered = [...rows].sort(compareRows);
  const considered = ordered.slice(0, transferRowCap);
  const rowsDroppedByCap = ordered.length - considered.length;

  const assets = new Map<string, AssetAccumulator>();
  const counterparties = new Map<string, CounterpartyAccumulator>();

  for (const row of considered) {
    let asset = assets.get(row.assetHash);
    if (!asset) {
      asset = {
        scriptHash: row.assetHash,
        inRaw: 0n,
        outRaw: 0n,
        inCount: 0,
        outCount: 0,
        transferCount: 0,
        firstTimestampMs: null,
        lastTimestampMs: null,
      };
      assets.set(row.assetHash, asset);
    }
    if (row.direction === 'sent') {
      asset.outRaw += row.amount;
      asset.outCount += 1;
    } else {
      asset.inRaw += row.amount;
      asset.inCount += 1;
    }
    asset.transferCount += 1;
    asset.firstTimestampMs = asset.firstTimestampMs === null
      ? row.timestampMs
      : Math.min(asset.firstTimestampMs, row.timestampMs);
    asset.lastTimestampMs = asset.lastTimestampMs === null
      ? row.timestampMs
      : Math.max(asset.lastTimestampMs, row.timestampMs);

    let counterparty = counterparties.get(row.counterparty);
    if (!counterparty) {
      counterparty = {
        address: row.counterparty,
        transferCount: 0,
        inCount: 0,
        outCount: 0,
        firstTimestampMs: null,
        lastTimestampMs: null,
        assets: new Map(),
      };
      counterparties.set(row.counterparty, counterparty);
    }
    let counterpartyAsset = counterparty.assets.get(row.assetHash);
    if (!counterpartyAsset) {
      counterpartyAsset = { inRaw: 0n, outRaw: 0n, transferCount: 0 };
      counterparty.assets.set(row.assetHash, counterpartyAsset);
    }
    if (row.direction === 'sent') {
      counterpartyAsset.outRaw += row.amount;
      counterparty.outCount += 1;
    } else {
      counterpartyAsset.inRaw += row.amount;
      counterparty.inCount += 1;
    }
    counterpartyAsset.transferCount += 1;
    counterparty.transferCount += 1;
    counterparty.firstTimestampMs = counterparty.firstTimestampMs === null
      ? row.timestampMs
      : Math.min(counterparty.firstTimestampMs, row.timestampMs);
    counterparty.lastTimestampMs = counterparty.lastTimestampMs === null
      ? row.timestampMs
      : Math.max(counterparty.lastTimestampMs, row.timestampMs);
  }

  const assetRows = [...assets.values()]
    .map((accumulator) => toAssetRow(accumulator, decimalsFor, describeAccount))
    .sort((a, b) => {
      const left = a.asset.scriptHash ?? '';
      const right = b.asset.scriptHash ?? '';
      return left < right ? -1 : left > right ? 1 : 0;
    });

  const counterpartyRows = [...counterparties.values()]
    .map((accumulator) => ({
      address: accumulator.address,
      label: describeAccount(accumulator.address)?.name ?? null,
      transferCount: accumulator.transferCount,
      inCount: accumulator.inCount,
      outCount: accumulator.outCount,
      assets: [...accumulator.assets.entries()]
        .map(([scriptHash, totals]) => ({
          assetScriptHash: scriptHash,
          inRaw: totals.inRaw.toString(),
          outRaw: totals.outRaw.toString(),
          transferCount: totals.transferCount,
        }))
        .sort((a, b) => (a.assetScriptHash < b.assetScriptHash ? -1 : a.assetScriptHash > b.assetScriptHash ? 1 : 0)),
      firstTimestampMs: accumulator.firstTimestampMs,
      lastTimestampMs: accumulator.lastTimestampMs,
    }))
    // Transfer count, not value: amounts of different assets are different units and cannot be
    // ranked against each other. The basis is named in the response.
    .sort((a, b) => {
      if (a.transferCount !== b.transferCount) return b.transferCount - a.transferCount;
      const left = a.lastTimestampMs ?? -1;
      const right = b.lastTimestampMs ?? -1;
      if (left !== right) return right - left;
      return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
    });

  const rowsExcluded = exclusions.rowsMissingTimestamp
    + exclusions.rowsOutsideWindow
    + exclusions.rowsAfterDataThrough
    + exclusions.rowsMissingAssetHash
    + exclusions.rowsMissingAmount;

  const windowClippedAtDataThrough = input.toTimestampMs !== null
    && dataThroughTimeMs !== null
    && input.toTimestampMs > dataThroughTimeMs;

  const lastConsideredTimestampMs = considered.reduce(
    (latest: number | null, row) => (latest === null ? row.timestampMs : Math.max(latest, row.timestampMs)),
    null,
  );
  // Coverage is only claimed up to the time the data provably runs through. Without a
  // data-through block time there is no such bound, so the end of coverage is unknown rather
  // than assumed to be the requested end.
  const coveredToDataThrough = dataThroughTimeMs === null
    ? null
    : minOrNull(input.toTimestampMs, dataThroughTimeMs);
  const coveredThroughTimestampMs = rowsDroppedByCap > 0
    ? minOrNull(coveredToDataThrough, lastConsideredTimestampMs)
    : coveredToDataThrough;

  const reasons: string[] = [];
  if (rowsDroppedByCap > 0) reasons.push(REASON_TRANSFER_ROWS_CAPPED);
  if (windowClippedAtDataThrough) reasons.push(REASON_WINDOW_CLIPPED);
  if (exclusions.rowsMissingTimestamp > 0) reasons.push(REASON_ROWS_MISSING_TIMESTAMP);
  if (exclusions.rowsOutsideWindow > 0) reasons.push(REASON_ROWS_OUTSIDE_WINDOW);
  if (exclusions.rowsAfterDataThrough > 0) reasons.push(REASON_ROWS_AFTER_DATA_THROUGH);
  if (exclusions.rowsMissingAssetHash > 0) reasons.push(REASON_ROWS_MISSING_ASSET_HASH);
  if (exclusions.rowsMissingAmount > 0) reasons.push(REASON_ROWS_MISSING_AMOUNT);
  if (!input.dataThrough.available) reasons.push(REASON_DATA_THROUGH_UNAVAILABLE);
  else if (input.dataThrough.blockTimeMs === null) reasons.push(REASON_DATA_THROUGH_TIME_UNAVAILABLE);
  if (!input.gasClaims.available || input.gasClaims.unclaimedGas === null) {
    reasons.push(REASON_GAS_CLAIMS_UNAVAILABLE);
  }
  reasons.sort();

  const inCount = considered.reduce((total, row) => total + (row.direction === 'received' ? 1 : 0), 0);
  const outCount = considered.length - inCount;

  return {
    schemaVersion: 1,
    kind: 'neoos.account.activity.summary',
    readOnly: true,
    canSign: false,
    canBroadcast: false,
    address: input.address,
    network: input.network,
    amountUnit: 'base_units',
    scope: { standard: 'NEP-17', excludes: ['NEP-11'] },
    window: {
      fromTimestampMs: input.fromTimestampMs,
      toTimestampMs: input.toTimestampMs,
    },
    freshness: {
      observedAt: new Date(input.observedAtMs).toISOString(),
      observedAtMs: input.observedAtMs,
      dataThroughBlock: input.dataThrough.available ? input.dataThrough.block : null,
      dataThroughBlockHash: input.dataThrough.available ? input.dataThrough.blockHash : null,
      dataThroughBlockTimeMs: input.dataThrough.available ? input.dataThrough.blockTimeMs : null,
      dataThroughBlockTimeIso: input.dataThrough.available && input.dataThrough.blockTimeMs !== null
        ? new Date(input.dataThrough.blockTimeMs).toISOString()
        : null,
      dataThroughAvailable: input.dataThrough.available,
    },
    coverage: {
      coveredFromTimestampMs: input.fromTimestampMs,
      coveredThroughTimestampMs,
      windowClippedAtDataThrough,
    },
    transfers: {
      counted: considered.length,
      inCount,
      outCount,
      rowsObserved: observed,
      rowsSummarized: considered.length,
      rowsExcluded,
      rowsDroppedByCap,
      distinctAssets: assets.size,
      distinctCounterparties: counterparties.size,
    },
    assets: assetRows,
    topCounterparties: counterpartyRows.slice(0, topCounterpartiesLimit),
    topCounterpartiesRankedBy: 'transfer_count',
    topCounterpartiesLimit,
    gasClaims: {
      available: input.gasClaims.available && input.gasClaims.unclaimedGas !== null,
      unclaimedGas: input.gasClaims.available ? input.gasClaims.unclaimedGas : null,
      source: input.gasClaims.available ? input.gasClaims.source : null,
      reason: input.gasClaims.available && input.gasClaims.unclaimedGas !== null
        ? null
        : (input.gasClaims.reason ?? REASON_GAS_CLAIMS_UNAVAILABLE),
    },
    truncation: {
      truncated: reasons.length > 0,
      reasons,
      transferRowCap,
      rowsMissingTimestamp: exclusions.rowsMissingTimestamp,
      rowsOutsideWindow: exclusions.rowsOutsideWindow,
      rowsAfterDataThrough: exclusions.rowsAfterDataThrough,
      rowsMissingAssetHash: exclusions.rowsMissingAssetHash,
      rowsMissingAmount: exclusions.rowsMissingAmount,
    },
  };
}
