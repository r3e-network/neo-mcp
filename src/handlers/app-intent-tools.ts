import { createHash } from 'node:crypto';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { readBoundedJson } from '../utils/bounded-json';
import { canonicalIntentJson, snapshotIntentParams, validateIntentParams } from './app-intent-validation';

type AppRecord = Record<string, unknown>;
type CatalogKind = 'miniapps' | 'minigames';
type CatalogDocument = { kind: CatalogKind; url: string; digest: string; revision: string; apps: AppRecord[] };

const NETWORKS = new Set(['neo-n3-mainnet', 'neo-n3-testnet', 'neo-x-mainnet', 'neo-x-testnet']);
const APP_ID = /^[a-z0-9][a-z0-9._-]{0,199}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ACTION = /^[a-z][a-z0-9._:-]{0,95}$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_CAPABILITIES = 64;
const MAX_CAPABILITY_BYTES = 64 * 1024;
const CAPABILITY_KEYS = new Set([
  'id', 'action', 'name', 'label', 'description', 'mode', 'chain', 'networks',
  'input_schema', 'keywords', 'contract', 'method', 'requiresUserSignature',
  'required', 'requiredParams', 'risk',
]);
const CATALOG_URLS: Readonly<Record<CatalogKind, string>> = Object.freeze({
  miniapps: process.env.NEOOS_APP_CATALOG_URL || 'https://cdn.neoos.network/catalog/miniapps.json',
  minigames: process.env.NEOOS_GAME_CATALOG_URL || 'https://cdn.neoos.network/catalog/minigames.json',
});
const TRUSTED_HOSTS = new Set(['cdn.neoos.network', 'neoos.network', 'localhost', '127.0.0.1', '::1']);
const RELEASE_HOSTS = new Set(['cdn.neoos.network', 'neoos.network', 'localhost', '127.0.0.1', '::1']);
const SAFE_DEFAULT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: false });

let cachedCatalogs = new Map<CatalogKind, { document: CatalogDocument; expiresAt: number }>();
let manifestCache = new Map<string, { manifest: AppRecord; expiresAt: number }>();

function obj(value: unknown): AppRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as AppRecord : {}; }
function str(value: unknown, max = 512): string { return String(value ?? '').trim().slice(0, max); }
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function fail(code: string): never { throw new ProtocolError(ProtocolErrorCode.InvalidParams, code); }
function canonicalHash(value: unknown): string { return createHash('sha256').update(canonicalIntentJson(value)).digest('hex'); }

function assertCatalogUrl(raw: string): URL {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return fail('app_catalog_url_invalid'); }
  if (!TRUSTED_HOSTS.has(parsed.hostname)
    || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)))) return fail('app_catalog_url_not_trusted');
  if (parsed.username || parsed.password || parsed.hash) return fail('app_catalog_url_invalid');
  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) && parsed.port) return fail('app_catalog_url_invalid');
  return parsed;
}

function assertReleaseUrl(raw: unknown, kind: CatalogKind, suffix: 'entry' | 'manifest'): string {
  const value = str(raw, 2048);
  if (!value) return '';
  let parsed: URL;
  try { parsed = new URL(value); } catch { return fail('release_url_invalid'); }
  if (!RELEASE_HOSTS.has(parsed.hostname) || parsed.protocol !== 'https:' || parsed.search || parsed.hash) return fail('release_url_not_trusted');
  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) && parsed.port) return fail('release_url_not_trusted');
  const expected = suffix === 'manifest' ? 'neo-manifest.json' : 'index.html';
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts[0] !== kind || parts[parts.length - 1] !== expected) return fail('release_url_not_canonical');
  const release = parts.slice(1, -1);
  const dated = release.length === 4 && /^20\d{6}$/.test(release[0]);
  if ((release.length !== 3 && !dated) || !SLUG.test(dated ? release[1] : release[0])) return fail('release_url_not_canonical');
  const digest = dated ? release[3] : release[2];
  if (!SHA256.test(digest) && !/^[a-f0-9]{16}$/i.test(digest)) return fail('release_url_not_content_addressed');
  return parsed.toString();
}

