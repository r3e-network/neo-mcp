import { jest } from '@jest/globals';
import {
  ACCOUNT_ACTIVITY_TOOLS,
  summarizeAccountActivity,
  type AccountActivitySources,
} from '../src/handlers/account-activity-tools';
import { PUBLIC_TOOLS, resolveRoute } from '../src/registry/tool-registry';
import {
  CP_ONE,
  DATA_THROUGH_BLOCK,
  DATA_THROUGH_HASH,
  DATA_THROUGH_TIME_MS,
  FIXTURE_ACCOUNT,
  FIXTURE_SIMPLE,
  FIXTURE_SIMPLE_EXPECTED,
  GAS_SCRIPT_HASH,
  NEO_SCRIPT_HASH,
  UNKNOWN_TOKEN_HASH,
  WINDOW_FROM_MS,
  WINDOW_TO_MS,
} from './fixtures/account-activity-fixtures';

const HISTORY = {
  sent: FIXTURE_SIMPLE.sent,
  received: FIXTURE_SIMPLE.received,
};

type SourceMock = (...args: never[]) => unknown;

function makeSources(overrides: Partial<Record<keyof AccountActivitySources, SourceMock>> = {}): AccountActivitySources {
  const base: Record<keyof AccountActivitySources, SourceMock> = {
    getNep17Transfers: jest.fn(async () => HISTORY),
    getUnclaimedGas: jest.fn(async () => ({ address: FIXTURE_ACCOUNT, unclaimedGas: '0.00350538' })),
    // getBlockCount reports the number of blocks, so the latest index is one lower.
    getBlockCount: jest.fn(async () => DATA_THROUGH_BLOCK + 1),
    getBlock: jest.fn(async () => ({ index: DATA_THROUGH_BLOCK, hash: DATA_THROUGH_HASH, time: DATA_THROUGH_TIME_MS })),
  };
  return { ...base, ...overrides } as unknown as AccountActivitySources;
}

function call(sources: AccountActivitySources, input: Record<string, unknown> = {}) {
  return summarizeAccountActivity({
    address: FIXTURE_ACCOUNT,
    fromTimestampMs: WINDOW_FROM_MS,
    toTimestampMs: WINDOW_TO_MS,
    ...input,
  }, sources);
}

function assetRow(summary: Record<string, any>, scriptHash: string) {
  const row = (summary.assets as Array<Record<string, any>>)
    .find((candidate) => candidate.asset.scriptHash === scriptHash);
  if (!row) throw new Error(`asset ${scriptHash} missing from summary`);
  return row;
}

function rejects(sources: AccountActivitySources, input: Record<string, unknown> = {}) {
  return expect(call(sources, input)).rejects;
}

describe('summarize_account_activity — parameters', () => {
  test('rejects an address that is not a Neo N3 address', async () => {
    await rejects(makeSources(), { address: 'not-an-address' }).toThrow(/address/i);
  });

  test('rejects an empty address', async () => {
    await rejects(makeSources(), { address: '' }).toThrow(/address/i);
  });

  test('rejects a non-integer window bound', async () => {
    await rejects(makeSources(), { fromTimestampMs: 1.5 }).toThrow(/fromTimestampMs/);
    await rejects(makeSources(), { toTimestampMs: 'soon' }).toThrow(/toTimestampMs/);
    await rejects(makeSources(), { fromTimestampMs: -1 }).toThrow(/fromTimestampMs/);
  });

  test('rejects a window that ends before it starts', async () => {
    await rejects(makeSources(), {
      fromTimestampMs: WINDOW_TO_MS,
      toTimestampMs: WINDOW_FROM_MS,
    }).toThrow(/fromTimestampMs must be less than or equal to toTimestampMs/);
  });

  test('rejects a topCounterparties bound outside 1-25', async () => {
    await rejects(makeSources(), { topCounterparties: 0 }).toThrow(/topCounterparties/);
    await rejects(makeSources(), { topCounterparties: 26 }).toThrow(/topCounterparties/);
    await rejects(makeSources(), { topCounterparties: 2.5 }).toThrow(/topCounterparties/);
  });

  test('rejects an unsupported network rather than guessing one', async () => {
    await rejects(makeSources(), { network: 'mainnetz' }).toThrow(/network/);
  });

  test('rejects a non-object argument set', async () => {
    await expect(summarizeAccountActivity(null as any, makeSources())).rejects.toThrow(/object/i);
  });
});

