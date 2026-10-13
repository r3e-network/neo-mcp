// Neo N3 analytical indexer REST transport.
//
// The DEPLOYED n3index indexer (api.n3index.dev) is a REST API — NOT a neo3fura
// JSON-RPC gateway. It exposes per-network resources at
//   GET `${base}/${network}/${path}`   (network is "mainnet" | "testnet")
// returning `{ data, meta }` envelopes. This client is the N3 analogue of the
// working Neo X Blockscout transport (`src/contracts/blockscout-client.ts`) and
// mirrors it exactly: outcomes are distinguished the same way the Blockscout
// client distinguishes them:
//   - 404                     -> resolve null (render an empty / not-found state)
//   - 5xx / network / timeout -> throw NetworkError (an outage, not emptiness)
//   - ok                      -> the parsed JSON body
//
// Read-only: this client never mutates chain state. It only ever issues GETs
// against a base URL from config (never a model-authored host), blocks redirects,
// and caps the response body at 4 MiB.

import { NeoNetwork } from '../services/neo-service';
import { readBoundedJson } from '../utils/bounded-json';
import { NetworkError, ValidationError } from '../utils/errors';
import { assertIndexerAvailable } from '../utils/indexer-availability';
import { config } from '../config';

type FetchLike = typeof fetch;

const DEFAULT_N3INDEX_TIMEOUT_MS = 12000;
const MAX_N3INDEX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * Assert the requested indexer network is one of the supported N3 networks.
 * `network` becomes a path segment (`${base}/${network}/...`), so validating it
 * against the fixed enum values is a defense-in-depth guarantee that no arbitrary
 * segment can be injected — the enum values are plain lowercase words.
 * @throws {ValidationError} on an unrecognized network id.
 */
function assertN3IndexNetwork(network: NeoNetwork): NeoNetwork {
  if (network !== NeoNetwork.MAINNET && network !== NeoNetwork.TESTNET) {
    throw new ValidationError(
      `Unsupported N3 indexer network: ${String(network)}. Must be one of: mainnet, testnet`,
    );
  }
  return network;
}

function resolveBaseUrl(): string {
  const base = String(config.n3index.baseUrl || '').replace(/\/+$/, '');
  const parsed = new URL(base);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new ValidationError('N3 indexer base URL must be an HTTP/HTTPS URL without embedded credentials');
  }
  return base;
}

function buildUrl(network: NeoNetwork, path: string, params: Record<string, unknown>): string {
  const base = resolveBaseUrl();
  const cleanPath = String(path || '').replace(/^\/+/, '');
  const url = new URL(`${base}/${network}/${cleanPath}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * Fetch a Neo N3 indexer REST resource for a network.
 *
 * @param network   Neo N3 network id (NeoNetwork.MAINNET | NeoNetwork.TESTNET). The
 *                  analytical tools are mainnet-only; the value comes from
 *                  `resolveIndexerNetwork`, which defaults to mainnet.
 * @param path      Path under the network segment (e.g. "accounts/N..", "tokens/0x../holders").
 * @param params    Optional query params.
 * @param signal    Optional caller abort signal (in addition to the internal timeout).
 * @param fetchImpl Injectable fetch (defaults to the global fetch; used by tests).
 * @returns Parsed JSON body (the `{ data, meta }` envelope), or null on 404.
 * @throws {NetworkError} on 5xx, network error, or timeout.
 * @throws {ValidationError} on an unknown network or malformed base URL.
 */
export async function fetchN3Index<T = unknown>(
  network: NeoNetwork,
  path: string,
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<T | null> {
  // Last line of defence: a handler that forgets its own gate still cannot reach the host.
  assertIndexerAvailable('N3 indexer access');
  assertN3IndexNetwork(network);
  const url = buildUrl(network, path, params);

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const abortFromParent = () => controller?.abort();
  if (signal?.aborted) {
    controller?.abort();
  } else {
    signal?.addEventListener('abort', abortFromParent, { once: true });
  }
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), DEFAULT_N3INDEX_TIMEOUT_MS)
    : null;
  timeoutId?.unref?.();

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      ...(controller ? { signal: controller.signal } : {}),
    });

    if (response.status === 404) {
      await response.body?.cancel?.().catch(() => undefined);
      return null;
    }
    if (!response.ok) {
      throw new NetworkError(`N3 indexer responded ${response.status}`);
    }

    return await readBoundedJson<T>(response, MAX_N3INDEX_RESPONSE_BYTES, 'N3 indexer');
  } catch (error) {
    if (error instanceof NetworkError || error instanceof ValidationError) {
      throw error;
    }
    if (controller?.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw new NetworkError('N3 indexer request timed out');
    }
    throw new NetworkError(error instanceof Error ? error.message : 'N3 indexer request failed');
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    signal?.removeEventListener('abort', abortFromParent);
  }
}
