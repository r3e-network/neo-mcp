import * as neonJs from '@cityofzion/neon-js';
import type { ContractInvocationResult, NeoService } from '../services/neo-service';
import { createSuccessResponse } from '../utils/error-handler';
import { ValidationError } from '../utils/errors';
import { validateAddress } from '../utils/validation';

export const NNS_SCRIPT_HASHES = Object.freeze({
  mainnet: '0x50ac1c37690cc2cfc594472833cf57505d5f46de',
  testnet: '0xd4dbd72c8965b8f12c14d37ad57ddd91ee1d98cb',
});
export const ORACLE_SCRIPT_HASH = '0xfe924b7cfe89ddd271abaf7210a80a7e11178758';
export const NEOFS_REST_GATEWAY = 'https://rest.fs.neo.org';

const NNS_RECORD_TYPES = Object.freeze({
  A: 1,
  CNAME: 5,
  TXT: 16,
  AAAA: 28,
});
const NNS_DOMAIN_RE =
  /^(?=.{3,255}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+neo$/;
const NEOFS_ID_RE = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const EXTERNAL_TIMEOUT_MS = 10_000;
const MAX_EXTERNAL_BYTES = 1024 * 1024;

export const ECOSYSTEM_META_TOOLS = new Set([
  'get_neo_service_info',
  'query_neofs',
]);
export const ECOSYSTEM_N3_TOOLS = new Set([
  'query_nns',
  'get_oracle_info',
]);

function requireString(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeNnsDomain(value: unknown): string {
  if (typeof value !== 'string') throw new ValidationError('domain must be a string');
  const domain = value.trim().toLowerCase().replace(/\.$/, '');
  if (!NNS_DOMAIN_RE.test(domain)) {
    throw new ValidationError(
      'domain must be a lowercase-compatible .neo name with valid DNS label characters',
    );
  }
  return domain;
}

function selectedNetwork(neoService: NeoService): 'mainnet' | 'testnet' {
  return neoService.getNetwork() === 'testnet' ? 'testnet' : 'mainnet';
}

function requestedNetwork(input: Record<string, unknown>): 'mainnet' | 'testnet' {
  const network = typeof input.network === 'string' ? input.network.trim().toLowerCase() : '';
  if (network !== 'mainnet' && network !== 'testnet') {
    throw new ValidationError('network must be mainnet or testnet');
  }
  return network;
}

function nnsScriptHash(network: 'mainnet' | 'testnet'): string {
  return NNS_SCRIPT_HASHES[network];
}

function booleanStack(result: ContractInvocationResult): boolean | null {
  const first = Array.isArray(result.stack) ? result.stack[0] : null;
  if (!first || typeof first !== 'object') return null;
  const item = first as { type?: unknown; value?: unknown };
  if (String(item.type || '').toLowerCase() !== 'boolean') return null;
  if (item.value === true || item.value === 'true' || item.value === 1 || item.value === '1') {
    return true;
  }
  if (item.value === false || item.value === 'false' || item.value === 0 || item.value === '0') {
    return false;
  }
  return null;
}

function integerStack(result: ContractInvocationResult): string | null {
  const first = Array.isArray(result.stack) ? result.stack[0] : null;
  if (!first || typeof first !== 'object') return null;
  const item = first as { type?: unknown; value?: unknown };
  if (String(item.type || '').toLowerCase() !== 'integer') return null;
  return typeof item.value === 'string' && /^-?\d+$/.test(item.value) ? item.value : null;
}

function byteStringBuffer(item: unknown): Buffer | null {
  if (!item || typeof item !== 'object') return null;
  const stackItem = item as { type?: unknown; value?: unknown };
  if (!['bytestring', 'buffer'].includes(String(stackItem.type || '').toLowerCase())) return null;
  if (typeof stackItem.value !== 'string') return null;
  try {
    return Buffer.from(stackItem.value, 'base64');
  } catch {
    return null;
  }
}

function byteStringText(item: unknown): string | null {
  const bytes = byteStringBuffer(item);
  if (!bytes) return null;
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null;
}

function hash160StackAddress(item: unknown): string | null {
  const bytes = byteStringBuffer(item);
  if (!bytes || bytes.length !== 20) return null;
  return neonJs.wallet.getAddressFromScriptHash(Buffer.from(bytes).reverse().toString('hex'));
}

function decodeNnsProperties(result: ContractInvocationResult): Record<string, unknown> | null {
  if (String(result.state || '').toUpperCase() !== 'HALT') return null;
  const first = Array.isArray(result.stack) ? result.stack[0] : null;
  if (!first || typeof first !== 'object') return null;
  const map = first as { type?: unknown; value?: unknown };
  if (String(map.type || '').toLowerCase() !== 'map' || !Array.isArray(map.value)) return null;
  const out: Record<string, unknown> = {};
  for (const entry of map.value) {
    if (!entry || typeof entry !== 'object') continue;
    const pair = entry as { key?: unknown; value?: unknown };
    const key = byteStringText(pair.key);
    if (!key) continue;
    const value = pair.value as { type?: unknown; value?: unknown } | undefined;
    if (key === 'admin') {
      out.admin = hash160StackAddress(value) || null;
    } else if (String(value?.type || '').toLowerCase() === 'integer') {
      out[key] = typeof value?.value === 'string' ? value.value : null;
    } else {
      out[key] = byteStringText(value) ?? null;
    }
  }
  const expiration = typeof out.expiration === 'string' && /^\d+$/.test(out.expiration)
    ? Number(out.expiration)
    : null;
  if (expiration !== null && Number.isSafeInteger(expiration)) {
    out.expirationIso = new Date(expiration).toISOString();
  }
  return out;
}

function requireHalt(result: ContractInvocationResult, operation: string): ContractInvocationResult {
  if (String(result.state || '').toUpperCase() !== 'HALT' || result.exception) {
    throw new ValidationError(
      `${operation} failed: ${String(result.exception || result.state || 'unknown VM error')}`,
    );
  }
  return result;
}

function datosToGas(datos: string | null): string | null {
  if (datos === null || !/^-?\d+$/.test(datos)) return null;
  const value = BigInt(datos);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 100_000_000n;
  const fraction = (absolute % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

async function queryNns(
  input: Record<string, unknown>,
  neoService: NeoService,
): Promise<Record<string, unknown>> {
  const domain = normalizeNnsDomain(input.domain);
  const network = selectedNetwork(neoService);
  const contractHash = nnsScriptHash(network);
  const recordTypeName = String(input.recordType || 'TXT').toUpperCase();
  const recordType = NNS_RECORD_TYPES[recordTypeName as keyof typeof NNS_RECORD_TYPES];
  if (recordType === undefined) {
    throw new ValidationError('recordType must be A, CNAME, TXT, or AAAA');
  }

  const availability = requireHalt(
    await neoService.testInvoke(
      contractHash,
      'isAvailable',
      [{ type: 'String', value: domain }],
      [],
    ),
    'NNS isAvailable',
  );
  const available = booleanStack(availability);
  if (available === null) throw new ValidationError('NNS isAvailable returned a non-Boolean result');

  const labelLength = domain.split('.')[0].length;
  const priceResult = await neoService.testInvoke(
    contractHash,
    'getPrice',
    [{ type: 'Integer', value: String(labelLength) }],
    [],
  ).catch(() => null);
  const registrationPriceDatos = priceResult ? integerStack(priceResult) : null;

  if (available) {
    return createSuccessResponse({
      network,
      contractHash,
      domain,
      available: true,
      registrationPriceDatos,
      registrationPriceGas: datosToGas(registrationPriceDatos),
      recordType: recordTypeName,
      resolved: null,
      owner: null,
      properties: null,
    });
  }

  const tokenId = Buffer.from(domain, 'utf8').toString('base64');
  const [propertiesResult, ownerResult, resolveResult] = await Promise.all([
    neoService.testInvoke(
      contractHash,
      'properties',
      [{ type: 'ByteArray', value: tokenId }],
      [],
    ).catch(() => null),
    neoService.testInvoke(
      contractHash,
      'ownerOf',
      [{ type: 'ByteArray', value: tokenId }],
      [],
    ).catch(() => null),
    neoService.testInvoke(
      contractHash,
      'resolve',
      [
        { type: 'String', value: domain },
        { type: 'Integer', value: String(recordType) },
      ],
      [],
    ).catch(() => null),
  ]);

  const ownerFirst = ownerResult && Array.isArray(ownerResult.stack) ? ownerResult.stack[0] : null;
  const resolveFirst = resolveResult && Array.isArray(resolveResult.stack) ? resolveResult.stack[0] : null;
  return createSuccessResponse({
    network,
    contractHash,
    domain,
    available: false,
    registrationPriceDatos,
    registrationPriceGas: datosToGas(registrationPriceDatos),
    recordType: recordTypeName,
    resolved: byteStringText(resolveFirst),
    owner: hash160StackAddress(ownerFirst),
    properties: propertiesResult ? decodeNnsProperties(propertiesResult) : null,
  });
}

async function getOracleInfo(neoService: NeoService): Promise<Record<string, unknown>> {
  const network = selectedNetwork(neoService);
  const result = requireHalt(
    await neoService.testInvoke(ORACLE_SCRIPT_HASH, 'getPrice', [], []),
    'Oracle getPrice',
  );
  const responseFeeDatos = integerStack(result);
  if (responseFeeDatos === null) {
    throw new ValidationError('Oracle getPrice returned a non-Integer result');
  }
  return createSuccessResponse({
    network,
    contractHash: ORACLE_SCRIPT_HASH,
    responseFeeDatos,
    responseFeeGas: datosToGas(responseFeeDatos),
    role: 'Neo N3 native Oracle service',
    requestMethod: 'request(url, filter, callback, userData, gasForResponse)',
    note:
      'Oracle requests are contract-originated and asynchronous. This tool reads the current native response price; it does not fabricate a request transaction for an arbitrary externally owned account.',
  });
}

async function fetchFixedJson(path: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXTERNAL_TIMEOUT_MS);
  try {
    const response = await fetch(`${NEOFS_REST_GATEWAY}${path}`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new ValidationError(`NeoFS gateway returned HTTP ${response.status}`);
    const length = Number(response.headers.get('content-length') || '0');
    if (Number.isFinite(length) && length > MAX_EXTERNAL_BYTES) {
      throw new ValidationError('NeoFS gateway response exceeds the size limit');
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_EXTERNAL_BYTES) {
      throw new ValidationError('NeoFS gateway response exceeds the size limit');
    }
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ValidationError('NeoFS gateway request timed out');
    }
    throw new ValidationError(
      `NeoFS gateway request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function queryNeoFs(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const n3Network = requestedNetwork(input);
  const operation = String(input.operation || '');
  if (operation === 'network_info') {
    return createSuccessResponse({
      operation,
      n3Network,
      gateway: NEOFS_REST_GATEWAY,
      networkBoundary: 'NeoFS gateway is global; n3Network is context only and does not select a different gateway.',
      data: await fetchFixedJson('/v1/network-info'),
    });
  }
  if (operation === 'container') {
    const containerId = requireString(input, 'containerId');
    if (!NEOFS_ID_RE.test(containerId)) throw new ValidationError('Invalid NeoFS container id');
    return createSuccessResponse({
      operation,
      n3Network,
      gateway: NEOFS_REST_GATEWAY,
      networkBoundary: 'NeoFS gateway is global; n3Network is context only and does not select a different gateway.',
      data: await fetchFixedJson(`/v1/containers/${encodeURIComponent(containerId)}`),
    });
  }
  if (operation === 'account_balance') {
    const address = validateAddress(requireString(input, 'address'));
    return createSuccessResponse({
      operation,
      n3Network,
      gateway: NEOFS_REST_GATEWAY,
      networkBoundary: 'NeoFS accounting is queried from the global gateway; the N3 network is retained as address context.',
      address,
      data: await fetchFixedJson(`/v1/accounting/balance/${encodeURIComponent(address)}`),
    });
  }
  if (operation === 'object_link') {
    const containerId = requireString(input, 'containerId');
    const objectId = requireString(input, 'objectId');
    if (!NEOFS_ID_RE.test(containerId)) throw new ValidationError('Invalid NeoFS container id');
    if (!NEOFS_ID_RE.test(objectId)) throw new ValidationError('Invalid NeoFS object id');
    return createSuccessResponse({
      operation,
      n3Network,
      containerId,
      objectId,
      uri: `neofs://${containerId}/${objectId}`,
      httpGatewayUrl: `https://http.fs.neo.org/${containerId}/${objectId}`,
      networkBoundary: 'Object identifiers and links are NeoFS-global; n3Network is context only.',
      note: 'The generated links identify the object; object availability still depends on NeoFS nodes.',
    });
  }
  throw new ValidationError(
    'operation must be network_info, container, account_balance, or object_link',
  );
}

function getServiceInfo(input: Record<string, unknown>): Record<string, unknown> {
  const service = String(input.service || '').toLowerCase();
  const network = String(input.network || 'mainnet').toLowerCase();
  if (network !== 'mainnet' && network !== 'testnet') {
    throw new ValidationError('network must be mainnet or testnet');
  }
  if (service === 'nns') {
    return createSuccessResponse({
      service: 'Neo Name Service',
      network,
      contractHash: nnsScriptHash(network),
      explorerPath: '/nns',
      capabilities: ['availability', 'owner', 'properties', 'records', 'register', 'renew', 'transfer'],
    });
  }
  if (service === 'neofs') {
    return createSuccessResponse({
      service: 'NeoFS',
      network,
      restGateway: NEOFS_REST_GATEWAY,
      httpGateway: 'https://http.fs.neo.org',
      explorerPath: '/tools/neofs',
      capabilities: ['network info', 'container metadata', 'accounting balance', 'object links'],
      writeBoundary:
        'File upload requires file bytes plus a wallet-authorized NeoFS client session and cannot be represented as a normal Neo N3 transaction proposal.',
    });
  }
  if (service === 'oracle') {
    return createSuccessResponse({
      service: 'Neo N3 Oracle',
      network,
      contractHash: ORACLE_SCRIPT_HASH,
      capabilities: ['response price', 'contract-originated asynchronous requests'],
      writeBoundary:
        'Oracle.request is normally called by a smart contract with a callback and response gas budget; arbitrary EOA requests are not generated.',
    });
  }
  if (service === 'bridge') {
    return createSuccessResponse({
      service: 'Neo X Bridge',
      network,
      officialUrl: network === 'mainnet'
        ? 'https://xbridge.neo.org/'
        : 'https://testnet.bridge.banelabs.org/',
      neoXTokenBridge: '0x1212000000000000000000000000000000000004',
      neoXMessageBridge: '0x1212000000000000000000000000000000000009',
      documentationUrl: 'https://xdocs.ngd.network/bridge/general',
      messageBridgeDocumentationUrl: 'https://xdocs.ngd.network/bridge/messaging-bridge',
      capabilities: [
        'Neo N3 to Neo X token deposit',
        'Neo X to Neo N3 token withdrawal',
        'Neo N3 and Neo X arbitrary message relay',
      ],
      assetBoundary:
        'The live bridge UI is authoritative for currently enabled assets, quotas, fees, and pause state. Never infer support from a same-symbol token contract.',
      writeBoundary:
        'Bridge transfers are multi-stage operations involving bridge contracts, relayers, proofs, and both wallet networks. Use the official bridge UI instead of synthesizing a one-step transaction.',
    });
  }
  throw new ValidationError('service must be nns, neofs, oracle, or bridge');
}

export async function dispatchEcosystemMetaTool(
  name: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (name === 'get_neo_service_info') return getServiceInfo(input);
  if (name === 'query_neofs') return await queryNeoFs(input);
  throw new ValidationError(`Unknown ecosystem meta tool: ${name}`);
}

export async function dispatchEcosystemN3Tool(
  name: string,
  input: Record<string, unknown>,
  neoService: NeoService,
): Promise<Record<string, unknown>> {
  if (name === 'query_nns') return await queryNns(input, neoService);
  if (name === 'get_oracle_info') return await getOracleInfo(neoService);
  throw new ValidationError(`Unknown Neo N3 ecosystem tool: ${name}`);
}
