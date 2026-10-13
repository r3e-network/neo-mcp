/**
 * Validation utilities for Neo MCP Server
 * Provides robust validation for input parameters
 *
 * This module contains comprehensive validation functions for all Neo N3 blockchain
 * related parameters, ensuring data integrity and security.
 */

import * as neonJs from '@cityofzion/neon-js';
import type { NeoNetwork } from '../services/neo-service';
import { ValidationError } from './errors';
import { logger } from './logger';

// Constants for validation
const MAX_GAS_AMOUNT = 1_000_000_000; // 1 billion GAS
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 100;
const NEO_ADDRESS_PATTERN = /^[A-Za-z0-9]{34}$/;
const HASH_LENGTH = 64; // 32 bytes * 2 chars per byte
const SCRIPT_HASH_LENGTH = 40; // 20 bytes * 2 chars per byte
const HEX_PATTERN = /^[0-9a-fA-F]+$/;
const POSITIVE_NUMBER_PATTERN = /^[0-9]+(\.[0-9]+)?$/;
const POSITIVE_INTEGER_PATTERN = /^[0-9]+$/;
/** A uint256 has at most 78 decimal digits; reject larger input before BigInt. */
export const MAX_EVM_AMOUNT_DIGITS = 78;

/**
 * Validate Neo N3 address format
 * @param address Neo N3 address to validate
 * @returns Validated address
 * @throws ValidationError if invalid
 */
export function validateAddress(address: string): string {
  if (!address || typeof address !== 'string') {
    throw new ValidationError('Address must be a non-empty string');
  }

  // Check basic format (Neo N3 addresses are 34 characters)
  if (!NEO_ADDRESS_PATTERN.test(address)) {
    throw new ValidationError(`Invalid Neo N3 address format: ${address}`);
  }

  try {
    if (!neonJs.wallet.isAddress(address, neonJs.CONST.DEFAULT_ADDRESS_VERSION)) {
      throw new Error('Invalid address checksum or version');
    }
    const scriptHash = neonJs.wallet.getScriptHashFromAddress(address);
    if (!scriptHash || scriptHash.length !== SCRIPT_HASH_LENGTH) {
      throw new Error('Invalid address conversion');
    }
  } catch (error) {
    logger.warn(`Address validation failed: ${address}`, {
      error: error instanceof Error ? error.message : String(error)
    });
    throw new ValidationError(`Invalid Neo N3 address: ${address}`);
  }

  return address;
}

/**
 * Validate transaction hash format
 * @param hash Transaction hash to validate
 * @returns Validated hash
 * @throws ValidationError if invalid
 */
export function validateHash(hash: string): string {
  if (!hash || typeof hash !== 'string') {
    throw new ValidationError('Hash must be a non-empty string');
  }

  // Remove '0x' prefix if present
  const cleanHash = hash.startsWith('0x') ? hash.substring(2) : hash;

  // Check length (64 characters for a transaction hash without '0x')
  if (cleanHash.length !== HASH_LENGTH) {
    throw new ValidationError(`Invalid hash length: ${hash}. Expected ${HASH_LENGTH} characters (without 0x prefix).`);
  }

  // Check if hexadecimal
  if (!HEX_PATTERN.test(cleanHash)) {
    throw new ValidationError(`Invalid hash format (not hexadecimal): ${hash}`);
  }

  // Return normalized form (with 0x prefix)
  return `0x${cleanHash}`;
}

/**
 * Validate script hash format
 * @param scriptHash Script hash to validate
 * @returns Validated script hash
 * @throws ValidationError if invalid
 */
export function validateScriptHash(scriptHash: string): string {
  if (!scriptHash || typeof scriptHash !== 'string') {
    throw new ValidationError('Script hash must be a non-empty string');
  }

  // Remove '0x' prefix if present
  const cleanHash = scriptHash.startsWith('0x') ? scriptHash.substring(2) : scriptHash;

  // Check length (40 characters for a Neo script hash without '0x')
  if (cleanHash.length !== SCRIPT_HASH_LENGTH) {
    throw new ValidationError(`Invalid script hash length: ${scriptHash}. Expected ${SCRIPT_HASH_LENGTH} characters (without 0x prefix).`);
  }

  // Check if hexadecimal
  if (!HEX_PATTERN.test(cleanHash)) {
    throw new ValidationError(`Invalid script hash format (not hexadecimal): ${scriptHash}`);
  }

  // Return normalized form (with 0x prefix)
  return `0x${cleanHash}`;
}

