import { jest } from '@jest/globals';

import {
  buildAccountActivitySummary,
  type AccountActivitySummary,
  type RawTransferHistory,
} from '../src/utils/account-activity-summary';
import { summarizeAccountActivity, type AccountActivitySources } from '../src/handlers/account-activity-tools';
import { resolveKnownAccount } from '../src/metadata/known-accounts';
import { createToolResponse, renderJsonText } from '../src/utils/error-handler';
import { PUBLIC_TOOLS, publicToolNames } from '../src/registry/tool-registry';
import {
  DATA_THROUGH_BLOCK,
  DATA_THROUGH_HASH,
  DATA_THROUGH_TIME_MS,
  FIXTURE_ACCOUNT,
  GAS_SCRIPT_HASH,
  OBSERVED_AT_MS,
  UNKNOWN_TOKEN_HASH,
} from './fixtures/account-activity-fixtures';

/**
 * Auditor-gap suite for `summarize_account_activity` (CU-53).
 *
 * Each `describe` closes one gap named in the independent review. Every test names the boundary or
 * symbol it must touch and is written so a planted mutant of that symbol fails it. Nothing here
 * asserts a value the code cannot change; where a property lives in another repository (HTML
 * rendering) it is recorded as an auditor item in the evidence, not faked here.
 */

const okGasClaims = { available: true, unclaimedGas: '0', source: 'rpc:getunclaimedgas', reason: null };
const okDataThrough = {
  available: true,
  block: DATA_THROUGH_BLOCK,
  blockHash: DATA_THROUGH_HASH,
  blockTimeMs: DATA_THROUGH_TIME_MS,
  reason: null,
};

function summary(history: RawTransferHistory, overrides: Record<string, unknown> = {}): AccountActivitySummary {
  return buildAccountActivitySummary({
    address: FIXTURE_ACCOUNT,
    network: 'mainnet',
    fromTimestampMs: null,
    toTimestampMs: null,
    history,
    gasClaims: okGasClaims,
    dataThrough: okDataThrough,
    observedAtMs: OBSERVED_AT_MS,
    ...(overrides as object),
  } as Parameters<typeof buildAccountActivitySummary>[0]);
}

function assetRow(s: AccountActivitySummary, scriptHash: string) {
  const row = s.assets.find((candidate) => candidate.asset.scriptHash === scriptHash);
  if (!row) throw new Error(`asset ${scriptHash} missing`);
  return row;
}

// --- (i) escaping at the render and log boundaries ------------------------------

/** A counterparty string that would break an un-escaping render or forge a log line. */
const HOSTILE_COUNTERPARTY =
  'evil"], "pwned": 1, "x": ["\n[FORGED] ERROR injected <script>alert(1)</script> \\';

describe('auditor gap (i) — escaping at the render boundary', () => {
  test('renders hostile row fields as inert JSON: no frame break, no key injection, exact round-trip', () => {
    // transferaddress survives into topCounterparties[].address as a trimmed free string, so it is
    // the untrusted field that can carry markup and structural characters into the response.
    const s = summary({
      received: [
        {
          timestamp: 1_000,
          assethash: GAS_SCRIPT_HASH,
          transferaddress: `  ${HOSTILE_COUNTERPARTY}  `,
          amount: '5',
          blockindex: 1,
          txhash: `0x${'ab'.repeat(32)}`,
        },
      ],
    });

    // The live render boundary is renderJsonText (the server's createTextResponse goes through it).
    const text = renderJsonText(s);
    // createToolResponse wraps the same render, so the MCP envelope carries the same escaping.
    expect(createToolResponse(s).content[0].text).toBe(text);

    // The render boundary is JSON: the text must parse as one value, whatever the field holds.
    const parsed = JSON.parse(text) as Record<string, any>;
    const address = parsed.topCounterparties[0].address as string;

    // Trimmed, but the payload characters are still present as DATA.
    expect(address).toBe(HOSTILE_COUNTERPARTY);
    // Structural escaping held: no sibling key was injected anywhere in the object.
    expect(Object.keys(parsed)).not.toContain('pwned');
    expect(JSON.stringify(parsed)).not.toContain('"pwned"');
    // The quote and newline inside the value are escaped in the rendered text, not raw.
    expect(text).toContain('\\"'); // the embedded quote is escaped
    expect(text).toContain('\\n[FORGED]'); // the embedded newline is escaped to \n, then [FORGED]
    expect(text).not.toMatch(/\n\[FORGED\]/); // so it never forges a real line of its own
  });

  test('a hostile assethash or amount is never emitted as a raw string into the response', () => {
    // These two untrusted fields are normalised before they reach the response: a non-script-hash
    // assethash and a non-integer amount are excluded from the sums, so they cannot carry markup.
    const s = summary({
      sent: [
        {
          timestamp: 1_000,
          assethash: '<script>alert(1)</script>',
          transferaddress: 'NaDeJ5VHcWYkgVdw5MK4Co9KvhTMBmfrxU',
          amount: '9',
          blockindex: 1,
        },
        {
          timestamp: 2_000,
          assethash: GAS_SCRIPT_HASH,
          transferaddress: 'NaDeJ5VHcWYkgVdw5MK4Co9KvhTMBmfrxU',
          amount: '<script>1</script>',
          blockindex: 2,
        },
      ],
    });

    const text = JSON.stringify(s);
    expect(text).not.toContain('<script>');
    expect(s.truncation.rowsMissingAssetHash).toBe(1);
    expect(s.truncation.rowsMissingAmount).toBe(1);
    expect(s.assets).toHaveLength(0);
  });
});

