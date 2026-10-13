/**
 * Fixture addresses and transfer histories for `summarize_account_activity`.
 *
 * Every expected total below was computed by hand from the rows in this file and is asserted
 * as an exact string, so a regression in the aggregation is a diff against a number a person
 * checked rather than against whatever the code currently produces.
 *
 * Amounts are Neo N3 base units (the unit `getnep17transfers` reports). Display values are
 * derivable only for the native assets, whose decimals are a protocol constant.
 */

import type { RawTransferHistory } from '../../src/utils/account-activity-summary';

export const FIXTURE_ACCOUNT = 'NiUs458jFbTH1DA3b9QyeDhMaD282h3iJg';

export const GAS_SCRIPT_HASH = '0xd2a4cff31913016155e38e474a2c06d08be276cf';
export const NEO_SCRIPT_HASH = '0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5';
export const UNKNOWN_TOKEN_HASH = '0x1234567890123456789012345678901234567890';

export const CP_ONE = 'NaDeJ5VHcWYkgVdw5MK4Co9KvhTMBmfrxU';
export const CP_TWO = 'NT8ERSnVtU346KkghE4Ed6z1NGo9FKChXf';
export const CP_THREE = 'NLEPgiduktPSRvcBLTjfHsqXj7Y1c9NBYS';
export const CP_FOUR = 'NQ3aD8KCmEbQ3T5GK2oEugc48r2Wem7ofN';

export const WINDOW_FROM_MS = 1_700_000_000_000;
export const WINDOW_TO_MS = 1_700_000_060_000;
export const DATA_THROUGH_BLOCK = 4_242;
export const DATA_THROUGH_TIME_MS = 1_700_000_500_000;
export const DATA_THROUGH_HASH = '0x9f1c2d3e4f5061728394a5b6c7d8e9f00112233445566778899aabbccddeeff0';
export const OBSERVED_AT_MS = 1_700_000_700_000;

/**
 * FIXTURE_SIMPLE — two native assets plus one unknown token, both directions, three
 * counterparties, one counterparty tie broken by last activity.
 */
export const FIXTURE_SIMPLE: RawTransferHistory = {
  sent: [
    {
      timestamp: 1_700_000_010_000,
      assethash: GAS_SCRIPT_HASH,
      transferaddress: CP_ONE,
      amount: '100000000',
      blockindex: 4200,
      transfernotifyindex: 0,
      txhash: '0x' + '11'.repeat(32),
    },
    {
      timestamp: 1_700_000_020_000,
      assethash: UNKNOWN_TOKEN_HASH,
      transferaddress: CP_TWO,
      amount: '7',
      blockindex: 4201,
      transfernotifyindex: 0,
      txhash: '0x' + '22'.repeat(32),
    },
    {
      timestamp: 1_700_000_040_000,
      assethash: GAS_SCRIPT_HASH,
      transferaddress: CP_ONE,
      amount: '25000000',
      blockindex: 4203,
      transfernotifyindex: 0,
      txhash: '0x' + '33'.repeat(32),
    },
    {
      timestamp: 1_700_000_060_000,
      assethash: NEO_SCRIPT_HASH,
      transferaddress: CP_TWO,
      amount: '50000000',
      blockindex: 4205,
      transfernotifyindex: 0,
      txhash: '0x' + '44'.repeat(32),
    },
  ],
  received: [
    {
      timestamp: 1_700_000_030_000,
      assethash: GAS_SCRIPT_HASH,
      transferaddress: CP_THREE,
      amount: '300000000',
      blockindex: 4202,
      transfernotifyindex: 0,
      txhash: '0x' + '55'.repeat(32),
    },
    {
      timestamp: 1_700_000_050_000,
      assethash: NEO_SCRIPT_HASH,
      transferaddress: CP_ONE,
      amount: '200000000',
      blockindex: 4204,
      transfernotifyindex: 0,
      txhash: '0x' + '66'.repeat(32),
    },
  ],
};

