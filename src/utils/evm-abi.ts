// Minimal, self-contained EVM ABI encoder for building UNSIGNED Neo X call
// proposals. It computes 4-byte function selectors (keccak256 of the signature)
// and ABI-encodes a common subset of argument types. There is no dependency on
// ethers/web3; keccak256 is implemented here because Node's crypto exposes
// sha3-256 (different padding) but not Ethereum's keccak256.
//
// This module NEVER signs or broadcasts anything — it only turns
// (functionSignature, args) into calldata that a user's wallet later signs.

import { ValidationError } from './errors';

export const MAX_ABI_SIGNATURE_LENGTH = 1024;
export const MAX_ABI_ARGUMENTS = 64;
export const MAX_ABI_DYNAMIC_BYTES = 64 * 1024;
export const MAX_ABI_CALLDATA_BYTES = 128 * 1024;

// --- keccak256 (Keccak-f[1600], rate 136, 0x01 domain padding) -------------

const KECCAK_ROUND_CONSTANTS: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// Rotation offsets r[x][y]; lane index is x + 5*y.
const KECCAK_ROTATION: number[][] = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

const MASK64 = (1n << 64n) - 1n;

function rotl64(value: bigint, shift: number): bigint {
  const s = BigInt(shift);
  return ((value << s) | (value >> (64n - s))) & MASK64;
}

function keccakF(state: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    // Theta
    const c: bigint[] = new Array(5);
    for (let x = 0; x < 5; x++) {
      c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    const d: bigint[] = new Array(5);
    for (let x = 0; x < 5; x++) {
      d[x] = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        state[x + 5 * y] ^= d[x];
      }
    }

    // Rho + Pi
    const b: bigint[] = new Array(25).fill(0n);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const nx = y;
        const ny = (2 * x + 3 * y) % 5;
        b[nx + 5 * ny] = rotl64(state[x + 5 * y], KECCAK_ROTATION[x][y]);
      }
    }

    // Chi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        state[x + 5 * y] = b[x + 5 * y] ^ ((~b[((x + 1) % 5) + 5 * y] & MASK64) & b[((x + 2) % 5) + 5 * y]);
      }
    }

    // Iota
    state[0] ^= KECCAK_ROUND_CONSTANTS[round];
  }
}

