import { dispatchAppIntentTool, clearAppIntentCatalogCache } from '../src/handlers/app-intent-tools';

const catalog = { apps: [{
  appId: 'demo', name: 'Demo', version: '1.0.0',
  supported_networks: ['neo-n3-testnet'], default_network: 'neo-n3-testnet',
  capabilities: [{ id: 'open', name: 'Open', mode: 'read' }, {
    id: 'pay', name: 'Pay', mode: 'write', required: ['recipient', 'amount'],
  }],
}] };

beforeEach(() => {
  clearAppIntentCatalogCache();
  (global.fetch as jest.Mock) = jest.fn(async (url: string) => new Response(JSON.stringify(
    String(url).includes('minigames.json') ? { apps: [] } : catalog,
  ), { status: 200 }));
});

test('lists apps and returns a deterministic non-executable open intent', async () => {
  const listed = await dispatchAppIntentTool('list_apps', { query: 'demo' });
  expect(listed).toMatchObject({ count: 1 });
  const first = await dispatchAppIntentTool('draft_app_intent', { appId: 'demo', action: 'open', network: 'neo-n3-testnet' });
  const second = await dispatchAppIntentTool('draft_app_intent', { appId: 'demo', action: 'open', network: 'neo-n3-testnet' });
  expect(first).toMatchObject({ status: 'draft', execution: 'open_app', canSign: false, canBroadcast: false, transaction: null });
  expect(first.intentId).toBe(second.intentId);
});

test('returns declarative skills only when they reference declared capabilities', async () => {
  clearAppIntentCatalogCache();
  const skill = { id: 'payment-flow', name: 'Payment flow', description: 'Prepare a reviewed payment.', capability_ids: ['pay'], audience: ['user', 'assistant'] };
  (global.fetch as jest.Mock)
    .mockImplementationOnce(async () => new Response(JSON.stringify({ apps: [{ ...catalog.apps[0], skills: [skill] }] }), { status: 200 }))
    .mockImplementationOnce(async () => new Response(JSON.stringify({ apps: [] }), { status: 200 }));
  const result = await dispatchAppIntentTool('get_app_capabilities', { appId: 'demo' });
  expect(result).toMatchObject({ skillSchemaVersion: 'neoos.skill-manifest/v1', skills: [skill], canSign: false, canBroadcast: false });
  clearAppIntentCatalogCache();
  (global.fetch as jest.Mock).mockResolvedValue(new Response(JSON.stringify({ apps: [{ ...catalog.apps[0], skills: [{ ...skill, capability_ids: ['missing'] }] }] })));
  await expect(dispatchAppIntentTool('get_app_capabilities', { appId: 'demo' })).rejects.toThrow('invalid_skills');
});

test('lists skills through the same trusted catalog and never exposes execution authority', async () => {
  clearAppIntentCatalogCache();
  const skill = { id: 'payment-flow', name: 'Payment flow', description: 'Prepare a reviewed payment.', capability_ids: ['pay'], keywords: ['send'] };
  (global.fetch as jest.Mock).mockResolvedValue(new Response(JSON.stringify({ apps: [{ ...catalog.apps[0], skills: [skill] }] })));
  const result = await dispatchAppIntentTool('list_skills', { appId: 'demo', query: 'send' });
  expect(result).toMatchObject({ skillSchemaVersion: 'neoos.skill-manifest/v1', count: 1, readOnly: true, canSign: false, canBroadcast: false });
  expect((result.skills as Array<{ skill: typeof skill }>)[0].skill).toEqual(skill);
});

test('requires declared write action parameters and wallet metadata', async () => {
  const draft = await dispatchAppIntentTool('draft_app_intent', { appId: 'demo', action: 'pay', network: 'neo-n3-testnet', params: {} });
  expect(draft).toMatchObject({ status: 'needs_clarification', requiresUserSignature: true });
  expect((draft.validation as { missing: string[] }).missing).toEqual(expect.arrayContaining(['recipient', 'amount']));
  await expect(dispatchAppIntentTool('draft_app_intent', { appId: 'demo', action: 'unknown', network: 'neo-n3-testnet' })).rejects.toThrow('action_not_declared');
});

