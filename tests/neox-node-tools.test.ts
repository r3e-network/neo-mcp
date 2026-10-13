/**
 * Neo X live-node tool handlers.
 *
 * These are the Neo X half of the unified `chain` axis: the same seven questions
 * the Neo N3 node tools answer (chain info, height, block, transaction, balance,
 * transaction status, read-only contract call), answered over EVM JSON-RPC
 * instead of Neo RPC.
 *
 * Every test injects a fetch stub, so the suite is deterministic and never
 * opens a socket. The assertions pin the JSON-RPC method and params that each
 * handler is allowed to emit, which is what keeps the read-only guarantee
 * observable rather than merely intended.
 */

import {
  NEOX_NODE_TOOLS,
  dispatchNeoxNodeTool,
} from '../src/handlers/neox-node-tools';

interface RpcCall {
  method: string;
  params: unknown[];
}

/**
 * Builds a fetch stub that answers each JSON-RPC method from a fixed map and
 * records every call, so a test can assert both the request and the response
 * shaping.
 */
function rpcStub(answers: Record<string, unknown>): {
  fetchImpl: jest.Mock;
  calls: RpcCall[];
} {
  const calls: RpcCall[] = [];
  const fetchImpl = jest.fn(async (_url: string, init: { body: string }) => {
    const payload = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
    calls.push({ method: payload.method, params: payload.params });
    if (!(payload.method in answers)) {
      throw new Error(`unexpected RPC method in test: ${payload.method}`);
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ jsonrpc: '2.0', id: payload.id, result: answers[payload.method] }),
    };
  });
  return { fetchImpl: fetchImpl as unknown as jest.Mock, calls };
}

function resultOf(response: unknown): Record<string, unknown> {
  const envelope = response as { result?: unknown; error?: { message?: string } };
  expect(envelope.error).toBeUndefined();
  return envelope.result as Record<string, unknown>;
}

function errorTextOf(response: unknown): string {
  const envelope = response as { result?: unknown; error?: { message?: string } };
  expect(envelope.result).toBeUndefined();
  expect(typeof envelope.error?.message).toBe('string');
  return envelope.error?.message ?? '';
}

