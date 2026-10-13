/**
 * Neo N3 transaction status, composed from the two RPCs that each know half of
 * the answer.
 *
 * `getrawtransaction` reports relay and burial depth but never execution
 * outcome; `getapplicationlog` reports the VM state but only once the
 * transaction is in a block. Reading either one alone misreports the common
 * case of a mined-but-faulted transaction, so this handler reads both and is
 * explicit about which parts it could not determine.
 */

import { createSuccessResponse, handleError } from '../utils/error-handler';
import { validateHash } from '../utils/validation';

/** Minimal surface this handler needs, so tests can supply a stub. */
export interface N3StatusService {
  getTransaction(txid: string): Promise<unknown>;
  getApplicationLog(txid: string): Promise<unknown>;
  getBlockCount(): Promise<number>;
}

export type N3TransactionStatus = 'confirmed' | 'pending' | 'unknown';

/**
 * Errors a Neo N3 node produces for a hash it has never seen. Anything else
 * (connection refused, TLS failure, rate limit) is a real fault and must not be
 * flattened into "unknown", or an outage would look like a missing transaction.
 */
const UNKNOWN_TRANSACTION_PATTERN = /unknown transaction|not found|does not exist|no such transaction|invalid params/i;

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function nonNegativeInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Picks the Application-trigger execution when present. Verification executions
 * exist on some transactions and carry their own VM state, which is not the
 * outcome a caller asking "did my transfer work?" means.
 */
function selectExecution(applicationLog: unknown): Record<string, unknown> {
  const executions = asRecord(applicationLog).executions;
  if (!Array.isArray(executions) || executions.length === 0) {
    return {};
  }
  const application = executions
    .map(asRecord)
    .find((execution) => String(execution.trigger ?? '').toLowerCase() === 'application');
  return application ?? asRecord(executions[0]);
}

export async function handleN3TransactionStatus(
  input: Record<string, unknown>,
  service: N3StatusService,
): Promise<unknown> {
  try {
    const args = input ?? {};
    const hash = validateHash(String(args.hash ?? args.txid ?? ''));
    const network = typeof args.network === 'string' ? args.network : 'mainnet';

    let transaction: Record<string, unknown>;
    try {
      transaction = asRecord(await service.getTransaction(hash));
    } catch (error) {
      const message = errorMessageOf(error);
      if (!UNKNOWN_TRANSACTION_PATTERN.test(message)) {
        throw error;
      }
      return createSuccessResponse({
        chain: 'n3',
        network,
        hash,
        status: 'unknown' as N3TransactionStatus,
        succeeded: false,
        confirmations: 0,
        blockNumber: null,
        blockHash: null,
        vmState: null,
        gasConsumed: null,
        exception: null,
      });
    }

    const blockHash = nonEmptyString(transaction.blockhash);
    const confirmations = nonNegativeInteger(transaction.confirmations) ?? 0;

    if (!blockHash) {
      // Relayed and sitting in the mempool: there is no execution to report yet.
      return createSuccessResponse({
        chain: 'n3',
        network,
        hash,
        status: 'pending' as N3TransactionStatus,
        succeeded: false,
        confirmations: 0,
        blockNumber: null,
        blockHash: null,
        vmState: null,
        gasConsumed: null,
        exception: null,
      });
    }

    // Neo N3 counts the containing block itself as one confirmation, so the
    // block index is (tip index) - (confirmations - 1).
    let blockNumber: number | null = null;
    if (confirmations > 0) {
      try {
        const blockCount = await service.getBlockCount();
        const tipIndex = nonNegativeInteger(blockCount);
        if (tipIndex !== null && tipIndex > 0) {
          const derived = tipIndex - 1 - (confirmations - 1);
          blockNumber = derived >= 0 ? derived : null;
        }
      } catch {
        // The height is a convenience, not the answer being asked for; a
        // failure here must not discard a status we already know.
        blockNumber = null;
      }
    }

    let vmState: string | null = null;
    let gasConsumed: string | null = null;
    let exception: string | null = null;
    let succeeded: boolean | null = null;
    let applicationLogError: string | undefined;

    try {
      const execution = selectExecution(await service.getApplicationLog(hash));
      vmState = nonEmptyString(execution.vmstate) ?? nonEmptyString(execution.vmState);
      gasConsumed = nonEmptyString(execution.gasconsumed) ?? nonEmptyString(execution.gasConsumed);
      exception = nonEmptyString(execution.exception);
      succeeded = vmState === null ? null : vmState.toUpperCase() === 'HALT';
    } catch (error) {
      // Confirmed on chain, outcome unreadable. Reporting `false` here would
      // invent a failure; reporting `true` would hide one.
      applicationLogError = 'Application log unavailable';
    }

    return createSuccessResponse({
      chain: 'n3',
      network,
      hash,
      status: 'confirmed' as N3TransactionStatus,
      succeeded,
      confirmations,
      blockNumber,
      blockHash,
      vmState,
      gasConsumed,
      exception,
      ...(applicationLogError === undefined ? {} : { applicationLogError }),
    });
  } catch (error) {
    return handleError(error);
  }
}