describe('summarize_account_activity — reads', () => {
  test('asks the transfer read for exactly the requested window', async () => {
    const sources = makeSources();
    await call(sources, { fromTimestampMs: WINDOW_FROM_MS, toTimestampMs: WINDOW_TO_MS });
    expect(sources.getNep17Transfers).toHaveBeenCalledWith(FIXTURE_ACCOUNT, {
      fromTimestampMs: WINDOW_FROM_MS,
      toTimestampMs: WINDOW_TO_MS,
    });
  });

  test('omits an unbounded window bound from the transfer read instead of sending null', async () => {
    const sources = makeSources();
    await call(sources, { fromTimestampMs: undefined, toTimestampMs: undefined });
    expect(sources.getNep17Transfers).toHaveBeenCalledWith(FIXTURE_ACCOUNT, {});
  });

  test('reads the data-through block one below the block count', async () => {
    const sources = makeSources();
    await call(sources);
    expect(sources.getBlockCount).toHaveBeenCalledTimes(1);
    expect(sources.getBlock).toHaveBeenCalledWith(DATA_THROUGH_BLOCK);
  });

  test('reads claimable GAS for the same address', async () => {
    const sources = makeSources();
    await call(sources);
    expect(sources.getUnclaimedGas).toHaveBeenCalledWith(FIXTURE_ACCOUNT);
  });
});

