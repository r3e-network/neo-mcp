/**
 * Generated Neo N3 network identity registry.
 *
 * The only module the rest of the server reads for Neo N3 network identity.
 * It loads `src/config/generated/network-identities.v1.json` — the artifact
 * emitted by `scripts/generate-network-identities.mjs` — validates every field
 * fail-closed at module load, rejects unknown fields rather than dropping
 * them, and hands out frozen identities. A malformed or hand-edited artifact
 * prevents the server from starting rather than letting a call site sign
 * against the wrong network.
 */

import networkIdentities from '../config/generated/network-identities.v1.json';
import { ValidationError } from '../utils/errors';

/** Network names the registry serves. */
export const IDENTITY_NETWORKS = ['mainnet', 'testnet'] as const;

export type IdentityNetwork = (typeof IDENTITY_NETWORKS)[number];

/** One reviewed Neo N3 network identity. All fields are immutable. */
export interface NetworkIdentity {
  readonly network: IdentityNetwork;
  readonly magic: number;
  readonly genesisHash: string;
  readonly provenance: string;
}

/** Map from network name to its identity. */
export type NetworkIdentityMap = Readonly<Record<IdentityNetwork, NetworkIdentity>>;

const SCHEMA_VERSION = 1;
const GENESIS_HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const PROVENANCE_PATTERN = /^neo-go\/[0-9a-f]{40}\//;
const NETWORK_NAME_PATTERN = /^(mainnet|testnet)$/;
const DOCUMENT_FIELDS = ['schemaVersion', 'networks'] as const;
const IDENTITY_FIELDS = ['network', 'magic', 'genesisHash', 'provenance'] as const;

function failLoad(field: string, detail: string): never {
  // Module-load failure: a deployment misconfiguration, not a caller error. The
  // server must not start with unreviewed identity material.
  throw new Error(`network-identity-registry: ${field} ${detail}`);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unexpected = Object.keys(value)
    .filter((key) => !(allowed as readonly string[]).includes(key))
    .sort();
  if (unexpected.length > 0) {
    failLoad(label, `has unknown field(s) ${unexpected.join(', ')}; allowed fields are ${allowed.join(', ')}`);
  }
}

function freezeIdentity(value: {
  network: string;
  magic: number;
  genesisHash: string;
  provenance: string;
}): NetworkIdentity {
  return Object.freeze({
    network: value.network as IdentityNetwork,
    magic: value.magic,
    genesisHash: value.genesisHash,
    provenance: value.provenance,
  });
}

/**
 * Parse and validate a raw identity document. Throws on any malformed shape so
 * the caller never observes a half-validated map. Unknown fields are rejected,
 * not dropped: a configuration surface that silently ignores hand-added keys
 * fails open.
 */
export function parseNetworkIdentities(raw: unknown): NetworkIdentityMap {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    failLoad('document', 'must be a JSON object');
  }
  const document = raw as Record<string, unknown>;
  rejectUnknownKeys(document, DOCUMENT_FIELDS, 'document');

  if (document.schemaVersion !== SCHEMA_VERSION) {
    failLoad('schemaVersion', `must be exactly ${SCHEMA_VERSION}, got ${JSON.stringify(document.schemaVersion)}`);
  }
  if (document.networks === null || typeof document.networks !== 'object' || Array.isArray(document.networks)) {
    failLoad('networks', 'must be an object');
  }
  const networks = document.networks as Record<string, unknown>;

  const keys = Object.keys(networks).sort();
  const expected = [...IDENTITY_NETWORKS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    failLoad('networks', `must have exactly the keys ${expected.join(', ')}, got ${keys.join(', ') || '(none)'}`);
  }

  const result: Record<string, NetworkIdentity> = {};
  for (const name of expected) {
    const entry = networks[name];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      failLoad(`networks.${name}`, 'must be an object');
    }
    const identity = entry as Record<string, unknown>;
    rejectUnknownKeys(identity, IDENTITY_FIELDS, `networks.${name}`);

    if (identity.network !== name) {
      failLoad(`networks.${name}.network`, `must equal its key, got ${JSON.stringify(identity.network)}`);
    }
    if (!NETWORK_NAME_PATTERN.test(name)) {
      failLoad(`networks.${name}`, 'is not a supported network name');
    }
    const magic = identity.magic;
    if (typeof magic !== 'number' || !Number.isSafeInteger(magic) || magic <= 0) {
      failLoad(`networks.${name}.magic`, 'must be a positive safe integer');
    }
    const genesisHash = identity.genesisHash;
    if (typeof genesisHash !== 'string' || !GENESIS_HASH_PATTERN.test(genesisHash)) {
      failLoad(`networks.${name}.genesisHash`, 'must be 0x-prefixed lowercase hex of 32 bytes');
    }
    const provenance = identity.provenance;
    if (typeof provenance !== 'string' || !PROVENANCE_PATTERN.test(provenance)) {
      failLoad(`networks.${name}.provenance`, 'must name a neo-go commit (neo-go/<40 hex>/...)');
    }

    result[name] = freezeIdentity({
      network: name,
      magic,
      genesisHash,
      provenance,
    });
  }

  return Object.freeze(result as Record<IdentityNetwork, NetworkIdentity>);
}

function isIdentityNetwork(value: unknown): value is IdentityNetwork {
  return typeof value === 'string' && (IDENTITY_NETWORKS as readonly string[]).includes(value);
}

/** Every reviewed network identity, frozen. */
export const NETWORK_IDENTITIES: NetworkIdentityMap = parseNetworkIdentities(networkIdentities);

/** Return the identity for one network. Throws `ValidationError` on an unknown name. */
export function networkIdentity(network: unknown): NetworkIdentity {
  if (!isIdentityNetwork(network)) {
    throw new ValidationError(`Unknown Neo N3 network identity name: ${JSON.stringify(network)}`);
  }
  return NETWORK_IDENTITIES[network];
}

/** Return the network magic for one network. Throws `ValidationError` on an unknown name. */
export function neoNetworkMagic(network: unknown): number {
  return networkIdentity(network).magic;
}
