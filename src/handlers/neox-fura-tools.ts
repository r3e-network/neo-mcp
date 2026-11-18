// Neo X Fura deep-analytics tool handlers.
//
// Mirrors the Neo N3 fura ergonomics: on Neo N3 the assistant reaches fura's
// deep analytics through curated `n3_*` tools; on Neo X these `x_fura_*` tools
// play the same role, backed by the NeoX Fura readapi
// (neo-os-fura/supabase_indexer cmd/neox-indexer, /neox/{network}/... surface).
//
// Every tool is a fixed allowlist entry: the path template and the permitted
// query params are declared here, never taken from caller input. Path segments
// are validated EVM addresses / hashes; query params are bounded integers or
// enum values. Nothing free-form reaches the URL.
//
// Read-only: no handler in this file mutates chain state or touches wallets.

import { fetchNeoxFura, resolveNeoxFuraNetwork } from '../contracts/neox-fura-client';
import type { NeoxNetwork } from '../contracts/neox-fura-client';
import { ValidationError } from '../utils/errors';
import { createSuccessResponse, handleError } from '../utils/error-handler';
import { validateEvmAddress, validateEvmHash } from '../utils/validation';

/** Path/query budget shared with the other explorer families. */
const MAX_LIMIT = 1000;
const MAX_DAYS = 365;
const MAX_HOURS = 24 * 31;
const MAX_DEPTH = 5;

const SORT_FIELDS: readonly string[] = ['transactions', 'transfers', 'gas'];

/** A validated, fully-resolved upstream request for one tool call. */
interface FuraRequest {
  path: string;
  params: Record<string, string>;
}

type PathParam =
  | { kind: 'address'; field: string }
  | { kind: 'hash'; field: string };

type QueryRule =
  | { type: 'integer'; min?: number; max?: number }
  | { type: 'enum'; values: readonly string[] };

interface ToolSpec {
  /** Upstream path under /neox/{network}; `{name}` segments are substituted. */
  pathTemplate: string;
  /** Path params in template order, with their validators. */
  pathParams?: PathParam[];
  /** Permitted query params and their bounds. */
  query?: Record<string, QueryRule>;
  /** The one free-text param (`q` for search); bounded to 1..256 chars. */
  freeText?: boolean;
}

/**
 * The Neo X Fura deep-analytics tools. Internal routing targets: the public
 * surface reaches them through the unified registry tools (and the neox routes
 * of the existing `analyze_*` tools), never directly.
 */
export const NEOX_FURA_TOOLS: ReadonlySet<string> = new Set([
  'query_neox_fura',
  'x_fura_status',
  'x_fura_search',
  'x_fura_address_analytics',
  'x_fura_address_relationships',
  'x_fura_address_patterns',
  'x_fura_address_tokens',
  'x_fura_account_graph',
  'x_fura_contract_analytics',
  'x_fura_contract_methods',
  'x_fura_contract_interactions',
  'x_fura_contract_callers',
  'x_fura_token_analytics',
  'x_fura_token_distribution',
  'x_fura_token_velocity',
  'x_fura_network_daily',
  'x_fura_network_gas',
  'x_fura_network_growth',
  'x_fura_top_accounts',
  'x_fura_top_contracts',
  'x_fura_top_tokens',
  'x_fura_whales',
  'x_fura_bots',
  'x_fura_token_flow',
  'x_fura_defi_pools',
  'x_fura_defi_volume',
]);

