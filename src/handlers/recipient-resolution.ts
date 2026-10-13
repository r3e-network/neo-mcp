/**
 * Deterministic recipient resolution for .neo names (CU-37).
 *
 * Class A: a name that resolves to the wrong recipient sends value to the wrong
 * place. This module is the only place a `.neo` name becomes an address, and it
 * holds to three rules:
 *
 *   1. **Deterministic.** The same name against the same chain state resolves to
 *      the same recipient every time. One record type (TXT), one owner read, one
 *      expiry read, no wall-clock in the answer, no cache, no record ordering.
 *   2. **Fail closed.** A name that cannot be resolved — unregistered, no owner,
 *      a record that is not a Neo N3 address, a chain read that does not halt —
 *      is refused with an error. There is no default, no fallback address and no
 *      partial provenance; a refusal is never a success payload that says "no".
 *   3. **A typed address passes through unchanged.** A recipient that is already
 *      a valid Neo N3 address is returned exactly as typed, with no chain read.
 *
 * Unlike `query_nns` (discovery: availability, price, one arbitrary record),
 * which tolerates failed reads and reports an available name as a success, every
 * read here must succeed or the whole resolution is refused. The two tools are
 * deliberately separate so neither contract is diluted.
 */

import * as neonJs from '@cityofzion/neon-js';
import type { ContractInvocationResult, NeoService } from '../services/neo-service';
import { NNS_SCRIPT_HASHES, decodeNnsProperties } from './ecosystem-tools';
import { createSuccessResponse } from '../utils/error-handler';
import { ValidationError } from '../utils/errors';
import { validateAddress } from '../utils/validation';

/** Tools on this dispatch path. */
export const RECIPIENT_RESOLUTION_TOOLS = new Set(['resolve_recipient']);

/**
 * NNS record type TXT (16) — the record `.neo` names use to publish an N3
 * address. Fixed, not caller-selectable: a caller who may choose the record type
 * may choose a different recipient for the same name.
 */
const NNS_RECORD_TYPE_TXT = 16;

/** Longest recipient string accepted, before any decoding. */
const MAX_RECIPIENT_LENGTH = 255;