/** Compute keccak256 of a byte array, returning 32 raw bytes. */
export function keccak256(input: Uint8Array): Uint8Array {
  const rate = 136; // bytes (1088 bits) for keccak256
  const state: bigint[] = new Array(25).fill(0n);

  // Pad: append 0x01, zero-fill to rate boundary, set final byte's high bit.
  const padded = new Uint8Array(Math.ceil((input.length + 1) / rate) * rate);
  padded.set(input);
  padded[input.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 0; b < 8; b++) {
        lane |= BigInt(padded[offset + i * 8 + b]) << BigInt(8 * b);
      }
      state[i] ^= lane;
    }
    keccakF(state);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = state[i];
    for (let b = 0; b < 8; b++) {
      out[i * 8 + b] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/** keccak256 of a UTF-8 string, as a lowercase 0x-prefixed hex string. */
export function keccak256Hex(text: string): string {
  return `0x${toHex(keccak256(new TextEncoder().encode(text)))}`;
}

// --- ABI encoding ----------------------------------------------------------

const FUNCTION_SIGNATURE_PATTERN = /^([A-Za-z_$][A-Za-z0-9_$]*)\((.*)\)$/;

/** Parse a canonical function signature into a name and its parameter types. */
export function parseFunctionSignature(signature: string): { name: string; types: string[] } {
  if (typeof signature !== 'string') {
    throw new ValidationError('functionSignature must be a string');
  }
  if (signature.length > MAX_ABI_SIGNATURE_LENGTH) {
    throw new ValidationError(`functionSignature exceeds the ${MAX_ABI_SIGNATURE_LENGTH}-character limit`);
  }
  const trimmed = signature.replace(/\s+/g, '');
  const match = FUNCTION_SIGNATURE_PATTERN.exec(trimmed);
  if (!match) {
    throw new ValidationError(
      `Invalid function signature: ${signature}. Expected e.g. "transfer(address,uint256)".`
    );
  }
  const [, name, rawTypes] = match;
  const types = rawTypes.length === 0 ? [] : rawTypes.split(',');
  if (types.length > MAX_ABI_ARGUMENTS) {
    throw new ValidationError(`ABI argument count exceeds the ${MAX_ABI_ARGUMENTS}-argument limit`);
  }
  return { name, types };
}

/** Canonical selector (first 4 bytes of keccak256(signature)) as 0x-hex. */
export function functionSelector(signature: string): string {
  const { name, types } = parseFunctionSignature(signature);
  const canonical = `${name}(${types.join(',')})`;
  return keccak256Hex(canonical).slice(0, 10); // '0x' + 8 hex chars
}

function padLeft32(hexNo0x: string): string {
  if (hexNo0x.length > 64) {
    throw new ValidationError('ABI word overflow (value wider than 32 bytes)');
  }
  return hexNo0x.padStart(64, '0');
}

function padRightToWord(hexNo0x: string): string {
  const remainder = hexNo0x.length % 64;
  return remainder === 0 ? hexNo0x : hexNo0x + '0'.repeat(64 - remainder);
}

function encodeUint(value: unknown, bits: number): string {
  const big = toBigIntArg(value);
  if (big < 0n) {
    throw new ValidationError('uint value must be non-negative');
  }
  const max = (1n << BigInt(bits)) - 1n;
  if (big > max) {
    throw new ValidationError(`uint${bits} value exceeds its range`);
  }
  return padLeft32(big.toString(16));
}

function encodeInt(value: unknown, bits: number): string {
  const big = toBigIntArg(value);
  const min = -(1n << BigInt(bits - 1));
  const max = (1n << BigInt(bits - 1)) - 1n;
  if (big < min || big > max) {
    throw new ValidationError(`int${bits} value exceeds its range`);
  }
  const twos = big < 0n ? (big + (1n << 256n)) & ((1n << 256n) - 1n) : big;
  return padLeft32(twos.toString(16));
}

function toBigIntArg(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new ValidationError('numeric ABI argument must be a safe integer; pass a decimal string instead');
    }
    return BigInt(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^-?0x[0-9a-fA-F]+$/.test(trimmed)) {
      return BigInt(trimmed);
    }
    if (/^-?[0-9]+$/.test(trimmed)) {
      return BigInt(trimmed);
    }
    throw new ValidationError(`Invalid integer ABI argument: ${value}`);
  }
  throw new ValidationError('Integer ABI argument must be a string, number, or bigint');
}

function normalizeEvmAddressArg(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ValidationError('address ABI argument must be a string');
  }
  const prefixed = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{40}$/.test(prefixed)) {
    throw new ValidationError(`Invalid address ABI argument: ${value}`);
  }
  return prefixed.toLowerCase();
}

