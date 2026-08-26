import { callTool } from '../src/handlers/tool-handler';
import { NeoService, NeoNetwork } from '../src/services/neo-service';
import { ContractService } from '../src/contracts/contract-service';
import { config } from '../src/config';

// The analytical indexer + Neo X tools route straight to their HTTP clients and
// never touch NeoService/ContractService, so empty service maps are sufficient.
const emptyNeoServices = new Map<NeoNetwork, NeoService>();
const emptyContractServices = new Map<NeoNetwork, ContractService>();

const VALID_N3_ADDRESS = 'NaMLm1hwCaQitxmLboJGo2XJkG8PSYvuyr';
const VALID_N3_TARGET = 'NSkSDp2FjS4G3ngP5Rryi77qa6yWFuR8LK';
const VALID_N3_TOKEN_HASH = '0xd2a4cff31913016155e38e474a2c06d08be276cf';
const VALID_EVM_ADDRESS = '0x1111111111111111111111111111111111111111';

// The live n3index REST base. The N3 analytical tools are mainnet-only (no network field on
// the newer ones; resolveIndexerNetwork defaults to mainnet), so every request targets this.
const N3_MAINNET = 'https://api.n3index.dev/mainnet';

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: { get: () => null },
    body: null,
    json: async () => body,
  } as any;
}