test('refuses catalog redirects before leaving the trusted host', async () => {
  (global.fetch as jest.Mock).mockImplementation(async (_url, options) => {
    expect(options.redirect).toBe('error');
    throw new TypeError('fetch failed');
  });
  await expect(dispatchAppIntentTool('list_apps', {})).rejects.toThrow('fetch failed');
});

test('rejects an oversized catalog before parsing it', async () => {
  const response = new Response('untrusted body', {
    headers: { 'content-length': String(4 * 1024 * 1024 + 1) },
  });
  (global.fetch as jest.Mock).mockResolvedValue(response);
  await expect(dispatchAppIntentTool('list_apps', {})).rejects.toThrow('response exceeds');
  expect(response.bodyUsed).toBe(true);
});

test('rejects a malformed catalog instead of reporting an empty app fleet', async () => {
  (global.fetch as jest.Mock).mockResolvedValue(new Response(JSON.stringify({ error: 'unavailable' })));
  await expect(dispatchAppIntentTool('list_apps', {})).rejects.toThrow('catalog_invalid_apps');
});

const paymentSchema = {
  type: 'object', additionalProperties: false, required: ['recipient', 'amount', 'route'],
  properties: {
    recipient: { type: 'string', pattern: '^N[a-zA-Z0-9]{4}$' },
    amount: { type: 'integer', minimum: 1, maximum: 100 },
    route: { type: 'object', additionalProperties: false, required: ['token'], properties: { token: { type: 'string', enum: ['GAS', 'NEO'] } } },
  },
};
const validPayment = { recipient: 'Nabcd', amount: 2, route: { token: 'GAS' } };

function mockCapability(capability: Record<string, unknown>, appOverrides: Record<string, unknown> = {}) {
  (global.fetch as jest.Mock).mockResolvedValue(new Response(JSON.stringify({ apps: [{
    ...catalog.apps[0], ...appOverrides, capabilities: [{ id: 'pay', mode: 'write', ...capability }],
  }] })));
}
function draft(params: unknown = validPayment, extra: Record<string, unknown> = {}) {
  return dispatchAppIntentTool('draft_app_intent', { appId: 'demo', action: 'pay', walletAddress: 'public-wallet-hint', params, ...extra });
}

test.each([
  {},
  { ...validPayment, amount: '2' },
  { ...validPayment, amount: 0 },
  { ...validPayment, amount: 101 },
  { ...validPayment, amount: 1.5 },
  { ...validPayment, recipient: 'wrong' },
  { ...validPayment, extra: true },
  { ...validPayment, route: {} },
  { ...validPayment, route: { token: 'FAKE' } },
  { ...validPayment, route: { token: 'GAS', extra: true } },
])('rejects schema-invalid payment %#', async (params) => {
  mockCapability({ input_schema: paymentSchema });
  expect(await draft(params)).toMatchObject({ validation: { valid: false }, status: 'needs_clarification', transaction: null });
});

test('accepts schema-valid parameters without modifying them or enabling execution', async () => {
  mockCapability({ input_schema: paymentSchema });
  expect(await draft()).toMatchObject({ validation: { valid: true }, params: validPayment, canSign: false, canBroadcast: false, requiresUserReview: true, transaction: null });
});

