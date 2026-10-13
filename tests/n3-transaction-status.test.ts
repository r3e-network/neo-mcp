/**
 * Contract for the Neo N3 half of the unified `get_transaction_status` tool.
 *
 * Neo N3 has no single RPC that answers "did this transaction succeed?".
 * `getrawtransaction` says whether it was relayed and how deeply it is buried;
 * only the application log says whether the VM halted or faulted. A caller that
 * reads confirmations alone will report a reverted transaction as a success, so
 * this handler composes both — and these tests pin what happens when only one of
 * them is available.
 *
 * The service is a stub: no sockets, no timers, deterministic by construction.
 */

import { handleN3TransactionStatus } from '../src/handlers/n3-transaction-status';

interface StubCalls {
  getTransaction: string[];
  getApplicationLog: string[];
  getBlockCount: number;
}

interface StubOptions {
  transaction?: unknown | (() => never);
  applicationLog?: unknown | (() => never);
  blockCount?: number;
}

function serviceStub(options: StubOptions): { service: any; calls: StubCalls } {
  const calls: StubCalls = { getTransaction: [], getApplicationLog: [], getBlockCount: 0 };
  const service = {
    async getTransaction(txid: string) {
      calls.getTransaction.push(txid);
      if (typeof options.transaction === 'function') {
        return (options.transaction as () => never)();
      }
      return options.transaction;
    },
    async getApplicationLog(txid: string) {
      calls.getApplicationLog.push(txid);
      if (typeof options.applicationLog === 'function') {
        return (options.applicationLog as () => never)();
      }
      return options.applicationLog;
    },
    async getBlockCount() {
      calls.getBlockCount += 1;
      if (options.blockCount === undefined) {
        throw new Error('getBlockCount was not expected in this test');
      }
      return options.blockCount;
    },
  };
  return { service, calls };
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

const HASH = '0x7da6ae7ff9d0b7af3d32f3a2feb2aa96c2a27ef8b651f9a132cfaad6ef20724c';
const BLOCK_HASH = '0x0c1f4c4a2ae4c5d5b8fbc61c2fbb1c11c9c8e0a6b0f0e5b9e3fa9d6b0d7c2a11';

describe('handleN3TransactionStatus', () => {
  it('composes confirmations and VM state for a successful transaction', async () => {
    const { service, calls } = serviceStub({
      transaction: { hash: HASH, blockhash: BLOCK_HASH, confirmations: 11, sender: 'NRxLm2j5cKHXVQ7oGYaHfCcs4WSMc2fgXY' },
      applicationLog: {
        txid: HASH,
        executions: [{ trigger: 'Application', vmstate: 'HALT', gasconsumed: '1234567', stack: [] }],
      },
      blockCount: 1000,
    });

    const result = resultOf(await handleN3TransactionStatus({ hash: HASH }, service));

    expect(result).toMatchObject({
      chain: 'n3',
      hash: HASH,
      status: 'confirmed',
      succeeded: true,
      confirmations: 11,
      blockHash: BLOCK_HASH,
      vmState: 'HALT',
      gasConsumed: '1234567',
    });
    expect(result.exception).toBeNull();
    expect(calls.getTransaction).toEqual([HASH]);
    expect(calls.getApplicationLog).toEqual([HASH]);
  });

  it('derives a block height from the chain tip and confirmations', async () => {
    const { service, calls } = serviceStub({
      transaction: { hash: HASH, blockhash: BLOCK_HASH, confirmations: 11 },
      applicationLog: { executions: [{ vmstate: 'HALT', gasconsumed: '10' }] },
      blockCount: 1000,
    });

    const result = resultOf(await handleN3TransactionStatus({ hash: HASH }, service));

    // Tip index is blockCount - 1 = 999; a transaction with 11 confirmations
    // sits 10 blocks below the tip.
    expect(result.blockNumber).toBe(989);
    expect(calls.getBlockCount).toBe(1);
  });

  it('reports a faulted transaction as confirmed but unsuccessful', async () => {
    const { service } = serviceStub({
      transaction: { hash: HASH, blockhash: BLOCK_HASH, confirmations: 3 },
      applicationLog: {
        executions: [{ vmstate: 'FAULT', gasconsumed: '999', exception: 'Insufficient balance' }],
      },
      blockCount: 100,
    });

    const result = resultOf(await handleN3TransactionStatus({ hash: HASH }, service));

    expect(result).toMatchObject({
      status: 'confirmed',
      succeeded: false,
      vmState: 'FAULT',
      exception: 'Insufficient balance',
    });
  });

  it('reports a relayed but unconfirmed transaction as pending', async () => {
    const { service, calls } = serviceStub({
      transaction: { hash: HASH, confirmations: 0 },
    });

    const result = resultOf(await handleN3TransactionStatus({ hash: HASH }, service));

    expect(result).toMatchObject({
      status: 'pending',
      succeeded: false,
      confirmations: 0,
    });
    expect(result.vmState).toBeNull();
    // A mempool transaction has no application log; asking for one would only
    // produce a misleading error.
    expect(calls.getApplicationLog).toEqual([]);
    expect(calls.getBlockCount).toBe(0);
  });

  it('reports an unrelayed hash as unknown rather than failing', async () => {
    const { service, calls } = serviceStub({
      transaction: () => {
        throw new Error('Failed to get transaction 0x…: Unknown transaction');
      },
    });

    const result = resultOf(await handleN3TransactionStatus({ hash: HASH }, service));

    expect(result).toMatchObject({
      status: 'unknown',
      succeeded: false,
      confirmations: 0,
    });
    expect(calls.getApplicationLog).toEqual([]);
  });

  it('surfaces a genuine RPC failure instead of calling it unknown', async () => {
    const { service } = serviceStub({
      transaction: () => {
        throw new Error('Failed to get transaction: connect ECONNREFUSED 127.0.0.1:10332');
      },
    });

    // Surfaced as an error envelope (`handleError` rewrites connection faults
    // into an actionable message) rather than as a `status: 'unknown'` result,
    // which would tell a caller the transaction does not exist.
    expect(errorTextOf(await handleN3TransactionStatus({ hash: HASH }, service))).toMatch(/could not connect/i);
  });

  it('leaves success undetermined when the application log is unavailable', async () => {
    const { service } = serviceStub({
      transaction: { hash: HASH, blockhash: BLOCK_HASH, confirmations: 5 },
      applicationLog: () => {
        throw new Error('Failed to get application log for 0x…: rpc timeout');
      },
      blockCount: 50,
    });

    const result = resultOf(await handleN3TransactionStatus({ hash: HASH }, service));

    expect(result).toMatchObject({ status: 'confirmed', confirmations: 5 });
    // Neither true nor false: the chain accepted the transaction, but whether
    // the script halted is unknown, and guessing would be worse than saying so.
    expect(result.succeeded).toBeNull();
    expect(result.applicationLogError).toBe('Application log unavailable');
  });

  it('tolerates a transaction confirmed without a reachable chain tip', async () => {
    const { service } = serviceStub({
      transaction: { hash: HASH, blockhash: BLOCK_HASH, confirmations: 7 },
      applicationLog: { executions: [{ vmstate: 'HALT', gasconsumed: '5' }] },
    });

    const result = resultOf(await handleN3TransactionStatus({ hash: HASH }, service));

    expect(result).toMatchObject({ status: 'confirmed', succeeded: true, confirmations: 7 });
    expect(result.blockNumber).toBeNull();
  });

  it('rejects a malformed hash without touching the service', async () => {
    const { service, calls } = serviceStub({});

    expect(errorTextOf(await handleN3TransactionStatus({ hash: 'nope' }, service))).toMatch(/hash/i);
    expect(calls.getTransaction).toEqual([]);
  });
});
