// Neo X (EVM sidechain) JSON-RPC 2.0 transport — READ ONLY.
//
// This client POSTs a JSON-RPC 2.0 envelope to the configured Neo X node for a
// network ("neox-mainnet" | "neox-testnet"). It exists solely to *simulate* and
// *estimate* transactions (eth_call, eth_estimateGas, eth_gasPrice, ...) so that
// the construct tools can attach a preview to an UNSIGNED proposal. It mirrors
// indexer-rpc-client.ts for base-url validation, bounded JSON, and timeout.
//
// HARD SECURITY BOUNDARY: only a strict allowlist of read-only methods may be
// invoked. Any broadcasting / signing method (eth_sendRawTransaction,
// eth_sendTransaction, eth_signTransaction, ...) is rejected with a typed error
// BEFORE any network call is made. This client never signs and never broadcasts.

import { readBoundedJson } from '../utils/bounded-json';
import { NetworkError, ValidationError } from '../utils/errors';
import { createRequestAbortScope } from '../utils/request-abort-scope';
import { config } from '../config';

export type FetchLike = typeof fetch;

export type NeoxEvmNetwork = 'neox-mainnet' | 'neox-testnet';

const DEFAULT_EVM_RPC_TIMEOUT_MS = 12000;
const MAX_EVM_RPC_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * The only JSON-RPC methods this client is ever permitted to call. Every entry
 * is a read-only query that cannot change chain state. This set is the security
 * boundary for the non-custodial write layer.
 */
export const EVM_READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  'eth_chainId',
  'eth_gasPrice',
  'eth_estimateGas',
  'eth_call',
  'eth_getTransactionCount',
  'eth_getBalance',
  'eth_blockNumber',
  'net_version',
  // Live chain reads used by the unified node tools (get_block, get_transaction,
  // get_transaction_status, get_contract_code). Every one is a pure query: the
  // node computes nothing it would not compute for a block explorer.
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getBlockTransactionCountByNumber',
  'eth_getBlockTransactionCountByHash',
  'eth_getTransactionByHash',
  'eth_getTransactionByBlockNumberAndIndex',
  'eth_getTransactionByBlockHashAndIndex',
  'eth_getTransactionReceipt',
  'eth_getCode',
  'eth_getLogs',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_syncing',
]);

/**
 * Methods that would sign or broadcast a transaction. Explicitly enumerated so
 * a mistaken call produces an unmistakable, typed rejection rather than an
 * opaque "not allowed" message.
 */
export const EVM_FORBIDDEN_METHODS: ReadonlySet<string> = new Set([
  'eth_sendRawTransaction',
  'eth_sendTransaction',
  'eth_signTransaction',
  'eth_sign',
  'personal_sign',
  'personal_sendTransaction',
]);

interface JsonRpcErrorBody {
  code?: number;
  message?: string;
  data?: unknown;
}

interface JsonRpcEnvelope<T> {
  jsonrpc?: string;
  id?: unknown;
  result?: T;
  error?: JsonRpcErrorBody;
}

let rpcRequestId = 0;

function nextRpcId(): number {
  rpcRequestId = (rpcRequestId + 1) % Number.MAX_SAFE_INTEGER;
  return rpcRequestId;
}

/**
 * Normalize a caller-supplied Neo X EVM network id.
 * @throws {ValidationError} on an unrecognized network id.
 */
export function resolveNeoxEvmNetwork(network: string): NeoxEvmNetwork {
  const normalized = String(network || '').trim().toLowerCase();
  if (normalized === 'neox-mainnet' || normalized === 'mainnet') {
    return 'neox-mainnet';
  }
  if (normalized === 'neox-testnet' || normalized === 'testnet') {
    return 'neox-testnet';
  }
  throw new ValidationError(
    `Invalid Neo X network: ${network}. Must be one of: neox-mainnet, neox-testnet`
  );
}

/** Resolve the EIP-155 chain id for a Neo X network. */
export function neoxChainId(network: NeoxEvmNetwork): number {
  return network === 'neox-testnet' ? config.neox.testnetChainId : config.neox.mainnetChainId;
}

function resolveRpcUrls(network: NeoxEvmNetwork): string[] {
  if (network === 'neox-testnet' && !config.neox.testnetEnabled) {
    throw new ValidationError(
      'Neo X testnet access is disabled (set NEOX_TESTNET_ENABLED=true to enable).'
    );
  }
  const candidates = network === 'neox-testnet'
    ? config.neox.testnetRpcUrls
    : config.neox.mainnetRpcUrls;
  const bases = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => String(candidate || '').replace(/\/+$/, ''))
    .filter(Boolean);
  const unique = [...new Set(bases)];
  if (unique.length === 0) {
    throw new ValidationError(`No Neo X RPC URL configured for ${network}`);
  }
  // Every entry is validated, not just the one that happens to answer first: an
  // unusable URL further down the list would otherwise only surface during an
  // outage, when the failover is the last thing left working.
  for (const base of unique) {
    const parsed = new URL(base);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new ValidationError('Neo X RPC URL must be an HTTP/HTTPS URL without embedded credentials');
    }
  }
  return unique;
}

/**
 * Assert that a JSON-RPC method is in the read-only allowlist.
 * @throws {ValidationError} for forbidden (broadcast/sign) or any non-allowlisted method.
 */
