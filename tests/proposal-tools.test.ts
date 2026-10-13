import * as evmRpc from '../src/contracts/evm-rpc-client';
import {
  handleN3BuildTransfer,
  handleN3BuildInvoke,
  handleN3TestInvoke,
  handleXBuildTransfer,
  handleXBuildContractCall,
  handleXSimulateCall,
} from '../src/handlers/proposal-tools';
import { NEO_NATIVE_SCRIPT_HASH, GAS_NATIVE_SCRIPT_HASH } from '../src/utils/transaction-proposal';
import { ValidationError } from '../src/utils/errors';
import type { NeoService } from '../src/services/neo-service';

// Two valid Neo N3 addresses (checksummed) and their script hashes.
const FROM_ADDR = 'NMquFyaSmvtX4t3fV9TyFmVSDP2CK8aEcJ';
const FROM_SH = '336bcb67c7f0ec61da334fcef59964be364f2b15';
const TO_ADDR = 'Nam32gCLrSV4ciKdib5eizvEMy7R25p676';
const TO_SH = 'ad028bd5a2dc85ed08f16603028a6b37f959d9a2';

const EVM_FROM = '0x1111111111111111111111111111111111111111';
const EVM_TO = '0x2222222222222222222222222222222222222222';

function mockNeoService(overrides: Partial<jest.Mocked<NeoService>> = {}): NeoService {
  const testInvoke = jest.fn().mockResolvedValue({
    state: 'HALT',
    gasconsumed: '997752',
    exception: null,
    stack: [{ type: 'Boolean', value: true }],
  });
  return { testInvoke, ...overrides } as unknown as NeoService;
}

// callEvmRpc dispatcher keyed by method, so tests never need a real network.
function stubEvmRpc(map: Record<string, unknown>) {
  return jest.spyOn(evmRpc, 'callEvmRpc').mockImplementation(async (_network, method) => {
    if (!(method in map)) {
      throw new Error(`unexpected EVM RPC method in test: ${method}`);
    }
    return map[method] as never;
  });
}

const NON_SEND_METHODS = new Set([
  'eth_chainId', 'eth_gasPrice', 'eth_estimateGas', 'eth_call',
  'eth_getTransactionCount', 'eth_getBalance', 'eth_blockNumber', 'net_version',
]);

