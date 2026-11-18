// Neo X Fura deep-analytics read transport.
//
// Targets the NeoX Fura readapi served by neo-os-fura/supabase_indexer
// (cmd/neox-indexer, apiOnly mode) at `${base}/neox/${network}/${path}` where
// `base` is the per-network deployment URL from config. The surface is the
// AI-agent contract documented in neo-os-fura/docs/NEOX-AI-AGENT-CAPABILITIES.md.
//
// Response envelope mirrors the Neo N3 fura contract the `query_indexer` tools
// already speak: `{ evidence: { chain, network, indexed_tip, as_of_block, fresh,
// data_source, generated_at }, data }`. Callers get the whole envelope so the
// assistant can cite freshness the same way it does on Neo N3.
//
// Outcomes:
//   - 404            -> resolve null (not-found state)
//   - 5xx / network / timeout -> throw NetworkError
//   - ok             -> the parsed JSON body
//
// Read-only: this client never mutates chain state.

import { readBoundedJson } from '../utils/bounded-json';
import { NetworkError, ValidationError } from '../utils/errors';
import { config } from '../config';
import type { NeoxNetwork } from './blockscout-client';
import { resolveNeoxNetwork } from './blockscout-client';

export { resolveNeoxNetwork };
export type { NeoxNetwork };

const DEFAULT_FURA_TIMEOUT_MS = 12_000;
const MAX_FURA_RESPONSE_BYTES = 4 * 1024 * 1024;

type FetchLike = typeof fetch;

/**
 * Normalize a caller-supplied Neo X network id (same vocabulary as the
 * Blockscout tools: "neox-mainnet" | "neox-testnet" | "mainnet" | "testnet").
 * @throws {ValidationError} on an unrecognized network id.
 */
export function resolveNeoxFuraNetwork(network: string): NeoxNetwork {
  return resolveNeoxNetwork(network);
}

function resolveBaseUrl(network: NeoxNetwork): string {
  if (network === 'neox-testnet' && !config.neox.testnetEnabled) {
    throw new ValidationError('Neo X testnet Fura access is disabled (set NEOX_TESTNET_ENABLED=true to enable).');
  }
  const rawBase = network === 'neox-testnet'
    ? config.neox.testnetFuraApiBaseUrl
    : config.neox.mainnetFuraApiBaseUrl;
  const base = String(rawBase || '').trim().replace(/\/+$/, '');
  if (!base) {
    throw new ValidationError(
      'Neo X Fura analytics are not configured; set NEOX_MAINNET_FURA_API_BASE_URL '
      + '(and NEOX_TESTNET_FURA_API_BASE_URL for testnet) to the readapi deployment URL.'
    );
  }
  const parsed = new URL(base);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new ValidationError('Neo X Fura base URL must be an HTTP/HTTPS URL without embedded credentials');
  }
  return base;
}

function buildUrl(network: NeoxNetwork, path: string, params: Record<string, unknown>): string {
  const base = resolveBaseUrl(network);
  // The readapi mounts everything under /neox/{network}; collapse duplicate
  // slashes but keep the documented path otherwise verbatim.
  const cleanPath = String(path || '')
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const url = new URL(`${base}/neox/${network === 'neox-mainnet' ? 'mainnet' : 'testnet'}/${cleanPath}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * Fetch a Neo X Fura readapi resource.
 *
 * @param network   Neo X network id ("neox-mainnet" | "neox-testnet").
 * @param path      Path under /neox/{network} (e.g. "addresses/0x../analytics").
 * @param params    Optional query params (limit, days, hours, sort, ...).
 * @param signal    Optional caller abort signal (in addition to the internal timeout).
 * @param fetchImpl Injectable fetch (defaults to the global fetch; used by tests).
 * @returns Parsed JSON body (the evidence+data envelope), or null on 404.
 * @throws {NetworkError} on 5xx, network error, or timeout.
 * @throws {ValidationError} on an unknown network, malformed base URL, or missing configuration.
 */
export async function fetchNeoxFura<T = unknown>(
  network: NeoxNetwork,
  path: string,
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<T | null> {
  const url = buildUrl(network, path, params);

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const abortFromParent = () => controller?.abort();
  if (signal?.aborted) {
    controller?.abort();
  } else {
    signal?.addEventListener('abort', abortFromParent, { once: true });
  }
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), DEFAULT_FURA_TIMEOUT_MS)
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
      throw new NetworkError(`Neo X Fura readapi responded ${response.status}`);
    }

    return await readBoundedJson<T>(response, MAX_FURA_RESPONSE_BYTES, 'Neo X Fura readapi');
  } catch (error) {
    if (error instanceof NetworkError || error instanceof ValidationError) {
      throw error;
    }
    if (controller?.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw new NetworkError('Neo X Fura readapi request timed out');
    }
    throw new NetworkError(error instanceof Error ? error.message : 'Neo X Fura readapi request failed');
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    signal?.removeEventListener('abort', abortFromParent);
  }
}
