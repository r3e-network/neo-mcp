import { fetchBlockscout, NeoxNetwork, resolveNeoxNetwork } from '../contracts/blockscout-client';
import { validateEvmAddress, validateEvmBlockRef, validateEvmHash } from '../utils/validation';
import { ValidationError } from '../utils/errors';

const COLLECTION_ITEM_LIMIT = 25;
const NESTED_ARRAY_LIMIT = 50;
const STRING_LIMIT = 12_000;
const SECTION_JSON_LIMIT = 96_000;
const OBJECT_KEY_LIMIT = 120;
const VALUE_DEPTH_LIMIT = 8;

type EntityKind = 'transaction' | 'block' | 'address' | 'contract' | 'token';

interface SectionSpec {
  name: string;
  path: string;
  primary?: boolean;
}

interface CompactResult {
  value: unknown;
  truncated: boolean;
}

function enforceSectionBudget(compacted: CompactResult): CompactResult {
  const serialized = JSON.stringify(compacted.value);
  if (serialized.length <= SECTION_JSON_LIMIT) return compacted;
  return {
    value: {
      preview_json: serialized.slice(0, SECTION_JSON_LIMIT),
      original_json_characters: serialized.length,
      note: 'Section exceeded the bounded analysis payload and was truncated.',
    },
    truncated: true,
  };
}

interface SettledSection {
  status: 'available' | 'not_found' | 'unavailable';
  data: unknown;
  boundary: {
    returned?: number;
    upstream_page_items?: number;
    has_more?: boolean;
    value_truncated: boolean;
  };
}

export const NEOX_ANALYSIS_TOOLS = new Set([
  'x_analyze_transaction',
  'x_analyze_block',
  'x_analyze_address',
  'x_analyze_contract',
  'x_analyze_token',
]);

function compactValue(value: unknown, depth = 0): CompactResult {
  if (typeof value === 'string') {
    if (value.length <= STRING_LIMIT) return { value, truncated: false };
    return {
      value: `${value.slice(0, STRING_LIMIT)}...[truncated ${value.length - STRING_LIMIT} chars]`,
      truncated: true,
    };
  }
  if (value === null || typeof value !== 'object') {
    return { value, truncated: false };
  }
  if (depth >= VALUE_DEPTH_LIMIT) {
    return { value: '[nested value omitted]', truncated: true };
  }
  if (Array.isArray(value)) {
    let truncated = value.length > NESTED_ARRAY_LIMIT;
    const items = value.slice(0, NESTED_ARRAY_LIMIT).map((item) => {
      const compacted = compactValue(item, depth + 1);
      truncated ||= compacted.truncated;
      return compacted.value;
    });
    return { value: items, truncated };
  }

  const entries = Object.entries(value as Record<string, unknown>);
  let truncated = entries.length > OBJECT_KEY_LIMIT;
  const compacted: Record<string, unknown> = {};
  for (const [key, item] of entries.slice(0, OBJECT_KEY_LIMIT)) {
    const result = compactValue(item, depth + 1);
    compacted[key] = result.value;
    truncated ||= result.truncated;
  }
  return { value: compacted, truncated };
}

function settleSection(result: PromiseSettledResult<unknown>): SettledSection {
  if (result.status === 'rejected') {
    return {
      status: 'unavailable',
      data: null,
      boundary: { value_truncated: false },
    };
  }
  if (result.value === null) {
    return {
      status: 'not_found',
      data: null,
      boundary: { value_truncated: false },
    };
  }

  const raw = result.value;
  if (
    raw
    && typeof raw === 'object'
    && !Array.isArray(raw)
    && Array.isArray((raw as Record<string, unknown>).items)
  ) {
    const record = raw as Record<string, unknown>;
    const upstreamItems = record.items as unknown[];
    const compacted = enforceSectionBudget(
      compactValue(upstreamItems.slice(0, COLLECTION_ITEM_LIMIT)),
    );
    const hasMore = upstreamItems.length > COLLECTION_ITEM_LIMIT || record.next_page_params != null;
    return {
      status: 'available',
      data: compacted.value,
      boundary: {
        returned: Math.min(upstreamItems.length, COLLECTION_ITEM_LIMIT),
        upstream_page_items: upstreamItems.length,
        has_more: hasMore,
        value_truncated: compacted.truncated,
      },
    };
  }

  if (Array.isArray(raw)) {
    const compacted = enforceSectionBudget(compactValue(raw.slice(0, COLLECTION_ITEM_LIMIT)));
    return {
      status: 'available',
      data: compacted.value,
      boundary: {
        returned: Math.min(raw.length, COLLECTION_ITEM_LIMIT),
        upstream_page_items: raw.length,
        has_more: raw.length > COLLECTION_ITEM_LIMIT,
        value_truncated: compacted.truncated,
      },
    };
  }

  const compacted = enforceSectionBudget(compactValue(raw));
  return {
    status: 'available',
    data: compacted.value,
    boundary: { value_truncated: compacted.truncated },
  };
}