function assertOnlyReadMethodsCalled(spy: jest.SpyInstance) {
  for (const call of spy.mock.calls) {
    const method = call[1] as string;
    expect(NON_SEND_METHODS.has(method)).toBe(true);
    expect(method).not.toMatch(/send|sign/i);
  }
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('n3_build_transfer', () => {
  test('builds NeoLine invoke params for a NEO transfer with a simulation and never signs', async () => {
    const neoService = mockNeoService();
    const res = await handleN3BuildTransfer(
      { network: 'mainnet', from: FROM_ADDR, to: TO_ADDR, asset: 'NEO', amount: '1' },
      neoService,
    );
    const proposal = (res as any).result;

    expect(proposal.proposal).toBe(true);
    expect(proposal.chain).toBe('n3');
    expect(proposal.kind).toBe('invoke');
    expect(proposal.scriptHash).toBe(NEO_NATIVE_SCRIPT_HASH);
    expect(proposal.operation).toBe('transfer');
    expect(proposal.from).toBe(FROM_ADDR);
    expect(proposal.to).toBe(TO_ADDR);
    expect(proposal.args).toEqual([
      { type: 'Hash160', value: FROM_SH },
      { type: 'Hash160', value: TO_SH },
      { type: 'Integer', value: '1' },
      { type: 'Any', value: null },
    ]);
    expect(proposal.signers).toEqual([{ account: FROM_ADDR, scopes: 'CalledByEntry' }]);
    expect(proposal.simulation).toEqual({
      state: 'HALT',
      gasConsumed: '997752',
      exception: null,
      stack: [{ type: 'Boolean', value: true }],
    });
    // Proposal must not carry any secret/signature/broadcast field.
    expect(JSON.stringify(proposal)).not.toMatch(/privateKey|wif|signature|rawTransaction|sendrawtransaction/i);

    // Simulation used a read-only test invoke, with the 0x signer account form.
    expect(neoService.testInvoke).toHaveBeenCalledWith(
      NEO_NATIVE_SCRIPT_HASH,
      'transfer',
      proposal.args,
      [{ account: `0x${FROM_SH}`, scopes: 'CalledByEntry' }],
    );
  });

  test('scales GAS (8 decimals) amounts correctly', async () => {
    const neoService = mockNeoService();
    const res = await handleN3BuildTransfer(
      { network: 'testnet', from: FROM_ADDR, to: TO_ADDR, asset: 'GAS', amount: '1.5' },
      neoService,
    );
    const proposal = (res as any).result;
    expect(proposal.scriptHash).toBe(GAS_NATIVE_SCRIPT_HASH);
    expect(proposal.args[2]).toEqual({ type: 'Integer', value: '150000000' });
  });

  test('fetches decimals for a custom NEP-17 token when not provided', async () => {
    const customHash = '0x' + 'ab'.repeat(20);
    const testInvoke = jest.fn()
      .mockResolvedValueOnce({ state: 'HALT', stack: [{ type: 'Integer', value: '4' }] }) // decimals
      .mockResolvedValueOnce({
        state: 'HALT',
        gasconsumed: '1',
        exception: null,
        stack: [{ type: 'Boolean', value: true }],
      }); // simulation
    const neoService = { testInvoke } as unknown as NeoService;

    const res = await handleN3BuildTransfer(
      { network: 'mainnet', from: FROM_ADDR, to: TO_ADDR, asset: customHash, amount: '1.2345' },
      neoService,
    );
    const proposal = (res as any).result;
    expect(proposal.args[2]).toEqual({ type: 'Integer', value: '12345' });
    expect(testInvoke.mock.calls[0][1]).toBe('decimals');
  });

  test('rejects an invalid recipient address', async () => {
    const neoService = mockNeoService();
    await expect(
      handleN3BuildTransfer(
        { network: 'mainnet', from: FROM_ADDR, to: 'not-an-address', asset: 'NEO', amount: '1' },
        neoService,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('rejects a non-numeric amount', async () => {
    const neoService = mockNeoService();
    await expect(
      handleN3BuildTransfer(
        { network: 'mainnet', from: FROM_ADDR, to: TO_ADDR, asset: 'NEO', amount: 'abc' },
        neoService,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('does not return a signable proposal when the exact transfer simulation faults', async () => {
    const neoService = mockNeoService({
      testInvoke: jest.fn().mockResolvedValue({
        state: 'FAULT',
        gasconsumed: '123',
        exception: 'Insufficient balance',
        stack: [],
      }),
    });

    await expect(
      handleN3BuildTransfer(
        { network: 'mainnet', from: FROM_ADDR, to: TO_ADDR, asset: 'GAS', amount: '1' },
        neoService,
      ),
    ).rejects.toThrow(/simulation failed/i);
  });

  test('does not return a signable proposal when a HALT transfer returns false', async () => {
    const neoService = mockNeoService({
      testInvoke: jest.fn().mockResolvedValue({
        state: 'HALT',
        gasconsumed: '215925',
        exception: null,
        stack: [{ type: 'Boolean', value: false }],
      }),
    });

    await expect(
      handleN3BuildTransfer(
        { network: 'testnet', from: FROM_ADDR, to: TO_ADDR, asset: 'GAS', amount: '0.00000001' },
        neoService,
      ),
    ).rejects.toThrow(/transfer did not return true/i);
  });
});

describe('n3_build_invoke', () => {
  test('builds a generic invoke proposal with a default CalledByEntry signer and simulation', async () => {
    const neoService = mockNeoService();
    const res = await handleN3BuildInvoke(
      {
        network: 'mainnet',
        scriptHash: GAS_NATIVE_SCRIPT_HASH,
        operation: 'balanceOf',
        args: [FROM_ADDR],
        from: FROM_ADDR,
      },
      neoService,
    );
    const proposal = (res as any).result;
    expect(proposal.operation).toBe('balanceOf');
    expect(proposal.args).toEqual([{ type: 'Hash160', value: FROM_SH }]);
    expect(proposal.signers).toEqual([{ account: FROM_ADDR, scopes: 'CalledByEntry' }]);
    expect(proposal.simulation.state).toBe('HALT');
  });

  test('rejects an invalid script hash', async () => {
    const neoService = mockNeoService();
    await expect(
      handleN3BuildInvoke(
        { network: 'mainnet', scriptHash: '0xdeadbeef', operation: 'foo', from: FROM_ADDR },
        neoService,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('n3_test_invoke', () => {
  test('formats args and forwards signers to a read-only test invoke', async () => {
    const neoService = mockNeoService();
    const res = await handleN3TestInvoke(
      {
        network: 'mainnet',
        scriptHash: GAS_NATIVE_SCRIPT_HASH,
        operation: 'transfer',
        args: [FROM_ADDR, TO_ADDR, 5, null],
        signers: [{ account: FROM_ADDR }],
      },
      neoService,
    );
    expect((res as any).result.state).toBe('HALT');
    expect((res as any).result.gasConsumed).toBe('997752');

    expect(neoService.testInvoke).toHaveBeenCalledWith(
      GAS_NATIVE_SCRIPT_HASH,
      'transfer',
      [
        { type: 'Hash160', value: FROM_SH },
        { type: 'Hash160', value: TO_SH },
        { type: 'Integer', value: '5' },
        { type: 'Any', value: null },
      ],
      [{ account: FROM_ADDR, scopes: 'CalledByEntry' }],
    );
  });
});

describe('x_build_transfer', () => {
  test('builds an eth_tx proposal with mocked gas/gasPrice and never calls a send method', async () => {
    const spy = stubEvmRpc({
      eth_call: '0x',
      eth_estimateGas: '0x5208',
      eth_gasPrice: '0x3b9aca00',
    });

    const res = await handleXBuildTransfer({
      network: 'neox-mainnet',
      from: EVM_FROM,
      to: EVM_TO,
      amountWei: '1000000000000000000',
    });
    const proposal = (res as any).result;

    expect(proposal).toMatchObject({
      proposal: true,
      chain: 'neox',
      kind: 'eth_tx',
      network: 'neox-mainnet',
      tx: {
        from: EVM_FROM,
        to: EVM_TO,
        value: '0xde0b6b3a7640000', // 1e18 wei
        data: '0x',
        chainId: '0xba93', // 47763
        gas: '0x5208',
        gasPrice: '0x3b9aca00',
      },
      simulation: {
        network: 'neox-mainnet',
        callResult: '0x',
        gasEstimate: '0x5208',
        gasPrice: '0x3b9aca00',
      },
    });
    // No nonce and no signature fields.
    expect(proposal.tx).not.toHaveProperty('nonce');
    expect(JSON.stringify(proposal)).not.toMatch(/privateKey|signature|rawTransaction|sendRawTransaction/i);

    // eth_estimateGas was called with the transfer call object.
    const estimateCall = spy.mock.calls.find((c) => c[1] === 'eth_estimateGas');
    expect(estimateCall?.[2]).toEqual([{ from: EVM_FROM, to: EVM_TO, value: '0xde0b6b3a7640000' }]);
    assertOnlyReadMethodsCalled(spy);
  });

  test('rejects an invalid sender address', async () => {
    const spy = stubEvmRpc({ eth_call: '0x', eth_estimateGas: '0x5208', eth_gasPrice: '0x1' });
    await expect(
      handleXBuildTransfer({ network: 'neox-mainnet', from: '0xdead', to: EVM_TO, amountWei: '1' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(spy).not.toHaveBeenCalled();
  });

  test('rejects a negative amount', async () => {
    stubEvmRpc({ eth_call: '0x', eth_estimateGas: '0x5208', eth_gasPrice: '0x1' });
    await expect(
      handleXBuildTransfer({ network: 'neox-mainnet', from: EVM_FROM, to: EVM_TO, amountWei: '-5' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test('does not return a signable proposal when eth_call reports a revert', async () => {
    jest.spyOn(evmRpc, 'callEvmRpc').mockImplementation(async (_network, method) => {
      if (method === 'eth_call') throw new Error('execution reverted');
      if (method === 'eth_estimateGas') return '0x5208' as never;
      if (method === 'eth_gasPrice') return '0x1' as never;
      throw new Error(`unexpected ${method}`);
    });

    await expect(
      handleXBuildTransfer({
        network: 'neox-mainnet',
        from: EVM_FROM,
        to: EVM_TO,
        amountWei: '1',
      }),
    ).rejects.toThrow(/simulation failed/i);
  });
});

describe('x_build_contract_call', () => {
  test('ABI-encodes functionSignature + args and builds an eth_tx proposal', async () => {
    const spy = stubEvmRpc({
      eth_call: '0x01',
      eth_estimateGas: '0xc350',
      eth_gasPrice: '0x3b9aca00',
    });

    const res = await handleXBuildContractCall({
      network: 'neox-testnet',
      from: EVM_FROM,
      to: EVM_TO,
      functionSignature: 'transfer(address,uint256)',
      args: [EVM_TO, '1'],
    });
    const proposal = (res as any).result;

    const expectedCalldata = '0xa9059cbb'
      + '0000000000000000000000002222222222222222222222222222222222222222'
      + '0000000000000000000000000000000000000000000000000000000000000001';
    expect(proposal.encodedCalldata).toBe(expectedCalldata);
    expect(proposal.tx.data).toBe(expectedCalldata);
    expect(proposal.tx.chainId).toBe('0xba9304'); // 12227332
    expect(proposal.tx.gas).toBe('0xc350');
    expect(proposal.simulation).toEqual({
      network: 'neox-testnet',
      callResult: '0x01',
      gasEstimate: '0xc350',
      gasPrice: '0x3b9aca00',
    });

    const estimateCall = spy.mock.calls.find((c) => c[1] === 'eth_estimateGas');
    expect((estimateCall?.[2] as any[])[0].data).toBe(expectedCalldata);
    assertOnlyReadMethodsCalled(spy);
  });

  test('accepts pre-encoded calldata', async () => {
    stubEvmRpc({ eth_call: '0x', eth_estimateGas: '0x1', eth_gasPrice: '0x1' });
    const res = await handleXBuildContractCall({
      network: 'neox-mainnet',
      from: EVM_FROM,
      to: EVM_TO,
      data: '0xabcdef',
    });
    expect((res as any).result.tx.data).toBe('0xabcdef');
  });

  test('rejects oversized pre-encoded calldata before any RPC call', async () => {
    const spy = stubEvmRpc({ eth_call: '0x', eth_estimateGas: '0x1', eth_gasPrice: '0x1' });
    await expect(
      handleXBuildContractCall({
        network: 'neox-mainnet',
        from: EVM_FROM,
        to: EVM_TO,
        data: '0x' + 'ab'.repeat(128 * 1024 + 1),
      }),
    ).rejects.toThrow(/131072.*byte/i);
    expect(spy).not.toHaveBeenCalled();
  });

  test('still accepts calldata at the byte limit', async () => {
    stubEvmRpc({ eth_call: '0x', eth_estimateGas: '0x1', eth_gasPrice: '0x1' });
    const data = '0x' + 'ab'.repeat(128 * 1024);
    const res = await handleXBuildContractCall({
      network: 'neox-mainnet',
      from: EVM_FROM,
      to: EVM_TO,
      data,
    });
    expect((res as any).result.tx.data).toBe(data);
  });

  test('rejects when neither data nor functionSignature is provided', async () => {
    stubEvmRpc({ eth_call: '0x', eth_estimateGas: '0x1', eth_gasPrice: '0x1' });
    await expect(
      handleXBuildContractCall({ network: 'neox-mainnet', from: EVM_FROM, to: EVM_TO }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('x_simulate_call', () => {
  test('runs eth_call + eth_estimateGas + eth_gasPrice with the right params', async () => {
    const spy = stubEvmRpc({
      eth_call: '0x0000000000000000000000000000000000000000000000000000000000000001',
      eth_estimateGas: '0x5208',
      eth_gasPrice: '0x3b9aca00',
    });

    const res = await handleXSimulateCall({
      network: 'neox-mainnet',
      to: EVM_TO,
      from: EVM_FROM,
      data: '0x70a08231',
    });
    const out = (res as any).result;
    expect(out.callResult).toBe('0x0000000000000000000000000000000000000000000000000000000000000001');
    expect(out.gasEstimate).toBe('0x5208');
    expect(out.gasPrice).toBe('0x3b9aca00');
    expect(out).not.toHaveProperty('revertReason');

    const callArgs = spy.mock.calls.find((c) => c[1] === 'eth_call');
    expect(callArgs?.[2]).toEqual([{ to: EVM_TO, from: EVM_FROM, data: '0x70a08231' }, 'latest']);
    assertOnlyReadMethodsCalled(spy);
  });

  test('captures a revert reason when eth_call fails', async () => {
    jest.spyOn(evmRpc, 'callEvmRpc').mockImplementation(async (_network, method) => {
      if (method === 'eth_call') throw new Error('Neo X RPC eth_call error: execution reverted');
      if (method === 'eth_estimateGas') throw new Error('Neo X RPC eth_estimateGas error: execution reverted');
      if (method === 'eth_gasPrice') return '0x3b9aca00' as never;
      throw new Error(`unexpected ${method}`);
    });

    const res = await handleXSimulateCall({ network: 'neox-mainnet', to: EVM_TO, data: '0xdeadbeef' });
    const out = (res as any).result;
    expect(out.revertReason).toMatch(/reverted/);
    expect(out.gasEstimate).toBeNull();
    expect(out.gasPrice).toBe('0x3b9aca00');
  });
});