function releaseSegments(raw: string): { slug: string; version: string; digest: string } | null {
  const parts = new URL(raw).pathname.split('/').filter(Boolean).slice(1, -1);
  const dated = parts.length === 4 && /^20\d{6}$/.test(parts[0]);
  if (parts.length !== 3 && !dated) return null;
  return dated ? { slug: parts[1], version: parts[2], digest: parts[3] } : { slug: parts[0], version: parts[1], digest: parts[2] };
}

function validateCatalogRow(raw: unknown, kind: CatalogKind): AppRecord {
  const row = obj(raw);
  const rawAppId = String(row.appId ?? row.app_id ?? row.id ?? '').trim();
  if (rawAppId.length > 200) return fail('catalog_app_id_invalid');
  const appId = rawAppId;
  if (!APP_ID.test(appId)) return fail('catalog_app_id_invalid');
  const rowKind = str(row.kind, 32).toLowerCase();
  if (rowKind && rowKind !== kind) return fail('catalog_kind_mismatch');
  const status = str(row.status, 32).toLowerCase() || 'active';
  if (status === 'disabled') return { ...row, __appId: appId, __kind: kind, __disabled: true };
  if (status !== 'active') return fail('catalog_status_invalid');
  const version = str(row.version, 80);
  if (version && !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(version)) return fail('catalog_version_invalid');
  if (row.release_sha256 !== undefined && !SHA256.test(str(row.release_sha256, 80))) return fail('catalog_release_digest_invalid');
  if (row.supported_networks !== undefined && (!Array.isArray(row.supported_networks) || row.supported_networks.some((network) => typeof network !== 'string' || !NETWORKS.has(network)))) return fail('catalog_networks_invalid');
  const manifestUrl = assertReleaseUrl(row.manifest_url, kind, 'manifest');
  const entryUrl = assertReleaseUrl(row.entry_url, kind, 'entry');
  if (manifestUrl && entryUrl) {
    const manifestPath = new URL(manifestUrl).pathname.split('/').filter(Boolean).slice(0, -1).join('/');
    const entryPath = new URL(entryUrl).pathname.split('/').filter(Boolean).slice(0, -1).join('/');
    if (manifestPath !== entryPath) return fail('catalog_release_binding_mismatch');
  }
  for (const releaseUrl of [manifestUrl, entryUrl]) {
    if (!releaseUrl) continue;
    const release = releaseSegments(releaseUrl);
    const rowSlug = str(row.slug, 120);
    if (!release || (rowSlug && rowSlug !== release.slug) || (version && version !== release.version)
      || (row.release_sha256 && !str(row.release_sha256, 80).toLowerCase().startsWith(release.digest.toLowerCase()))) return fail('catalog_release_identity_mismatch');
  }
  return { ...row, __appId: appId, __kind: kind, __disabled: false, __manifestUrl: manifestUrl, __entryUrl: entryUrl };
}

