import {
  buildAccountActivitySummary,
  DEFAULT_MAX_TRANSFER_ROWS,
  DEFAULT_TOP_COUNTERPARTIES,
  type AccountActivitySummary,
  type DecimalsResolution,
} from '../src/utils/account-activity-summary';
import {
  CP_ONE,
  CP_THREE,
  CP_TWO,
  DATA_THROUGH_BLOCK,
  DATA_THROUGH_HASH,
  DATA_THROUGH_TIME_MS,
  FIXTURE_ACCOUNT,
  FIXTURE_CAP,
  FIXTURE_CAP_EXPECTED,
  FIXTURE_COUNTERPARTY,
  FIXTURE_COUNTERPARTY_EXPECTED_ORDER,
  FIXTURE_DEFECTS,
  FIXTURE_DEFECTS_EXPECTED,
  FIXTURE_SIMPLE,
  FIXTURE_SIMPLE_EXPECTED,
  FIXTURE_WINDOW,
  GAS_SCRIPT_HASH,
  NEO_SCRIPT_HASH,
  OBSERVED_AT_MS,
  UNKNOWN_TOKEN_HASH,
  WINDOW_FROM_MS,
  WINDOW_TO_MS,
} from './fixtures/account-activity-fixtures';

/** Verified decimals are known only for the Neo N3 native tokens (protocol constant, 8). */
const nativeOnlyDecimals = (scriptHash: string): DecimalsResolution | null => {
  if (scriptHash === GAS_SCRIPT_HASH || scriptHash === NEO_SCRIPT_HASH) {
    return { decimals: 8, source: 'native_protocol' };
  }
  return null;
};

const okGasClaims = {
  available: true,
  unclaimedGas: '0.00350538',
  source: 'rpc:getunclaimedgas',
};

const okDataThrough = {
  available: true,
  block: DATA_THROUGH_BLOCK,
  blockHash: DATA_THROUGH_HASH,
  blockTimeMs: DATA_THROUGH_TIME_MS,
};

function simpleSummary(overrides: Partial<Parameters<typeof buildAccountActivitySummary>[0]> = {}) {
  return buildAccountActivitySummary({
    address: FIXTURE_ACCOUNT,
    network: 'mainnet',
    fromTimestampMs: WINDOW_FROM_MS,
    toTimestampMs: WINDOW_TO_MS,
    history: FIXTURE_SIMPLE,
    gasClaims: okGasClaims,
    dataThrough: okDataThrough,
    observedAtMs: OBSERVED_AT_MS,
    options: { decimalsFor: nativeOnlyDecimals },
    ...overrides,
  });
}

function assetRow(summary: AccountActivitySummary, scriptHash: string) {
  const row = summary.assets.find((candidate) => candidate.asset.scriptHash === scriptHash);
  if (!row) throw new Error(`asset ${scriptHash} missing from summary`);
  return row;
}

/** Every path whose last segment is a raw amount must live under an asset-scoped object. */
function pathsCarryingRawAmounts(value: unknown, prefix = ''): string[] {
  const found: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      found.push(...pathsCarryingRawAmounts(entry, `${prefix}[${index}]`));
    });
    return found;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (/Raw$/.test(key)) found.push(path);
      found.push(...pathsCarryingRawAmounts(entry, path));
    }
  }
  return found;
}