test.each([
  null,
  { type: 'object', properties: { amount: { type: 'made-up-type' } } },
  { type: 'object', unsupportedConstraint: true },
  { type: 'object', properties: { amount: { type: 'string', format: 'unknown-format' } } },
  { $ref: 'https://untrusted.example/schema.json' },
  { $schema: 'https://untrusted.example/dialect', type: 'object' },
])('fails closed for invalid or unsupported schema %#', async (input_schema) => {
  mockCapability({ input_schema });
  await expect(draft()).rejects.toThrow(/intent_schema_must_be_closed/);
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test.each([undefined, 'http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2019-09/schema', 'https://json-schema.org/draft/2020-12/schema'])('supports declared dialect %s', async ($schema) => {
  mockCapability({ input_schema: { ...paymentSchema, $schema } });
  expect(await draft()).toMatchObject({ validation: { valid: true } });
});

test('does not fill defaults to satisfy required parameters', async () => {
  mockCapability({ input_schema: { type: 'object', additionalProperties: false, required: ['amount'], properties: { amount: { type: 'integer', default: 1 } } } });
  expect(await draft({})).toMatchObject({ params: {}, validation: { valid: false, missing: ['amount'] } });
});

test.each([null, [], 'amount=2', { amount: NaN }, { amount: Infinity }, { amount: undefined }, { amount: BigInt(2) }, { amount: 'x'.repeat(16385) }])('rejects malformed or oversized parameter payload %# before fetching', async (params) => {
  await expect(draft(params)).rejects.toThrow('bounded JSON object');
  expect(global.fetch).not.toHaveBeenCalled();
});

test('rejects cyclic and overly nested parameters', async () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await expect(draft(cyclic)).rejects.toThrow('bounded JSON object');
  let nested: Record<string, unknown> = {};
  for (let i = 0; i < 18; i++) nested = { nested };
  await expect(draft(nested)).rejects.toThrow('bounded JSON object');
});

test('snapshots nested parameters before asynchronous catalog loading', async () => {
  mockCapability({ input_schema: paymentSchema });
  const params = { ...validPayment, route: { ...validPayment.route } };
  const pending = draft(params);
  params.amount = 999;
  params.route.token = 'FAKE';
  expect(await pending).toMatchObject({ params: validPayment, validation: { valid: true } });
});

test('fingerprint ignores object property insertion order', async () => {
  mockCapability({ input_schema: paymentSchema });
  const first = await draft();
  const second = await draft({ route: { token: 'GAS' }, amount: 2, recipient: 'Nabcd' });
  expect(first.intentId).toBe(second.intentId);
});

test('capability cannot expand application networks', async () => {
  mockCapability({ networks: ['neo-n3-mainnet'] });
  await expect(draft(validPayment, { network: 'neo-n3-mainnet' })).rejects.toThrow('network_not_supported');
});

test('rejects an application default outside the capability intersection', async () => {
  mockCapability({ networks: ['neo-n3-testnet'] }, { default_network: 'neo-n3-mainnet', supported_networks: ['neo-n3-mainnet', 'neo-n3-testnet'] });
  await expect(draft()).rejects.toThrow('network_not_supported');
  expect(await draft(validPayment, { network: 'neo-n3-testnet' })).toMatchObject({ network: 'neo-n3-testnet' });
});

test('rejects unsupported tool names before reading the catalog', async () => {
  await expect(dispatchAppIntentTool('sign_app_intent', {})).rejects.toThrow('unknown_app_intent_tool');
  expect(global.fetch).not.toHaveBeenCalled();
});

test('reports disabled transactions and refuses a schema-valid write draft', async () => {
  mockCapability({ input_schema: paymentSchema }, { platform: { transactions: false } });
  const capabilities = await dispatchAppIntentTool('get_app_capabilities', { appId: 'demo' });
  expect(capabilities).toMatchObject({ transactionsEnabled: false, canSign: false, canBroadcast: false });
  expect(await draft()).toMatchObject({ status: 'needs_clarification', validation: { valid: false, errors: expect.arrayContaining([expect.objectContaining({ code: 'transactions_disabled' })]) }, transaction: null });
});

test('keeps read-only quote drafts available when transactions are disabled', async () => {
  mockCapability({ input_schema: paymentSchema, mode: 'read' }, { platform: { transactions: false } });
  expect(await draft()).toMatchObject({ validation: { valid: true }, requiresUserSignature: false, canSign: false, canBroadcast: false });
});

test.each([['n3', 'neo-x-mainnet'], ['neox', 'neo-n3-mainnet']])('rejects %s capability on %s even if the app supports it', async (chain, network) => {
  mockCapability({ chain }, { supported_networks: [network], default_network: network });
  await expect(draft()).rejects.toThrow('network_not_supported');
});

test('accepts a matching chain and refuses an unknown chain declaration', async () => {
  mockCapability({ chain: 'n3' });
  expect(await draft()).toMatchObject({ validation: { valid: true } });
  clearAppIntentCatalogCache();
  mockCapability({ chain: 'unknown' });
  await expect(draft()).rejects.toThrow('invalid_capability_chain');
});

test('write drafts ask for in-app confirmation while reads stay reviewable', async () => {
  const write = await draft();
  expect(write).toMatchObject({ execution: 'requires_user_confirmation', requiresUserSignature: true,
    canSign: false, canBroadcast: false, transaction: null });

  // The handler caches the catalog, so clear it before switching the capability mode.
  clearAppIntentCatalogCache();
  mockCapability({ input_schema: paymentSchema, mode: 'read' }, { platform: { transactions: true } });
  const read = await draft();
  expect(read).toMatchObject({ execution: 'requires_app_review', requiresUserSignature: false,
    canSign: false, canBroadcast: false, transaction: null });
});

test('discovers a published game from the game catalog and derives only safe reads', async () => {
  clearAppIntentCatalogCache();
  const game = {
    app_id: 'minigame-demo', kind: 'minigames', slug: 'demo', version: '1.0.0',
    supported_networks: ['neo-n3-mainnet'], release_sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    entry_url: 'https://cdn.neoos.network/minigames/demo/1.0.0/0123456789abcdef/index.html',
    manifest_url: 'https://cdn.neoos.network/minigames/demo/1.0.0/0123456789abcdef/neo-manifest.json',
  };
  (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
    if (url.includes('minigames.json')) return new Response(JSON.stringify({ kind: 'minigames', apps: [game] }));
    if (url.includes('neo-manifest.json')) return new Response(JSON.stringify({ id: 'minigame-demo', version: '1.0.0', permissions: ['payments'] }));
    return new Response(JSON.stringify({ kind: 'miniapps', apps: [] }));
  });
  const capabilities = await dispatchAppIntentTool('get_app_capabilities', { appId: 'minigame-demo' });
  expect(capabilities).toMatchObject({ kind: 'minigames', capabilitySource: 'derived-safe-default', canSign: false, canBroadcast: false });
  expect((capabilities.capabilities as Array<Record<string, unknown>>).every((cap) => cap.mode === 'read')).toBe(true);
  expect(await dispatchAppIntentTool('draft_app_intent', { appId: 'minigame-demo', action: 'open_app', network: 'neo-n3-mainnet' })).toMatchObject({ execution: 'open_app', requiresUserSignature: false, canBroadcast: false });
});