const TOOL_SPECS: ReadonlyMap<string, ToolSpec> = new Map<string, ToolSpec>([
  ['x_fura_status', { pathTemplate: 'status' }],
  ['x_fura_search', {
    pathTemplate: 'search',
    freeText: true,
  }],
  ['x_fura_address_analytics', {
    pathTemplate: 'addresses/{address}/analytics',
    pathParams: [{ kind: 'address', field: 'address' }],
  }],
  ['x_fura_address_relationships', {
    pathTemplate: 'addresses/{address}/relationships',
    pathParams: [{ kind: 'address', field: 'address' }],
    query: { limit: { type: 'integer', min: 1, max: MAX_LIMIT } },
  }],
  ['x_fura_address_patterns', {
    pathTemplate: 'addresses/{address}/patterns',
    pathParams: [{ kind: 'address', field: 'address' }],
  }],
  ['x_fura_address_tokens', {
    pathTemplate: 'addresses/{address}/tokens',
    pathParams: [{ kind: 'address', field: 'address' }],
    query: { limit: { type: 'integer', min: 1, max: MAX_LIMIT } },
  }],
  ['x_fura_account_graph', {
    pathTemplate: 'graph/relationships/{address}',
    pathParams: [{ kind: 'address', field: 'address' }],
    query: {
      depth: { type: 'integer', min: 1, max: MAX_DEPTH },
      limit: { type: 'integer', min: 1, max: MAX_LIMIT },
    },
  }],
  ['x_fura_contract_analytics', {
    pathTemplate: 'contracts/{address}/analytics',
    pathParams: [{ kind: 'address', field: 'address' }],
  }],
  ['x_fura_contract_methods', {
    pathTemplate: 'contracts/{address}/methods',
    pathParams: [{ kind: 'address', field: 'address' }],
    query: { limit: { type: 'integer', min: 1, max: MAX_LIMIT } },
  }],
  ['x_fura_contract_interactions', {
    pathTemplate: 'contracts/{address}/interactions',
    pathParams: [{ kind: 'address', field: 'address' }],
    query: { limit: { type: 'integer', min: 1, max: MAX_LIMIT } },
  }],
  ['x_fura_contract_callers', {
    pathTemplate: 'contracts/{address}/callers',
    pathParams: [{ kind: 'address', field: 'address' }],
    query: { limit: { type: 'integer', min: 1, max: MAX_LIMIT } },
  }],
  ['x_fura_token_analytics', {
    pathTemplate: 'tokens/{address}/analytics',
    pathParams: [{ kind: 'address', field: 'address' }],
  }],
  ['x_fura_token_distribution', {
    pathTemplate: 'tokens/{address}/distribution',
    pathParams: [{ kind: 'address', field: 'address' }],
  }],
  ['x_fura_token_velocity', {
    pathTemplate: 'tokens/{address}/velocity',
    pathParams: [{ kind: 'address', field: 'address' }],
    query: { days: { type: 'integer', min: 1, max: MAX_DAYS } },
  }],
  ['x_fura_network_daily', {
    pathTemplate: 'analytics/network/daily',
    query: { days: { type: 'integer', min: 1, max: MAX_DAYS } },
  }],
  ['x_fura_network_gas', {
    pathTemplate: 'analytics/network/gas',
    query: { hours: { type: 'integer', min: 1, max: MAX_HOURS } },
  }],
  ['x_fura_network_growth', { pathTemplate: 'analytics/network/growth' }],
  ['x_fura_top_accounts', {
    pathTemplate: 'analytics/top-accounts',
    query: {
      sort: { type: 'enum', values: SORT_FIELDS },
      limit: { type: 'integer', min: 1, max: MAX_LIMIT },
    },
  }],
  ['x_fura_top_contracts', {
    pathTemplate: 'analytics/top-contracts',
    query: { limit: { type: 'integer', min: 1, max: MAX_LIMIT } },
  }],
  ['x_fura_top_tokens', {
    pathTemplate: 'analytics/top-tokens',
    query: { limit: { type: 'integer', min: 1, max: MAX_LIMIT } },
  }],
  ['x_fura_whales', {
    pathTemplate: 'analytics/whales',
    query: { limit: { type: 'integer', min: 1, max: MAX_LIMIT } },
  }],
  ['x_fura_bots', {
    pathTemplate: 'analytics/bots',
    query: { limit: { type: 'integer', min: 1, max: MAX_LIMIT } },
  }],
  ['x_fura_token_flow', {
    pathTemplate: 'graph/token-flow/{token}',
    pathParams: [{ kind: 'address', field: 'token' }],
    query: { hours: { type: 'integer', min: 1, max: MAX_HOURS } },
  }],
  ['x_fura_defi_pools', {
    pathTemplate: 'defi/pools',
    query: { limit: { type: 'integer', min: 1, max: MAX_LIMIT } },
  }],
  ['x_fura_defi_volume', { pathTemplate: 'defi/volume' }],
]);

/**
 * Public `query_neox_fura` topics mapped onto the internal single-purpose
 * tool names. The registry schema pins the same enum.
 */
export const NEOX_FURA_TOPICS: Readonly<Record<string, string>> = Object.freeze({
  status: 'x_fura_status',
  search: 'x_fura_search',
  address_analytics: 'x_fura_address_analytics',
  address_relationships: 'x_fura_address_relationships',
  address_patterns: 'x_fura_address_patterns',
  address_tokens: 'x_fura_address_tokens',
  account_graph: 'x_fura_account_graph',
  contract_analytics: 'x_fura_contract_analytics',
  contract_methods: 'x_fura_contract_methods',
  contract_interactions: 'x_fura_contract_interactions',
  contract_callers: 'x_fura_contract_callers',
  token_analytics: 'x_fura_token_analytics',
  token_distribution: 'x_fura_token_distribution',
  token_velocity: 'x_fura_token_velocity',
  network_daily: 'x_fura_network_daily',
  network_gas: 'x_fura_network_gas',
  network_growth: 'x_fura_network_growth',
  top_accounts: 'x_fura_top_accounts',
  top_contracts: 'x_fura_top_contracts',
  top_tokens: 'x_fura_top_tokens',
  whales: 'x_fura_whales',
  bots: 'x_fura_bots',
  token_flow: 'x_fura_token_flow',
  defi_pools: 'x_fura_defi_pools',
  defi_volume: 'x_fura_defi_volume',
});

