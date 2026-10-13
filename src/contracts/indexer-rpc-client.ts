// neo3fura analytical indexer JSON-RPC transport.
//
// The public neo3fura gateway (api.n3index.dev) exposes a JSON-RPC 2.0 surface
// per network: a request is POSTed to `${base}/${network}` (network is
// "mainnet" | "testnet") with an envelope of the form
//   {"jsonrpc":"2.0","id":<n>,"method":"GetXxx","params":{...},"id":1}
// The gateway is backed by Go's net/rpc with a custom codec that title-cases the
// method onto a single service (see neo3fura_http/lib/rpccodec): method names
// MUST be sent in their exact PascalCase form (e.g. "GetAddressByAddress") and
// params MUST be a single object whose keys match the handler's arg struct
// fields (PascalCase, e.g. {Address, Limit, Skip, ContractHash}).
//
// Successful responses carry a top-level `result`; failures carry a top-level
// `error` object ({code, message}). Both non-200 HTTP responses and JSON-RPC
// `error` envelopes are surfaced as a typed NetworkError, and a stalled upstream
// is bounded by an AbortController timeout (mirroring N3IndexClient).

import { NeoNetwork } from '../services/neo-service';
import { readBoundedJson } from '../utils/bounded-json';
import { NetworkError, ValidationError } from '../utils/errors';
import { assertIndexerAvailable } from '../utils/indexer-availability';
import { createRequestAbortScope } from '../utils/request-abort-scope';
import { config } from '../config';

type FetchLike = typeof fetch;

const DEFAULT_INDEXER_RPC_TIMEOUT_MS = 8000;
const MAX_INDEXER_RPC_RESPONSE_BYTES = 4 * 1024 * 1024;

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

function assertSupportedNetwork(network: NeoNetwork): NeoNetwork {
  if (network !== NeoNetwork.MAINNET && network !== NeoNetwork.TESTNET) {
    throw new ValidationError(`Unsupported indexer network: ${String(network)}`);
  }
  return network;
}

function resolveEndpoint(network: NeoNetwork): string {
  const rawBase = config.n3index.baseUrl.replace(/\/+$/, '');
  const parsed = new URL(rawBase);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new ValidationError('Indexer base URL must be an HTTP/HTTPS URL without embedded credentials');
  }
  return `${rawBase}/${network}`;
}

/**
 * Invoke a neo3fura analytical indexer JSON-RPC method.
 *
 * @param network  Neo N3 network ("mainnet" | "testnet").
 * @param method   Exact PascalCase method name (e.g. "GetRawTransactionByAddress").
 * @param params   Params object keyed by the handler's PascalCase fields.
 * @param signal   Optional caller abort signal (in addition to the internal timeout).
 * @param fetchImpl Injectable fetch (defaults to the global fetch; used by tests).
 * @returns The JSON-RPC `result` payload.
 * @throws {NetworkError} on non-200 status, JSON-RPC error envelope, or timeout.
 * @throws {ValidationError} on an unsupported network or malformed base URL.
 */
export async function callIndexerRpc<T = unknown>(
  network: NeoNetwork,
  method: string,
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<T> {
  // Last line of defence: a handler that forgets its own gate still cannot reach the host.
  assertIndexerAvailable('N3 indexer access');
  assertSupportedNetwork(network);
  if (!method || typeof method !== 'string') {
    throw new ValidationError('Indexer RPC method must be a non-empty string');
  }
  const url = resolveEndpoint(network);

  // Serialize before allocating timers/listeners; invalid envelopes own no transport resources.
  const body = JSON.stringify({ jsonrpc: '2.0', id: nextRpcId(), method, params });
  const scope = createRequestAbortScope(DEFAULT_INDEXER_RPC_TIMEOUT_MS, signal);

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
      throw new NetworkError(`Indexer RPC ${method} failed (${response.status})`);
    }

    const envelope = await readBoundedJson<JsonRpcEnvelope<T>>(
      response,
      MAX_INDEXER_RPC_RESPONSE_BYTES,
      'Indexer RPC',
    );

    if (envelope && envelope.error) {
      const { code, message } = envelope.error;
      throw new NetworkError(
        `Indexer RPC ${method} error: ${message ?? 'unknown error'}${code !== undefined ? ` (code ${code})` : ''}`,
      );
    }

    return envelope?.result as T;
  } catch (error) {
    if (scope.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw new NetworkError(`Indexer RPC ${method} timed out after ${DEFAULT_INDEXER_RPC_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    scope.dispose();
  }
}