describe('auditor gap (i) — escaping at the log boundary', () => {
  test('a hostile row field in log context cannot forge a log line', () => {
    const previous = { NODE_ENV: process.env.NODE_ENV, LOG_CONSOLE: process.env.LOG_CONSOLE };
    process.env.NODE_ENV = 'production';
    process.env.LOG_CONSOLE = 'true';
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined as unknown as void);

    try {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { logger } = require('../src/utils/logger') as typeof import('../src/utils/logger');
        logger.error('row-field-log-check', {
          transferaddress: 'evil\n[FORGED] ERROR injected-line',
          amount: '5',
        });
      });

      const output = errorSpy.mock.calls.map(([message]) => String(message)).join('\n');
      // The newline inside the value must not become a real line break (that forges a log line).
      expect(output).not.toMatch(/\n\[FORGED\]/);
      // The value is present as escaped data on a single line.
      expect(output).toContain('row-field-log-check');
      expect(output.split('\n')).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
      process.env.NODE_ENV = previous.NODE_ENV;
      process.env.LOG_CONSOLE = previous.LOG_CONSOLE;
    }
  });
});

// --- (ii) resolveKnownAccount must not map a foreign hash onto native decimals ---

const FOREIGN_HASH = UNKNOWN_TOKEN_HASH; // a well-formed 40-hex script hash that is not NEO or GAS

describe('auditor gap (ii) — resolveKnownAccount never maps a foreign hash onto native decimals', () => {
  test('resolveKnownAccount returns no native-token mapping for a foreign hash on either network', () => {
    for (const network of ['mainnet', 'testnet'] as const) {
      const known = resolveKnownAccount(FOREIGN_HASH, network);
      expect(known).toBeNull();
    }
  });

  test('a foreign hash planted on testnet yields no invented display value or native decimals', async () => {
    const sources: AccountActivitySources = {
      getNep17Transfers: jest.fn(async () => ({
        received: [
          { timestamp: 1_000, assethash: FOREIGN_HASH, transferaddress: 'NaDeJ5VHcWYkgVdw5MK4Co9KvhTMBmfrxU', amount: '7', blockindex: 1 },
        ],
      })) as unknown as AccountActivitySources['getNep17Transfers'],
      getUnclaimedGas: jest.fn(async () => ({ unclaimedGas: '0' })) as unknown as AccountActivitySources['getUnclaimedGas'],
      getBlockCount: jest.fn(async () => DATA_THROUGH_BLOCK + 1) as unknown as AccountActivitySources['getBlockCount'],
      getBlock: jest.fn(async () => ({ index: DATA_THROUGH_BLOCK, hash: DATA_THROUGH_HASH, time: DATA_THROUGH_TIME_MS })) as unknown as AccountActivitySources['getBlock'],
    };

    const s = await summarizeAccountActivity(
      { address: FIXTURE_ACCOUNT, network: 'testnet', toTimestampMs: null },
      sources,
    ) as unknown as AccountActivitySummary;

    const foreign = assetRow(s, FOREIGN_HASH);
    expect(foreign.decimals).toBeNull();
    expect(foreign.decimalsSource).toBe('unresolved');
    expect('inDisplay' in foreign).toBe(false);
    expect('outDisplay' in foreign).toBe(false);
    expect('netDisplay' in foreign).toBe(false);
  });
});

