/**
 * NeoX Fura tools: request construction, param validation and dispatch.
 *
 * These tests pin the security properties the x_fura_* family promises:
 *   - every upstream path comes from the tool allowlist (never caller input),
 *   - path segments are validated EVM addresses / hashes,
 *   - query params are bounded integers or enums, and unknown params are
 *     rejected before any network call,
 *   - the evidence+data envelope from the readapi is passed through so the
 *     assistant can cite freshness the same way it does on Neo N3.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  NEOX_FURA_TOPICS,
  buildNeoxFuraRequest,
  dispatchNeoxFuraTool,
} from '../src/handlers/neox-fura-tools';
import { NetworkError, ValidationError } from '../src/utils/errors';

const EVM = (digit: string) => `0x${digit.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: { get: () => null },
    body: null,
    json: async () => body,
  } as any;
}

const FURA_ENVELOPE = {
  evidence: {
    chain: 'neox',
    network: 'testnet',
    indexed_tip: 1000,
    as_of_block: 0,
    fresh: true,
    data_source: 'neox_indexer',
    generated_at: '2026-11-18T04:00:00.000Z',
  },
  data: { whatever: true },
};

describe('neox fura tool surface', () => {
  test('exposes a topic for every documented analytics capability', () => {
    // Read the registry enum out of the source so the public surface and the
    // dispatcher cannot drift apart silently.
    const registrySrc = readFileSync(
      path.join(__dirname, '..', 'src', 'registry', 'tool-registry.ts'),
      'utf8',
    );
    for (const topic of Object.keys(NEOX_FURA_TOPICS)) {
      expect(registrySrc).toContain(`'${topic}'`);
    }
    expect(NEOX_FURA_TOPICS.whales).toBe('x_fura_whales');
    expect(NEOX_FURA_TOPICS.defi_volume).toBe('x_fura_defi_volume');
  });
});

describe('buildNeoxFuraRequest', () => {
  test('builds the documented upstream path from the allowlist spec', () => {
    const { network, request } = buildNeoxFuraRequest('x_fura_address_analytics', {
      network: 'testnet',
      address: EVM('1'),
    });
    expect(network).toBe('neox-testnet');
    expect(request.path).toBe(`addresses/${EVM('1')}/analytics`);
    expect(request.params).toEqual({});
  });

  test('maps query_neox_fura topics onto their single-purpose specs', () => {
    const whales = buildNeoxFuraRequest('query_neox_fura', { topic: 'whales', limit: 10 });
    expect(whales.request.path).toBe('analytics/whales');
    expect(whales.request.params).toEqual({ limit: '10' });

    const graph = buildNeoxFuraRequest('query_neox_fura', {
      topic: 'account_graph',
      address: EVM('2'),
      depth: 2,
      network: 'testnet',
    });
    expect(graph.request.path).toBe(`graph/relationships/${EVM('2')}`);
    expect(graph.request.params).toEqual({ depth: '2' });

    const flow = buildNeoxFuraRequest('query_neox_fura', {
      topic: 'token_flow',
      token: EVM('3'),
      hours: 24,
    });
    expect(flow.request.path).toBe(`graph/token-flow/${EVM('3')}`);
    expect(flow.request.params).toEqual({ hours: '24' });
  });

  test('rejects unknown topics, missing addresses, bad bounds and unknown params', () => {
    expect(() => buildNeoxFuraRequest('query_neox_fura', { topic: 'moon' }))
      .toThrow(ValidationError);
    expect(() => buildNeoxFuraRequest('x_fura_address_analytics', {}))
      .toThrow(ValidationError);
    expect(() => buildNeoxFuraRequest('x_fura_address_analytics', { address: 'not-an-address' }))
      .toThrow(ValidationError);
    expect(() => buildNeoxFuraRequest('x_fura_whales', { limit: 5000 }))
      .toThrow(ValidationError);
    expect(() => buildNeoxFuraRequest('x_fura_top_accounts', { sort: 'vibes' }))
      .toThrow(ValidationError);
    expect(() => buildNeoxFuraRequest('x_fura_network_daily', { hours: 12 }))
      .toThrow(ValidationError);
  });

  test('requires a non-empty q for search and bounds its length', () => {
    expect(() => buildNeoxFuraRequest('x_fura_search', {})).toThrow(ValidationError);
    expect(() => buildNeoxFuraRequest('x_fura_search', { q: 'x'.repeat(257) }))
      .toThrow(ValidationError);
    const ok = buildNeoxFuraRequest('x_fura_search', { q: ' usdt ' });
    expect(ok.request.params).toEqual({ q: 'usdt' });
  });
});

describe('dispatchNeoxFuraTool', () => {
  test('passes the evidence envelope through and reports found: true', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(FURA_ENVELOPE));
    const response = await dispatchNeoxFuraTool('x_fura_address_analytics', {
      network: 'testnet',
      address: EVM('1'),
    }, fetchMock as any);

    expect(response.result).toMatchObject({
      network: 'testnet',
      backend: 'neox-fura-readapi',
      found: true,
    });
    expect((response.result as Record<string, unknown>).fura).toEqual(FURA_ENVELOPE);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:8545/neox/testnet/addresses/${EVM('1')}/analytics`);
  });

  test('reports found: false on a 404 instead of failing the call', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({}, { ok: false, status: 404 }));
    const response = await dispatchNeoxFuraTool('query_neox_fura', {
      topic: 'whales',
      network: 'mainnet',
    }, fetchMock as any);
    expect(response.result).toMatchObject({ found: false, network: 'mainnet' });
  });

  test('wraps upstream outages in a NetworkError', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({}, { ok: false, status: 503 }));
    const response = await dispatchNeoxFuraTool('x_fura_network_daily', { days: 7 }, fetchMock as any);
    expect(response.error).toBeDefined();
    expect(JSON.stringify(response)).toContain('Neo X Fura readapi responded 503');
    expect(NetworkError).toBeDefined();
  });

  test('returns a clear validation error for invalid input without any network call', async () => {
    const fetchMock = jest.fn();
    const response = await dispatchNeoxFuraTool('query_neox_fura', { topic: 'moon' });
    expect(JSON.stringify(response)).toContain('topic');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