describe('buildAccountActivitySummary — exact totals', () => {
  test('returns exact per-asset inflow and outflow for the fixture address', () => {
    const summary = simpleSummary();

    const gas = assetRow(summary, GAS_SCRIPT_HASH);
    expect(gas.inRaw).toBe(FIXTURE_SIMPLE_EXPECTED.gas.inRaw);
    expect(gas.outRaw).toBe(FIXTURE_SIMPLE_EXPECTED.gas.outRaw);
    expect(gas.netRaw).toBe(FIXTURE_SIMPLE_EXPECTED.gas.netRaw);
    expect(gas.inCount).toBe(FIXTURE_SIMPLE_EXPECTED.gas.inCount);
    expect(gas.outCount).toBe(FIXTURE_SIMPLE_EXPECTED.gas.outCount);
    expect(gas.transferCount).toBe(FIXTURE_SIMPLE_EXPECTED.gas.transferCount);

    const neo = assetRow(summary, NEO_SCRIPT_HASH);
    expect(neo.inRaw).toBe(FIXTURE_SIMPLE_EXPECTED.neo.inRaw);
    expect(neo.outRaw).toBe(FIXTURE_SIMPLE_EXPECTED.neo.outRaw);
    expect(neo.netRaw).toBe(FIXTURE_SIMPLE_EXPECTED.neo.netRaw);

    const unknown = assetRow(summary, UNKNOWN_TOKEN_HASH);
    expect(unknown.inRaw).toBe(FIXTURE_SIMPLE_EXPECTED.unknownToken.inRaw);
    expect(unknown.outRaw).toBe(FIXTURE_SIMPLE_EXPECTED.unknownToken.outRaw);
    expect(unknown.netRaw).toBe(FIXTURE_SIMPLE_EXPECTED.unknownToken.netRaw);
    expect(unknown.inCount).toBe(FIXTURE_SIMPLE_EXPECTED.unknownToken.inCount);
    expect(unknown.outCount).toBe(FIXTURE_SIMPLE_EXPECTED.unknownToken.outCount);
  });

  test('every asset net equals in minus out when recomputed independently', () => {
    const summary = simpleSummary();
    expect(summary.assets.length).toBe(3);
    for (const row of summary.assets) {
      expect(row.netRaw).toBe((BigInt(row.inRaw) - BigInt(row.outRaw)).toString());
    }
  });

  test('reports transfer counts, distinct assets and distinct counterparties', () => {
    const summary = simpleSummary();
    expect(summary.transfers).toMatchObject(FIXTURE_SIMPLE_EXPECTED.transfers);
  });

  test('sums exactly at the 2^53 boundary where floating point would round', () => {
    const raw = '9007199254740993';
    const summary = buildAccountActivitySummary({
      address: FIXTURE_ACCOUNT,
      network: 'mainnet',
      fromTimestampMs: null,
      toTimestampMs: null,
      history: {
        sent: [{ timestamp: 1, assethash: GAS_SCRIPT_HASH, transferaddress: CP_ONE, amount: raw }],
      },
      gasClaims: { available: false, unclaimedGas: null, source: null, reason: 'gas_claims_unavailable' },
      dataThrough: { available: false, block: null, blockHash: null, blockTimeMs: null, reason: 'data_through_unavailable' },
      observedAtMs: OBSERVED_AT_MS,
      options: { decimalsFor: nativeOnlyDecimals },
    });
    // Number(raw) is 9007199254740992; the summary must not have gone through a double.
    expect(assetRow(summary, GAS_SCRIPT_HASH).outRaw).toBe(raw);
    expect(assetRow(summary, GAS_SCRIPT_HASH).outDisplay).toBe('90071992.54740993');
  });

  test('the row accounting identity holds', () => {
    for (const summary of [simpleSummary()]) {
      expect(summary.transfers.rowsObserved).toBe(
        summary.transfers.rowsSummarized
        + summary.transfers.rowsExcluded
        + summary.transfers.rowsDroppedByCap,
      );
    }
  });

  test('asset rows are ordered by script hash regardless of the order rows arrive in', () => {
    const shuffled = simpleSummary({
      history: {
        received: [...FIXTURE_SIMPLE.received!].reverse(),
        sent: [...FIXTURE_SIMPLE.sent!].reverse(),
      },
    });
    expect(shuffled.assets.map((row) => row.asset.scriptHash)).toEqual(
      [...simpleSummary().assets.map((row) => row.asset.scriptHash)],
    );
  });
});

