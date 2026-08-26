import { callTool } from '../src/handlers/tool-handler';
import { NeoNetwork, NeoService } from '../src/services/neo-service';
import { ContractService } from '../src/contracts/contract-service';

const emptyNeoServices = new Map<NeoNetwork, NeoService>();
const emptyContractServices = new Map<NeoNetwork, ContractService>();
const HASH = `0x${'ab'.repeat(32)}`;
const ADDRESS = `0x${'12'.repeat(20)}`;

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: { get: () => null },
    body: null,
    json: async () => body,
  } as any;
}

describe('bounded Neo X intelligence tools', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
  });

  test('aggregates transaction evidence in parallel and keeps optional failure explicit', async () => {
    const items = Array.from({ length: 40 }, (_, index) => ({ index, data: `0x${index}` }));
    const fetchMock = jest.fn(async (url: string) => {
      if (url.endsWith('/logs')) return jsonResponse({ items, next_page_params: { index: 40 } });
      if (url.endsWith('/internal-transactions')) return jsonResponse({ items: [{ type: 'call' }], next_page_params: null });
      if (url.endsWith('/token-transfers')) return jsonResponse({ message: 'down' }, { ok: false, status: 503 });
      if (url.endsWith('/state-changes')) return jsonResponse({ items: [{ type: 'coin' }], next_page_params: null });
      return jsonResponse({ hash: HASH, status: 'ok', raw_input: '0x1234' });
    });
    global.fetch = fetchMock as any;

    const response = await callTool(
      'x_analyze_transaction',
      { hash: HASH, network: 'neox-mainnet' },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(expect.arrayContaining([
      `https://xexplorer.neo.org/api/v2/transactions/${HASH}`,
      `https://xexplorer.neo.org/api/v2/transactions/${HASH}/logs`,
      `https://xexplorer.neo.org/api/v2/transactions/${HASH}/internal-transactions`,
      `https://xexplorer.neo.org/api/v2/transactions/${HASH}/token-transfers`,
      `https://xexplorer.neo.org/api/v2/transactions/${HASH}/state-changes`,
    ]));
    expect(response.result).toEqual(expect.objectContaining({
      engine_version: 'neox-transaction-intelligence/v1',
      chain: 'neox',
      network: 'neox-mainnet',
      entity: { kind: 'transaction', identifier: HASH, found: true },
      sections: expect.objectContaining({
        transaction: expect.objectContaining({ status: 'available' }),
        logs: expect.objectContaining({
          status: 'available',
          boundary: expect.objectContaining({ returned: 25, has_more: true }),
        }),
        token_transfers: expect.objectContaining({ status: 'unavailable', data: null }),
      }),
      boundary: expect.objectContaining({ exhaustive_history: false }),
    }));
  });

  test('isolates every address request to Neo X testnet', async () => {
    const fetchMock = jest.fn(async (url: string) => {
      if (url.endsWith('/counters')) return jsonResponse({ transactions_count: '3' });
      if (url.endsWith('/token-balances')) return jsonResponse([{ value: '1' }]);
      if (/\/(transactions|token-transfers|internal-transactions)$/.test(url)) {
        return jsonResponse({ items: [], next_page_params: null });
      }
      return jsonResponse({ hash: ADDRESS, is_contract: false });
    });
    global.fetch = fetchMock as any;

    const response = await callTool(
      'x_analyze_address',
      { address: ADDRESS, network: 'neox-testnet' },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).toHaveBeenCalledTimes(6);
    for (const [url] of fetchMock.mock.calls) {
      expect(url).toMatch(/^https:\/\/xt4scan\.ngd\.network\/api\/v2\/addresses\//);
    }
    expect(response.result).toEqual(expect.objectContaining({
      engine_version: 'neox-address-intelligence/v1',
      network: 'neox-testnet',
      entity: expect.objectContaining({ kind: 'address', identifier: ADDRESS, found: true }),
    }));
  });

  test('returns not_found for a missing primary entity without inventing facts', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(null, { ok: false, status: 404 })) as any;

    const response = await callTool(
      'x_analyze_token',
      { address: ADDRESS, network: 'neox-mainnet' },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(response.result).toEqual(expect.objectContaining({
      entity: expect.objectContaining({ kind: 'token', identifier: ADDRESS, found: false }),
      sections: expect.objectContaining({
        token: expect.objectContaining({ status: 'not_found', data: null }),
      }),
    }));
  });

  test('caps an oversized section before it reaches the model-facing payload', async () => {
    const oversized = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`field_${index}`, 'x'.repeat(10_000)]),
    );
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(oversized)) as any;

    const response = await callTool(
      'x_analyze_block',
      { blockNumberOrHash: 42, network: 'neox-mainnet' },
      emptyNeoServices,
      emptyContractServices,
    );
    const result = response.result as any;

    expect(result.sections.block.boundary.value_truncated).toBe(true);
    expect(result.sections.block.data.preview_json.length).toBe(96_000);
    expect(result.boundary.section_json_character_limit).toBe(96_000);
  });

  test('fails closed on an invalid address before any upstream request', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const response = await callTool(
      'x_analyze_contract',
      { address: 'not-an-address', network: 'neox-mainnet' },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.error).toBeDefined();
  });

  test('attaches network-scoped curated identity to official Neo X contracts', async () => {
    const bridge = '0x1212000000000000000000000000000000000004';
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ hash: bridge, is_contract: true })) as any;

    const response = await callTool(
      'x_analyze_contract',
      { address: bridge, network: 'neox-mainnet' },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(response.result).toEqual(expect.objectContaining({
      entity: expect.objectContaining({
        kind: 'contract',
        identifier: bridge,
        identity: expect.objectContaining({
          status: 'curated',
          label: 'Neo X Bridge (Token Bridge)',
          role: 'bridge',
          evidence: expect.objectContaining({ kind: 'curated_official_registry' }),
        }),
      }),
    }));
  });

  test('does not leak a mainnet-only token identity into Neo X testnet', async () => {
    const mainnetWgas = '0xde41591ed1f8ed1484ac2cd8ca0876428de60eff';
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ hash: mainnetWgas })) as any;

    const response = await callTool(
      'x_analyze_token',
      { address: mainnetWgas, network: 'neox-testnet' },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(response.result).toEqual(expect.objectContaining({
      network: 'neox-testnet',
      entity: expect.objectContaining({ identity: { status: 'unlabeled' } }),
    }));
  });
});
