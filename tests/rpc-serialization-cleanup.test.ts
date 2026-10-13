import { callEvmRpc } from '../src/contracts/evm-rpc-client';
import { callIndexerRpc } from '../src/contracts/indexer-rpc-client';
import { NeoNetwork } from '../src/services/neo-service';

describe('invalid RPC envelope owns no transport resources', () => {
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });
  test('EVM circular parameters fail before timers or parent listeners are allocated', async () => {
    jest.useFakeTimers(); const parent = new AbortController(), add = jest.spyOn(parent.signal, 'addEventListener');
    const params: unknown[] = []; params.push(params); const fetcher = jest.fn();
    await expect(callEvmRpc('neox-mainnet', 'eth_call', params, parent.signal, fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(0); expect(add).not.toHaveBeenCalled();
  });
  test('indexer circular parameters fail before timers or parent listeners are allocated', async () => {
    jest.useFakeTimers(); const parent = new AbortController(), add = jest.spyOn(parent.signal, 'addEventListener');
    const params: Record<string, unknown> = {}; params.self = params; const fetcher = jest.fn();
    await expect(callIndexerRpc(NeoNetwork.MAINNET, 'GetAddressByAddress', params, parent.signal, fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(0); expect(add).not.toHaveBeenCalled();
  });
});