describe('buildAccountActivitySummary — no total is left to model arithmetic', () => {
  test('emits display values only for assets whose decimals were verified', () => {
    const summary = simpleSummary();
    const gas = assetRow(summary, GAS_SCRIPT_HASH);
    expect(gas.decimals).toBe(8);
    expect(gas.decimalsSource).toBe('native_protocol');
    expect(gas.inDisplay).toBe(FIXTURE_SIMPLE_EXPECTED.gas.inDisplay);
    expect(gas.outDisplay).toBe(FIXTURE_SIMPLE_EXPECTED.gas.outDisplay);
    expect(gas.netDisplay).toBe(FIXTURE_SIMPLE_EXPECTED.gas.netDisplay);

    const neo = assetRow(summary, NEO_SCRIPT_HASH);
    expect(neo.inDisplay).toBe(FIXTURE_SIMPLE_EXPECTED.neo.inDisplay);
    expect(neo.outDisplay).toBe(FIXTURE_SIMPLE_EXPECTED.neo.outDisplay);
    expect(neo.netDisplay).toBe(FIXTURE_SIMPLE_EXPECTED.neo.netDisplay);
  });

  test('never invents a display value for an asset with unresolved decimals', () => {
    const unknown = assetRow(simpleSummary(), UNKNOWN_TOKEN_HASH);
    expect(unknown.decimals).toBeNull();
    expect(unknown.decimalsSource).toBe('unresolved');
    expect('inDisplay' in unknown).toBe(false);
    expect('outDisplay' in unknown).toBe(false);
    expect('netDisplay' in unknown).toBe(false);
  });

  test('with no decimals resolver at all the summary carries base units only', () => {
    const summary = buildAccountActivitySummary({
      address: FIXTURE_ACCOUNT,
      network: 'mainnet',
      fromTimestampMs: WINDOW_FROM_MS,
      toTimestampMs: WINDOW_TO_MS,
      history: FIXTURE_SIMPLE,
      gasClaims: okGasClaims,
      dataThrough: okDataThrough,
      observedAtMs: OBSERVED_AT_MS,
    });
    expect(summary.amountUnit).toBe('base_units');
    for (const row of summary.assets) {
      expect(row.decimals).toBeNull();
      expect('inDisplay' in row).toBe(false);
    }
  });

  test('no path in the response sums across two different assets', () => {
    const rawPaths = pathsCarryingRawAmounts(simpleSummary());
    expect(rawPaths.length).toBeGreaterThan(0);
    for (const path of rawPaths) {
      expect(path).toMatch(/(^|\.)assets\[\d+\]\.(in|out|net)Raw$/);
    }
  });

  test('a counterparty carries per-asset sums and never one blended amount', () => {
    const summary = simpleSummary();
    const one = summary.topCounterparties.find((row) => row.address === CP_ONE)!;
    expect(one.transferCount).toBe(FIXTURE_SIMPLE_EXPECTED.counterparties[CP_ONE].transferCount);
    expect(one.inCount).toBe(FIXTURE_SIMPLE_EXPECTED.counterparties[CP_ONE].inCount);
    expect(one.outCount).toBe(FIXTURE_SIMPLE_EXPECTED.counterparties[CP_ONE].outCount);
    expect(one.assets).toEqual(
      expect.arrayContaining([
        { assetScriptHash: GAS_SCRIPT_HASH, inRaw: '0', outRaw: '125000000', transferCount: 2 },
        { assetScriptHash: NEO_SCRIPT_HASH, inRaw: '200000000', outRaw: '0', transferCount: 1 },
      ]),
    );
    for (const key of Object.keys(one)) {
      expect(/^(in|out|net|total|volume)(Raw|Display|Amount|Value|Sum)$/i.test(key)).toBe(false);
    }
  });

  test('the summary names the ranking basis instead of implying a value ranking', () => {
    const summary = simpleSummary();
    expect(summary.topCounterpartiesRankedBy).toBe('transfer_count');
  });
});