// --- (iii) collectRows: huge history and huge digit strings ---------------------

describe('auditor gap (iii) — collectRows under a huge history and a huge digit string', () => {
  test('a huge digit string in an amount is summed exactly, never truncated to a float', () => {
    // 200 digits — far above Number.MAX_SAFE_INTEGER, so any path through Number loses digits.
    const huge = '9'.repeat(200);
    const s = summary({
      received: [
        { timestamp: 1_000, assethash: GAS_SCRIPT_HASH, transferaddress: 'NaDeJ5VHcWYkgVdw5MK4Co9KvhTMBmfrxU', amount: huge, blockindex: 1 },
      ],
    });
    const gas = assetRow(s, GAS_SCRIPT_HASH);
    // Exact BigInt string, digit for digit — the wrong thing would be a rounded or truncated figure.
    expect(gas.inRaw).toBe(huge);
    expect(gas.netRaw).toBe(huge);
  });

  test('a history far larger than the row cap is capped at the stated bound with exact sums', () => {
    // Explicit bound: 2500 rows, capped at 1000. Sum of the earliest 1000 amounts (1..1000) = 500500.
    const rows = Array.from({ length: 2_500 }, (_unused, i) => ({
      timestamp: i + 1,
      assethash: GAS_SCRIPT_HASH,
      transferaddress: 'NaDeJ5VHcWYkgVdw5MK4Co9KvhTMBmfrxU',
      amount: String(i + 1),
      blockindex: i + 1,
    }));
    const s = buildAccountActivitySummary({
      address: FIXTURE_ACCOUNT,
      network: 'mainnet',
      fromTimestampMs: null,
      toTimestampMs: null,
      history: { received: rows },
      gasClaims: okGasClaims,
      dataThrough: okDataThrough,
      observedAtMs: OBSERVED_AT_MS,
      options: { maxTransferRows: 1_000 },
    });

    expect(s.transfers.rowsObserved).toBe(2_500);
    expect(s.transfers.rowsSummarized).toBe(1_000);
    expect(s.transfers.rowsDroppedByCap).toBe(1_500);
    expect(s.truncation.truncated).toBe(true);
    expect(s.truncation.reasons).toContain('transfer_rows_capped');
    // The sums cover exactly the earliest 1000 rows: 1+2+...+1000.
    expect(assetRow(s, GAS_SCRIPT_HASH).inRaw).toBe(String((1_000 * 1_001) / 2));
  });
});

// --- (iv) the advertised surface carries no key-custody or signing tool ---------

/** Parameter names that would denote server-side key custody or signing. */
const KEY_MATERIAL_INPUT = /(?:^|_|-)(?:private_?key|priv_?key|wif|mnemonic|seed(?:_?phrase)?|passphrase|signing_?key|secret_?key)(?:$|_|-)/i;
/** Tool names that would denote a signing or key-custody capability. */
const SIGNING_OR_CUSTODY_NAME = /sign|wif|private|mnemonic|seed|secret|custody|keystore|broadcast|raw_?tx|send_?raw/i;

