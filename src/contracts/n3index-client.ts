import { NeoNetwork } from '../services/neo-service';
import { readBoundedJson } from '../utils/bounded-json';
import { ValidationError } from '../utils/errors';
import { assertIndexerAvailable } from '../utils/indexer-availability';
import { validateScriptHash } from '../utils/validation';

interface N3IndexContractMetadataCacheRow {
  contract_hash: string;
  display_name: string;
  symbol: string;
  logo_url?: string;
  network: string;
  source?: string;
}

export interface N3IndexResolvedContract {
  contractHash: string;
  network: NeoNetwork;
  displayName?: string;
  symbol?: string;
  logoUrl?: string;
  source: 'contract_metadata_cache' | 'contracts_index';
  manifestName?: string;
  updateCounter?: number;
  firstSeenBlock?: number;
  lastSeenBlock?: number;
}

type FetchLike = typeof fetch;

const DEFAULT_FETCH_TIMEOUT_MS = 3000;
const DEFAULT_RESOLUTION_TIMEOUT_MS = 3000;
const DEFAULT_NEGATIVE_CACHE_TTL_MS = 60_000;
const DEFAULT_NEGATIVE_CACHE_MAX_ENTRIES = 1024;
const METADATA_CATALOG_LIMIT = 10_000;
const MAX_N3INDEX_RESPONSE_BYTES = 2 * 1024 * 1024;

function normalizeName(value: string | undefined | null): string {
  return (value || '').trim().toLowerCase();
}

function buildEqNetwork(network: NeoNetwork): string {
  return `eq.${network}`;
}