describe('callTool analytical dispatch', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  // ── Neo N3 analytical tools → live n3index REST API ──────────────────────────
  // Each vetted endpoint KEY + typed params is rebuilt into a concrete REST path by the guard
  // and GET-fetched at `${N3_MAINNET}/<path>` — never a model-authored path (SSRF/traversal-proof).

  test('routes n3_get_address to the n3index REST API with a validated base58 address', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({ data: { address: VALID_N3_ADDRESS } }),
    );
    global.fetch = fetchMock as any;

    const response = await callTool(
      'n3_get_address',
      { address: VALID_N3_ADDRESS, network: 'mainnet' },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${N3_MAINNET}/accounts/${VALID_N3_ADDRESS}`);
    expect(init.method).toBe('GET');
    expect(response.result).toEqual({ data: { address: VALID_N3_ADDRESS } });
  });

  test('query_indexer routes a vetted endpoint to the mainnet REST path with a substituted segment', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({ data: { address: VALID_N3_ADDRESS } }),
    );
    global.fetch = fetchMock as any;

    const response = await callTool(
      'query_indexer',
      { method: 'get_address_summary', params: { address: VALID_N3_ADDRESS } },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    // Mainnet only: no network param on the tool, resolveIndexerNetwork -> mainnet.
    expect(url).toBe(`${N3_MAINNET}/accounts/${VALID_N3_ADDRESS}`);
    expect(init.method).toBe('GET');
    expect(response.result).toEqual({ data: { address: VALID_N3_ADDRESS } });
  });

  test('query_indexer routes account graph reads to the selected network', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({ data: { address: VALID_N3_ADDRESS, coverage: { complete: false } } }),
    );
    global.fetch = fetchMock as any;

    const response = await callTool(
      'query_indexer',
      {
        method: 'analyze_account_graph',
        params: { address: VALID_N3_ADDRESS, limit: 20 },
        network: 'testnet',
      },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `https://api.n3index.dev/testnet/accounts/${VALID_N3_ADDRESS}/graph?limit=20`,
    );
    expect(init.method).toBe('GET');
    expect(response.result).toEqual({
      data: { address: VALID_N3_ADDRESS, coverage: { complete: false } },
    });
  });

  test('query_indexer routes consensus health reads to the selected network', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({ data: { network: 'testnet', status: 'healthy', engine_version: 'n3-consensus-health/v1' } }),
    );
    global.fetch = fetchMock as any;

    const response = await callTool(
      'query_indexer',
      {
        method: 'analyze_consensus_health',
        network: 'testnet',
        params: {
          lookback: 32,
          streak_threshold: 5,
          duration_threshold_s: 120,
          max_data_age_s: 180,
          max_clock_skew_s: 30,
        },
      },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://api.n3index.dev/testnet/consensus/health?lookback=32&streak_threshold=5&duration_threshold_s=120&max_data_age_s=180&max_clock_skew_s=30',
    );
    expect(init.method).toBe('GET');
    expect(response.result).toEqual({
      data: { network: 'testnet', status: 'healthy', engine_version: 'n3-consensus-health/v1' },
    });
  });

  test('query_indexer routes bounded address intelligence to the selected N3 network', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({ data: { address: VALID_N3_ADDRESS, engine_version: 'n3-address-intelligence/v2' } }),
    );
    global.fetch = fetchMock as any;

    const response = await callTool(
      'query_indexer',
      {
        method: 'analyze_address',
        network: 'testnet',
        params: { address: VALID_N3_ADDRESS, sample: 100, limit: 12 },
      },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `https://api.n3index.dev/testnet/accounts/${VALID_N3_ADDRESS}/intelligence?sample=100&limit=12`,
    );
    expect(response.result).toEqual({
      data: { address: VALID_N3_ADDRESS, engine_version: 'n3-address-intelligence/v2' },
    });
  });

  test('query_indexer routes bounded address connection evidence without a model-authored path', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({
        data: {
          source: { address: VALID_N3_ADDRESS },
          target: { address: VALID_N3_TARGET },
          status: 'indirect',
          evidence: [],
          engine_version: 'n3-address-connection/v1',
          sample: { exhaustive: false },
        },
      }),
    );
    global.fetch = fetchMock as any;

    const response = await callTool(
      'query_indexer',
      {
        method: 'analyze_address_connection',
        network: 'testnet',
        params: {
          address: VALID_N3_ADDRESS,
          target: VALID_N3_TARGET,
          sample: 80,
          limit: 6,
        },
      },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `https://api.n3index.dev/testnet/accounts/${VALID_N3_ADDRESS}/connection`
      + `?target=${VALID_N3_TARGET}&sample=80&limit=6`,
    );
    expect(response.result).toEqual(expect.objectContaining({
      data: expect.objectContaining({
        status: 'indirect',
        engine_version: 'n3-address-connection/v1',
      }),
    }));
  });

  test('query_indexer routes deterministic transaction analysis to the selected N3 network', async () => {
    const txid = `0x${'ab'.repeat(32)}`;
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({
        data: {
          txid,
          engine_version: 'n3-transaction-analysis/v1',
          transfers: [{ amount_raw: '7086000000', amount: '70.86', decimals_known: true }],
        },
      }),
    );
    global.fetch = fetchMock as any;

    const response = await callTool(
      'query_indexer',
      {
        method: 'analyze_transaction',
        network: 'testnet',
        params: { txid },
      },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://api.n3index.dev/testnet/transactions/${txid}/analysis`,
    );
    expect(response.result).toEqual({
      data: {
        txid,
        engine_version: 'n3-transaction-analysis/v1',
        transfers: [{ amount_raw: '7086000000', amount: '70.86', decimals_known: true }],
      },
    });
  });

  test('query_indexer routes a canonical multi-transaction investigation set', async () => {
    const txA = `0x${'a'.repeat(64)}`;
    const txB = `0x${'b'.repeat(64)}`;
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({
        data: {
          network: 'testnet',
          investigation_id: 'investigation:abc',
          requested_txids: [txA, txB],
          engine_version: 'n3-transaction-investigation/v1',
          timeline: [],
          relationships: [],
        },
      }),
    );
    global.fetch = fetchMock as any;

    const response = await callTool(
      'query_indexer',
      {
        method: 'investigate_transactions',
        network: 'testnet',
        params: { txids: [txB, txA] },
      },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://api.n3index.dev/testnet/investigations/transactions?txids=${txA}%2C${txB}`,
    );
    expect(response.result).toEqual(expect.objectContaining({
      data: expect.objectContaining({
        investigation_id: 'investigation:abc',
        engine_version: 'n3-transaction-investigation/v1',
      }),
    }));
  });

  test('query_indexer routes deterministic contract analysis to the selected N3 network', async () => {
    const hash = `0x${'ab'.repeat(20)}`;
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({
        data: {
          contract_hash: hash,
          engine_version: 'n3-contract-analysis/v1',
          findings: [{
            code: 'wildcard_contract_permission',
            severity: 'medium',
            evidence_refs: ['permission:1'],
          }],
        },
      }),
    );
    global.fetch = fetchMock as any;

    const response = await callTool(
      'query_indexer',
      {
        method: 'analyze_contract',
        network: 'testnet',
        params: { hash },
      },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://api.n3index.dev/testnet/contracts/${hash}/analysis`,
    );
    expect(response.result).toEqual({
      data: {
        contract_hash: hash,
        engine_version: 'n3-contract-analysis/v1',
        findings: [{
          code: 'wildcard_contract_permission',
          severity: 'medium',
          evidence_refs: ['permission:1'],
        }],
      },
    });
  });

  test('query_indexer routes paginated contract code inspection to the selected N3 network', async () => {
    const hash = `0x${'ab'.repeat(20)}`;
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({
        data: {
          contract_hash: hash,
          engine_version: 'n3-contract-opcodes/v1',
          code: { parse_status: 'complete', instruction_count: 301 },
          instructions: [{ evidence_id: 'opcode:100', offset: 100, opcode: 'RET' }],
        },
        paging: { limit: 50, offset: 100, count: 1, total: 301 },
      }),
    );
    global.fetch = fetchMock as any;

    const response = await callTool(
      'query_indexer',
      {
        method: 'inspect_contract_code',
        network: 'testnet',
        params: { hash, limit: 50, offset: 100 },
      },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://api.n3index.dev/testnet/contracts/${hash}/opcodes?limit=50&offset=100`,
    );
    expect(response.result).toEqual({
      data: {
        contract_hash: hash,
        engine_version: 'n3-contract-opcodes/v1',
        code: { parse_status: 'complete', instruction_count: 301 },
        instructions: [{ evidence_id: 'opcode:100', offset: 100, opcode: 'RET' }],
      },
      paging: { limit: 50, offset: 100, count: 1, total: 301 },
    });
  });

  test('query_indexer routes contract upgrade analysis without hiding partial history', async () => {
    const hash = `0x${'ab'.repeat(20)}`;
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({
        data: {
          contract_hash: hash,
          engine_version: 'n3-contract-upgrades/v1',
          coverage: {
            status: 'partial',
            expected_versions: 3,
            captured_versions: 1,
            missing_counters: [0, 1],
          },
          transitions: [],
        },
      }),
    );
    global.fetch = fetchMock as any;

    const response = await callTool(
      'query_indexer',
      {
        method: 'analyze_contract_upgrades',
        network: 'testnet',
        params: { hash },
      },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://api.n3index.dev/testnet/contracts/${hash}/upgrades`,
    );
    expect(response.result).toEqual({
      data: {
        contract_hash: hash,
        engine_version: 'n3-contract-upgrades/v1',
        coverage: {
          status: 'partial',
          expected_versions: 3,
          captured_versions: 1,
          missing_counters: [0, 1],
        },
        transitions: [],
      },
    });
  });

  test('query_indexer routes reproducible source evidence to the selected N3 network', async () => {
    const hash = `0x${'ab'.repeat(20)}`;
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({
        data: {
          network: 'testnet',
          contract_hash: hash,
          status: 'verified',
          current_update_counter: 2,
          current_verification: {
            evidence_id: 'source-verification:2:123456789abc',
            update_counter: 2,
            source_bundle_sha256: '12'.repeat(32),
          },
          engine_version: 'n3-contract-source-verification/v1',
        },
      }),
    );
    global.fetch = fetchMock as any;

    const response = await callTool(
      'query_indexer',
      {
        method: 'get_contract_source_verification',
        network: 'testnet',
        params: { hash },
      },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://api.n3index.dev/testnet/contracts/${hash}/source-verification`,
    );
    expect(response.result).toEqual({
      data: {
        network: 'testnet',
        contract_hash: hash,
        status: 'verified',
        current_update_counter: 2,
        current_verification: {
          evidence_id: 'source-verification:2:123456789abc',
          update_counter: 2,
          source_bundle_sha256: '12'.repeat(32),
        },
        engine_version: 'n3-contract-source-verification/v1',
      },
    });
  });

  test('query_indexer surfaces a 404 as an empty/not-found result (result: null), not an error', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(null, { status: 404 }));
    global.fetch = fetchMock as any;

    const response = await callTool(
      'query_indexer',
      { method: 'get_transaction', params: { txid: `0x${'ab'.repeat(32)}` } },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${N3_MAINNET}/transactions/0x${'ab'.repeat(32)}`);
    expect(response.error).toBeUndefined();
    expect(response.result).toBeNull();
  });

  test('query_indexer rejects a non-allowlisted endpoint with NO network call', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const response = await callTool(
      'query_indexer',
      { method: 'DropDatabase', params: {} },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.error).toBeDefined();
  });

  test('query_indexer rejects a legacy JSON-RPC method name (backend is now REST) with NO network call', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const response = await callTool(
      'query_indexer',
      { method: 'GetAddressByAddress', params: { address: VALID_N3_ADDRESS } },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.error).toBeDefined();
  });

  test('query_indexer rejects an unknown param (injection-proof) with NO network call', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const response = await callTool(
      'query_indexer',
      { method: 'get_address_summary', params: { address: VALID_N3_ADDRESS, evil: { $where: '1' } } },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.error).toBeDefined();
  });

  test('query_indexer rejects a path-traversal path param (SSRF-proof) with NO network call', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const response = await callTool(
      'query_indexer',
      { method: 'get_address_summary', params: { address: '../../../../etc/passwd' } },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.error).toBeDefined();
  });

  test('query_indexer rejects a raw REST path passed as the endpoint key with NO network call', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const response = await callTool(
      'query_indexer',
      { method: 'accounts/{address}', params: { address: VALID_N3_ADDRESS } },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.error).toBeDefined();
  });

  test('query_indexer clamps pagination limit to 100 on a paginated endpoint', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ data: [] }));
    global.fetch = fetchMock as any;

    await callTool(
      'query_indexer',
      { method: 'list_token_holders', params: { hash: VALID_N3_TOKEN_HASH, limit: 5000 } },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${N3_MAINNET}/tokens/${VALID_N3_TOKEN_HASH}/holders?limit=100`,
    );
  });

  test('n3_list_transactions_by_address maps skip->offset and clamps limit to 100', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ data: [] }));
    global.fetch = fetchMock as any;

    await callTool(
      'n3_list_transactions_by_address',
      { address: VALID_N3_ADDRESS, limit: 5000, skip: 10 },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${N3_MAINNET}/accounts/${VALID_N3_ADDRESS}/transactions?limit=100&offset=10`,
    );
  });

  test('n3_get_block resolves a block height into the {blockRef} segment', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ data: { index: 42 } }));
    global.fetch = fetchMock as any;

    await callTool(
      'n3_get_block',
      { block: '42' },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${N3_MAINNET}/blocks/42`);
  });

  test('n3_list_nep17_transfers_by_contract is repointed to the token holders REST endpoint', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ data: [] }));
    global.fetch = fetchMock as any;

    await callTool(
      'n3_list_nep17_transfers_by_contract',
      { contractHash: VALID_N3_TOKEN_HASH, limit: 20 },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${N3_MAINNET}/tokens/${VALID_N3_TOKEN_HASH}/holders?limit=20`,
    );
  });

  test('n3_contract_by_name is repointed to the global search REST endpoint (q=name)', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ data: { hits: [] } }));
    global.fetch = fetchMock as any;

    await callTool(
      'n3_contract_by_name',
      { name: 'flamingo' },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${N3_MAINNET}/search?q=flamingo`);
  });

  test('aggregates N3 stablecoin candidates in one bounded, evidence-labeled call', async () => {
    const stablecoinHash = '0x68b938cc42b6a2d54fb9040f5facf4290ebb8c5f';
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(jsonResponse({
        data: {
          hits: [{
            type: 'token',
            title: 'USDT',
            subtitle: 'USDT · NEP-17',
            hash: stablecoinHash,
          }],
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: {
          contract_hash: stablecoinHash,
          symbol: 'USDT',
          decimals: 6,
          decimals_known: true,
          total_supply_raw: '4177713119789',
          total_supply_known: true,
        },
      }));
    global.fetch = fetchMock as any;

    const response = await callTool(
      'n3_analyze_stablecoins',
      { network: 'mainnet' },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      `${N3_MAINNET}/search?q=USD`,
      `${N3_MAINNET}/tokens/${stablecoinHash}`,
    ]);
    expect(response.result).toMatchObject({
      version: 'neo-stablecoin-candidates/v1',
      chain: 'n3',
      network: 'mainnet',
      candidates: [{
        contractHash: stablecoinHash,
        classification: 'usd_name_or_symbol_candidate',
        pegAndReserveStatus: 'not_verified_by_explorer_evidence',
      }],
      coverage: { exhaustive: false },
    });
  });

  test('returns a validation error (no fetch) for an invalid N3 address', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const response = await callTool(
      'n3_get_address',
      { address: 'not-a-neo-address' },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.error).toBeDefined();
  });

  // ── Neo X (Blockscout v2) tools — unchanged, must keep working ───────────────

  test('routes x_get_address to Blockscout with a normalized 0x address', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ hash: VALID_EVM_ADDRESS }));
    global.fetch = fetchMock as any;

    const response = await callTool(
      'x_get_address',
      { address: VALID_EVM_ADDRESS.toUpperCase().replace('0X', '0x'), network: 'neox-mainnet' },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://xexplorer.neo.org/api/v2/addresses/${VALID_EVM_ADDRESS}`,
    );
    expect(response.result).toEqual({ hash: VALID_EVM_ADDRESS });
  });

  test('keeps same-symbol Neo X stablecoins as candidates rather than verified issuers', async () => {
    const token = '0x242D405a58F2358eC2810De195b31FbD0508bb18';
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(jsonResponse({
        items: [{
          type: 'token',
          name: 'Bridged USDT',
          symbol: 'USDT',
          address_hash: token,
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        address: token.toLowerCase(),
        name: 'Bridged USDT',
        symbol: 'USDT',
        decimals: '6',
      }));
    global.fetch = fetchMock as any;

    const response = await callTool(
      'x_analyze_stablecoins',
      { network: 'neox-mainnet' },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(response.result).toMatchObject({
      version: 'neo-stablecoin-candidates/v1',
      chain: 'neox',
      network: 'neox-mainnet',
      candidates: [{
        address: token.toLowerCase(),
        classification: 'usd_name_or_symbol_candidate',
        pegAndReserveStatus: 'not_verified_by_explorer_evidence',
      }],
      coverage: { exhaustive: false },
    });
  });

  test('returns a validation error (no fetch) for an invalid EVM address', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const response = await callTool(
      'x_get_address',
      { address: 'not-an-evm-address' },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.error).toBeDefined();
  });

  test('x_query routes a vetted endpoint to Blockscout with a substituted typed path segment', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ hash: VALID_EVM_ADDRESS }));
    global.fetch = fetchMock as any;

    const response = await callTool(
      'x_query',
      { endpoint: 'get_address', params: { address: VALID_EVM_ADDRESS } },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Mainnet only: x_query exposes no network field, resolveNeoxNetworkParam -> neox-mainnet.
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://xexplorer.neo.org/api/v2/addresses/${VALID_EVM_ADDRESS}`,
    );
    expect(response.result).toEqual({ hash: VALID_EVM_ADDRESS });
  });

  test('x_query rejects a non-allowlisted endpoint with NO network call', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const response = await callTool(
      'x_query',
      { endpoint: 'bogus', params: {} },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.error).toBeDefined();
  });

  test('x_query rejects a path-traversal path param (SSRF-proof) with NO network call', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const response = await callTool(
      'x_query',
      { endpoint: 'get_address', params: { address: '../../../../etc/passwd' } },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.error).toBeDefined();
  });

  // --- Phase 2 gated tools: query_indexer_find + x_graphql ---
  // query_indexer_find still targets the (currently-unreachable) neo3fura JSON-RPC gateway and
  // stays GATED; x_graphql targets the Blockscout GraphQL endpoint and stays GATED. Both must
  // (a) refuse with a clear "disabled" error and NO network call while their feature flag is off
  // (the default), (b) POST a guard-sanitized request when the flag is stubbed on, and (c) reject
  // an injection attempt (a $where operator / a mutation) with NO network call even when enabled.
  // The flags are reset after each case so a stubbed enable can never leak into another test.
  describe('gated Phase 2 tools', () => {
    afterEach(() => {
      config.n3index.findEnabled = false;
      config.neox.graphqlEnabled = false;
    });

    test('query_indexer_find refuses with NO fetch while N3INDEX_FIND_ENABLED is off', async () => {
      const fetchMock = jest.fn();
      global.fetch = fetchMock as any;

      const response = await callTool(
        'query_indexer_find',
        { collection: 'transactions', filter: { sender: VALID_N3_ADDRESS } },
        emptyNeoServices,
        emptyContractServices,
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(response.error).toBeDefined();
      expect((response.error as { message: string }).message).toMatch(/disabled/i);
    });

    test('x_graphql refuses with NO fetch while NEOX_GRAPHQL_ENABLED is off', async () => {
      const fetchMock = jest.fn();
      global.fetch = fetchMock as any;

      const response = await callTool(
        'x_graphql',
        { query: '{ block(number: 1) { hash } }' },
        emptyNeoServices,
        emptyContractServices,
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(response.error).toBeDefined();
      expect((response.error as { message: string }).message).toMatch(/disabled/i);
    });

    test('query_indexer_find (enabled) POSTs the sanitized PascalCase Filter to the JSON-RPC gateway', async () => {
      config.n3index.findEnabled = true;
      const fetchMock = jest.fn().mockResolvedValue(
        jsonResponse({ jsonrpc: '2.0', id: 1, result: [] }),
      );
      global.fetch = fetchMock as any;

      await callTool(
        'query_indexer_find',
        {
          collection: 'transactions',
          filter: { sender: VALID_N3_ADDRESS },
          sort: { blockIndex: -1 },
          limit: 5000,
        },
        emptyNeoServices,
        emptyContractServices,
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      // Mainnet only: query_indexer_find exposes no network field. It still uses the JSON-RPC
      // transport (the neo3fura gateway), which is why it stays gated off by default.
      expect(url).toBe(N3_MAINNET);
      const sent = JSON.parse(init.body as string);
      expect(sent.method).toBe('GetTransactionList');
      // The whole { Filter, Sort, Limit, Skip } request is rebuilt by the guard: only the
      // allowlisted PascalCase Filter/Sort survive, and limit is clamped to the cap.
      expect(sent.params.Filter).toEqual({ sender: VALID_N3_ADDRESS });
      expect(sent.params.Sort).toEqual({ blockIndex: -1 });
      expect(sent.params.Limit).toBe(100);
      expect(sent.params.Skip).toBe(0);
    });

    test('query_indexer_find (enabled) rejects a $where injection with NO fetch', async () => {
      config.n3index.findEnabled = true;
      const fetchMock = jest.fn();
      global.fetch = fetchMock as any;

      const response = await callTool(
        'query_indexer_find',
        { collection: 'transactions', filter: { $where: 'sleep(1000)' } },
        emptyNeoServices,
        emptyContractServices,
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(response.error).toBeDefined();
    });

    test('query_indexer_find (enabled) rejects an unknown collection with NO fetch', async () => {
      config.n3index.findEnabled = true;
      const fetchMock = jest.fn();
      global.fetch = fetchMock as any;

      const response = await callTool(
        'query_indexer_find',
        { collection: 'Transaction', filter: {} },
        emptyNeoServices,
        emptyContractServices,
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(response.error).toBeDefined();
    });

    test('x_graphql (enabled) POSTs a vetted read query to the Blockscout GraphQL endpoint', async () => {
      config.neox.graphqlEnabled = true;
      const fetchMock = jest.fn().mockResolvedValue(
        jsonResponse({ data: { block: { hash: VALID_EVM_ADDRESS } } }),
      );
      global.fetch = fetchMock as any;

      const response = await callTool(
        'x_graphql',
        { query: '{ block(number: 1) { hash } }' },
        emptyNeoServices,
        emptyContractServices,
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      // Mainnet only: x_graphql exposes no network field; the GraphQL path is /api/v1/graphql.
      expect(url).toBe('https://xexplorer.neo.org/api/v1/graphql');
      expect(init.method).toBe('POST');
      const sent = JSON.parse(init.body as string);
      expect(sent.query).toBe('{ block(number: 1) { hash } }');
      expect(response.result).toEqual({ data: { block: { hash: VALID_EVM_ADDRESS } } });
    });

    test('x_graphql (enabled) rejects a mutation with NO fetch', async () => {
      config.neox.graphqlEnabled = true;
      const fetchMock = jest.fn();
      global.fetch = fetchMock as any;

      const response = await callTool(
        'x_graphql',
        { query: 'mutation { setThing(id: 1) { ok } }' },
        emptyNeoServices,
        emptyContractServices,
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(response.error).toBeDefined();
    });
  });
});