describe('buildAccountActivitySummary — top counterparties', () => {
  const counterpartySummary = () => buildAccountActivitySummary({
    address: FIXTURE_ACCOUNT,
    network: 'mainnet',
    fromTimestampMs: 0,
    toTimestampMs: 10_000,
    history: FIXTURE_COUNTERPARTY,
    gasClaims: okGasClaims,
    dataThrough: okDataThrough,
    observedAtMs: OBSERVED_AT_MS,
  });

  test('ranks by transfer count, then last activity, then address ascending', () => {
    expect(counterpartySummary().topCounterparties.map((row) => row.address))
      .toEqual(FIXTURE_COUNTERPARTY_EXPECTED_ORDER);
  });

  test('a tie on both count and last activity is broken by address ascending', () => {
    const rows = counterpartySummary().topCounterparties;
    const tied = rows.filter((row) => row.address === CP_THREE || row.address === CP_TWO);
    expect(tied.map((row) => row.address)).toEqual([CP_THREE, CP_TWO]);
    expect(tied[0].transferCount).toBe(tied[1].transferCount);
    expect(tied[0].lastTimestampMs).toBe(tied[1].lastTimestampMs);
  });

  test('bounding the list is not a truncation of the totals', () => {
    const summary = buildAccountActivitySummary({
      address: FIXTURE_ACCOUNT,
      network: 'mainnet',
      fromTimestampMs: 0,
      toTimestampMs: 10_000,
      history: FIXTURE_COUNTERPARTY,
      gasClaims: okGasClaims,
      dataThrough: okDataThrough,
      observedAtMs: OBSERVED_AT_MS,
      options: { topCounterparties: 1 },
    });
    expect(summary.topCounterparties).toHaveLength(1);
    expect(summary.topCounterpartiesLimit).toBe(1);
    expect(summary.transfers.distinctCounterparties).toBe(4);
    expect(summary.truncation.truncated).toBe(false);
    expect(summary.truncation.reasons).toEqual([]);
    expect(summary.transfers.counted).toBe(7);
    expect(summary.transfers.rowsDroppedByCap).toBe(0);
  });

  test('the default bound is reported and is not silently unlimited', () => {
    expect(DEFAULT_TOP_COUNTERPARTIES).toBe(5);
    expect(simpleSummary().topCounterpartiesLimit).toBe(DEFAULT_TOP_COUNTERPARTIES);
  });
});