test('rejects a game manifest whose identity differs from the catalog', async () => {
  clearAppIntentCatalogCache();
  const game = { app_id: 'minigame-demo', kind: 'minigames', slug: 'demo', version: '1.0.0', supported_networks: ['neo-n3-mainnet'], entry_url: 'https://cdn.neoos.network/minigames/demo/1.0.0/0123456789abcdef/index.html', manifest_url: 'https://cdn.neoos.network/minigames/demo/1.0.0/0123456789abcdef/neo-manifest.json' };
  (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
    if (url.includes('minigames.json')) return new Response(JSON.stringify({ kind: 'minigames', apps: [game] }));
    if (url.includes('neo-manifest.json')) return new Response(JSON.stringify({ id: 'minigame-other', version: '1.0.0' }));
    return new Response(JSON.stringify({ kind: 'miniapps', apps: [] }));
  });
  await expect(dispatchAppIntentTool('get_app_capabilities', { appId: 'minigame-demo' })).rejects.toThrow('manifest_app_id_mismatch');
});

test('rejects a published manifest whose capabilities differ from the catalog declaration', async () => {
  clearAppIntentCatalogCache();
  const game = {
    app_id: 'minigame-demo', kind: 'minigames', slug: 'demo', version: '1.0.0',
    supported_networks: ['neo-n3-mainnet'], release_sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    entry_url: 'https://cdn.neoos.network/minigames/demo/1.0.0/0123456789abcdef/index.html',
    manifest_url: 'https://cdn.neoos.network/minigames/demo/1.0.0/0123456789abcdef/neo-manifest.json',
    intent_capabilities: [{ id: 'open_app', name: 'Open', mode: 'read', chain: 'n3', input_schema: { type: 'object', additionalProperties: false } }],
  };
  (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
    if (url.includes('minigames.json')) return new Response(JSON.stringify({ kind: 'minigames', apps: [game] }));
    if (url.includes('neo-manifest.json')) return new Response(JSON.stringify({
      id: 'minigame-demo', version: '1.0.0', intent_capabilities: [{ id: 'withdraw', name: 'Withdraw', mode: 'write', chain: 'n3', input_schema: { type: 'object', additionalProperties: false } }],
    }));
    return new Response(JSON.stringify({ kind: 'miniapps', apps: [] }));
  });
  await expect(dispatchAppIntentTool('get_app_capabilities', { appId: 'minigame-demo' })).rejects.toThrow('manifest_capabilities_mismatch');
});