/** Hand-computed totals for FIXTURE_SIMPLE. */
export const FIXTURE_SIMPLE_EXPECTED = {
  transfers: {
    counted: 6,
    inCount: 2,
    outCount: 4,
    rowsObserved: 6,
    rowsSummarized: 6,
    rowsExcluded: 0,
    rowsDroppedByCap: 0,
    distinctAssets: 3,
    distinctCounterparties: 3,
  },
  gas: {
    inRaw: '300000000',
    outRaw: '125000000',
    netRaw: '175000000',
    inDisplay: '3',
    outDisplay: '1.25',
    netDisplay: '1.75',
    inCount: 1,
    outCount: 2,
    transferCount: 3,
  },
  neo: {
    inRaw: '200000000',
    outRaw: '50000000',
    netRaw: '150000000',
    inDisplay: '2',
    outDisplay: '0.5',
    netDisplay: '1.5',
    inCount: 1,
    outCount: 1,
    transferCount: 2,
  },
  unknownToken: {
    inRaw: '0',
    outRaw: '7',
    netRaw: '-7',
    inCount: 0,
    outCount: 1,
    transferCount: 1,
  },
  /** Ranked by transfer count desc, then last activity desc, then address ascending. */
  topCounterparties: [CP_ONE, CP_TWO, CP_THREE],
  counterparties: {
    [CP_ONE]: { transferCount: 3, inCount: 1, outCount: 2 },
    [CP_TWO]: { transferCount: 2, inCount: 0, outCount: 2 },
    [CP_THREE]: { transferCount: 1, inCount: 1, outCount: 0 },
  },
};

/**
 * FIXTURE_COUNTERPARTY — four counterparties that exercise every ranking tie-break:
 * two share both a count and a last-activity time (address ascending decides), one shares
 * only the count (last activity decides), one is alone at the bottom.
 *
 * Lexicographic ascending among the 2-count pair: CP_THREE (`NLEP…`) before CP_TWO (`NT8E…`).
 */
export const FIXTURE_COUNTERPARTY: RawTransferHistory = {
  sent: [
    // CP_THREE: two transfers, last activity 2000
    { timestamp: 1_000, assethash: GAS_SCRIPT_HASH, transferaddress: CP_THREE, amount: '1', blockindex: 1 },
    { timestamp: 2_000, assethash: GAS_SCRIPT_HASH, transferaddress: CP_THREE, amount: '2', blockindex: 2 },
    // CP_TWO: two transfers, last activity 2000 (tied with CP_THREE)
    { timestamp: 1_500, assethash: GAS_SCRIPT_HASH, transferaddress: CP_TWO, amount: '3', blockindex: 3 },
    { timestamp: 2_000, assethash: GAS_SCRIPT_HASH, transferaddress: CP_TWO, amount: '4', blockindex: 4 },
  ],
  received: [
    // CP_ONE: two transfers, last activity 1000
    { timestamp: 900, assethash: GAS_SCRIPT_HASH, transferaddress: CP_ONE, amount: '5', blockindex: 5 },
    { timestamp: 1_000, assethash: GAS_SCRIPT_HASH, transferaddress: CP_ONE, amount: '6', blockindex: 6 },
    // CP_FOUR: one transfer
    { timestamp: 3_000, assethash: GAS_SCRIPT_HASH, transferaddress: CP_FOUR, amount: '7', blockindex: 7 },
  ],
};

export const FIXTURE_COUNTERPARTY_EXPECTED_ORDER = [CP_THREE, CP_TWO, CP_ONE, CP_FOUR];

/**
 * FIXTURE_CAP — five summarizable rows so a cap of 3 must drop the two newest and say so.
 * The builder covers the earliest rows of the window first, so the two dropped are the last
 * two by timestamp.
 */