export function assertReadOnlyEvmMethod(method: string): string {
  if (!method || typeof method !== 'string') {
    throw new ValidationError('EVM RPC method must be a non-empty string');
  }
  if (EVM_FORBIDDEN_METHODS.has(method)) {
    throw new ValidationError(
      `EVM RPC method "${method}" is forbidden: this server never signs or broadcasts transactions. `
      + 'Construct tools return an unsigned proposal for the user to sign in their own wallet.'
    );
  }
  if (!EVM_READ_ONLY_METHODS.has(method)) {
    throw new ValidationError(
      `EVM RPC method "${method}" is not allowed. Permitted read-only methods: `
      + `${[...EVM_READ_ONLY_METHODS].join(', ')}.`
    );
  }
  return method;
}

/**
 * Invoke a read-only Neo X EVM JSON-RPC method.
 *
 * @param network  Neo X network ("neox-mainnet" | "neox-testnet").
 * @param method   A method from EVM_READ_ONLY_METHODS. Broadcast/sign methods throw.
 * @param params   JSON-RPC params array.
 * @param signal   Optional caller abort signal (in addition to the internal timeout).
 * @param fetchImpl Injectable fetch (defaults to the global fetch; used by tests).
 *
 * Endpoints from the configured list are tried in order. The next one is only
 * attempted when the current endpoint did not answer at all (non-2xx status,
 * connection failure, stall); a JSON-RPC error envelope such as
 * "execution reverted" is a real answer and is returned to the caller as-is.
 *
 * @returns The JSON-RPC `result` payload.
 * @throws {ValidationError} for a forbidden/non-allowlisted method, unknown network, or bad URL.
 * @throws {NetworkError} on non-200 status, JSON-RPC error envelope, or timeout.
 */
export async function callEvmRpc<T = unknown>(
  network: NeoxEvmNetwork,
  method: string,
  params: unknown[] = [],
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<T> {
  // Enforce the allowlist BEFORE resolving a URL or touching the network.
  assertReadOnlyEvmMethod(method);
  if (!Array.isArray(params)) {
    throw new ValidationError('EVM RPC params must be an array');
  }
  const urls = resolveRpcUrls(network);

  let lastTransportError: unknown;
  for (const url of urls) {
    try {
      return await postEvmRpc<T>(url, method, params, signal, fetchImpl);
    } catch (error) {
      // A JSON-RPC error envelope, a rejected method, or a caller abort is a
      // definitive answer: the node was reached and replied. Retrying it against
      // another endpoint would only turn one clear failure into several.
      if (error instanceof ValidationError || !isRetryableEvmTransportError(error)) {
        throw error;
      }
      if (signal?.aborted) {
        throw error;
      }
      lastTransportError = error;
    }
  }

  throw lastTransportError;
}

/** True when a failure means "this endpoint did not answer", so the next one is worth trying. */
function isRetryableEvmTransportError(error: unknown): boolean {
  return error instanceof NetworkError && (error as EvmTransportError).evmRetryable === true;
}

interface EvmTransportError extends NetworkError {
  evmRetryable?: boolean;
}

/** Mark a NetworkError as an endpoint-level fault that failover may skip past. */
function retryable(error: NetworkError): NetworkError {
  (error as EvmTransportError).evmRetryable = true;
  return error;
}

async function postEvmRpc<T>(
  url: string,
  method: string,
  params: unknown[],
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike,
): Promise<T> {
  // Serialize before allocating timers/listeners; invalid envelopes own no transport resources.
  const body = JSON.stringify({ jsonrpc: '2.0', id: nextRpcId(), method, params });
  const scope = createRequestAbortScope(DEFAULT_EVM_RPC_TIMEOUT_MS, signal);

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body,
      redirect: 'error',
      ...(scope.signal ? { signal: scope.signal } : {}),
    });

    if (!response.ok) {
      throw retryable(new NetworkError(`Neo X RPC ${method} failed (${response.status})`));
    }

    const envelope = await readBoundedJson<JsonRpcEnvelope<T>>(
      response,
      MAX_EVM_RPC_RESPONSE_BYTES,
      'Neo X RPC',
    );

    if (envelope && envelope.error) {
      const { code, message } = envelope.error;
      throw new NetworkError(
        `Neo X RPC ${method} error: ${message ?? 'unknown error'}`
        + `${code !== undefined ? ` (code ${code})` : ''}`,
      );
    }

    return envelope?.result as T;
  } catch (error) {
    if (error instanceof NetworkError || error instanceof ValidationError) {
      throw error;
    }
    if (scope.aborted || (error instanceof Error && error.name === 'AbortError')) {
      // A timeout is only worth retrying elsewhere when it was this endpoint
      // stalling; a caller-initiated abort must stop the whole call.
      const timeout = new NetworkError(
        `Neo X RPC ${method} timed out after ${DEFAULT_EVM_RPC_TIMEOUT_MS}ms`
      );
      throw signal?.aborted ? timeout : retryable(timeout);
    }
    // Connection refused / DNS failure / socket reset: the node was never reached.
    throw retryable(
      new NetworkError(error instanceof Error ? error.message : `Neo X RPC ${method} failed`)
    );
  } finally {
    scope.dispose();
  }
}
