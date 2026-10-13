/**
 * Neo X live-node tool handlers.
 *
 * The unified tool surface has two orthogonal axes: the chain (`n3` | `neox`)
 * and the backend (live node RPC vs. indexer/explorer analytics). Neo N3 has
 * always had both. Neo X had only the explorer backend, so a caller asking
 * `get_block({chain: 'neox'})` had nowhere to land. This module is the missing
 * half: the seven node-backed questions, answered over EVM JSON-RPC.
 *
 * Everything here goes through `neoxNodeCall`, which enforces the node
 * read-method allowlist before a URL is even resolved. No handler in this file
 * may reach a method outside `NEOX_NODE_READ_METHODS`, and none of them ever
 * accepts a key, a signature, or a raw transaction.
 */

import { neoxNodeCall } from '../chains/neox-node-adapter';
import type { FetchLike } from '../contracts/evm-rpc-client';
import { ValidationError } from '../utils/errors';
import { createSuccessResponse, handleError } from '../utils/error-handler';
import { encodeFunctionCall, MAX_ABI_CALLDATA_BYTES } from '../utils/evm-abi';
import { validateEvmAddress, validateEvmHash } from '../utils/validation';

/** Wei per GAS on Neo X — the native token uses 18 decimals, as on Ethereum. */
const NEOX_NATIVE_DECIMALS = 18;

/** Block tags EVM nodes accept in place of a height. */
const BLOCK_TAGS: ReadonlySet<string> = new Set(['latest', 'earliest', 'pending', 'safe', 'finalized']);

const HEX_DATA_PATTERN = /^0x([0-9a-fA-F]{2})*$/;
const DECIMAL_PATTERN = /^[0-9]+$/;
const MAX_BLOCK_REFERENCE_LENGTH = 80;

/**
 * The Neo X node tools. These names are internal routing targets: the public
 * surface reaches them through the unified `chain: 'neox'` tools, never directly.
 */
export const NEOX_NODE_TOOLS: ReadonlySet<string> = new Set([
  'x_node_get_chain_info',
  'x_node_get_block_height',
  'x_node_get_block',
  'x_node_get_transaction',
  'x_node_get_balance',
  'x_node_get_transaction_status',
  'x_node_call_contract',
]);

function requestedNetwork(input: Record<string, unknown>): string | undefined {
  const raw = input.network;
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'string') {
    throw new ValidationError('network must be a string ("mainnet" or "testnet")');
  }
  return raw;
}

/** Normalises the caller-visible network back for echoing in the response. */
function reportedNetwork(input: Record<string, unknown>): string {
  const raw = requestedNetwork(input);
  return raw !== undefined && raw.trim().length > 0 && /test/i.test(raw) ? 'testnet' : 'mainnet';
}

/**
 * Converts an EVM hex quantity to a JavaScript number.
 *
 * Heights, chain ids, and confirmation counts are all far below 2^53, so a
 * number is the friendlier representation for a model to read. Values that
 * genuinely can exceed the safe range (balances, gas prices) use
 * {@link hexToDecimalString} instead.
 */
function hexToNumber(value: unknown, label: string): number {
  const big = hexToBigInt(value, label);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ValidationError(`${label} exceeds the safe integer range: ${big.toString()}`);
  }
  return Number(big);
}