async function loadCatalog(kind: CatalogKind): Promise<CatalogDocument> {
  const existing = cachedCatalogs.get(kind);
  if (existing && existing.expiresAt > Date.now()) return existing.document;
  const url = CATALOG_URLS[kind];
  assertCatalogUrl(url);
  const response = await fetch(url, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error(`catalog_${response.status}`);
  const payload = obj(await readBoundedJson<unknown>(response, MAX_CATALOG_BYTES, `${kind} catalog`));
  if (!Array.isArray(payload.apps)) throw new Error('catalog_invalid_apps');
  if (payload.kind !== undefined && str(payload.kind, 32) !== kind) throw new Error('catalog_kind_mismatch');
  if (payload.apps.length > 2000) throw new Error('catalog_too_large');
  if (payload.count !== undefined && (!Number.isInteger(payload.count) || payload.count !== payload.apps.length)) throw new Error('catalog_count_mismatch');
  const apps = payload.apps.map((row) => validateCatalogRow(row, kind)).filter((row) => !row.__disabled);
  const seen = new Set<string>();
  for (const app of apps) { const id = String(app.__appId); if (seen.has(id)) throw new Error('catalog_duplicate_app_id'); seen.add(id); }
  const document: CatalogDocument = { kind, url, digest: canonicalHash(payload), revision: str(payload.delivery_revision ?? payload.revision, 160) || canonicalHash(payload), apps };
  cachedCatalogs.set(kind, { document, expiresAt: Date.now() + 60_000 });
  return document;
}

async function loadApps(includeGames: boolean): Promise<{ apps: AppRecord[]; catalogs: CatalogDocument[] }> {
  const miniapps = await loadCatalog('miniapps');
  const catalogs = includeGames ? [miniapps, await loadCatalog('minigames')] : [miniapps];
  const byId = new Map<string, AppRecord>();
  for (const catalog of catalogs) for (const app of catalog.apps) { const id = String(app.__appId); if (byId.has(id)) throw new Error('catalog_duplicate_app_id'); byId.set(id, app); }
  return { apps: [...byId.values()], catalogs };
}

async function findApp(appId: string): Promise<{ app: AppRecord; catalogs: CatalogDocument[] }> {
  const first = await loadApps(false);
  const found = first.apps.find((candidate) => candidate.__appId === appId);
  if (found) return { app: found, catalogs: first.catalogs };
  const all = await loadApps(true);
  const app = all.apps.find((candidate) => candidate.__appId === appId);
  if (!app) fail('app_not_found');
  return { app, catalogs: all.catalogs };
}

function appIdOf(app: AppRecord): string { return str(app.__appId ?? app.appId ?? app.app_id ?? app.id, 200); }
function appKindOf(app: AppRecord): CatalogKind { return app.__kind === 'minigames' ? 'minigames' : 'miniapps'; }
function appNetworksOf(app: AppRecord): string[] { return list(app.supported_networks ?? app.supportedNetworks).filter((x): x is string => typeof x === 'string' && NETWORKS.has(x)); }

function safeDefaults(app: AppRecord): AppRecord[] {
  const chain = derivedChain(app);
  return [
    { id: 'open_app', name: 'Open app', description: 'Open the published runtime.', mode: 'read', chain, input_schema: SAFE_DEFAULT_SCHEMA, keywords: ['open', 'launch', 'play'] },
    { id: 'inspect_release', name: 'Inspect release', description: 'Inspect the published release metadata.', mode: 'read', chain, input_schema: SAFE_DEFAULT_SCHEMA, keywords: ['version', 'release', 'metadata'] },
  ];
}

function derivedChain(app: AppRecord): string {
  const networks = appNetworksOf(app);
  const hasN3 = networks.some((network) => network.startsWith('neo-n3-'));
  const hasX = networks.some((network) => network.startsWith('neo-x-'));
  return hasN3 && hasX ? 'both' : hasX ? 'neox' : 'n3';
}

function normalizeCapabilities(raw: unknown, app: AppRecord): { capabilities: AppRecord[]; source: string } {
  if (raw === undefined || raw === null) return { capabilities: safeDefaults(app), source: 'derived-safe-default' };
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_CAPABILITIES) return fail('invalid_intent_capabilities');
  const ids = new Set<string>();
  const capabilities = raw.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('invalid_intent_capabilities');
    const cap = { ...(value as AppRecord) };
    // Older published catalogs used nullable optional metadata fields. They
    // carry no capability semantics, so normalize them away before comparing
    // the catalog declaration with the immutable release manifest.
    for (const key of ['label', 'contract', 'method', 'requiresUserSignature', 'required', 'requiredParams', 'risk']) {
      if (cap[key] === null) delete cap[key];
    }
    if (Object.keys(cap).some((key) => !CAPABILITY_KEYS.has(key))) return fail('invalid_intent_capabilities');
    const rawId = cap.id ?? cap.action;
    const rawMode = cap.mode;
    const rawChain = cap.chain;
    if (typeof rawId !== 'string' || typeof rawMode !== 'string' || (rawChain !== undefined && typeof rawChain !== 'string')) return fail('invalid_intent_capabilities');
    const id = rawId.trim(); const mode = rawMode.trim().toLowerCase(); const declaredChain = (rawChain || '').trim().toLowerCase();
    if (id.length > 96 || mode.length > 16 || declaredChain.length > 16) return fail('invalid_intent_capabilities');
    if (declaredChain && !['n3', 'neox', 'both'].includes(declaredChain)) return fail('invalid_capability_chain');
    const chain = declaredChain || derivedChain(app);
    if (!ACTION.test(id) || ids.has(id) || !['read', 'write'].includes(mode) || !['n3', 'neox', 'both'].includes(chain)) return fail('invalid_intent_capabilities');
    ids.add(id);
    if (cap.name !== undefined && (typeof cap.name !== 'string' || cap.name.trim().length === 0 || cap.name.length > 120)) return fail('invalid_intent_capabilities');
    if (cap.label !== undefined && (typeof cap.label !== 'string' || cap.label.length > 120)) return fail('invalid_intent_capabilities');
    if (cap.description !== undefined && (typeof cap.description !== 'string' || cap.description.length > 600)) return fail('invalid_intent_capabilities');
    if (cap.input_schema !== undefined && (obj(cap.input_schema).type !== 'object' || obj(cap.input_schema).additionalProperties !== false)) return fail('intent_schema_must_be_closed');
    if (cap.networks !== undefined && (!Array.isArray(cap.networks) || cap.networks.length === 0 || cap.networks.length > 4 || cap.networks.some((network) => typeof network !== 'string' || !NETWORKS.has(network)))) return fail('invalid_intent_capabilities');
    if (cap.keywords !== undefined && (!Array.isArray(cap.keywords) || cap.keywords.length > 24 || cap.keywords.some((keyword) => typeof keyword !== 'string' || keyword.length > 80))) return fail('invalid_intent_capabilities');
    for (const key of ['required', 'requiredParams']) {
      if (cap[key] !== undefined && (!Array.isArray(cap[key]) || cap[key].length > 32 || cap[key].some((item) => typeof item !== 'string' || item.length > 80))) return fail('invalid_intent_capabilities');
    }
    for (const key of ['contract', 'method']) {
      if (cap[key] !== undefined && (typeof cap[key] !== 'string' || cap[key].length > 100)) return fail('invalid_intent_capabilities');
    }
    if (cap.requiresUserSignature !== undefined && typeof cap.requiresUserSignature !== 'boolean') return fail('invalid_intent_capabilities');
    if (cap.risk !== undefined && (typeof cap.risk !== 'string' || !['low', 'medium', 'high'].includes(cap.risk))) return fail('invalid_intent_capabilities');
    return { ...cap, id, mode, chain };
  });
  const serialized = JSON.stringify(capabilities);
  if (Buffer.byteLength(serialized) > MAX_CAPABILITY_BYTES) return fail('intent_capabilities_too_large');
  return { capabilities: JSON.parse(serialized) as AppRecord[], source: 'declared' };
}

