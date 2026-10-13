// Pure builders for UNSIGNED transaction proposals (Neo N3 + Neo X).
//
// A "proposal" is a plain data object describing a transaction the user's own
// wallet (NeoLine / WalletConnect for N3, MetaMask for Neo X) will review and
// sign. These builders construct the wallet-facing parameters ONLY — they never
// sign, never hold a key, and never broadcast. Nothing in this module imports a
// signer, a wallet store, or the write-operation-service: that is the hard
// non-custodial boundary for the agent's write layer.

import * as neonJs from '@cityofzion/neon-js';
import { ValidationError } from './errors';
import { formatContractParameters, FormattedContractParameter } from './contract-params';
import { validateAddress, validateScriptHash, validateEvmAddress, validateEvmAmount } from './validation';
import { MAX_ABI_CALLDATA_BYTES } from './evm-abi';

// Native NEP-17 contract hashes (identical on Neo N3 mainnet and testnet).
export const NEO_NATIVE_SCRIPT_HASH = '0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5';
export const GAS_NATIVE_SCRIPT_HASH = '0xd2a4cff31913016155e38e474a2c06d08be276cf';

export type N3Network = 'mainnet' | 'testnet';

export interface N3InvokeProposal {
  proposal: true;
  chain: 'n3';
  kind: 'invoke';
  network: N3Network;
  scriptHash: string;
  operation: string;
  args: FormattedContractParameter[];
  signers: Array<{ account: string; scopes: string }>;
  from: string;
  /** Recipient address for transfer proposals; absent for generic invokes. */
  to?: string;
  summary: string;
  simulation?: N3Simulation;
  signingNote: string;
}

export interface N3Simulation {
  state: string;
  gasConsumed: string | null;
  exception: string | null;
  stack?: unknown[];
}

export interface EvmTxProposal {
  proposal: true;
  chain: 'neox';
  kind: 'eth_tx';
  network: 'neox-mainnet' | 'neox-testnet';
  tx: {
    from: string;
    to: string;
    value: string;
    data: string;
    chainId: string;
    gas: string;
    gasPrice: string;
  };
  summary: string;
  signingNote: string;
}

const SIGNING_NOTE_N3 =
  'UNSIGNED proposal. This MCP server never signs or broadcasts. '
  + 'Hand these invoke params to the user\'s NeoLine/WalletConnect wallet to sign and send.';
const SIGNING_NOTE_EVM =
  'UNSIGNED proposal. This MCP server never signs or broadcasts. '
  + 'Hand this transaction to the user\'s MetaMask wallet to fill the nonce, sign, and send.';

/**
 * Resolve a NEP-17 asset identifier to its 0x-prefixed contract script hash.
 * Accepts the symbols "NEO"/"GAS" (case-insensitive) or a raw script hash.
 */
export function resolveNep17ScriptHash(asset: string): { scriptHash: string; symbol?: string } {
  if (typeof asset !== 'string' || asset.trim().length === 0) {
    throw new ValidationError('Asset must be "NEO", "GAS", or a NEP-17 script hash');
  }
  const trimmed = asset.trim();
  const upper = trimmed.toUpperCase();
  if (upper === 'NEO') {
    return { scriptHash: NEO_NATIVE_SCRIPT_HASH, symbol: 'NEO' };
  }
  if (upper === 'GAS') {
    return { scriptHash: GAS_NATIVE_SCRIPT_HASH, symbol: 'GAS' };
  }
  return { scriptHash: validateScriptHash(trimmed) };
}

/** Default decimals for the native tokens; undefined for anything else. */
export function defaultDecimalsForScriptHash(scriptHash: string): number | undefined {
  const normalized = scriptHash.toLowerCase();
  if (normalized === NEO_NATIVE_SCRIPT_HASH) return 0;
  if (normalized === GAS_NATIVE_SCRIPT_HASH) return 8;
  return undefined;
}