describe('buildAccountActivitySummary — truncation', () => {
  const capped = () => buildAccountActivitySummary({
    address: FIXTURE_ACCOUNT,
    network: 'mainnet',
    fromTimestampMs: 0,
    toTimestampMs: 10_000,
    history: FIXTURE_CAP,
    gasClaims: okGasClaims,
    dataThrough: okDataThrough,
    observedAtMs: OBSERVED_AT_MS,
    options: { decimalsFor: nativeOnlyDecimals, maxTransferRows: FIXTURE_CAP_EXPECTED.cap },
  });

  test('exceeding the transfer row cap is flagged and the sums cover only the rows considered', () => {
    const summary = capped();
    expect(summary.truncation.truncated).toBe(true);
    expect(summary.truncation.reasons).toContain('transfer_rows_capped');
    expect(summary.truncation.transferRowCap).toBe(FIXTURE_CAP_EXPECTED.cap);
    expect(summary.transfers.rowsObserved).toBe(FIXTURE_CAP_EXPECTED.rowsObserved);
    expect(summary.transfers.rowsSummarized).toBe(FIXTURE_CAP_EXPECTED.rowsSummarized);
    expect(summary.transfers.rowsDroppedByCap).toBe(FIXTURE_CAP_EXPECTED.rowsDroppedByCap);

    const gas = assetRow(summary, GAS_SCRIPT_HASH);
    expect(gas.inRaw).toBe(FIXTURE_CAP_EXPECTED.gasInRaw);
    expect(gas.outRaw).toBe(FIXTURE_CAP_EXPECTED.gasOutRaw);
    expect(gas.netRaw).toBe(FIXTURE_CAP_EXPECTED.gasNetRaw);
    expect(gas.inCount).toBe(FIXTURE_CAP_EXPECTED.inCount);
    expect(gas.outCount).toBe(FIXTURE_CAP_EXPECTED.outCount);
  });

  test('the cap covers the earliest rows of the window and says how many it dropped', () => {
    const summary = capped();
    expect(summary.transfers.rowsDroppedByCap).toBe(2);
    expect(summary.transfers.rowsObserved).toBe(
      summary.transfers.rowsSummarized + summary.transfers.rowsExcluded + summary.transfers.rowsDroppedByCap,
    );
    // Coverage stops at the newest row that was actually summarised, not at the requested end.
    expect(summary.coverage.coveredThroughTimestampMs).toBe(3_000);
    expect(summary.coverage.coveredFromTimestampMs).toBe(0);
  });

  test('the default cap is a stated bound', () => {
    expect(DEFAULT_MAX_TRANSFER_ROWS).toBe(1000);
    expect(simpleSummary().truncation.transferRowCap).toBe(DEFAULT_MAX_TRANSFER_ROWS);
  });

  test('rows that cannot be summarised are excluded, counted and named — never silently summed', () => {
    const summary = buildAccountActivitySummary({
      address: FIXTURE_ACCOUNT,
      network: 'mainnet',
      fromTimestampMs: 1_000,
      toTimestampMs: 3_000,
      history: FIXTURE_DEFECTS,
      gasClaims: okGasClaims,
      dataThrough: okDataThrough,
      observedAtMs: OBSERVED_AT_MS,
      options: { decimalsFor: nativeOnlyDecimals },
    });

    const gas = assetRow(summary, GAS_SCRIPT_HASH);
    expect(gas.inRaw).toBe(FIXTURE_DEFECTS_EXPECTED.gasInRaw);
    expect(gas.outRaw).toBe(FIXTURE_DEFECTS_EXPECTED.gasOutRaw);
    expect(gas.netRaw).toBe(FIXTURE_DEFECTS_EXPECTED.gasNetRaw);

    expect(summary.transfers.rowsObserved).toBe(FIXTURE_DEFECTS_EXPECTED.rowsObserved);
    expect(summary.transfers.rowsSummarized).toBe(FIXTURE_DEFECTS_EXPECTED.rowsSummarized);
    expect(summary.transfers.rowsExcluded).toBe(FIXTURE_DEFECTS_EXPECTED.rowsExcluded);
    expect(summary.truncation.rowsMissingTimestamp).toBe(FIXTURE_DEFECTS_EXPECTED.rowsMissingTimestamp);
    expect(summary.truncation.rowsMissingAmount).toBe(FIXTURE_DEFECTS_EXPECTED.rowsMissingAmount);
    expect(summary.truncation.rowsMissingAssetHash).toBe(FIXTURE_DEFECTS_EXPECTED.rowsMissingAssetHash);
    expect(summary.truncation.rowsOutsideWindow).toBe(FIXTURE_DEFECTS_EXPECTED.rowsOutsideWindow);
    expect(summary.truncation.reasons).toEqual(FIXTURE_DEFECTS_EXPECTED.reasons);
    expect(summary.truncation.truncated).toBe(true);
    expect(summary.transfers.rowsObserved).toBe(
      summary.transfers.rowsSummarized + summary.transfers.rowsExcluded + summary.transfers.rowsDroppedByCap,
    );
  });

  test('a negative or fractional amount never reaches a total', () => {
    const summary = buildAccountActivitySummary({
      address: FIXTURE_ACCOUNT,
      network: 'mainnet',
      fromTimestampMs: 0,
      toTimestampMs: 10_000,
      history: {
        sent: [
          { timestamp: 1, assethash: GAS_SCRIPT_HASH, transferaddress: CP_ONE, amount: '-5' },
          { timestamp: 2, assethash: GAS_SCRIPT_HASH, transferaddress: CP_ONE, amount: 1.5 },
        ],
        received: [{ timestamp: 3, assethash: GAS_SCRIPT_HASH, transferaddress: CP_TWO, amount: '10' }],
      },
      gasClaims: okGasClaims,
      dataThrough: okDataThrough,
      observedAtMs: OBSERVED_AT_MS,
      options: { decimalsFor: nativeOnlyDecimals },
    });
    const gas = assetRow(summary, GAS_SCRIPT_HASH);
    expect(gas.outRaw).toBe('0');
    expect(gas.inRaw).toBe('10');
    expect(summary.truncation.rowsMissingAmount).toBe(2);
    expect(summary.truncation.truncated).toBe(true);
  });

  test('a complete summary is not flagged as truncated', () => {
    const summary = simpleSummary();
    expect(summary.truncation.truncated).toBe(false);
    expect(summary.truncation.reasons).toEqual([]);
    expect(summary.coverage.windowClippedAtDataThrough).toBe(false);
  });
});