async function analyzeEntity(
  network: NeoxNetwork,
  kind: EntityKind,
  identifier: string,
  specs: SectionSpec[],
): Promise<Record<string, unknown>> {
  const outcomes = await Promise.allSettled(
    specs.map((spec) => fetchBlockscout(network, spec.path)),
  );
  const primaryIndex = specs.findIndex((spec) => spec.primary);
  const requiredIndex = primaryIndex >= 0 ? primaryIndex : 0;
  if (outcomes[requiredIndex].status === 'rejected') {
    throw (outcomes[requiredIndex] as PromiseRejectedResult).reason;
  }

  const sections: Record<string, SettledSection> = {};
  const evidence: Array<Record<string, unknown>> = [];
  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index];
    const section = settleSection(outcomes[index]);
    sections[spec.name] = section;
    evidence.push({
      id: `neox:${kind}:${identifier}:${spec.name}`,
      source: 'blockscout_v2',
      section: spec.name,
      status: section.status,
      ...section.boundary,
    });
  }

  const primary = sections[specs[requiredIndex].name];
  return {
    engine_version: `neox-${kind}-intelligence/v1`,
    chain: 'neox',
    network,
    entity: {
      kind,
      identifier,
      found: primary.status === 'available',
    },
    sections,
    evidence,
    boundary: {
      source: 'Neo X Blockscout v2 indexed API',
      collection_item_limit: COLLECTION_ITEM_LIMIT,
      string_character_limit: STRING_LIMIT,
      section_json_character_limit: SECTION_JSON_LIMIT,
      exhaustive_history: false,
      note: 'Collection sections contain only the newest bounded page. Missing optional sections do not prove no activity.',
    },
  };
}

function selectedNetwork(input: Record<string, unknown>): NeoxNetwork {
  const network = typeof input.network === 'string' ? input.network : 'neox-mainnet';
  return resolveNeoxNetwork(network);
}

export async function dispatchNeoxAnalysisTool(
  name: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const network = selectedNetwork(input);
  switch (name) {
    case 'x_analyze_transaction': {
      const hash = validateEvmHash(input.hash as string);
      return analyzeEntity(network, 'transaction', hash, [
        { name: 'transaction', path: `transactions/${hash}`, primary: true },
        { name: 'logs', path: `transactions/${hash}/logs` },
        { name: 'internal_transactions', path: `transactions/${hash}/internal-transactions` },
        { name: 'token_transfers', path: `transactions/${hash}/token-transfers` },
        { name: 'state_changes', path: `transactions/${hash}/state-changes` },
      ]);
    }
    case 'x_analyze_block': {
      const blockRef = validateEvmBlockRef(input.blockNumberOrHash as string | number);
      return analyzeEntity(network, 'block', blockRef, [
        { name: 'block', path: `blocks/${blockRef}`, primary: true },
        { name: 'transactions', path: `blocks/${blockRef}/transactions` },
      ]);
    }
    case 'x_analyze_address': {
      const address = validateEvmAddress(input.address as string);
      return analyzeEntity(network, 'address', address, [
        { name: 'address', path: `addresses/${address}`, primary: true },
        { name: 'counters', path: `addresses/${address}/counters` },
        { name: 'transactions', path: `addresses/${address}/transactions` },
        { name: 'token_transfers', path: `addresses/${address}/token-transfers` },
        { name: 'internal_transactions', path: `addresses/${address}/internal-transactions` },
        { name: 'token_balances', path: `addresses/${address}/token-balances` },
      ]);
    }
    case 'x_analyze_contract': {
      const address = validateEvmAddress(input.address as string);
      return analyzeEntity(network, 'contract', address, [
        { name: 'address', path: `addresses/${address}`, primary: true },
        { name: 'verified_contract', path: `smart-contracts/${address}` },
        { name: 'counters', path: `addresses/${address}/counters` },
        { name: 'transactions', path: `addresses/${address}/transactions` },
        { name: 'token_transfers', path: `addresses/${address}/token-transfers` },
        { name: 'logs', path: `addresses/${address}/logs` },
      ]);
    }
    case 'x_analyze_token': {
      const address = validateEvmAddress(input.address as string);
      return analyzeEntity(network, 'token', address, [
        { name: 'token', path: `tokens/${address}`, primary: true },
        { name: 'counters', path: `tokens/${address}/counters` },
        { name: 'holders', path: `tokens/${address}/holders` },
        { name: 'transfers', path: `tokens/${address}/transfers` },
        { name: 'instances', path: `tokens/${address}/instances` },
      ]);
    }
    default:
      throw new ValidationError(`Unknown Neo X analysis tool: ${name}`);
  }
}