describe('summarize_account_activity — totals reach the caller unchanged', () => {
  test('returns the exact fixture totals with a freshness stamp', async () => {
    const summary = await call(makeSources());
    expect(summary.schemaVersion).toBe(1);
    expect(summary.readOnly).toBe(true);
    expect(summary.canSign).toBe(false);
    expect(summary.canBroadcast).toBe(false);
    expect(summary.address).toBe(FIXTURE_ACCOUNT);

    const gas = assetRow(summary, GAS_SCRIPT_HASH);
    expect(gas.inRaw).toBe(FIXTURE_SIMPLE_EXPECTED.gas.inRaw);
    expect(gas.outRaw).toBe(FIXTURE_SIMPLE_EXPECTED.gas.outRaw);
    expect(gas.netRaw).toBe(FIXTURE_SIMPLE_EXPECTED.gas.netRaw);
    expect(gas.inDisplay).toBe(FIXTURE_SIMPLE_EXPECTED.gas.inDisplay);
    expect(gas.outDisplay).toBe(FIXTURE_SIMPLE_EXPECTED.gas.outDisplay);

    expect((summary.transfers as Record<string, any>).counted).toBe(
      FIXTURE_SIMPLE_EXPECTED.transfers.counted,
    );
    expect((summary.topCounterparties as Array<Record<string, any>>).map((row) => row.address))
      .toEqual(FIXTURE_SIMPLE_EXPECTED.topCounterparties);

    expect(summary.freshness as Record<string, any>).toMatchObject({
      observedAtMs: expect.any(Number),
      dataThroughBlock: DATA_THROUGH_BLOCK,
      dataThroughBlockHash: DATA_THROUGH_HASH,
      dataThroughBlockTimeMs: DATA_THROUGH_TIME_MS,
      dataThroughAvailable: true,
    });
    expect((summary.freshness as Record<string, any>).observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('resolves decimals for the native tokens and leaves everything else unresolved', async () => {
    const summary = await call(makeSources());
    expect(assetRow(summary, GAS_SCRIPT_HASH).decimals).toBe(8);
    expect(assetRow(summary, NEO_SCRIPT_HASH).decimals).toBe(8);
    expect(assetRow(summary, UNKNOWN_TOKEN_HASH).decimals).toBeNull();
    expect(assetRow(summary, UNKNOWN_TOKEN_HASH).decimalsSource).toBe('unresolved');
    expect('inDisplay' in assetRow(summary, UNKNOWN_TOKEN_HASH)).toBe(false);
  });

  test('leaves a counterparty the metadata does not know unlabeled', async () => {
    const summary = await call(makeSources());
    const rows = summary.topCounterparties as Array<Record<string, any>>;
    const one = rows.find((row) => row.address === CP_ONE)!;
    // CP_ONE is a bare fixture address with no known-account entry.
    expect(one.label).toBeNull();
  });

  test('passes a zero claimable GAS figure through instead of dropping it', async () => {
    const summary = await call(makeSources({
      getUnclaimedGas: jest.fn(async () => ({ address: FIXTURE_ACCOUNT, unclaimedGas: '0' })),
    }));
    expect((summary.gasClaims as Record<string, any>).available).toBe(true);
    expect((summary.gasClaims as Record<string, any>).unclaimedGas).toBe('0');
    expect((summary.truncation as Record<string, any>).reasons).not.toContain('gas_claims_unavailable');
  });
});

describe('summarize_account_activity — a failed read is reported, never invented', () => {
  test('a failing transfer read is an error, not an empty summary', async () => {
    await rejects(makeSources({
      getNep17Transfers: jest.fn(async () => {
        throw new Error('rpc down');
      }),
    })).toThrow(/rpc down/);
  });

  test('a non-object history is an error, not a zero-activity summary', async () => {
    await rejects(makeSources({
      getNep17Transfers: jest.fn(async () => null),
    })).toThrow(/history/i);
  });

  test('a history whose direction lists are not arrays is an error', async () => {
    await rejects(makeSources({
      getNep17Transfers: jest.fn(async () => ({ sent: 'nope', received: [] })),
    })).toThrow(/history/i);
  });

  test('a failing claims read yields unavailable claims and still exact transfer totals', async () => {
    const summary = await call(makeSources({
      getUnclaimedGas: jest.fn(async () => {
        throw new Error('claims down');
      }),
    }));
    const claims = summary.gasClaims as Record<string, any>;
    expect(claims.available).toBe(false);
    expect(claims.unclaimedGas).toBeNull();
    expect(claims.reason).toBe('gas_claims_unavailable');
    expect((summary.truncation as Record<string, any>).reasons).toContain('gas_claims_unavailable');
    expect(assetRow(summary, GAS_SCRIPT_HASH).inRaw).toBe(FIXTURE_SIMPLE_EXPECTED.gas.inRaw);
  });

  test('an unreadable claims payload is unavailable rather than a guessed number', async () => {
    const summary = await call(makeSources({
      getUnclaimedGas: jest.fn(async () => ({ unexpected: 'shape' })),
    }));
    const claims = summary.gasClaims as Record<string, any>;
    expect(claims.available).toBe(false);
    expect(claims.unclaimedGas).toBeNull();
    expect(claims.reason).toBe('gas_claims_unreadable');
  });

  test('a failing block-count read marks the data-through block unavailable', async () => {
    const summary = await call(makeSources({
      getBlockCount: jest.fn(async () => {
        throw new Error('height down');
      }),
    }));
    const freshness = summary.freshness as Record<string, any>;
    expect(freshness.dataThroughAvailable).toBe(false);
    expect(freshness.dataThroughBlock).toBeNull();
    expect((summary.truncation as Record<string, any>).reasons).toContain('data_through_unavailable');
    expect(assetRow(summary, GAS_SCRIPT_HASH).outRaw).toBe(FIXTURE_SIMPLE_EXPECTED.gas.outRaw);
  });

  test('a failing block read keeps the height and drops only the block time', async () => {
    const summary = await call(makeSources({
      getBlock: jest.fn(async () => {
        throw new Error('block down');
      }),
    }));
    const freshness = summary.freshness as Record<string, any>;
    expect(freshness.dataThroughAvailable).toBe(true);
    expect(freshness.dataThroughBlock).toBe(DATA_THROUGH_BLOCK);
    expect(freshness.dataThroughBlockHash).toBeNull();
    expect(freshness.dataThroughBlockTimeMs).toBeNull();
    expect((summary.truncation as Record<string, any>).reasons).toContain('data_through_time_unavailable');
  });
});

describe('summarize_account_activity — registry', () => {
  test('the tool is advertised under exactly one name', () => {
    expect([...ACCOUNT_ACTIVITY_TOOLS]).toEqual(['summarize_account_activity']);
  });

  test('the public spec is read-only and Neo N3 only', () => {
    const spec = PUBLIC_TOOLS['summarize_account_activity'];
    expect(spec).toBeDefined();
    expect(spec.readOnly).toBe(true);
    expect(spec.chains).toEqual(['n3']);
    expect(Object.keys(spec.inputSchema)).toContain('address');
    expect(Object.keys(spec.inputSchema)).not.toContain('chain');
    expect(spec.description.length).toBeGreaterThan(20);
  });

  test('the route resolves to the NeoService-backed internal name', () => {
    const route = resolveRoute('summarize_account_activity', {
      address: FIXTURE_ACCOUNT,
      chain: 'n3',
    });
    expect(route.internalName).toBe('summarize_account_activity');
    expect(route.requiresServices).toBe(true);
    expect(route.chain).toBe('n3');
    expect('chain' in route.args).toBe(false);
  });

  test('the tool name contains no signing verb', () => {
    expect(/sign|wif|private|mnemonic|broadcast/i.test('summarize_account_activity')).toBe(false);
  });
});