/**
 * Scale a human decimal amount to a raw integer using `decimals`, safely and
 * without floating point. Rejects negatives, zero, and over-precision.
 */
export function scaleTokenAmount(amount: string, decimals: number): string {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new ValidationError(`Invalid token decimals: ${decimals}`);
  }
  if (typeof amount !== 'string' || !/^\d+(?:\.\d+)?$/.test(amount.trim())) {
    throw new ValidationError('Amount must be a positive decimal string');
  }
  const [whole, fraction = ''] = amount.trim().split('.');
  if (fraction.length > decimals) {
    throw new ValidationError(`Amount has more than ${decimals} decimal places`);
  }
  const scaled = BigInt(`${whole}${fraction.padEnd(decimals, '0')}`);
  if (scaled <= 0n) {
    throw new ValidationError(`Amount must be greater than zero: ${amount}`);
  }
  if (scaled > (1n << 255n) - 1n) {
    throw new ValidationError('Scaled amount exceeds the Neo VM integer range');
  }
  return scaled.toString();
}

/** Big-endian script hash (no 0x) for a validated Neo N3 address, for Hash160 args. */
function addressToHash160Value(address: string): string {
  return neonJs.wallet.getScriptHashFromAddress(address).toLowerCase();
}

/** RPC/dapi signer for a Neo N3 address with CalledByEntry scope. */
export function calledByEntrySigner(address: string): { account: string; scopes: string } {
  return { account: `0x${addressToHash160Value(address)}`, scopes: 'CalledByEntry' };
}

/**
 * Build an UNSIGNED NEP-17 transfer proposal (NeoLine dapi invoke params).
 * `decimals` must already be resolved (0 for NEO, 8 for GAS, token decimals otherwise).
 */
export function buildN3TransferProposal(input: {
  network: N3Network;
  from: string;
  to: string;
  asset: string;
  amount: string;
  decimals: number;
}): N3InvokeProposal {
  const from = validateAddress(input.from);
  const to = validateAddress(input.to);
  const { scriptHash, symbol } = resolveNep17ScriptHash(input.asset);
  const rawAmount = scaleTokenAmount(input.amount, input.decimals);

  // Unified typed args, valid both as NeoLine dapi args and RPC invokefunction params.
  const args = formatContractParameters([from, to, BigInt(rawAmount), null]);
  const assetLabel = symbol ?? scriptHash;

  return {
    proposal: true,
    chain: 'n3',
    kind: 'invoke',
    network: input.network,
    scriptHash,
    operation: 'transfer',
    args,
    signers: [{ account: from, scopes: 'CalledByEntry' }],
    from,
    to,
    summary: `Transfer ${input.amount} ${assetLabel} from ${from} to ${to} on Neo N3 ${input.network}.`,
    signingNote: SIGNING_NOTE_N3,
  };
}

/**
 * Build an UNSIGNED generic contract-invoke proposal (NeoLine dapi invoke params).
 */
export function buildN3InvokeProposal(input: {
  network: N3Network;
  scriptHash: string;
  operation: string;
  args?: unknown[];
  from: string;
  signers?: Array<{ account: string; scopes: string }>;
}): N3InvokeProposal {
  const scriptHash = validateScriptHash(input.scriptHash);
  const from = validateAddress(input.from);
  if (typeof input.operation !== 'string' || input.operation.trim().length === 0) {
    throw new ValidationError('operation must be a non-empty string');
  }
  const args = formatContractParameters(Array.isArray(input.args) ? input.args : []);
  const signers = Array.isArray(input.signers) && input.signers.length > 0
    ? input.signers
    : [{ account: from, scopes: 'CalledByEntry' }];

  return {
    proposal: true,
    chain: 'n3',
    kind: 'invoke',
    network: input.network,
    scriptHash,
    operation: input.operation.trim(),
    args,
    signers,
    from,
    summary: `Invoke ${input.operation.trim()} on ${scriptHash} (Neo N3 ${input.network}), signed by ${from}.`,
    signingNote: SIGNING_NOTE_N3,
  };
}