// Skills are signed, declarative scenario bundles. They may only group
// capabilities already present in the same release; they never add tools,
// permissions, signing authority, or executable code.
function normalizeSkills(raw: unknown, capabilities: AppRecord[]): AppRecord[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 32) return fail('invalid_skills');
  const capabilityIds = new Set(capabilities.map((cap) => str(cap.id, 96)));
  const ids = new Set<string>();
  const keys = new Set(['id', 'name', 'description', 'version', 'capability_ids', 'keywords', 'audience']);
  return raw.map((value) => {
    const skill = obj(value); const id = str(skill.id, 64); const name = str(skill.name, 120); const description = str(skill.description, 600);
    if (!Array.isArray(skill.capability_ids) || skill.capability_ids.some((item) => typeof item !== 'string' || !/^[a-z][a-z0-9._:-]{0,95}$/.test(item))) return fail('invalid_skills');
    const refs = skill.capability_ids as string[];
    if (Object.keys(skill).some((key) => !keys.has(key)) || typeof skill.id !== 'string' || skill.id.length > 64 || typeof skill.name !== 'string' || skill.name.length > 120 || typeof skill.description !== 'string' || skill.description.length > 600 || !/^[a-z][a-z0-9._:-]{0,63}$/.test(id) || ids.has(id) || !name || !description || refs.length < 1 || refs.length > 32 || new Set(refs).size !== refs.length || refs.some((ref) => !ACTION.test(ref) || !capabilityIds.has(ref))) return fail('invalid_skills');
    if (skill.version !== undefined && (typeof skill.version !== 'string' || skill.version.length > 32 || !/^\d+\.\d+\.\d+$/.test(skill.version))) return fail('invalid_skills');
    if (skill.keywords !== undefined && (!Array.isArray(skill.keywords) || skill.keywords.length > 24 || skill.keywords.some((x) => typeof x !== 'string' || x.length > 80))) return fail('invalid_skills');
    if (skill.audience !== undefined && (!Array.isArray(skill.audience) || skill.audience.length > 8 || skill.audience.some((x) => !['user', 'assistant', 'developer'].includes(x)))) return fail('invalid_skills');
    ids.add(id);
    return { id, name, description, capability_ids: refs,
      ...(skill.version !== undefined ? { version: str(skill.version, 32) } : {}),
      ...(skill.keywords !== undefined ? { keywords: list(skill.keywords).map((x) => str(x, 80)).slice(0, 24) } : {}),
      ...(skill.audience !== undefined ? { audience: list(skill.audience).map((x) => str(x, 32)).slice(0, 8) } : {}),
    };
  });
}