export class N3IndexClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly fetchTimeoutMs: number;
  private readonly resolutionTimeoutMs: number;
  private readonly negativeCacheTtlMs: number;
  private readonly negativeCacheMaxEntries: number;
  private readonly negativeNameCache = new Map<string, number>();
  private readonly nameRequests = new Map<string, Promise<N3IndexResolvedContract | null>>();

  constructor(
    baseUrl: string,
    fetchImpl: FetchLike = fetch,
    options: {
      fetchTimeoutMs?: number;
      resolutionTimeoutMs?: number;
      negativeCacheTtlMs?: number;
      negativeCacheMaxEntries?: number;
    } = {}
  ) {
    const parsedBaseUrl = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsedBaseUrl.protocol) || parsedBaseUrl.username || parsedBaseUrl.password) {
      throw new Error('N3Index base URL must be an HTTP/HTTPS URL without embedded credentials');
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.fetchTimeoutMs = this.requirePositiveInteger(
      options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
      'fetchTimeoutMs'
    );
    this.resolutionTimeoutMs = this.requirePositiveInteger(
      options.resolutionTimeoutMs ?? DEFAULT_RESOLUTION_TIMEOUT_MS,
      'resolutionTimeoutMs'
    );
    this.negativeCacheTtlMs = this.requirePositiveInteger(
      options.negativeCacheTtlMs ?? DEFAULT_NEGATIVE_CACHE_TTL_MS,
      'negativeCacheTtlMs'
    );
    this.negativeCacheMaxEntries = this.requirePositiveInteger(
      options.negativeCacheMaxEntries ?? DEFAULT_NEGATIVE_CACHE_MAX_ENTRIES,
      'negativeCacheMaxEntries'
    );
  }

  private requirePositiveInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive integer`);
    }
    return value;
  }

  private async fetchJson<T>(
    pathname: string,
    params: Record<string, string>,
    parentSignal?: AbortSignal
  ): Promise<T> {
    // Last line of defence: a constructed client still cannot reach the host while off.
    assertIndexerAvailable('N3 indexer access');
    const url = new URL(`${this.baseUrl}${pathname}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const abortFromParent = () => controller?.abort();
    if (parentSignal?.aborted) {
      controller?.abort();
    } else {
      parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    }
    const timeoutId = controller
      ? setTimeout(() => controller.abort(), this.fetchTimeoutMs)
      : null;
    timeoutId?.unref?.();

    try {
      const response = await this.fetchImpl(url.toString(), {
        headers: {
          Accept: 'application/json',
        },
        redirect: 'error',
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!response.ok) {
        throw new Error(`N3Index request failed (${response.status}) for ${url.pathname}`);
      }

      return await readBoundedJson<T>(response, MAX_N3INDEX_RESPONSE_BYTES, 'N3Index');
    } catch (error) {
      if (controller?.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new Error(`N3Index request timed out for ${url.pathname}`);
      }
      throw error;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      parentSignal?.removeEventListener('abort', abortFromParent);
    }
  }

  async resolveByName(network: NeoNetwork, reference: string): Promise<N3IndexResolvedContract | null> {
    const normalizedReference = normalizeName(reference);
    if (!normalizedReference) {
      return null;
    }

    const cacheKey = `${network}:${normalizedReference}`;
    const negativeCacheExpiry = this.negativeNameCache.get(cacheKey);
    if (negativeCacheExpiry !== undefined) {
      if (negativeCacheExpiry > Date.now()) {
        return null;
      }
      this.negativeNameCache.delete(cacheKey);
    }

    const inFlight = this.nameRequests.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const request = this.resolveByNameWithDeadline(network, reference, normalizedReference)
      .then((result) => {
        if (!result) {
          this.cacheNegativeResult(cacheKey);
        }
        return result;
      })
      .finally(() => {
        this.nameRequests.delete(cacheKey);
      });
    this.nameRequests.set(cacheKey, request);
    return request;
  }

  private cacheNegativeResult(cacheKey: string): void {
    const now = Date.now();
    for (const [key, expiry] of this.negativeNameCache) {
      if (expiry <= now) {
        this.negativeNameCache.delete(key);
      }
    }

    this.negativeNameCache.delete(cacheKey);
    while (this.negativeNameCache.size >= this.negativeCacheMaxEntries) {
      const oldestKey = this.negativeNameCache.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.negativeNameCache.delete(oldestKey);
    }
    this.negativeNameCache.set(cacheKey, now + this.negativeCacheTtlMs);
  }

  private async resolveByNameWithDeadline(
    network: NeoNetwork,
    reference: string,
    normalizedReference: string
  ): Promise<N3IndexResolvedContract | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.resolutionTimeoutMs);
    timeout.unref?.();

    try {
      return await this.resolveByNameUncached(network, reference, normalizedReference, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`N3Index name resolution timed out after ${this.resolutionTimeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async resolveByNameUncached(
    network: NeoNetwork,
    reference: string,
    normalizedReference: string,
    signal: AbortSignal
  ): Promise<N3IndexResolvedContract | null> {
    const metadataRows = await this.fetchJson<N3IndexContractMetadataCacheRow[]>('/rest/v1/contract_metadata_cache', {
      network: buildEqNetwork(network),
      limit: String(METADATA_CATALOG_LIMIT),
      select: 'contract_hash,display_name,symbol,logo_url,network,source',
    }, signal);

    const exactMetadataMatches = metadataRows.filter((row) =>
      row.network === network
      && (normalizeName(row.display_name) === normalizedReference || normalizeName(row.symbol) === normalizedReference)
    );
    const matchesByHash = new Map(
      exactMetadataMatches.map((row) => [validateScriptHash(row.contract_hash), row])
    );
    if (matchesByHash.size > 1) {
      throw new ValidationError(`Contract name "${reference.trim()}" is ambiguous; use a script hash or address`);
    }
    const exactMetadataMatch = matchesByHash.values().next().value as N3IndexContractMetadataCacheRow | undefined;

    if (exactMetadataMatch) {
      return {
        contractHash: validateScriptHash(exactMetadataMatch.contract_hash),
        network,
        displayName: exactMetadataMatch.display_name || undefined,
        symbol: exactMetadataMatch.symbol || undefined,
        logoUrl: exactMetadataMatch.logo_url || undefined,
        source: 'contract_metadata_cache',
      };
    }

    return null;
  }

  async getContractByHash(network: NeoNetwork, contractHash: string): Promise<N3IndexResolvedContract | null> {
    const normalizedHash = validateScriptHash(contractHash);
    const metadataRows = await this.fetchJson<N3IndexContractMetadataCacheRow[]>('/rest/v1/contract_metadata_cache', {
      network: buildEqNetwork(network),
      contract_hash: `eq.${normalizedHash}`,
      select: 'contract_hash,display_name,symbol,logo_url,network,source',
      limit: '1',
    });
    const metadata = metadataRows[0];
    if (
      !metadata
      || metadata.network !== network
      || validateScriptHash(metadata.contract_hash) !== normalizedHash
    ) {
      return null;
    }

    return {
      contractHash: normalizedHash,
      network,
      displayName: metadata.display_name || undefined,
      symbol: metadata.symbol || undefined,
      logoUrl: metadata.logo_url || undefined,
      source: 'contract_metadata_cache',
    };
  }
}