/** RPC invokefunction params (formatted) + signers for simulating an invoke proposal. */
export function simulationRequestFor(proposal: N3InvokeProposal): {
  scriptHash: string;
  operation: string;
  params: FormattedContractParameter[];
  signers: Array<{ account: string; scopes: string }>;
} {
  // Signers for RPC must use the 0x script-hash account form. Proposal signers
  // may carry either a Neo N3 address (dapi form) or an 0x script hash.
  const signers = proposal.signers.map((signer) => {
    if (/^0x[0-9a-fA-F]{40}$/.test(signer.account)) {
      return { account: signer.account.toLowerCase(), scopes: signer.scopes };
    }
    return { account: calledByEntrySigner(validateAddress(signer.account)).account, scopes: signer.scopes };
  });
  return {
    scriptHash: proposal.scriptHash,
    operation: proposal.operation,
    params: proposal.args,
    signers,
  };
}

// --- Neo X (EVM) ------------------------------------------------------------

/** Convert a non-negative integer (bigint/number/decimal or 0x-hex string) to a minimal 0x-hex quantity. */
export function toHexQuantity(value: bigint | number | string): string {
  let big: bigint;
  if (typeof value === 'bigint') {
    big = value;
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ValidationError('Quantity must be a non-negative safe integer');
    }
    big = BigInt(value);
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
      big = BigInt(trimmed);
    } else if (/^[0-9]+$/.test(trimmed)) {
      big = BigInt(trimmed);
    } else {
      throw new ValidationError(`Invalid quantity: ${value}`);
    }
  } else {
    throw new ValidationError('Quantity must be a bigint, number, or string');
  }
  if (big < 0n) {
    throw new ValidationError('Quantity must not be negative');
  }
  return `0x${big.toString(16)}`;
}

export function normalizeCalldata(data: unknown): string {
  if (data === undefined || data === null || data === '') {
    return '0x';
  }
  if (typeof data !== 'string') {
    throw new ValidationError('Calldata must be a 0x-hex string');
  }
  const body = data.startsWith('0x') || data.startsWith('0X') ? data.slice(2) : data;
  if (body.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(body)) {
    throw new ValidationError(`Invalid calldata (not even-length hex): ${data}`);
  }
  if (body.length / 2 > MAX_ABI_CALLDATA_BYTES) {
    throw new ValidationError(`Calldata exceeds the ${MAX_ABI_CALLDATA_BYTES}-byte limit`);
  }
  return `0x${body.toLowerCase()}`;
}

/**
 * Build an UNSIGNED Neo X (EVM) transaction proposal. `gas` and `gasPrice` are
 * the values already fetched from the read-only RPC (eth_estimateGas /
 * eth_gasPrice). No nonce is included — the wallet fills it. Nothing is signed.
 */
export function buildEvmTxProposal(input: {
  network: 'neox-mainnet' | 'neox-testnet';
  from: string;
  to: string;
  valueWei: string;
  data?: string;
  chainId: number;
  gas: bigint | number | string;
  gasPrice: bigint | number | string;
  summary?: string;
}): EvmTxProposal {
  const from = validateEvmAddress(input.from);
  const to = validateEvmAddress(input.to);
  const value = validateEvmAmount(input.valueWei, { allowZero: true });
  const data = normalizeCalldata(input.data);
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) {
    throw new ValidationError('chainId must be a positive integer');
  }

  return {
    proposal: true,
    chain: 'neox',
    kind: 'eth_tx',
    network: input.network,
    tx: {
      from,
      to,
      value: toHexQuantity(value),
      data,
      chainId: toHexQuantity(input.chainId),
      gas: toHexQuantity(input.gas),
      gasPrice: toHexQuantity(input.gasPrice),
    },
    summary: input.summary
      ?? `Neo X ${input.network} transaction from ${from} to ${to} (value ${value} wei).`,
    signingNote: SIGNING_NOTE_EVM,
  };
}