/** Same grammar `query_nns` accepts for a fully-qualified .neo name. */
const NNS_DOMAIN_RE = /^(?=.{3,255}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+neo$/;

/** Base58 with the N3 length; the checksum is checked by `validateAddress`. */
const NEO_ADDRESS_SHAPE_RE = /^[A-Za-z0-9]{34}$/;

export type RecipientSource = 'typed' | 'nns';

export type NnsNetwork = 'mainnet' | 'testnet';

/** Why a recipient was refused. Stable, machine-readable, never a fallback. */
export type RefusalReason =
  | 'not_a_recipient'
  | 'invalid_network'
  | 'network_mismatch'
  | 'unregistered_name'
  | 'no_owner'
  | 'record_not_address'
  | 'incomplete_provenance'
  | 'chain_read_failed';

export interface ResolvedRecipient {
  /** The recipient the caller sent, trimmed. */
  recipient: string;
  /** Where the address came from. */
  source: RecipientSource;
  /** The recipient address: the typed input verbatim, or the NNS TXT record verbatim. */
  address: string;
  /** The network the resolution was read from. */
  network: NnsNetwork;
  /** Normalized `.neo` name, or null for a typed address. */
  domain: string | null;
  /** NameService contract on `network`, or null for a typed address. */
  contractHash: string | null;
  /** NNS owner of the name, or null for a typed address. */
  owner: string | null;
  /** Registration expiry, ISO-8601, or null for a typed address. */
  expiry: string | null;
  /** Registration expiry as the integer read from chain, or null for a typed address. */
  expiryMs: string | null;
  /** The NNS TXT record text, or null for a typed address. */
  record: string | null;
  /** The record type read. Always "TXT" for a resolved name, null for a typed address. */
  recordType: 'TXT' | null;
}

/**
 * Refuse a recipient. Always a thrown ValidationError — never a result object a
 * caller could mistake for a resolution.
 */
function refuse(
  reason: RefusalReason,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new ValidationError(message, { reason, ...details });
}

/** True when `value` is a Neo N3 address this server accepts. */
function isNeoN3Address(value: string): boolean {
  if (!NEO_ADDRESS_SHAPE_RE.test(value)) return false;
  try {
    validateAddress(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize a `.neo` name onto its canonical form (lowercase, no trailing dot).
 * Returns null when the value is not a .neo name at all.
 */
function normalizeDomain(value: string): string | null {
  const domain = value.toLowerCase().replace(/\.$/, '');
  return NNS_DOMAIN_RE.test(domain) ? domain : null;
}

function requireRecipient(input: Record<string, unknown>): string {
  const raw = input.recipient;
  if (typeof raw !== 'string') {
    refuse('not_a_recipient', 'recipient must be a Neo N3 address or a .neo name');
  }
  const recipient = raw.trim();
  if (recipient.length === 0 || recipient.length > MAX_RECIPIENT_LENGTH) {
    refuse('not_a_recipient', 'recipient must be a Neo N3 address or a .neo name');
  }
  return recipient;
}

function requireNetwork(input: Record<string, unknown>): NnsNetwork {
  const raw = input.network;
  if (raw !== 'mainnet' && raw !== 'testnet') {
    refuse(
      'invalid_network',
      'network must be "mainnet" or "testnet": a recipient is meaningless without the chain state it was read from',
    );
  }
  return raw;
}

// --- chain reads ------------------------------------------------------------
//
// Every read is fail-closed: a rejected call, a VM state that is not HALT, or a
// stack item that does not decode is a refusal. Nothing here degrades to null.

async function invokeNns(
  neoService: NeoService,
  contractHash: string,
  operation: string,
  params: unknown[],
  domain: string,
): Promise<ContractInvocationResult> {
  try {
    const result = await neoService.testInvoke(contractHash, operation, params, []);
    if (!result || String(result.state ?? '').toUpperCase() !== 'HALT' || result.exception) {
      refuse('chain_read_failed', `could not read the NNS registration for ${domain}`, { operation });
    }
    return result;
  } catch (error) {
    // A refusal thrown above must not be re-labelled as a transport failure.
    if (error instanceof ValidationError) throw error;
    refuse('chain_read_failed', `could not read the NNS registration for ${domain}`, { operation });
  }
}

function firstStackItem(result: ContractInvocationResult): Record<string, unknown> | null {
  const stack = Array.isArray(result.stack) ? result.stack[0] : undefined;
  return stack && typeof stack === 'object' ? (stack as Record<string, unknown>) : null;
}

function stackType(item: Record<string, unknown> | null): string {
  return String(item?.type ?? '').toLowerCase();
}

function stackBytes(item: Record<string, unknown> | null): Buffer | null {
  if (!['bytestring', 'buffer'].includes(stackType(item))) return null;
  const value = item?.value;
  if (typeof value !== 'string') return null;
  try {
    return Buffer.from(value, 'base64');
  } catch {
    return null;
  }
}

/** `isAvailable` is true for a name nobody holds — that name must not resolve. */
function readAvailability(result: ContractInvocationResult, domain: string): boolean {
  const item = firstStackItem(result);
  if (stackType(item) !== 'boolean') {
    refuse('chain_read_failed', `could not read the NNS registration for ${domain}`, {
      operation: 'isAvailable',
    });
  }
  const value = item?.value;
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  refuse('chain_read_failed', `could not read the NNS registration for ${domain}`, {
    operation: 'isAvailable',
  });
}

/** The NNS owner. A missing, short or zero owner means nobody holds the name. */
function readOwner(result: ContractInvocationResult, domain: string, network: NnsNetwork): string {
  const item = firstStackItem(result);
  const bytes = stackBytes(item);
  if (bytes === null) {
    refuse('chain_read_failed', `could not read the NNS registration for ${domain}`, {
      operation: 'ownerOf',
    });
  }
  if (bytes.length !== 20 || bytes.every((byte) => byte === 0)) {
    refuse('no_owner', `${domain} has no NNS owner on Neo N3 ${network}`, { domain, network });
  }
  return neonJs.wallet.getAddressFromScriptHash(Buffer.from(bytes).reverse().toString('hex'));
}

/**
 * The registration expiry. The provenance is part of the answer, so an expiry
 * that cannot be read is a refusal rather than a resolution with a hole in it.
 */
function readExpiry(
  result: ContractInvocationResult,
  domain: string,
  network: NnsNetwork,
): { expiry: string; expiryMs: string } {
  const properties = decodeNnsProperties(result);
  if (properties === null) {
    refuse('chain_read_failed', `could not read the NNS registration for ${domain}`, {
      operation: 'properties',
    });
  }
  const raw = properties.expiration;
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) {
    refuse(
      'incomplete_provenance',
      `${domain} has no readable registration expiry on Neo N3 ${network}`,
      { domain, network },
    );
  }
  const epochMs = Number(raw);
  if (!Number.isSafeInteger(epochMs)) {
    refuse(
      'incomplete_provenance',
      `${domain} has no readable registration expiry on Neo N3 ${network}`,
      { domain, network },
    );
  }
  try {
    return { expiry: new Date(epochMs).toISOString(), expiryMs: raw };
  } catch {
    refuse(
      'incomplete_provenance',
      `${domain} has no readable registration expiry on Neo N3 ${network}`,
      { domain, network },
    );
  }
}

/**
 * The TXT record, which must be a Neo N3 address. The record is chain-controlled
 * text and is never echoed into an error message.
 */
function readRecordAddress(result: ContractInvocationResult, domain: string): string {
  const bytes = stackBytes(firstStackItem(result));
  if (bytes === null) {
    refuse('chain_read_failed', `could not read the NNS registration for ${domain}`, {
      operation: 'resolve',
    });
  }
  const text = bytes.toString('utf8');
  const record = Buffer.from(text, 'utf8').equals(bytes) ? text : null;
  if (record === null || !isNeoN3Address(record)) {
    refuse(
      'record_not_address',
      `the NNS TXT record for ${domain} is not a Neo N3 address`,
      { domain, recordType: 'TXT' },
    );
  }
  return record;
}

async function resolveNnsName(
  recipient: string,
  domain: string,
  network: NnsNetwork,
  neoService: NeoService,
): Promise<ResolvedRecipient> {
  const contractHash = NNS_SCRIPT_HASHES[network];
  const nameParam = { type: 'String', value: domain };
  const tokenParam = { type: 'ByteArray', value: Buffer.from(domain, 'utf8').toString('base64') };

  const available = readAvailability(
    await invokeNns(neoService, contractHash, 'isAvailable', [nameParam], domain),
    domain,
  );
  if (available) {
    refuse(
      'unregistered_name',
      `${domain} is not registered on Neo N3 ${network}`,
      { domain, network },
    );
  }

  const owner = readOwner(
    await invokeNns(neoService, contractHash, 'ownerOf', [tokenParam], domain),
    domain,
    network,
  );
  const { expiry, expiryMs } = readExpiry(
    await invokeNns(neoService, contractHash, 'properties', [tokenParam], domain),
    domain,
    network,
  );
  const record = readRecordAddress(
    await invokeNns(
      neoService,
      contractHash,
      'resolve',
      [nameParam, { type: 'Integer', value: String(NNS_RECORD_TYPE_TXT) }],
      domain,
    ),
    domain,
  );

  return {
    recipient,
    source: 'nns',
    address: record,
    network,
    domain,
    contractHash,
    owner,
    expiry,
    expiryMs,
    record,
    recordType: 'TXT',
  };
}

/**
 * Resolve a transfer recipient.
 *
 * @param input `recipient` (a Neo N3 address or a .neo name) and `network`
 * @param neoService read-only Neo N3 service for the requested network
 * @throws ValidationError with `details.reason` set when the recipient must not
 *         be used as a transfer destination
 */
export async function resolveRecipient(
  input: Record<string, unknown>,
  neoService: NeoService,
): Promise<ResolvedRecipient> {
  const recipient = requireRecipient(input);
  const network = requireNetwork(input);

  const connected = neoService.getNetwork();
  if (connected !== network) {
    refuse(
      'network_mismatch',
      `network ${network} does not match the connected Neo N3 network ${connected}`,
      { requestedNetwork: network, connectedNetwork: connected },
    );
  }

  if (isNeoN3Address(recipient)) {
    return {
      recipient,
      source: 'typed',
      address: recipient,
      network,
      domain: null,
      contractHash: null,
      owner: null,
      expiry: null,
      expiryMs: null,
      record: null,
      recordType: null,
    };
  }

  const domain = normalizeDomain(recipient);
  if (domain === null) {
    refuse('not_a_recipient', 'recipient must be a Neo N3 address or a .neo name');
  }

  return await resolveNnsName(recipient, domain, network, neoService);
}

export async function dispatchRecipientResolutionTool(
  name: string,
  input: Record<string, unknown>,
  neoService: NeoService,
): Promise<Record<string, unknown>> {
  if (!RECIPIENT_RESOLUTION_TOOLS.has(name)) {
    throw new ValidationError(`Unknown recipient resolution tool: ${name}`);
  }
  return createSuccessResponse(await resolveRecipient(input, neoService));
}