function hexToBigInt(value: unknown, label: string): bigint {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new ValidationError(`Node returned a malformed ${label}: ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

/** Renders a hex quantity as a decimal string, safe for values above 2^53. */
function hexToDecimalString(value: unknown, label: string): string {
  return hexToBigInt(value, label).toString();
}

/**
 * Formats a wei amount as a decimal string with `decimals` fractional digits,
 * trimming trailing zeros. Done with BigInt arithmetic so that no balance is
 * ever rounded through a float.
 */
export function formatUnits(wei: bigint, decimals: number): string {
  const negative = wei < 0n;
  const magnitude = negative ? -wei : wei;
  const divisor = 10n ** BigInt(decimals);
  const whole = magnitude / divisor;
  const fraction = magnitude % divisor;
  const sign = negative ? '-' : '';
  if (fraction === 0n) {
    return `${sign}${whole.toString()}`;
  }
  const fractionDigits = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${sign}${whole.toString()}.${fractionDigits}`;
}

/**
 * Resolves a block reference into the JSON-RPC method and parameter that fetch
 * it: a 32-byte hash goes to `eth_getBlockByHash`, anything numeric or a tag
 * goes to `eth_getBlockByNumber` with a hex quantity.
 */
function resolveBlockLookup(reference: unknown): { method: string; param: string } {
  if (typeof reference === 'number') {
    if (!Number.isSafeInteger(reference) || reference < 0) {
      throw new ValidationError(`Invalid block height: ${reference}. Expected a non-negative integer.`);
    }
    return { method: 'eth_getBlockByNumber', param: `0x${reference.toString(16)}` };
  }
  if (typeof reference !== 'string' || reference.trim().length === 0) {
    throw new ValidationError('A block hash, height, or tag is required.');
  }
  const trimmed = reference.trim();
  if (trimmed.length > MAX_BLOCK_REFERENCE_LENGTH) {
    throw new ValidationError(`Block reference exceeds the ${MAX_BLOCK_REFERENCE_LENGTH}-character limit`);
  }
  if (BLOCK_TAGS.has(trimmed.toLowerCase())) {
    return { method: 'eth_getBlockByNumber', param: trimmed.toLowerCase() };
  }
  if (DECIMAL_PATTERN.test(trimmed)) {
    return { method: 'eth_getBlockByNumber', param: `0x${BigInt(trimmed).toString(16)}` };
  }
  if (/^0x[0-9a-fA-F]+$/.test(trimmed) && trimmed.length !== 66) {
    return { method: 'eth_getBlockByNumber', param: `0x${BigInt(trimmed).toString(16)}` };
  }
  // Anything left must be a block hash; validateEvmHash produces the precise
  // "expected 64 hex characters" message for everything that is not one.
  return { method: 'eth_getBlockByHash', param: validateEvmHash(trimmed) };
}

function requireEvmData(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${label} must be a non-empty hex string`);
  }
  const trimmed = value.trim();
  const prefixed = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  if (!HEX_DATA_PATTERN.test(prefixed)) {
    throw new ValidationError(`${label} must be 0x-prefixed hex with an even number of digits`);
  }
  if ((prefixed.length - 2) / 2 > MAX_ABI_CALLDATA_BYTES) {
    throw new ValidationError(`${label} exceeds the ${MAX_ABI_CALLDATA_BYTES}-byte limit`);
  }
  return prefixed.toLowerCase();
}

async function handleGetChainInfo(
  input: Record<string, unknown>,
  fetchImpl?: FetchLike,
): Promise<unknown> {
  const network = requestedNetwork(input);
  const [chainId, blockNumber, gasPrice] = await Promise.all([
    neoxNodeCall<string>(network, 'eth_chainId', [], undefined, fetchImpl),
    neoxNodeCall<string>(network, 'eth_blockNumber', [], undefined, fetchImpl),
    neoxNodeCall<string>(network, 'eth_gasPrice', [], undefined, fetchImpl),
  ]);
  return createSuccessResponse({
    chain: 'neox',
    network: reportedNetwork(input),
    chainId: hexToNumber(chainId, 'chain id'),
    blockHeight: hexToNumber(blockNumber, 'block number'),
    gasPrice: hexToDecimalString(gasPrice, 'gas price'),
    gasPriceUnit: 'wei',
    nativeSymbol: 'GAS',
    nativeDecimals: NEOX_NATIVE_DECIMALS,
  });
}

async function handleGetBlockHeight(
  input: Record<string, unknown>,
  fetchImpl?: FetchLike,
): Promise<unknown> {
  const network = requestedNetwork(input);
  const blockNumber = await neoxNodeCall<string>(network, 'eth_blockNumber', [], undefined, fetchImpl);
  const height = hexToNumber(blockNumber, 'block number');
  return createSuccessResponse({
    chain: 'neox',
    network: reportedNetwork(input),
    blockHeight: height,
    // Neo N3 reports a count (height + 1); both are given so a caller
    // comparing the two chains does not have to know which convention applies.
    blockCount: height + 1,
  });
}

async function handleGetBlock(
  input: Record<string, unknown>,
  fetchImpl?: FetchLike,
): Promise<unknown> {
  const network = requestedNetwork(input);
  const lookup = resolveBlockLookup(input.blockHashOrHeight ?? input.hashOrHeight);
  const includeTransactions = input.includeTransactions === true;
  const block = await neoxNodeCall<Record<string, unknown> | null>(
    network,
    lookup.method,
    [lookup.param, includeTransactions],
    undefined,
    fetchImpl,
  );
  if (block === null || block === undefined) {
    throw new ValidationError(`Block not found on Neo X: ${lookup.param}`);
  }
  return createSuccessResponse({
    chain: 'neox',
    network: reportedNetwork(input),
    blockNumber: hexToNumber(block.number, 'block number'),
    block,
  });
}

async function handleGetTransaction(
  input: Record<string, unknown>,
  fetchImpl?: FetchLike,
): Promise<unknown> {
  const network = requestedNetwork(input);
  const hash = validateEvmHash(input.hash as string);
  const transaction = await neoxNodeCall<Record<string, unknown> | null>(
    network,
    'eth_getTransactionByHash',
    [hash],
    undefined,
    fetchImpl,
  );
  if (transaction === null || transaction === undefined) {
    throw new ValidationError(`Transaction not found on Neo X: ${hash}`);
  }
  return createSuccessResponse({
    chain: 'neox',
    network: reportedNetwork(input),
    transaction,
  });
}

async function handleGetBalance(
  input: Record<string, unknown>,
  fetchImpl?: FetchLike,
): Promise<unknown> {
  const network = requestedNetwork(input);
  const address = validateEvmAddress(input.address as string);
  const wei = await neoxNodeCall<string>(
    network,
    'eth_getBalance',
    [address, 'latest'],
    undefined,
    fetchImpl,
  );
  const value = hexToBigInt(wei, 'balance');
  return createSuccessResponse({
    chain: 'neox',
    network: reportedNetwork(input),
    address,
    symbol: 'GAS',
    decimals: NEOX_NATIVE_DECIMALS,
    wei: value.toString(),
    balance: formatUnits(value, NEOX_NATIVE_DECIMALS),
  });
}

async function handleGetTransactionStatus(
  input: Record<string, unknown>,
  fetchImpl?: FetchLike,
): Promise<unknown> {
  const network = requestedNetwork(input);
  const hash = validateEvmHash(input.hash as string);
  const receipt = await neoxNodeCall<Record<string, unknown> | null>(
    network,
    'eth_getTransactionReceipt',
    [hash],
    undefined,
    fetchImpl,
  );

  if (receipt === null || receipt === undefined) {
    // No receipt means either "in the mempool" or "never seen". Only a pool
    // lookup separates the two, and the difference matters: one is worth
    // waiting on, the other means the hash is wrong.
    const pooled = await neoxNodeCall<Record<string, unknown> | null>(
      network,
      'eth_getTransactionByHash',
      [hash],
      undefined,
      fetchImpl,
    );
    const known = pooled !== null && pooled !== undefined;
    return createSuccessResponse({
      chain: 'neox',
      network: reportedNetwork(input),
      hash,
      status: known ? 'pending' : 'unknown',
      succeeded: false,
      confirmations: 0,
    });
  }

  const blockNumber = hexToNumber(receipt.blockNumber, 'block number');
  const tip = hexToNumber(
    await neoxNodeCall<string>(network, 'eth_blockNumber', [], undefined, fetchImpl),
    'block number',
  );
  return createSuccessResponse({
    chain: 'neox',
    network: reportedNetwork(input),
    hash,
    status: 'confirmed',
    // An EVM receipt status of 0x0 means the transaction was mined but
    // reverted: confirmed on chain, unsuccessful in effect.
    succeeded: hexToBigInt(receipt.status, 'receipt status') === 1n,
    blockNumber,
    blockHash: receipt.blockHash,
    confirmations: Math.max(0, tip - blockNumber + 1),
    gasUsed: hexToDecimalString(receipt.gasUsed, 'gas used'),
  });
}

async function handleCallContract(
  input: Record<string, unknown>,
  fetchImpl?: FetchLike,
): Promise<unknown> {
  const network = requestedNetwork(input);
  const to = validateEvmAddress((input.contract ?? input.to) as string);

  let data: string;
  if (input.data !== undefined) {
    data = requireEvmData(input.data, 'data');
  } else if (input.functionSignature !== undefined) {
    if (typeof input.functionSignature !== 'string' || input.functionSignature.trim().length === 0) {
      throw new ValidationError('functionSignature must be a non-empty string');
    }
    const args = input.args === undefined ? [] : input.args;
    if (!Array.isArray(args)) {
      throw new ValidationError('args must be an array when using functionSignature');
    }
    data = encodeFunctionCall(input.functionSignature.trim(), args);
  } else {
    throw new ValidationError(
      'Provide either pre-encoded "data" or a "functionSignature" (+ args) to encode.',
    );
  }

  const callObject: Record<string, string> = { to, data };
  if (input.from !== undefined) {
    callObject.from = validateEvmAddress(input.from as string);
  }

  const returned = await neoxNodeCall<string>(
    network,
    'eth_call',
    [callObject, 'latest'],
    undefined,
    fetchImpl,
  );
  return createSuccessResponse({
    chain: 'neox',
    network: reportedNetwork(input),
    contract: to,
    data: returned,
    // eth_call throws on revert, so reaching here means the call executed.
    // "HALT" mirrors the Neo N3 VM state vocabulary the N3 tools report.
    state: 'HALT',
  });
}

/**
 * Routes a Neo X node tool name to its handler.
 *
 * `fetchImpl` exists so tests can inject a stub; production callers omit it and
 * the adapter uses the global fetch.
 */
export async function dispatchNeoxNodeTool(
  name: string,
  input: Record<string, unknown>,
  fetchImpl?: FetchLike,
): Promise<unknown> {
  if (!NEOX_NODE_TOOLS.has(name)) {
    throw new Error(`${name} is not a Neo X node tool`);
  }
  const args = input ?? {};
  try {
    switch (name) {
      case 'x_node_get_chain_info':
        return await handleGetChainInfo(args, fetchImpl);
      case 'x_node_get_block_height':
        return await handleGetBlockHeight(args, fetchImpl);
      case 'x_node_get_block':
        return await handleGetBlock(args, fetchImpl);
      case 'x_node_get_transaction':
        return await handleGetTransaction(args, fetchImpl);
      case 'x_node_get_balance':
        return await handleGetBalance(args, fetchImpl);
      case 'x_node_get_transaction_status':
        return await handleGetTransactionStatus(args, fetchImpl);
      default:
        return await handleCallContract(args, fetchImpl);
    }
  } catch (error) {
    return handleError(error);
  }
}