const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const EVM_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/**
 * Validate a Neo X (EVM) 20-byte account/contract address.
 * Accepts an optional "0x" prefix and normalizes to a lowercase 0x-prefixed
 * form. Checksum casing (EIP-55) is not enforced.
 * @param address EVM address to validate
 * @returns Normalized lowercase 0x-prefixed address
 * @throws ValidationError if invalid
 */
export function validateEvmAddress(address: string): string {
  if (!address || typeof address !== 'string') {
    throw new ValidationError('EVM address must be a non-empty string');
  }
  const prefixed = address.startsWith('0x') || address.startsWith('0X') ? address : `0x${address}`;
  if (!EVM_ADDRESS_PATTERN.test(prefixed)) {
    throw new ValidationError(`Invalid Neo X address format: ${address}. Expected 40 hex characters (optional 0x prefix).`);
  }
  return prefixed.toLowerCase();
}

/**
 * Validate a Neo X (EVM) 32-byte transaction or block hash.
 * Accepts an optional "0x" prefix and normalizes to a lowercase 0x-prefixed
 * form.
 * @param hash EVM hash to validate
 * @returns Normalized lowercase 0x-prefixed hash
 * @throws ValidationError if invalid
 */
export function validateEvmHash(hash: string): string {
  if (!hash || typeof hash !== 'string') {
    throw new ValidationError('EVM hash must be a non-empty string');
  }
  const prefixed = hash.startsWith('0x') || hash.startsWith('0X') ? hash : `0x${hash}`;
  if (!EVM_HASH_PATTERN.test(prefixed)) {
    throw new ValidationError(`Invalid Neo X hash format: ${hash}. Expected 64 hex characters (optional 0x prefix).`);
  }
  return prefixed.toLowerCase();
}

/**
 * Validate a Neo X block reference: either a non-negative block number or a
 * 32-byte block hash.
 * @param reference Block number (string or number) or 0x block hash
 * @returns Normalized reference (decimal string for numbers, lowercase 0x hash otherwise)
 * @throws ValidationError if invalid
 */
export function validateEvmBlockRef(reference: string | number): string {
  if (typeof reference === 'number') {
    if (!Number.isSafeInteger(reference) || reference < 0) {
      throw new ValidationError('Block number must be a non-negative safe integer');
    }
    return String(reference);
  }
  if (!reference || typeof reference !== 'string') {
    throw new ValidationError('Block reference must be a non-empty string or number');
  }
  const trimmed = reference.trim();
  if (POSITIVE_INTEGER_PATTERN.test(trimmed)) {
    return trimmed;
  }
  return validateEvmHash(trimmed);
}

/**
 * Validate amount with decimal support
 * @param amount Amount to validate
 * @returns Normalized amount as string
 * @throws ValidationError if invalid
 */
export function validateAmount(amount: string | number): string {
  let numericAmount: number;

  if (typeof amount === 'string') {
    // Check for valid number format
    if (!POSITIVE_NUMBER_PATTERN.test(amount)) {
      throw new ValidationError(`Invalid amount format: ${amount}. Must be a positive number.`);
    }
    numericAmount = parseFloat(amount);
  } else if (typeof amount === 'number') {
    if (isNaN(amount) || !isFinite(amount)) {
      throw new ValidationError('Amount must be a valid number');
    }
    numericAmount = amount;
  } else {
    throw new ValidationError('Amount must be a number or numeric string');
  }

  // Check range
  if (numericAmount <= 0) {
    throw new ValidationError('Amount must be greater than zero');
  }

  // Check for reasonable max value
  if (numericAmount > MAX_GAS_AMOUNT) {
    throw new ValidationError(`Amount exceeds maximum allowed (${MAX_GAS_AMOUNT})`);
  }

  // Return normalized string format with up to 8 decimal places (Neo precision)
  return numericAmount.toString();
}