function hexArgToBytes(value: unknown, label: string): Uint8Array {
  if (typeof value !== 'string') {
    throw new ValidationError(`${label} ABI argument must be a 0x-hex string`);
  }
  const body = value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
  if (body.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(body)) {
    throw new ValidationError(`Invalid ${label} ABI argument (not even-length hex): ${value}`);
  }
  if (body.length / 2 > MAX_ABI_DYNAMIC_BYTES) {
    throw new ValidationError(`${label} ABI argument exceeds the ${MAX_ABI_DYNAMIC_BYTES}-byte limit`);
  }
  const bytes = new Uint8Array(body.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

interface EncodedComponent {
  dynamic: boolean;
  hex: string; // no 0x prefix, multiple of 64 chars
}

function encodeComponent(type: string, value: unknown): EncodedComponent {
  if (type === 'address') {
    return { dynamic: false, hex: padLeft32(normalizeEvmAddressArg(value)) };
  }
  if (type === 'bool') {
    if (typeof value !== 'boolean') {
      throw new ValidationError('bool ABI argument must be a boolean');
    }
    return { dynamic: false, hex: padLeft32(value ? '1' : '0') };
  }
  if (type === 'uint' || type === 'uint256') {
    return { dynamic: false, hex: encodeUint(value, 256) };
  }
  if (type === 'int' || type === 'int256') {
    return { dynamic: false, hex: encodeInt(value, 256) };
  }
  const uintMatch = /^uint([0-9]+)$/.exec(type);
  if (uintMatch) {
    const bits = Number(uintMatch[1]);
    if (bits < 8 || bits > 256 || bits % 8 !== 0) {
      throw new ValidationError(`Unsupported uint width: ${type}`);
    }
    return { dynamic: false, hex: encodeUint(value, bits) };
  }
  const intMatch = /^int([0-9]+)$/.exec(type);
  if (intMatch) {
    const bits = Number(intMatch[1]);
    if (bits < 8 || bits > 256 || bits % 8 !== 0) {
      throw new ValidationError(`Unsupported int width: ${type}`);
    }
    return { dynamic: false, hex: encodeInt(value, bits) };
  }
  const fixedBytesMatch = /^bytes([0-9]+)$/.exec(type);
  if (fixedBytesMatch) {
    const size = Number(fixedBytesMatch[1]);
    if (size < 1 || size > 32) {
      throw new ValidationError(`Unsupported fixed bytes width: ${type}`);
    }
    const bytes = hexArgToBytes(value, type);
    if (bytes.length !== size) {
      throw new ValidationError(`${type} argument must be exactly ${size} bytes`);
    }
    return { dynamic: false, hex: padRightToWord(toHex(bytes)) };
  }
  if (type === 'bytes') {
    const bytes = hexArgToBytes(value, 'bytes');
    const lengthWord = padLeft32(bytes.length.toString(16));
    const data = bytes.length === 0 ? '' : padRightToWord(toHex(bytes));
    return { dynamic: true, hex: lengthWord + data };
  }
  if (type === 'string') {
    if (typeof value !== 'string') {
      throw new ValidationError('string ABI argument must be a string');
    }
    const bytes = new TextEncoder().encode(value);
    if (bytes.length > MAX_ABI_DYNAMIC_BYTES) {
      throw new ValidationError(`string ABI argument exceeds the ${MAX_ABI_DYNAMIC_BYTES}-byte limit`);
    }
    const lengthWord = padLeft32(bytes.length.toString(16));
    const data = bytes.length === 0 ? '' : padRightToWord(toHex(bytes));
    return { dynamic: true, hex: lengthWord + data };
  }
  throw new ValidationError(
    `Unsupported ABI type "${type}". Supported: address, bool, uint<N>, int<N>, bytes<N>, bytes, string. `
    + 'For anything else, pass pre-encoded calldata via the "data" field.'
  );
}

/** ABI-encode a list of (type, value) pairs into a 0x-hex string. */
export function encodeAbiParameters(types: string[], values: unknown[]): string {
  if (!Array.isArray(types) || !Array.isArray(values)) {
    throw new ValidationError('ABI types and values must both be arrays');
  }
  if (types.length !== values.length) {
    throw new ValidationError(
      `ABI argument count mismatch: signature expects ${types.length}, received ${values.length}`
    );
  }
  if (types.length > MAX_ABI_ARGUMENTS) {
    throw new ValidationError(`ABI argument count exceeds the ${MAX_ABI_ARGUMENTS}-argument limit`);
  }

  const components = types.map((type, index) => encodeComponent(type.trim(), values[index]));
  const headWords = components.length;
  let head = '';
  let tail = '';
  for (const component of components) {
    if (component.dynamic) {
      const offset = headWords * 32 + tail.length / 2;
      head += padLeft32(offset.toString(16));
      tail += component.hex;
    } else {
      head += component.hex;
    }
  }
  const encoded = `0x${head}${tail}`;
  if ((encoded.length - 2) / 2 > MAX_ABI_CALLDATA_BYTES) {
    throw new ValidationError(`ABI calldata exceeds the ${MAX_ABI_CALLDATA_BYTES}-byte limit`);
  }
  return encoded;
}

/**
 * Encode a full call: 4-byte selector followed by ABI-encoded arguments.
 * @returns 0x-prefixed calldata.
 */
export function encodeFunctionCall(signature: string, args: unknown[]): string {
  const { types } = parseFunctionSignature(signature);
  const selector = functionSelector(signature);
  const encodedArgs = encodeAbiParameters(types, Array.isArray(args) ? args : []);
  return selector + encodedArgs.slice(2);
}