describe('auditor gap (iv) — the surface pin admits no signing or key-custody tool', () => {
  test('no advertised tool name is a signing or key-custody tool', () => {
    const offenders = publicToolNames().filter((name) => SIGNING_OR_CUSTODY_NAME.test(name));
    expect(offenders).toEqual([]);
  });

  test('no advertised tool accepts key material as an input', () => {
    const offenders: string[] = [];
    for (const [name, spec] of Object.entries(PUBLIC_TOOLS)) {
      for (const key of Object.keys(spec.inputSchema)) {
        if (KEY_MATERIAL_INPUT.test(key)) offenders.push(`${name}.${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the summary envelope is non-custodial', async () => {
    const sources: AccountActivitySources = {
      getNep17Transfers: jest.fn(async () => ({})) as unknown as AccountActivitySources['getNep17Transfers'],
      getUnclaimedGas: jest.fn(async () => ({ unclaimedGas: '0' })) as unknown as AccountActivitySources['getUnclaimedGas'],
      getBlockCount: jest.fn(async () => DATA_THROUGH_BLOCK + 1) as unknown as AccountActivitySources['getBlockCount'],
      getBlock: jest.fn(async () => ({ index: DATA_THROUGH_BLOCK, hash: DATA_THROUGH_HASH, time: DATA_THROUGH_TIME_MS })) as unknown as AccountActivitySources['getBlock'],
    };
    const s = await summarizeAccountActivity({ address: FIXTURE_ACCOUNT }, sources) as unknown as AccountActivitySummary;
    expect(s.readOnly).toBe(true);
    expect(s.canSign).toBe(false);
    expect(s.canBroadcast).toBe(false);
    expect(PUBLIC_TOOLS['summarize_account_activity'].readOnly).toBe(true);
    expect(publicToolNames().length).toBeLessThanOrEqual(63);
  });
});

// --- (v) coverage claims under an open-ended window -----------------------------

describe('auditor gap (v) — coverage claims under an open-ended window', () => {
  test('an open-ended window bounded by the row cap reports coverage through the last summarised row', () => {
    // to = null (open-ended) AND the row cap binds: coverage must stop at the newest row actually
    // summarised, not at the data-through time. This combination is the untested one.
    const rows = Array.from({ length: 5 }, (_unused, i) => ({
      timestamp: (i + 1) * 1_000, // 1000..5000
      assethash: GAS_SCRIPT_HASH,
      transferaddress: 'NaDeJ5VHcWYkgVdw5MK4Co9KvhTMBmfrxU',
      amount: '1',
      blockindex: i + 1,
    }));
    const s = buildAccountActivitySummary({
      address: FIXTURE_ACCOUNT,
      network: 'mainnet',
      fromTimestampMs: null,
      toTimestampMs: null,
      history: { received: rows },
      gasClaims: okGasClaims,
      dataThrough: okDataThrough,
      observedAtMs: OBSERVED_AT_MS,
      options: { maxTransferRows: 3 },
    });

    expect(s.window.toTimestampMs).toBeNull();
    expect(s.transfers.rowsDroppedByCap).toBe(2);
    // Earliest three rows are summarised (timestamps 1000, 2000, 3000); coverage stops at 3000.
    expect(s.coverage.coveredThroughTimestampMs).toBe(3_000);
    // An open end is never claimed to be "clipped at data through" — there was no end to clip.
    expect(s.coverage.windowClippedAtDataThrough).toBe(false);
    expect(s.truncation.reasons).not.toContain('window_clipped_at_data_through');
  });

  test('an open-ended window is not flagged as clipped even when data stops at the data-through block', () => {
    // Rows exist after the data-through time; they are excluded and counted, but an open-ended
    // window does not claim window_clipped_at_data_through (no requested end was clipped).
    const s = summary({
      received: [
        { timestamp: 1_000, assethash: GAS_SCRIPT_HASH, transferaddress: 'NaDeJ5VHcWYkgVdw5MK4Co9KvhTMBmfrxU', amount: '1', blockindex: 1 },
        // Beyond DATA_THROUGH_TIME_MS, so this row is excluded and counted as after-data-through.
        { timestamp: DATA_THROUGH_TIME_MS + 5_000, assethash: GAS_SCRIPT_HASH, transferaddress: 'NaDeJ5VHcWYkgVdw5MK4Co9KvhTMBmfrxU', amount: '1', blockindex: 2 },
      ],
    });
    expect(s.window.toTimestampMs).toBeNull();
    expect(s.coverage.windowClippedAtDataThrough).toBe(false);
    expect(s.coverage.coveredThroughTimestampMs).toBe(DATA_THROUGH_TIME_MS);
    expect(s.truncation.rowsAfterDataThrough).toBe(1);
    expect(s.truncation.reasons).not.toContain('window_clipped_at_data_through');
    expect(s.truncation.reasons).toContain('rows_after_data_through');
  });
});