export const FIXTURE_CAP: RawTransferHistory = {
  sent: [
    { timestamp: 1_000, assethash: GAS_SCRIPT_HASH, transferaddress: CP_ONE, amount: '1', blockindex: 1 },
    { timestamp: 3_000, assethash: GAS_SCRIPT_HASH, transferaddress: CP_ONE, amount: '2', blockindex: 3 },
    { timestamp: 5_000, assethash: GAS_SCRIPT_HASH, transferaddress: CP_ONE, amount: '4', blockindex: 5 },
  ],
  received: [
    { timestamp: 2_000, assethash: GAS_SCRIPT_HASH, transferaddress: CP_TWO, amount: '8', blockindex: 2 },
    { timestamp: 4_000, assethash: GAS_SCRIPT_HASH, transferaddress: CP_TWO, amount: '16', blockindex: 4 },
  ],
};

/** With a cap of 3 the summarised rows are amounts 1, 8 and 2 (timestamps 1000, 2000, 3000). */
export const FIXTURE_CAP_EXPECTED = {
  cap: 3,
  rowsObserved: 5,
  rowsSummarized: 3,
  rowsDroppedByCap: 2,
  gasInRaw: '8',
  gasOutRaw: '3',
  gasNetRaw: '5',
  inCount: 1,
  outCount: 2,
};

/**
 * FIXTURE_DEFECTS — one good row in each direction, plus one row per way a row can be
 * unusable. Each defective row carries exactly one defect so the exclusion reason is
 * unambiguous.
 */
export const FIXTURE_DEFECTS: RawTransferHistory = {
  sent: [
    // summarised
    { timestamp: 1_000, assethash: GAS_SCRIPT_HASH, transferaddress: CP_ONE, amount: '100000000', blockindex: 1 },
    // missing timestamp
    { assethash: GAS_SCRIPT_HASH, transferaddress: CP_ONE, amount: '999', blockindex: 2 },
    // unparseable timestamp
    { timestamp: 'not-a-timestamp', assethash: GAS_SCRIPT_HASH, transferaddress: CP_ONE, amount: '999', blockindex: 3 },
    // non-integer amount (a float must never reach the sum)
    { timestamp: 2_500, assethash: GAS_SCRIPT_HASH, transferaddress: CP_ONE, amount: '1.5', blockindex: 4 },
    // missing amount
    { timestamp: 2_600, assethash: GAS_SCRIPT_HASH, transferaddress: CP_ONE, blockindex: 5 },
    // missing asset hash
    { timestamp: 2_700, transferaddress: CP_ONE, amount: '999', blockindex: 6 },
    // timestamp before the requested window
    { timestamp: 10, assethash: GAS_SCRIPT_HASH, transferaddress: CP_ONE, amount: '999', blockindex: 7 },
  ],
  received: [
    // summarised
    { timestamp: 2_000, assethash: GAS_SCRIPT_HASH, transferaddress: CP_TWO, amount: '50000000', blockindex: 8 },
  ],
};

export const FIXTURE_DEFECTS_EXPECTED = {
  gasInRaw: '50000000',
  gasOutRaw: '100000000',
  gasNetRaw: '-50000000',
  rowsObserved: 8,
  rowsSummarized: 2,
  rowsMissingTimestamp: 2,
  rowsMissingAmount: 2,
  rowsMissingAssetHash: 1,
  rowsOutsideWindow: 1,
  rowsExcluded: 6,
  rowsDroppedByCap: 0,
  reasons: [
    'rows_missing_amount',
    'rows_missing_asset_hash',
    'rows_missing_timestamp',
    'rows_outside_window',
  ],
};

/** A window that ends after the data-through block must clip at the data-through block. */
export const FIXTURE_WINDOW = {
  fromTimestampMs: WINDOW_FROM_MS,
  toTimestampMs: 1_700_000_900_000,
  dataThroughTimeMs: DATA_THROUGH_TIME_MS,
  expectedCoveredThroughTimestampMs: DATA_THROUGH_TIME_MS,
  expectedCoveredFromTimestampMs: WINDOW_FROM_MS,
  expectedClipped: true,
};