/**
 * Validate a token amount without converting through JavaScript floating point.
 */
export function validateTokenAmount(amount: unknown): string {
  if (typeof amount !== 'string' || amount !== amount.trim() || amount.length === 0) {
    throw new ValidationError('Token amount must be provided as a non-empty decimal string');
  }
  if (amount.length > 1_024 || !/^\d+(?:\.\d+)?$/.test(amount)) {
    throw new ValidationError('Token amount must be a positive decimal string without exponent notation');
  }
  if (!/[1-9]/.test(amount)) {
    throw new ValidationError('Token amount must be greater than zero');
  }
  return amount;
}

/**
 * Validate a Neo X (EVM) amount expressed in wei as a non-negative integer.
 * Accepts a decimal string (preferred, to avoid float precision loss), a safe
 * integer number, or a bigint. Rejects negatives, fractions, NaN, and exponent
 * notation.
 * @param amount Wei amount
 * @param options.allowZero Permit a zero amount (default false)
 * @returns The amount as a canonical non-negative decimal wei string
 * @throws ValidationError if invalid
 */
export function validateEvmAmount(
  amount: unknown,
  options: { allowZero?: boolean } = {}
): string {
  let normalized: string;
  if (typeof amount === 'bigint') {
    normalized = amount.toString();
  } else if (typeof amount === 'number') {
    if (!Number.isSafeInteger(amount)) {
      throw new ValidationError('Wei amount number must be a safe integer; pass a decimal string for large values');
    }
    normalized = amount.toString();
  } else if (typeof amount === 'string') {
    const trimmed = amount.trim();
    if (trimmed.length > MAX_EVM_AMOUNT_DIGITS) {
      throw new ValidationError(`Wei amount exceeds the ${MAX_EVM_AMOUNT_DIGITS}-digit limit`);
    }
    if (!POSITIVE_INTEGER_PATTERN.test(trimmed)) {
      throw new ValidationError(`Invalid wei amount: ${amount}. Must be a non-negative integer string (no decimals or exponent).`);
    }
    normalized = trimmed;
  } else {
    throw new ValidationError('Wei amount must be a decimal string, safe integer, or bigint');
  }

  const value = BigInt(normalized);
  if (value < 0n) {
    throw new ValidationError('Wei amount must not be negative');
  }
  if (value === 0n && !options.allowZero) {
    throw new ValidationError('Wei amount must be greater than zero');
  }
  // Reject leading zeros ("007") by re-canonicalizing through BigInt.
  return value.toString();
}

/**
 * Validate password
 * @param password Password to validate
 * @returns Validated password
 * @throws ValidationError if invalid
 */