describe('buildAccountActivitySummary — window coverage and freshness', () => {
  test('an explicit end past the data-through block clips at the data-through block', () => {
    const summary = simpleSummary({
      toTimestampMs: FIXTURE_WINDOW.toTimestampMs,
    });
    expect(summary.coverage.windowClippedAtDataThrough).toBe(FIXTURE_WINDOW.expectedClipped);
    expect(summary.coverage.coveredThroughTimestampMs).toBe(FIXTURE_WINDOW.expectedCoveredThroughTimestampMs);
    expect(summary.coverage.coveredFromTimestampMs).toBe(FIXTURE_WINDOW.expectedCoveredFromTimestampMs);
    expect(summary.window.toTimestampMs).toBe(FIXTURE_WINDOW.toTimestampMs);
    expect(summary.truncation.reasons).toContain('window_clipped_at_data_through');
    expect(summary.truncation.truncated).toBe(true);
  });

  test('an explicit end inside the data-through range is not clipped', () => {
    const summary = simpleSummary();
    expect(summary.coverage.coveredThroughTimestampMs).toBe(WINDOW_TO_MS);
    expect(summary.coverage.windowClippedAtDataThrough).toBe(false);
    expect(summary.truncation.reasons).not.toContain('window_clipped_at_data_through');
  });

  test('an open-ended window reports coverage through the data-through block', () => {
    const summary = simpleSummary({ toTimestampMs: null });
    expect(summary.window.toTimestampMs).toBeNull();
    expect(summary.coverage.coveredThroughTimestampMs).toBe(DATA_THROUGH_TIME_MS);
    expect(summary.coverage.windowClippedAtDataThrough).toBe(false);
    expect(summary.truncation.reasons).not.toContain('window_clipped_at_data_through');
  });

  test('the freshness stamp names the observation time and the data-through block', () => {
    const summary = simpleSummary();
    expect(summary.freshness).toEqual({
      observedAt: '2023-11-14T22:25:00.000Z',
      observedAtMs: OBSERVED_AT_MS,
      dataThroughBlock: DATA_THROUGH_BLOCK,
      dataThroughBlockHash: DATA_THROUGH_HASH,
      dataThroughBlockTimeMs: DATA_THROUGH_TIME_MS,
      dataThroughBlockTimeIso: '2023-11-14T22:21:40.000Z',
      dataThroughAvailable: true,
    });
  });

  test('when the data-through block cannot be read the summary says so and keeps the totals exact', () => {
    const summary = simpleSummary({
      dataThrough: { available: false, block: null, blockHash: null, blockTimeMs: null, reason: 'data_through_unavailable' },
    });
    expect(summary.freshness.dataThroughAvailable).toBe(false);
    expect(summary.freshness.dataThroughBlock).toBeNull();
    expect(summary.freshness.dataThroughBlockTimeMs).toBeNull();
    expect(summary.freshness.observedAtMs).toBe(OBSERVED_AT_MS);
    expect(summary.truncation.reasons).toContain('data_through_unavailable');
    expect(summary.truncation.truncated).toBe(true);
    expect(assetRow(summary, GAS_SCRIPT_HASH).inRaw).toBe(FIXTURE_SIMPLE_EXPECTED.gas.inRaw);
    expect(assetRow(summary, GAS_SCRIPT_HASH).outRaw).toBe(FIXTURE_SIMPLE_EXPECTED.gas.outRaw);
  });

  test('without a data-through block time an explicit end is not claimed to be covered', () => {
    const summary = simpleSummary({
      toTimestampMs: FIXTURE_WINDOW.toTimestampMs,
      dataThrough: { available: true, block: DATA_THROUGH_BLOCK, blockHash: DATA_THROUGH_HASH, blockTimeMs: null },
    });
    expect(summary.coverage.coveredThroughTimestampMs).toBeNull();
    expect(summary.coverage.windowClippedAtDataThrough).toBe(false);
    expect(summary.truncation.reasons).toContain('data_through_time_unavailable');
    expect(summary.truncation.truncated).toBe(true);
  });
});

