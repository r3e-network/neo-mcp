# `summarize_account_activity`

Neo N3 read-only MCP tool. Answers "what did this address do between T0 and T1" with numbers the
server computed, so a model never adds transfers together and never estimates a figure the chain
data does not support.

## Problem

`get_nep17_transfers` returns raw rows. Turning rows into an answer ("I earned about 3 GAS this
week") means the model has to sum amounts across assets, decide what counts as an inflow, and
notice when the data is incomplete. Every one of those is a place to produce a wrong number on a
user-visible surface. This tool does that work in the server, exactly, and reports where it could
not.

## API

```
summarize_account_activity(
  address: string,                 // Neo N3 address
  fromTimestampMs?: number,        // Unix ms, inclusive; omit for "from the start"
  toTimestampMs?: number,          // Unix ms, inclusive; omit for "up to the data"
  topCounterparties?: number,      // 1-25, default 5
  network?: "mainnet" | "testnet"
)
```

`fromTimestampMs`/`toTimestampMs` match `get_nep17_transfers`. Chain is `n3` only; the tool takes
no `chain` field. It is `readOnly` and returns no proposal, signature or broadcast.

## Response

```jsonc
{
  "schemaVersion": 1,
  "kind": "neoos.account.activity.summary",
  "readOnly": true,
  "canSign": false,
  "canBroadcast": false,
  "address": "NiUs…",
  "network": "mainnet",
  "amountUnit": "base_units",
  "scope": { "standard": "NEP-17", "excludes": ["NEP-11"] },
  "window": { "fromTimestampMs": 1700000000000, "toTimestampMs": 1700000060000 },
  "freshness": {
    "observedAt": "2023-11-14T22:25:00.000Z",
    "observedAtMs": 1700000700000,
    "dataThroughBlock": 4242,
    "dataThroughBlockHash": "0x…",
    "dataThroughBlockTimeMs": 1700000500000,
    "dataThroughBlockTimeIso": "2023-11-14T22:21:40.000Z",
    "dataThroughAvailable": true
  },
  "coverage": {
    "coveredFromTimestampMs": 1700000000000,
    "coveredThroughTimestampMs": 1700000060000,
    "windowClippedAtDataThrough": false
  },
  "transfers": {
    "counted": 6, "inCount": 2, "outCount": 4,
    "rowsObserved": 6, "rowsSummarized": 6, "rowsExcluded": 0, "rowsDroppedByCap": 0,
    "distinctAssets": 3, "distinctCounterparties": 3
  },
  "assets": [
    {
      "asset": { "scriptHash": "0xd2a4…", "name": "GasToken", "symbol": "GAS" },
      "decimals": 8,
      "decimalsSource": "native_protocol",
      "inRaw": "300000000", "outRaw": "125000000", "netRaw": "175000000",
      "inDisplay": "3", "outDisplay": "1.25", "netDisplay": "1.75",
      "inCount": 1, "outCount": 2, "transferCount": 3,
      "firstTimestampMs": 1700000010000, "lastTimestampMs": 1700000050000
    }
  ],
  "topCounterparties": [
    {
      "address": "NaDe…", "label": null,
      "transferCount": 3, "inCount": 1, "outCount": 2,
      "assets": [
        { "assetScriptHash": "0xd2a4…", "inRaw": "0", "outRaw": "125000000", "transferCount": 2 },
        { "assetScriptHash": "0xef40…", "inRaw": "200000000", "outRaw": "0", "transferCount": 1 }
      ],
      "firstTimestampMs": 1700000010000, "lastTimestampMs": 1700000050000
    }
  ],
  "topCounterpartiesRankedBy": "transfer_count",
  "topCounterpartiesLimit": 5,
  "gasClaims": {
    "available": true,
    "unclaimedGas": "0.00350538",
    "source": "rpc:getunclaimedgas",
    "reason": null
  },
  "truncation": {
    "truncated": false,
    "reasons": [],
    "transferRowCap": 1000,
    "rowsMissingTimestamp": 0, "rowsOutsideWindow": 0, "rowsAfterDataThrough": 0,
    "rowsMissingAssetHash": 0, "rowsMissingAmount": 0
  }
}
```

## Data structures

| Field | Meaning |
| --- | --- |
| `amountUnit` | Always `"base_units"`: amounts are Neo N3 token base units summed with `BigInt`. |
| `assets[].inRaw` / `outRaw` / `netRaw` | Exact decimal strings. `netRaw === inRaw - outRaw`. |
| `assets[].decimals` | `8` and `decimalsSource: "native_protocol"` for native NEO and GAS; `null` and `"unresolved"` otherwise. |
| `assets[].inDisplay` … | Present **only** when `decimals` is known. Absent, never `0` and never guessed. |
| `coverage.coveredThroughTimestampMs` | The time the data provably runs through. `null` when the data-through block time is unknown. |
| `gasClaims.unclaimedGas` | The node's claimable-GAS figure passed through **unrescaled**, same value and unit as `get_unclaimed_gas`. |
| `truncation.truncated` | `true` whenever any part of the summary is incomplete. |
| `truncation.reasons` | Sorted, stable reason names; see below. |

### `truncation.reasons`

| Reason | Means |
| --- | --- |
| `transfer_rows_capped` | More summarizable rows than `transferRowCap` (1000). The sums cover the earliest rows of the window and `rowsDroppedByCap` says how many were not included. |
| `window_clipped_at_data_through` | The requested `to` is later than the data-through block time, so the window is only covered up to that block. |
| `rows_missing_timestamp` | Rows with no usable timestamp; they cannot be placed in the window, so they are not summed. |
| `rows_outside_window` | Rows the transfer read returned that fall outside the requested window. |
| `rows_after_data_through` | Rows timestamped after the data-through block, which the coverage claim does not extend to. |
| `rows_missing_asset_hash` | Rows with no usable asset script hash; they cannot be attributed to an asset. |
| `rows_missing_amount` | Rows whose amount is not a non-negative integer (missing, fractional, negative or non-numeric). |
| `data_through_unavailable` | The block height could not be read. |
| `data_through_time_unavailable` | The height is known but the block's own fields are not, so no coverage end can be claimed. |
| `gas_claims_unavailable` / `gas_claims_unreadable` | The claims read failed or returned an unrecognised payload. |

Row accounting always holds: `rowsObserved === rowsSummarized + rowsExcluded + rowsDroppedByCap`.
Each row is attributed to exactly one exclusion reason, in the priority order the table lists
timestamp, window, data-through, asset hash, amount.

## Why nothing is left to model arithmetic

1. **Sums are exact.** Amounts are parsed as non-negative integers and added with `BigInt`. A
   `Number` amount is accepted only when it is a safe integer; `1.5` and `-5` are excluded and
   counted, never summed.
2. **No cross-asset total exists.** GAS base units and NEO base units are different units. The
   response has no field that adds them, and `topCounterparties` is ranked by `transfer_count`
   (named in `topCounterpartiesRankedBy`) with per-asset sums attached, rather than by a blended
   volume. Value-ranked counterparties need a common unit of account and are out of scope.
3. **Display values are earned.** A human-scale string is emitted only when the server knows the
   asset's decimals. Today that is native NEO and GAS (8, a protocol constant, resolved through
   `src/metadata/known-accounts.ts`). For any other asset the display fields are absent and
   `decimalsSource` is `"unresolved"`; scaling is not left to the model either, because the model
   does not know the decimals.
