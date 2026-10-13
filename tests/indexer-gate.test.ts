import { ProtocolErrorCode } from '@modelcontextprotocol/server';
import { callTool } from '../src/handlers/tool-handler';
import { resolveRoute } from '../src/registry/tool-registry';
import { fetchN3Index } from '../src/contracts/n3index-rest-client';
import { callIndexerRpc } from '../src/contracts/indexer-rpc-client';
import { N3IndexClient } from '../src/contracts/n3index-client';
import { NeoService, NeoNetwork } from '../src/services/neo-service';
import { ContractService } from '../src/contracts/contract-service';
import { config } from '../src/config';

// The analytical indexer tools route straight to their HTTP clients and never touch
// NeoService/ContractService, so empty service maps are sufficient.
const emptyNeoServices = new Map<NeoNetwork, NeoService>();
const emptyContractServices = new Map<NeoNetwork, ContractService>();

const VALID_N3_ADDRESS = 'NaMLm1hwCaQitxmLboJGo2XJkG8PSYvuyr';
const VALID_N3_TARGET = 'NSkSDp2FjS4G3ngP5Rryi77qa6yWFuR8LK';
const VALID_N3_TOKEN_HASH = '0xd2a4cff31913016155e38e474a2c06d08be276cf';
const N3_MAINNET = 'https://api.n3index.dev/mainnet';

/** Every internal handler that reads from the n3index host (`api.n3index.dev`). */
const INDEXER_BACKED_CALLS: ReadonlyArray<[string, Record<string, unknown>]> = [
  ['n3_get_address', { address: VALID_N3_ADDRESS }],
  ['n3_list_transactions_by_address', { address: VALID_N3_ADDRESS, limit: 10, skip: 0 }],
  ['n3_list_transfers_by_address', { address: VALID_N3_ADDRESS, limit: 10, skip: 0 }],
  ['n3_asset_holders', { contractHash: VALID_N3_TOKEN_HASH, limit: 10, skip: 0 }],
  ['n3_assets_held_by_address', { address: VALID_N3_ADDRESS, limit: 10, skip: 0 }],
  ['n3_contract_by_name', { name: 'NeoFS' }],
  ['n3_list_blocks', { limit: 10, skip: 0 }],
  ['n3_list_transactions', { limit: 10, skip: 0 }],
  ['n3_get_transaction', { transactionHash: '0x' + 'ab'.repeat(32) }],
  ['n3_get_block', { block: 100 }],
  ['n3_list_nep17_transfers_by_contract', { contractHash: VALID_N3_TOKEN_HASH, limit: 10, skip: 0 }],
  ['n3_list_assets', { limit: 10, skip: 0 }],
  ['n3_analyze_stablecoins', {}],
  ['query_indexer', { method: 'analyze_address', params: { address: VALID_N3_ADDRESS } }],
  ['query_indexer_find', { collection: 'transactions', filter: { sender: VALID_N3_ADDRESS } }],
];

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: { get: () => null },
    body: null,
    json: async () => body,
  } as never;
}