function selectedNetwork(input: Record<string, unknown>): NeoxNetwork {
  const raw = typeof input.network === 'string' ? input.network : 'mainnet';
  return resolveNeoxFuraNetwork(raw);
}

function requireString(input: Record<string, unknown>, field: string, spec: ToolSpec): string {
  const value = input[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${spec.pathTemplate} requires a non-empty "${field}"`);
  }
  return value;
}

function resolvePathParams(input: Record<string, unknown>, spec: ToolSpec): string {
  let path = spec.pathTemplate;
  for (const param of spec.pathParams ?? []) {
    const raw = requireString(input, param.field, spec);
    const resolved = param.kind === 'hash' ? validateEvmHash(raw) : validateEvmAddress(raw);
    path = path.replace(`{${param.field}}`, resolved);
  }
  return path;
}

function resolveQuery(input: Record<string, unknown>, spec: ToolSpec): Record<string, string> {
  // Reject any caller key that is not part of this tool's declared vocabulary
  // (network/topic/path fields handled elsewhere) — mirroring the
  // query_indexer/x_query guard contract: nothing free-form reaches the URL.
  const pathFields = new Set((spec.pathParams ?? []).map((p) => p.field));
  const declared = new Set([
    ...Object.keys(spec.query ?? {}),
    ...(spec.freeText ? ['q'] : []),
    ...pathFields,
  ]);
  for (const key of Object.keys(input)) {
    if (key === 'network' || key === 'topic' || key === 'chain') continue;
    if (!declared.has(key)) {
      throw new ValidationError(
        `Unknown parameter "${key}" for this Neo X Fura topic; accepted keys: `
        + `${[...declared].join(', ') || 'none'}`
      );
    }
  }

  const params: Record<string, string> = {};
  for (const [key, rule] of Object.entries(spec.query ?? {})) {
    // `search` is the one free-text param; validate it separately below.
    if (rule === undefined) continue;
    const raw = input[key];
    if (raw === undefined || raw === null || raw === '') continue;
    if (rule.type === 'integer') {
      const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
      if (!Number.isSafeInteger(parsed)) {
        throw new ValidationError(`"${key}" must be an integer`);
      }
      if ((rule.min !== undefined && parsed < rule.min) || (rule.max !== undefined && parsed > rule.max)) {
        throw new ValidationError(`"${key}" must be between ${rule.min ?? 0} and ${rule.max}`);
      }
      params[key] = String(parsed);
      continue;
    }
    if (!rule.values.includes(String(raw))) {
      throw new ValidationError(`"${key}" must be one of: ${rule.values.join(', ')}`);
    }
    params[key] = String(raw);
  }
  if (spec.freeText) {
    const q = input.q;
    if (typeof q !== 'string' || q.trim().length === 0 || q.length > 256) {
      throw new ValidationError('"q" must be a search string of 1..256 characters');
    }
    params.q = q.trim();
  }
  return params;
}

/** Build the validated upstream request for one tool call. */
export function buildNeoxFuraRequest(name: string, input: Record<string, unknown>): {
  network: NeoxNetwork;
  request: FuraRequest;
} {
  // The generic public tool selects its single-purpose spec by topic.
  let toolName = name;
  if (name === 'query_neox_fura') {
    const topic = input.topic;
    if (typeof topic !== 'string' || !NEOX_FURA_TOPICS[topic]) {
      throw new ValidationError(
        `"topic" must be one of: ${Object.keys(NEOX_FURA_TOPICS).join(', ')}`
      );
    }
    toolName = NEOX_FURA_TOPICS[topic];
  }
  const spec = TOOL_SPECS.get(toolName);
  if (!spec) {
    throw new ValidationError(`Unknown Neo X Fura tool: ${toolName}`);
  }
  const network = selectedNetwork(input);
  const path = resolvePathParams(input, spec);
  const params = resolveQuery(input, spec);
  return { network, request: { path, params } };
}

/**
 * Dispatch an `x_fura_*` tool. The upstream response is the fura
 * evidence+data envelope, passed through so the assistant can cite
 * freshness (indexed_tip / generated_at) exactly as it does on Neo N3.
 */
export async function dispatchNeoxFuraTool(
  name: string,
  input: Record<string, unknown>,
  fetchImpl?: typeof fetch,
): Promise<Record<string, unknown>> {
  try {
    const { network, request } = buildNeoxFuraRequest(name, input);
    const result = await fetchNeoxFura(
      network,
      request.path,
      request.params,
      undefined,
      fetchImpl ?? fetch,
    );
    if (result === null) {
      return createSuccessResponse({
        network: network === 'neox-mainnet' ? 'mainnet' : 'testnet',
        backend: 'neox-fura-readapi',
        found: false,
        note: 'The Neo X Fura readapi returned no resource for this query (404).',
      });
    }
    return createSuccessResponse({
      network: network === 'neox-mainnet' ? 'mainnet' : 'testnet',
      backend: 'neox-fura-readapi',
      found: true,
      fura: result,
    });
  } catch (error) {
    return handleError(error);
  }
}