describe('buildAccountActivitySummary — GAS claims', () => {
  test('passes the claimable GAS figure through unchanged', () => {
    expect(simpleSummary().gasClaims).toEqual({
      available: true,
      unclaimedGas: '0.00350538',
      source: 'rpc:getunclaimedgas',
      reason: null,
    });
  });

  test('a failed claims read reports unavailability instead of a zero', () => {
    const summary = simpleSummary({
      gasClaims: { available: false, unclaimedGas: null, source: null, reason: 'gas_claims_unavailable' },
    });
    expect(summary.gasClaims.available).toBe(false);
    expect(summary.gasClaims.unclaimedGas).toBeNull();
    expect(summary.gasClaims.reason).toBe('gas_claims_unavailable');
    expect(summary.truncation.reasons).toContain('gas_claims_unavailable');
    expect(summary.truncation.truncated).toBe(true);
  });

  test('a claimable GAS of exactly zero is reported as zero, not as missing', () => {
    const summary = simpleSummary({
      gasClaims: { available: true, unclaimedGas: '0', source: 'rpc:getunclaimedgas' },
    });
    expect(summary.gasClaims.available).toBe(true);
    expect(summary.gasClaims.unclaimedGas).toBe('0');
    expect(summary.truncation.reasons).not.toContain('gas_claims_unavailable');
  });
});

describe('buildAccountActivitySummary — envelope', () => {
  test('declares itself read-only and non-signing', () => {
    const summary = simpleSummary();
    expect(summary.schemaVersion).toBe(1);
    expect(summary.kind).toBe('neoos.account.activity.summary');
    expect(summary.readOnly).toBe(true);
    expect(summary.canSign).toBe(false);
    expect(summary.canBroadcast).toBe(false);
    expect(summary.address).toBe(FIXTURE_ACCOUNT);
    expect(summary.network).toBe('mainnet');
    expect(summary.amountUnit).toBe('base_units');
    expect(summary.scope).toEqual({ standard: 'NEP-17', excludes: ['NEP-11'] });
    expect(summary.window).toEqual({ fromTimestampMs: WINDOW_FROM_MS, toTimestampMs: WINDOW_TO_MS });
  });

  test('handles a window with no activity at all', () => {
    const summary = simpleSummary({ history: { sent: [], received: [] } });
    expect(summary.assets).toEqual([]);
    expect(summary.topCounterparties).toEqual([]);
    expect(summary.transfers).toMatchObject({
      counted: 0,
      inCount: 0,
      outCount: 0,
      rowsObserved: 0,
      rowsSummarized: 0,
      rowsExcluded: 0,
      rowsDroppedByCap: 0,
      distinctAssets: 0,
      distinctCounterparties: 0,
    });
    expect(summary.truncation.truncated).toBe(false);
    expect(summary.truncation.reasons).toEqual([]);
  });

  test('handles a null history without claiming any activity', () => {
    const summary = simpleSummary({ history: null });
    expect(summary.transfers.counted).toBe(0);
    expect(summary.transfers.rowsObserved).toBe(0);
    expect(summary.truncation.reasons).toEqual([]);
    expect(summary.gasClaims.available).toBe(true);
  });
});