describe('N3INDEX_ENABLED gates the indexer-backed tools', () => {
  const realFetch = global.fetch;
  let enabled: boolean;

  beforeEach(() => {
    enabled = config.n3index.enabled;
    config.n3index.enabled = false;
  });

  afterEach(() => {
    config.n3index.enabled = enabled;
    global.fetch = realFetch;
  });

  // ── The acceptance: analyze_address fails closed, instead of calling out ──────

  test('analyze_address fails closed through its public route and never resolves a host', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const route = resolveRoute('analyze_address', { address: VALID_N3_ADDRESS, network: 'mainnet' });
    expect(route.internalName).toBe('query_indexer');

    const response = await callTool(
      route.internalName,
      route.args,
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.error).toBeDefined();
  });

  test('analyze_address refuses with a diagnosable message naming the tool and the flag', async () => {
    global.fetch = jest.fn() as any;
    const response = await callTool(
      'query_indexer',
      { method: 'analyze_address', params: { address: VALID_N3_ADDRESS } },
      emptyNeoServices,
      emptyContractServices,
    );
    const message = (response.error as { message: string }).message;
    expect(message).toBe('analyze_address is disabled; enable N3INDEX_ENABLED');
  });

  test('the refusal carries InvalidParams, not a transport failure', async () => {
    global.fetch = jest.fn() as any;
    const response = await callTool(
      'query_indexer',
      { method: 'analyze_address', params: { address: VALID_N3_ADDRESS } },
      emptyNeoServices,
      emptyContractServices,
    );
    expect((response.error as { code: number }).code).toBe(-32602);
  });

  // ── Every other indexer-backed tool fails closed too ──────────────────────────

  test.each(INDEXER_BACKED_CALLS)(
    '%s fails closed with no fetch while N3INDEX_ENABLED is off',
    async (name, input) => {
      const fetchMock = jest.fn();
      global.fetch = fetchMock as any;

      const response = await callTool(name, input, emptyNeoServices, emptyContractServices);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(response.error).toBeDefined();
      expect((response.error as { message: string }).message).toMatch(/N3INDEX_ENABLED/);
    },
  );

  test.each([
    ['analyze_address', { address: VALID_N3_ADDRESS }, 'analyze_address'],
    ['analyze_address_connection', { source: VALID_N3_ADDRESS, target: VALID_N3_TARGET }, 'analyze_address_connection'],
    ['analyze_account_graph', { address: VALID_N3_ADDRESS }, 'analyze_account_graph'],
    ['explorer_get_address', { chain: 'n3', address: VALID_N3_ADDRESS }, 'get_address_summary'],
    ['analyze_stablecoins', { chain: 'n3' }, 'n3_analyze_stablecoins'],
  ] as const)('public tool %s is gated before any host is resolved', async (tool, args, subject) => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;
    const route = resolveRoute(tool, { ...args });
    const response = await callTool(route.internalName, route.args, emptyNeoServices, emptyContractServices);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.error).toBeDefined();
    expect((response.error as { message: string }).message).toBe(
      `${subject} is disabled; enable N3INDEX_ENABLED`,
    );
  });

  // ── Last line of defence: the transports themselves refuse ───────────────────

  test('the three n3index transports refuse before any host is resolved', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    await expect(fetchN3Index(NeoNetwork.MAINNET, `accounts/${VALID_N3_ADDRESS}`, {}, undefined, fetchMock as never))
      .rejects.toThrow(/N3INDEX_ENABLED/);
    await expect(callIndexerRpc(NeoNetwork.MAINNET, 'GetAddressByAddress', { Address: VALID_N3_ADDRESS }, undefined, fetchMock as never))
      .rejects.toThrow(/N3INDEX_ENABLED/);
    const client = new N3IndexClient('https://api.n3index.dev', fetchMock as never);
    await expect(client.resolveByName(NeoNetwork.MAINNET, 'NeoFS')).rejects.toThrow(/N3INDEX_ENABLED/);
    await expect(client.getContractByHash(NeoNetwork.MAINNET, VALID_N3_TOKEN_HASH)).rejects.toThrow(/N3INDEX_ENABLED/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── The gate is real, not a permanent block (mutant-proofing) ─────────────────

  test('with the flag on the same tools do call out', async () => {
    config.n3index.enabled = true;
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ data: { address: VALID_N3_ADDRESS } }));
    global.fetch = fetchMock as any;

    const route = resolveRoute('analyze_address', { address: VALID_N3_ADDRESS, network: 'mainnet' });
    const response = await callTool(route.internalName, route.args, emptyNeoServices, emptyContractServices);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe(`${N3_MAINNET}/accounts/${VALID_N3_ADDRESS}/intelligence`);
    expect(response.result).toEqual({ data: { address: VALID_N3_ADDRESS } });
    expect(response.error).toBeUndefined();
  });

  // ── Scope of the gate: the n3index host only ─────────────────────────────────

  test('the n3index gate does not reach the Neo X Blockscout surface', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ hash: '0x' + '11'.repeat(20) }));
    global.fetch = fetchMock as any;

    const response = await callTool(
      'x_query',
      { endpoint: 'get_address', params: { address: '0x' + '11'.repeat(20) } },
      emptyNeoServices,
      emptyContractServices,
    );

    expect(fetchMock).toHaveBeenCalled();
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).not.toContain('n3index.dev');
    expect(response.error).toBeUndefined();
  });
});