4. **Failure is never a number.** An unreadable claims payload yields `available: false`,
   `unclaimedGas: null` and a `reason` — not `0`. An unreadable transfer history is an error, not
   an empty summary.

## Error handling

| Condition | Result |
| --- | --- |
| Missing/invalid `address` | `InvalidParams` ("Address must be a non-empty string" / "Invalid Neo N3 address format") |
| Non-integer or negative `fromTimestampMs` / `toTimestampMs` | `InvalidParams` naming the field |
| `fromTimestampMs > toTimestampMs` | `InvalidParams` "fromTimestampMs must be less than or equal to toTimestampMs" |
| `topCounterparties` outside 1-25 | `InvalidParams` naming the field |
| `network` other than `mainnet`/`testnet` | `InvalidParams` |
| Arguments are not an object | `InvalidParams` "Arguments must be an object." |
| Transfer history read fails, or is not a `sent`/`received` shape | `InternalError` — the call fails rather than reporting zero activity |
| Claimable GAS read fails | Summary succeeds; `gasClaims.available: false` and a truncation reason |
| Block height or block read fails | Summary succeeds; freshness and truncation record what is missing |

## Performance and sources

Four reads, all from the configured Neo N3 RPC and all already used by existing tools:
`getnep17transfers` (windowed), `getunclaimedgas`, `getblockcount`, `getblock`. The summary adds no
new host and does not touch the N3 indexer, so it is outside the `N3INDEX_ENABLED` gating applied
to indexer-backed tools. Aggregation is O(n log n) in the transfer row count.

## Security

Read-only. No key material, no signing, no broadcast, no proposal. It returns only public on-chain
data for a caller-supplied address. Arguments are validated before any read. The tool name and
schema contain no signing verb.

## Usage example

```
summarize_account_activity(
  address: "NiUs458jFbTH1DA3b9QyeDhMaD282h3iJg",
  fromTimestampMs: 1700000000000,
  toTimestampMs: 1700000060000
)
```

The fixture address and history in `tests/fixtures/account-activity-fixtures.ts` are built to give
hand-checked numbers; the expected output for that call is the `FIXTURE_SIMPLE_EXPECTED` block
there. A model answering "what did I earn" reads `assets[].inRaw`/`outDisplay` and
`freshness`, cites `truncation.truncated` when it is `true`, and writes narrative only.

## Fixtures

`tests/fixtures/account-activity-fixtures.ts` holds five fixture histories with hand-computed
totals, so a regression shows up as a diff against a number a person checked:

| Fixture | Covers |
| --- | --- |
| `FIXTURE_SIMPLE` | Exact per-asset in/out/net across two native assets and one unknown token, both directions. |
| `FIXTURE_COUNTERPARTY` | Every ranking tie-break: count, then last activity, then address ascending. |
| `FIXTURE_CAP` | The row cap: sums cover the earliest rows, `transfer_rows_capped` is flagged. |
| `FIXTURE_DEFECTS` | One row per way a row is unusable; each is excluded, counted and named. |
| `FIXTURE_WINDOW` | A window ending after the data-through block clips at that block. |

Fixture data lives in tests only. The tool ships no canned, sample or demo dataset.

## Not in this tool

- **Priced value with timestamp** (optional in the original gap note). Needs a verified price
  source and a price timestamp; without them it would be an unverified figure on a summary surface.
- **Verified decimals for arbitrary NEP-17 contracts.** Would need a `decimals` read per asset.
- **Value-ranked counterparties.** Needs the priced value above.
- **NEP-11 (NFT) activity.** Fungible and non-fungible amounts must not be added together; the
  response declares `scope.standard: "NEP-17"` and names NEP-11 as excluded. Use
  `get_nep11_transfers` for NFT history.