test('normalizes legacy nullable capability metadata without weakening the closed schema', async () => {
  clearAppIntentCatalogCache();
  const capability = { id: 'quote', name: 'Quote', mode: 'read', chain: 'n3', contract: null, input_schema: { type: 'object', additionalProperties: false } };
  const game = {
    app_id: 'minigame-legacy', kind: 'minigames', slug: 'legacy', version: '1.0.0', supported_networks: ['neo-n3-mainnet'],
    release_sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    entry_url: 'https://cdn.neoos.network/minigames/legacy/1.0.0/0123456789abcdef/index.html',
    manifest_url: 'https://cdn.neoos.network/minigames/legacy/1.0.0/0123456789abcdef/neo-manifest.json',
    capabilities: [capability],
  };
  (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
    if (url.includes('minigames.json')) return new Response(JSON.stringify({ kind: 'minigames', apps: [game] }));
    if (url.includes('neo-manifest.json')) return new Response(JSON.stringify({ id: 'minigame-legacy', version: '1.0.0', capabilities: [capability] }));
    return new Response(JSON.stringify({ kind: 'miniapps', apps: [] }));
  });
  await expect(dispatchAppIntentTool('get_app_capabilities', { appId: 'minigame-legacy' })).resolves.toMatchObject({ capabilitySource: 'declared', capabilities: [{ id: 'quote', mode: 'read' }] });
});

test('does not reuse a manifest cached for a different application', async () => {
  clearAppIntentCatalogCache();
  const release = '0123456789abcdef';
  const app = (appId: string, slug: string) => ({
    app_id: appId, kind: 'minigames', slug, version: '1.0.0', supported_networks: ['neo-n3-mainnet'],
    release_sha256: `${release}${'0'.repeat(48)}`,
    entry_url: `https://cdn.neoos.network/minigames/${slug}/1.0.0/${release}/index.html`,
    manifest_url: `https://cdn.neoos.network/minigames/${slug}/1.0.0/${release}/neo-manifest.json`,
  });
  (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
    if (url.includes('minigames.json')) return new Response(JSON.stringify({ kind: 'minigames', apps: [app('minigame-one', 'one'), app('minigame-two', 'two')] }));
    if (url.includes('neo-manifest.json')) return new Response(JSON.stringify({ id: 'minigame-one', version: '1.0.0' }));
    return new Response(JSON.stringify({ kind: 'miniapps', apps: [] }));
  });
  await expect(dispatchAppIntentTool('get_app_capabilities', { appId: 'minigame-one' })).resolves.toMatchObject({ appId: 'minigame-one' });
  await expect(dispatchAppIntentTool('get_app_capabilities', { appId: 'minigame-two' })).rejects.toThrow('manifest_app_id_mismatch');
});
