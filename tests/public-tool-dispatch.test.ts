import { createPublicToolDispatcher } from '../src/handlers/public-tool-dispatch';
import { resolveRoute, ToolRoute } from '../src/registry/tool-registry';

describe('public tool execution boundary', () => {
  function runtime() {
    const events: string[] = [];
    return { events,
      initializeServices: jest.fn(async () => { events.push('initialize'); }),
      invoke: jest.fn(async (_route: ToolRoute) => { events.push('invoke'); return { result: 'value' }; }),
      success: jest.fn((value: unknown) => ({ ok: true, value })),
      failure: jest.fn((error: unknown) => ({ ok: false, value: error })),
    };
  }
  test('registration has no execution and meta dispatch avoids service activation', async () => {
    const deps = runtime(), dispatch = createPublicToolDispatcher(deps);
    expect(deps.events).toEqual([]);
    expect(await dispatch('get_network_mode', {})).toEqual({ ok: true, value: { result: 'value' } });
    expect(deps.events).toEqual(['invoke']);
    expect(deps.invoke).toHaveBeenCalledWith(resolveRoute('get_network_mode', {}));
  });
  test('service activation precedes exactly one routed invocation', async () => {
    const deps = runtime(), input = { chain: 'n3', network: 'testnet' };
    await createPublicToolDispatcher(deps)('get_block_height', input);
    expect(deps.events).toEqual(['initialize', 'invoke']);
    expect(deps.invoke).toHaveBeenCalledWith(resolveRoute('get_block_height', input));
    expect(input).toEqual({ chain: 'n3', network: 'testnet' });
  });
  test('route wallet flags are preserved, without eagerly constructing a wallet', async () => {
    const deps = runtime(); await createPublicToolDispatcher(deps)('get_wallet', {});
    expect(deps.invoke.mock.calls[0][0].requiresWallet).toBe(true);
  });
  test.each(['unknown_tool', 'create_wallet'])('invalid route %s cannot activate or invoke', async name => {
    const deps = runtime(), result = await createPublicToolDispatcher(deps)(name, {});
    expect(result.ok).toBe(false); expect(deps.events).toEqual([]); expect(deps.failure).toHaveBeenCalledTimes(1);
  });
  test('missing chain fails before any effects', async () => {
    const deps = runtime(); expect((await createPublicToolDispatcher(deps)('get_block_height', {})).ok).toBe(false);
    expect(deps.events).toEqual([]);
  });
  test('a null argument bag is empty, never defaulted into a chain', async () => {
    const deps = runtime(); const result = await createPublicToolDispatcher(deps)('get_block_height', null);
    expect(result.ok).toBe(false); expect(deps.events).toEqual([]);
  });
  test('initialization and execution failures use the existing response adapter', async () => {
    const first = runtime(), initError = new Error('initialization failed'); first.initializeServices.mockRejectedValueOnce(initError);
    expect((await createPublicToolDispatcher(first)('get_block_height', { chain: 'n3' })).value).toBe(initError);
    expect(first.invoke).not.toHaveBeenCalled();
    const next = runtime(), invokeError = new Error('request failed'); next.invoke.mockRejectedValueOnce(invokeError);
    expect((await createPublicToolDispatcher(next)('get_network_mode', null)).value).toBe(invokeError);
    expect(next.failure).toHaveBeenCalledWith(invokeError);
  });
});