async function manifestFor(app: AppRecord): Promise<AppRecord | null> {
  const url = str(app.__manifestUrl, 2048);
  if (!url) return null;
  const appId = appIdOf(app);
  const version = str(app.version, 80);
  const releaseSha256 = str(app.release_sha256, 80).toLowerCase();
  const release = releaseSegments(url);
  if (!release || release.slug !== str(app.slug, 120) || (version && release.version !== version)
    || (releaseSha256 && !(releaseSha256 === release.digest.toLowerCase() || releaseSha256.startsWith(release.digest.toLowerCase())))) {
    throw new Error('manifest_release_binding_mismatch');
  }
  const cacheKey = `${appId}|${version}|${releaseSha256}|${url}`;
  const previous = manifestCache.get(cacheKey);
  if (previous && previous.expiresAt > Date.now()) return previous.manifest;
  const response = await fetch(url, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error(`manifest_${response.status}`);
  const manifest = obj(await readBoundedJson<unknown>(response, MAX_MANIFEST_BYTES, 'App manifest'));
  const manifestId = str(manifest.id ?? manifest.app_id ?? manifest.appId, 200);
  if (!manifestId) throw new Error('manifest_app_id_missing');
  if (manifestId !== appId) throw new Error('manifest_app_id_mismatch');
  const manifestVersion = str(manifest.version, 80);
  if (!manifestVersion) throw new Error('manifest_version_missing');
  if (version && manifestVersion !== version) throw new Error('manifest_version_mismatch');
  const manifestReleaseSha256 = str(manifest.release_sha256, 80).toLowerCase();
  if (manifestReleaseSha256 && (!SHA256.test(manifestReleaseSha256) || (releaseSha256 && manifestReleaseSha256 !== releaseSha256))) {
    throw new Error('manifest_release_digest_mismatch');
  }
  manifestCache.set(cacheKey, { manifest, expiresAt: Date.now() + 60_000 });
  return manifest;
}

async function capabilitiesOf(app: AppRecord): Promise<{ capabilities: AppRecord[]; skills: AppRecord[]; source: string }> {
  const catalogRaw = app.intent_capabilities ?? app.intentCapabilities ?? app.capabilities;
  const manifest = await manifestFor(app);
  const manifestRaw = manifest?.intent_capabilities ?? manifest?.intentCapabilities ?? manifest?.capabilities;
  const catalogSkills = normalizeSkills(app.skills, catalogRaw === undefined ? safeDefaults(app) : normalizeCapabilities(catalogRaw, app).capabilities);
  const manifestSkills = normalizeSkills(manifest?.skills, manifestRaw === undefined ? safeDefaults(app) : normalizeCapabilities(manifestRaw, app).capabilities);
  if (catalogRaw !== undefined && manifestRaw !== undefined) {
    const catalogResult = normalizeCapabilities(catalogRaw, app);
    const manifestResult = normalizeCapabilities(manifestRaw, app);
    if (canonicalIntentJson(catalogResult.capabilities) !== canonicalIntentJson(manifestResult.capabilities)) {
      throw new Error('manifest_capabilities_mismatch');
    }
    if (canonicalIntentJson(catalogSkills) !== canonicalIntentJson(manifestSkills)) throw new Error('manifest_skills_mismatch');
    return { ...manifestResult, skills: manifestSkills, source: 'declared' };
  }
  if (manifestRaw !== undefined) return { ...normalizeCapabilities(manifestRaw, app), skills: manifestSkills };
  if (catalogRaw !== undefined) return { ...normalizeCapabilities(catalogRaw, app), skills: catalogSkills };
  return { ...normalizeCapabilities(undefined, app), skills: [] };
}

function catalogMetaFor(app: AppRecord, catalogs: CatalogDocument[]): Record<string, unknown> {
  const catalog = catalogs.find((candidate) => candidate.kind === appKindOf(app));
  return { kind: appKindOf(app), url: catalog?.url || null, revision: catalog?.revision || null, digest: catalog?.digest || null, releaseSha256: SHA256.test(str(app.release_sha256, 80)) ? str(app.release_sha256, 80).toLowerCase() : null };
}

function normalizeInput(input: AppRecord): { appId: string; action?: string; network?: string; params: AppRecord; walletAddress?: string } {
  const rawAppId = String(input.appId ?? '').trim(); if (rawAppId.length > 200) fail('app_id_invalid');
  const appId = rawAppId; if (!APP_ID.test(appId)) fail('app_id_invalid');
  const rawAction = input.action === undefined ? undefined : String(input.action).trim(); if (rawAction !== undefined && rawAction.length > 96) fail('action_invalid');
  const action = rawAction; if (action !== undefined && !ACTION.test(action)) fail('action_invalid');
  const rawNetwork = input.network === undefined ? undefined : String(input.network).trim(); if (rawNetwork !== undefined && rawNetwork.length > 40) fail('network_invalid');
  const network = rawNetwork; if (network !== undefined && !NETWORKS.has(network)) fail('network_invalid');
  const params = snapshotIntentParams(input.params); const walletAddress = input.walletAddress === undefined ? undefined : str(input.walletAddress, 128);
  return { appId, action, network, params, walletAddress };
}

export const APP_INTENT_TOOLS = new Set(['list_apps', 'list_skills', 'get_app_capabilities', 'draft_app_intent']);

export async function dispatchAppIntentTool(name: string, input: AppRecord): Promise<Record<string, unknown>> {
  if (!APP_INTENT_TOOLS.has(name)) fail('unknown_app_intent_tool');
  if (name === 'list_apps') {
    const { apps, catalogs } = await loadApps(true);
    const query = str(input.query, 120).toLowerCase(); const category = str(input.category, 80).toLowerCase(); const network = input.network === undefined ? undefined : str(input.network, 40);
    if (network && !NETWORKS.has(network)) fail('network_invalid');
    const filtered = apps.filter((app) => { const text = [appIdOf(app), str(app.name), str(app.name_zh), str(app.description), ...list(app.tags).map((x) => str(x))].join(' ').toLowerCase(); return (!query || text.includes(query)) && (!category || str(app.category, 80).toLowerCase() === category) && (!network || appNetworksOf(app).includes(network)); });
    return { schemaVersion: 1, intentSchemaVersion: 'neoos.intent-capabilities/v1', skillSchemaVersion: 'neoos.skill-manifest/v1', count: filtered.length, catalogs: catalogs.map((catalog) => ({ kind: catalog.kind, revision: catalog.revision, digest: catalog.digest })), apps: filtered.map((app) => ({ appId: appIdOf(app), kind: appKindOf(app), name: str(app.name) || appIdOf(app), description: str(app.description), version: str(app.version) || null, category: str(app.category) || 'utility', supportedNetworks: appNetworksOf(app), capabilityCount: Array.isArray(app.intent_capabilities) ? app.intent_capabilities.length : null, skillCount: Array.isArray(app.skills) ? app.skills.length : null, capabilitySource: Array.isArray(app.intent_capabilities) ? str(app.intent_capability_source, 64) || 'declared' : 'deferred-manifest-or-safe-default' })) };
  }

  if (name === 'list_skills') {
    const requestedAppId = input.appId === undefined ? '' : str(input.appId, 200);
    if (requestedAppId && !APP_ID.test(requestedAppId)) fail('app_id_invalid');
    const query = str(input.query, 120).toLowerCase();
    const appsAndCatalogs = requestedAppId ? null : await loadApps(true);
    const found = requestedAppId ? await findApp(requestedAppId) : null;
    const apps = found ? [found.app] : appsAndCatalogs!.apps;
    const catalogs = found ? found.catalogs : appsAndCatalogs!.catalogs;
    const selected = apps;
    const rows: AppRecord[] = [];
    for (const app of selected) {
      const result = await capabilitiesOf(app);
      for (const skill of result.skills) {
        const haystack = [str(skill.id), str(skill.name), str(skill.description), ...list(skill.keywords).map((x) => str(x))].join(' ').toLowerCase();
        if (query && !haystack.includes(query)) continue;
        rows.push({ appId: appIdOf(app), kind: appKindOf(app), appName: str(app.name) || appIdOf(app), version: str(app.version) || null, skill, capabilitySource: result.source, provenance: catalogMetaFor(app, catalogs) });
      }
    }
    return { schemaVersion: 1, skillSchemaVersion: 'neoos.skill-manifest/v1', readOnly: true, canSign: false, canBroadcast: false, count: rows.length, skills: rows };
  }

  const normalized = normalizeInput(input); const { app, catalogs } = await findApp(normalized.appId); const capabilityResult = await capabilitiesOf(app); const capabilities = capabilityResult.capabilities;
  if (name === 'get_app_capabilities') return { schemaVersion: 1, intentSchemaVersion: 'neoos.intent-capabilities/v1', skillSchemaVersion: 'neoos.skill-manifest/v1', appId: normalized.appId, kind: appKindOf(app), appName: str(app.name) || normalized.appId, version: str(app.version) || null, capabilities, skills: capabilityResult.skills, capabilitySource: capabilityResult.source, provenance: catalogMetaFor(app, catalogs), transactionsEnabled: obj(app.platform).transactions ?? null, readOnly: true, canSign: false, canBroadcast: false };
  if (!normalized.action) fail('action_required');
  const capability = capabilities.find((candidate) => str(candidate.id ?? candidate.action, 100) === normalized.action || str(candidate.method, 100) === normalized.action); if (!capability) fail('action_not_declared');
  const appNetworks = appNetworksOf(app); const chain = str(capability.chain, 16).toLowerCase(); if (!['n3', 'neox', 'both'].includes(chain)) fail('invalid_capability_chain');
  const chainNetworks = appNetworks.filter((network) => chain === 'n3' ? network.startsWith('neo-n3-') : chain === 'neox' ? network.startsWith('neo-x-') : true); const supported = capability.networks === undefined ? chainNetworks : chainNetworks.filter((network) => list(capability.networks).includes(network));
  const network = normalized.network || str(app.default_network ?? app.defaultNetwork) || supported[0] || null; if (!network || !supported.includes(network)) fail('network_not_supported');
  const requiresSignature = str(capability.mode, 32).toLowerCase() === 'write' || capability.requiresUserSignature === true; const { missing, errors } = validateIntentParams(capability, normalized.params);
  if (requiresSignature && obj(app.platform).transactions !== undefined && obj(app.platform).transactions !== true) errors.push({ code: 'transactions_disabled', field: 'action', message: 'This app has not enabled transactions.' });
  if (requiresSignature && !normalized.walletAddress) errors.push({ code: 'wallet_required', field: 'walletAddress', message: 'Connect a wallet before reviewing a write intent.' });
  const validation = { valid: errors.length === 0, missing, errors }; const isOpen = normalized.action === 'open' || normalized.action === 'open_app';
  const intentBase = { schemaVersion: 1, intentSchemaVersion: 'neoos.intent-capabilities/v1', kind: 'neoos.app.intent', appId: normalized.appId, appKind: appKindOf(app), appName: str(app.name) || normalized.appId, appVersion: str(app.version) || null, action: normalized.action, params: normalized.params, network, walletAddress: normalized.walletAddress || null, capability: { id: str(capability.id ?? capability.action, 96), name: str(capability.name ?? capability.label, 120) || str(capability.id ?? capability.action, 96), mode: requiresSignature ? 'write' : 'read' }, capabilitySource: capabilityResult.source, provenance: catalogMetaFor(app, catalogs), validation, execution: isOpen ? 'open_app' : requiresSignature ? 'requires_user_confirmation' : 'requires_app_review', requiresUserReview: true, requiresUserSignature: requiresSignature, canSign: false, canBroadcast: false, transaction: null, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), status: validation.valid ? 'draft' : 'needs_clarification' };
  const fingerprint = { ...intentBase }; delete (fingerprint as Record<string, unknown>).createdAt; delete (fingerprint as Record<string, unknown>).expiresAt;
  return { ...intentBase, intentId: `intent_${canonicalHash(fingerprint)}` };
}

export function clearAppIntentCatalogCache(): void { cachedCatalogs = new Map(); manifestCache = new Map(); }