export function validatePassword(password: string): string {
  if (!password || typeof password !== 'string') {
    throw new ValidationError('Password must be a non-empty string');
  }

  // Check minimum length
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long`);
  }
  if (!/\S/.test(password)) {
    throw new ValidationError('Password must contain at least one non-whitespace character');
  }

  // Check maximum length to prevent DoS attacks
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new ValidationError(`Password must be less than ${MAX_PASSWORD_LENGTH} characters long`);
  }

  // Return the password
  return password;
}

/**
 * Validate Neo network
 * @param network Network to validate
 * @returns Validated network
 * @throws ValidationError if invalid
 */
export function validateNetwork(network?: string): NeoNetwork {
  if (!network) {
    return 'mainnet' as NeoNetwork;
  }

  if (typeof network !== 'string') {
    throw new ValidationError('Network must be a string');
  }

  const normalizedNetwork = network.toLowerCase().trim();

  if (normalizedNetwork === 'mainnet' || normalizedNetwork === 'testnet') {
    return normalizedNetwork as NeoNetwork;
  }

  throw new ValidationError(`Invalid network: ${network}. Must be one of: mainnet, testnet`);
}

/**
 * Sanitize string by removing control characters and trimming whitespace
 * @param input String to sanitize
 * @returns Sanitized string
 * @throws ValidationError if not a string
 */
export function sanitizeString(input: string): string {
  if (typeof input !== 'string') {
    throw new ValidationError('Input must be a string');
  }

  // Remove control characters and trim whitespace
  return input
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')  // Control chars
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Remove script tags and content
    .replace(/<[^>]*>/g, '')                        // Remove other HTML tags
    .trim();
}

/**
 * Validate boolean value
 * @param value Boolean value to validate
 * @returns Validated boolean
 * @throws ValidationError if invalid
 */
export function validateBoolean(value: boolean | string | number): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    // Be strict - no whitespace allowed
    if (value !== value.trim()) {
      throw new ValidationError(`Invalid boolean value: ${value}. No whitespace allowed.`);
    }
    
    const normalizedValue = value.toLowerCase();
    if (normalizedValue === 'true') return true;
    if (normalizedValue === 'false') return false;
    if (normalizedValue === '1') return true;
    if (normalizedValue === '0') return false;
    throw new ValidationError(`Invalid boolean value: ${value}. Must be 'true', 'false', '1', or '0'.`);
  }

  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    throw new ValidationError(`Invalid boolean value: ${value}. Must be 1 or 0.`);
  }

  throw new ValidationError('Boolean value must be a boolean, string, or number.');
}

/**
 * Validate positive integer
 * @param value Integer value to validate
 * @returns Validated integer
 * @throws ValidationError if invalid
 */
export function validateInteger(value: number | string): number {
  let intValue: number;

  if (typeof value === 'string') {
    if (!POSITIVE_INTEGER_PATTERN.test(value)) {
      throw new ValidationError(`Invalid integer format: ${value}`);
    }
    intValue = parseInt(value, 10);
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new ValidationError('Value must be a safe integer');
    }
    intValue = value;
  } else {
    throw new ValidationError('Value must be a number or numeric string');
  }

  if (!Number.isSafeInteger(intValue)) {
    throw new ValidationError('Value must be a safe integer');
  }

  if (intValue < 0) {
    throw new ValidationError('Value must be a positive integer');
  }

  return intValue;
}

/**
 * Validate contract name
 * @param contractName Contract name to validate
 * @param availableContracts List of available contract names
 * @returns Validated contract name
 * @throws ValidationError if invalid
 */
export function validateContractName(contractName: string, availableContracts: string[]): string {
  if (!contractName || typeof contractName !== 'string') {
    throw new ValidationError('Contract name must be a non-empty string');
  }

  // Sanitize and normalize contract name (case-insensitive)
  const normalizedName = contractName.trim();
  const lowerCaseName = normalizedName.toLowerCase();

  // Find the contract name case-insensitively
  const matchingContract = availableContracts.find(c => c.toLowerCase() === lowerCaseName);

  if (availableContracts.length > 0 && !matchingContract) {
    throw new ValidationError(
      `Invalid contract name: ${normalizedName}. ` +
      `Available contracts: ${availableContracts.join(', ')}`
    );
  }

  // Return the name with the correct casing from the available list
  return matchingContract || normalizedName; // Fallback to original if somehow not found after check
}

/**
 * Validate contract operation
 * @param operation Operation name to validate
 * @param availableOperations List of available operations
 * @returns Validated operation name
 * @throws ValidationError if invalid
 */
export function validateContractOperation(operation: string, availableOperations: string[]): string {
  if (!operation || typeof operation !== 'string') {
    throw new ValidationError('Operation name must be a non-empty string');
  }

  // Sanitize and normalize operation name
  const normalizedOperation = operation.trim();

  // Check if operation is in the list of available operations
  if (availableOperations.length > 0 && !availableOperations.includes(normalizedOperation)) {
    throw new ValidationError(
      `Invalid operation: ${normalizedOperation}. ` +
      `Available operations: ${availableOperations.join(', ')}`
    );
  }

  return normalizedOperation;
}