describe('Neo X node tool inventory', () => {
  test('exposes exactly the seven cross-chain node routes', () => {
    expect([...NEOX_NODE_TOOLS].sort()).toEqual([
      'x_node_call_contract',
      'x_node_get_balance',
      'x_node_get_block',
      'x_node_get_block_height',
      'x_node_get_chain_info',
      'x_node_get_transaction',
      'x_node_get_transaction_status',
    ]);
  });

  test('rejects an unknown tool name', async () => {
    const { fetchImpl } = rpcStub({});
    await expect(
      dispatchNeoxNodeTool('x_node_send_transaction', {}, fetchImpl as never),
    ).rejects.toThrow(/not a Neo X node tool/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('x_node_get_chain_info', () => {
  test('reports chain id, height and gas price for the default network', async () => {
    const { fetchImpl, calls } = rpcStub({
      eth_chainId: '0xba9304',
      eth_blockNumber: '0x1e8481',
      eth_gasPrice: '0x9502f900',
    });
    const result = resultOf(await dispatchNeoxNodeTool('x_node_get_chain_info', {}, fetchImpl as never));

    expect(result.chain).toBe('neox');
    expect(result.network).toBe('mainnet');
    expect(result.chainId).toBe(12227332);
    expect(result.blockHeight).toBe(2000001);
    expect(result.gasPrice).toBe('2500000000');
    expect(calls.map((c) => c.method).sort()).toEqual(['eth_blockNumber', 'eth_chainId', 'eth_gasPrice']);
  });

  test('honours network: testnet', async () => {
    const { fetchImpl } = rpcStub({
      eth_chainId: '0xba9302',
      eth_blockNumber: '0x10',
      eth_gasPrice: '0x1',
    });
    const result = resultOf(
      await dispatchNeoxNodeTool('x_node_get_chain_info', { network: 'testnet' }, fetchImpl as never),
    );
    expect(result.network).toBe('testnet');
    expect(result.chainId).toBe(12227330);
  });
});

describe('x_node_get_block_height', () => {
  test('decodes the hex height', async () => {
    const { fetchImpl, calls } = rpcStub({ eth_blockNumber: '0x2a' });
    const result = resultOf(await dispatchNeoxNodeTool('x_node_get_block_height', {}, fetchImpl as never));
    expect(result.blockHeight).toBe(42);
    expect(result.blockCount).toBe(43);
    expect(calls).toEqual([{ method: 'eth_blockNumber', params: [] }]);
  });
});

describe('x_node_get_block', () => {
  test('looks a numeric height up by number with hex encoding', async () => {
    const { fetchImpl, calls } = rpcStub({
      eth_getBlockByNumber: { number: '0x2a', hash: '0x' + 'ab'.repeat(32), transactions: [] },
    });
    const result = resultOf(
      await dispatchNeoxNodeTool('x_node_get_block', { blockHashOrHeight: 42 }, fetchImpl as never),
    );
    expect(calls).toEqual([{ method: 'eth_getBlockByNumber', params: ['0x2a', false] }]);
    expect((result.block as Record<string, unknown>).number).toBe('0x2a');
    expect(result.blockNumber).toBe(42);
  });

  test('accepts a decimal string height', async () => {
    const { fetchImpl, calls } = rpcStub({
      eth_getBlockByNumber: { number: '0x100', hash: '0x' + 'cd'.repeat(32), transactions: [] },
    });
    await dispatchNeoxNodeTool('x_node_get_block', { blockHashOrHeight: '256' }, fetchImpl as never);
    expect(calls[0]).toEqual({ method: 'eth_getBlockByNumber', params: ['0x100', false] });
  });

  test('looks a 32-byte hash up by hash', async () => {
    const hash = '0x' + 'ef'.repeat(32);
    const { fetchImpl, calls } = rpcStub({
      eth_getBlockByHash: { number: '0x5', hash, transactions: [] },
    });
    await dispatchNeoxNodeTool('x_node_get_block', { blockHashOrHeight: hash }, fetchImpl as never);
    expect(calls[0]).toEqual({ method: 'eth_getBlockByHash', params: [hash, false] });
  });

  test('forwards includeTransactions', async () => {
    const { fetchImpl, calls } = rpcStub({
      eth_getBlockByNumber: { number: '0x1', hash: '0x' + '11'.repeat(32), transactions: [] },
    });
    await dispatchNeoxNodeTool(
      'x_node_get_block',
      { blockHashOrHeight: 1, includeTransactions: true },
      fetchImpl as never,
    );
    expect(calls[0]).toEqual({ method: 'eth_getBlockByNumber', params: ['0x1', true] });
  });

  test('accepts the latest tag', async () => {
    const { fetchImpl, calls } = rpcStub({
      eth_getBlockByNumber: { number: '0x9', hash: '0x' + '22'.repeat(32), transactions: [] },
    });
    await dispatchNeoxNodeTool('x_node_get_block', { blockHashOrHeight: 'latest' }, fetchImpl as never);
    expect(calls[0]).toEqual({ method: 'eth_getBlockByNumber', params: ['latest', false] });
  });

  test('reports a missing block as an error instead of a null result', async () => {
    const { fetchImpl } = rpcStub({ eth_getBlockByNumber: null });
    const text = errorTextOf(
      await dispatchNeoxNodeTool('x_node_get_block', { blockHashOrHeight: 99999999 }, fetchImpl as never),
    );
    expect(text).toMatch(/not found/i);
  });

  test('rejects a malformed reference without touching the network', async () => {
    const { fetchImpl } = rpcStub({});
    const text = errorTextOf(
      await dispatchNeoxNodeTool('x_node_get_block', { blockHashOrHeight: 'not-a-block' }, fetchImpl as never),
    );
    expect(text).toMatch(/block/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('rejects an oversized block reference without touching the network', async () => {
    const { fetchImpl } = rpcStub({});
    const text = errorTextOf(
      await dispatchNeoxNodeTool('x_node_get_block', { blockHashOrHeight: 'b'.repeat(81) }, fetchImpl as never),
    );
    expect(text).toMatch(/80-character limit/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('x_node_get_transaction', () => {
  test('returns the transaction body', async () => {
    const hash = '0x' + '33'.repeat(32);
    const { fetchImpl, calls } = rpcStub({
      eth_getTransactionByHash: { hash, blockNumber: '0x7', from: '0xabc' },
    });
    const result = resultOf(await dispatchNeoxNodeTool('x_node_get_transaction', { hash }, fetchImpl as never));
    expect(calls).toEqual([{ method: 'eth_getTransactionByHash', params: [hash] }]);
    expect((result.transaction as Record<string, unknown>).hash).toBe(hash);
  });

  test('reports an unknown hash as an error', async () => {
    const hash = '0x' + '44'.repeat(32);
    const { fetchImpl } = rpcStub({ eth_getTransactionByHash: null });
    expect(
      errorTextOf(await dispatchNeoxNodeTool('x_node_get_transaction', { hash }, fetchImpl as never)),
    ).toMatch(/not found/i);
  });

  test('rejects a non-hash argument without touching the network', async () => {
    const { fetchImpl } = rpcStub({});
    expect(
      errorTextOf(await dispatchNeoxNodeTool('x_node_get_transaction', { hash: 'nope' }, fetchImpl as never)),
    ).toMatch(/hash/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('x_node_get_balance', () => {
  test('returns wei and a decimal GAS figure', async () => {
    const address = '0x' + '55'.repeat(20);
    const { fetchImpl, calls } = rpcStub({ eth_getBalance: '0xde0b6b3a7640000' });
    const result = resultOf(
      await dispatchNeoxNodeTool('x_node_get_balance', { address }, fetchImpl as never),
    );
    expect(calls).toEqual([{ method: 'eth_getBalance', params: [address, 'latest'] }]);
    expect(result.wei).toBe('1000000000000000000');
    expect(result.balance).toBe('1');
    expect(result.symbol).toBe('GAS');
    expect(result.decimals).toBe(18);
  });

  test('formats a fractional balance without losing precision', async () => {
    const address = '0x' + '66'.repeat(20);
    const { fetchImpl } = rpcStub({ eth_getBalance: '0x1bc16d674ec80000' });
    const result = resultOf(
      await dispatchNeoxNodeTool('x_node_get_balance', { address }, fetchImpl as never),
    );
    expect(result.wei).toBe('2000000000000000000');
    expect(result.balance).toBe('2');
  });

  test('formats sub-unit amounts with leading zeros', async () => {
    const address = '0x' + '77'.repeat(20);
    const { fetchImpl } = rpcStub({ eth_getBalance: '0x2386f26fc10000' });
    const result = resultOf(
      await dispatchNeoxNodeTool('x_node_get_balance', { address }, fetchImpl as never),
    );
    expect(result.wei).toBe('10000000000000000');
    expect(result.balance).toBe('0.01');
  });

  test('rejects a non-EVM address without touching the network', async () => {
    const { fetchImpl } = rpcStub({});
    expect(
      errorTextOf(
        await dispatchNeoxNodeTool(
          'x_node_get_balance',
          { address: 'NRxLm2j5cKHXVQ7oGYaHfCcs4WSMc2fgXY' },
          fetchImpl as never,
        ),
      ),
    ).toMatch(/address/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('x_node_get_transaction_status', () => {
  test('reports a confirmed success with confirmations', async () => {
    const hash = '0x' + '88'.repeat(32);
    const { fetchImpl } = rpcStub({
      eth_getTransactionReceipt: {
        transactionHash: hash,
        status: '0x1',
        blockNumber: '0x64',
        blockHash: '0x' + '99'.repeat(32),
        gasUsed: '0x5208',
      },
      eth_blockNumber: '0x6e',
    });
    const result = resultOf(
      await dispatchNeoxNodeTool('x_node_get_transaction_status', { hash }, fetchImpl as never),
    );
    expect(result.status).toBe('confirmed');
    expect(result.succeeded).toBe(true);
    expect(result.blockNumber).toBe(100);
    expect(result.confirmations).toBe(11);
    expect(result.gasUsed).toBe('21000');
  });

  test('reports a reverted transaction as confirmed but unsuccessful', async () => {
    const hash = '0x' + 'aa'.repeat(32);
    const { fetchImpl } = rpcStub({
      eth_getTransactionReceipt: {
        transactionHash: hash,
        status: '0x0',
        blockNumber: '0x2',
        blockHash: '0x' + 'bb'.repeat(32),
        gasUsed: '0x1',
      },
      eth_blockNumber: '0x2',
    });
    const result = resultOf(
      await dispatchNeoxNodeTool('x_node_get_transaction_status', { hash }, fetchImpl as never),
    );
    expect(result.status).toBe('confirmed');
    expect(result.succeeded).toBe(false);
    expect(result.confirmations).toBe(1);
  });

  test('distinguishes pending from unknown by falling back to the pool lookup', async () => {
    const hash = '0x' + 'cc'.repeat(32);
    const pending = rpcStub({
      eth_getTransactionReceipt: null,
      eth_getTransactionByHash: { hash, blockNumber: null },
    });
    const pendingResult = resultOf(
      await dispatchNeoxNodeTool('x_node_get_transaction_status', { hash }, pending.fetchImpl as never),
    );
    expect(pendingResult.status).toBe('pending');
    expect(pendingResult.succeeded).toBe(false);
    expect(pendingResult.confirmations).toBe(0);

    const unknown = rpcStub({
      eth_getTransactionReceipt: null,
      eth_getTransactionByHash: null,
    });
    const unknownResult = resultOf(
      await dispatchNeoxNodeTool('x_node_get_transaction_status', { hash }, unknown.fetchImpl as never),
    );
    expect(unknownResult.status).toBe('unknown');
  });
});

describe('x_node_call_contract', () => {
  test('ABI-encodes a function signature and eth_calls it', async () => {
    const contract = '0x' + 'dd'.repeat(20);
    const holder = '0x' + 'ee'.repeat(20);
    const { fetchImpl, calls } = rpcStub({
      eth_call: '0x0000000000000000000000000000000000000000000000000000000000000001',
    });
    const result = resultOf(
      await dispatchNeoxNodeTool(
        'x_node_call_contract',
        { contract, functionSignature: 'balanceOf(address)', args: [holder] },
        fetchImpl as never,
      ),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('eth_call');
    const callObject = calls[0].params[0] as Record<string, string>;
    expect(callObject.to).toBe(contract);
    expect(callObject.data.startsWith('0x70a08231')).toBe(true);
    expect(calls[0].params[1]).toBe('latest');
    expect(result.data).toBe('0x0000000000000000000000000000000000000000000000000000000000000001');
    expect(result.state).toBe('HALT');
  });

  test('accepts pre-encoded calldata', async () => {
    const contract = '0x' + 'dd'.repeat(20);
    const { fetchImpl, calls } = rpcStub({ eth_call: '0x' });
    await dispatchNeoxNodeTool(
      'x_node_call_contract',
      { contract, data: '0x06fdde03' },
      fetchImpl as never,
    );
    expect((calls[0].params[0] as Record<string, string>).data).toBe('0x06fdde03');
  });

  test('includes the caller when from is supplied', async () => {
    const contract = '0x' + 'dd'.repeat(20);
    const from = '0x' + '12'.repeat(20);
    const { fetchImpl, calls } = rpcStub({ eth_call: '0x' });
    await dispatchNeoxNodeTool(
      'x_node_call_contract',
      { contract, data: '0x06fdde03', from },
      fetchImpl as never,
    );
    expect((calls[0].params[0] as Record<string, string>).from).toBe(from);
  });

  test('requires either data or a function signature', async () => {
    const contract = '0x' + 'dd'.repeat(20);
    const { fetchImpl } = rpcStub({});
    expect(
      errorTextOf(await dispatchNeoxNodeTool('x_node_call_contract', { contract }, fetchImpl as never)),
    ).toMatch(/functionSignature/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('rejects non-hex calldata without touching the network', async () => {
    const contract = '0x' + 'dd'.repeat(20);
    const { fetchImpl } = rpcStub({});
    expect(
      errorTextOf(
        await dispatchNeoxNodeTool('x_node_call_contract', { contract, data: 'DROP TABLE' }, fetchImpl as never),
      ),
    ).toMatch(/hex/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('rejects oversized calldata before touching the network', async () => {
    const contract = '0x' + 'dd'.repeat(20);
    const { fetchImpl } = rpcStub({});
    const data = '0x' + 'aa'.repeat(128 * 1024 + 1);
    expect(
      errorTextOf(await dispatchNeoxNodeTool('x_node_call_contract', { contract, data }, fetchImpl as never)),
    ).toMatch(/131072.*byte/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
