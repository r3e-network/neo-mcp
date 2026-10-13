/**
 * Comprehensive Unit Tests for Validation Utils
 * Testing all validation functions with various edge cases
 */

import {
  validateAddress,
  validateHash,
  validateScriptHash,
  validateAmount,
  validateEvmAmount,
  validatePassword,
  validateNetwork,
  sanitizeString,
  validateBoolean,
  validateInteger,
  validateContractName,
  validateContractOperation
} from '../src/utils/validation';
import { NeoNetwork } from '../src/services/neo-service';
import { ValidationError } from '../src/utils/errors';

describe('Validation Utils', () => {
  
  describe('validateAddress', () => {
    const validAddresses = [
      'NUVPACMnKFhpuHjsRjhUvXz1XhqfGZYVtY',
      'NaMLm1hwCaQitxmLboJGo2XJkG8PSYvuyr',
      'NVbGwMfRQVudQCcChhCFwQRwSxr5vH8UhJ'
    ];

    const invalidAddresses = [
      '',
      '   ',
      'abc',
      'invalid-address',
      '123456789012345678901234567890123', // 33 chars
      '12345678901234567890123456789012345', // 35 chars
      'NUVPACMnKFhpuHjsRjhUvXz1XhqfGZYVt!', // invalid character
      'NbMLm1hwCaQitxmLboJGo2XJkG8PSYvuyr', // valid shape, invalid checksum
      null,
      undefined,
      123
    ];

    test.each(validAddresses)('should validate valid address: %s', (address) => {
      expect(() => validateAddress(address)).not.toThrow();
      expect(validateAddress(address)).toBe(address);
    });

    test.each(invalidAddresses)('should reject invalid address: %s', (address) => {
      expect(() => validateAddress(address as any)).toThrow(ValidationError);
    });

    test('should handle Neo-specific address validation', () => {
      // Test with known valid Neo addresses
      expect(() => validateAddress('NUVPACMnKFhpuHjsRjhUvXz1XhqfGZYVtY')).not.toThrow();
    });
  });

  describe('validateHash', () => {
    const validHashes = [
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      '0xABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890'
    ];

    const invalidHashes = [
      '',
      '0x123', // too short
      '123', // too short without 0x
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1', // too long
      '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdefG', // invalid char
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdeZ', // invalid char
      null,
      undefined,
      123
    ];

    test.each(validHashes)('should validate valid hash: %s', (hash) => {
      const result = validateHash(hash);
      expect(result).toMatch(/^0x[0-9a-fA-F]{64}$/);
    });

    test.each(invalidHashes)('should reject invalid hash: %s', (hash) => {
      expect(() => validateHash(hash as any)).toThrow(ValidationError);
    });

    test('should normalize hash format (add 0x prefix)', () => {
      const hash = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const result = validateHash(hash);
      expect(result).toBe(`0x${hash}`);
    });
  });

  describe('validateScriptHash', () => {
    const validScriptHashes = [
      '0x1234567890abcdef1234567890abcdef12345678',
      '1234567890abcdef1234567890abcdef12345678',
      '0xABCDEF1234567890ABCDEF1234567890ABCDEF12'
    ];

    const invalidScriptHashes = [
      '',
      '0x123', // too short
      '123', // too short without 0x
      '0x1234567890abcdef1234567890abcdef123456789', // too long
      '1234567890abcdef1234567890abcdef1234567G', // invalid char
      null,
      undefined,
      123
    ];

    test.each(validScriptHashes)('should validate valid script hash: %s', (hash) => {
      const result = validateScriptHash(hash);
      expect(result).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    test.each(invalidScriptHashes)('should reject invalid script hash: %s', (hash) => {
      expect(() => validateScriptHash(hash as any)).toThrow(ValidationError);
    });

    test('should normalize script hash format (add 0x prefix)', () => {
      const hash = '1234567890abcdef1234567890abcdef12345678';
      const result = validateScriptHash(hash);
      expect(result).toBe(`0x${hash}`);
    });
  });

  describe('validateAmount', () => {
    const validAmounts = [
      '100',
      '100.5',
      '0.00000001',
      '999999999',
      100,
      100.5,
      0.00000001,
      1
    ];

    const invalidAmounts = [
      '',
      '0',
      '-100',
      'abc',
      '100.abc',
      null,
      undefined,
      NaN,
      Infinity,
      -Infinity,
      0,
      -100,
      1000000001 // exceeds max
    ];

    test.each(validAmounts)('should validate valid amount: %s', (amount) => {
      const result = validateAmount(amount);
      expect(typeof result).toBe('string');
      expect(parseFloat(result)).toBeGreaterThan(0);
    });

    test.each(invalidAmounts)('should reject invalid amount: %s', (amount) => {
      expect(() => validateAmount(amount as any)).toThrow(ValidationError);
    });

    test('should normalize amount to string', () => {
      expect(validateAmount(100)).toBe('100');
      expect(validateAmount('100.5')).toBe('100.5');
    });
  });

  describe('validatePassword', () => {
    const validPasswords = [
      'password123',
      'MySecurePass!',
      '12345678', // minimum length
      'a'.repeat(100) // maximum length
    ];

    const invalidPasswords = [
      '',
      '        ',
      '1234567', // too short
      'a'.repeat(101), // too long
      null,
      undefined,
      123
    ];

    test.each(validPasswords)('should validate valid password', (password) => {
      expect(() => validatePassword(password)).not.toThrow();
      expect(validatePassword(password)).toBe(password);
    });

    test.each(invalidPasswords)('should reject invalid password', (password) => {
      expect(() => validatePassword(password as any)).toThrow(ValidationError);
    });
  });

  describe('validateNetwork', () => {
    test('should validate mainnet', () => {
      expect(validateNetwork('mainnet')).toBe(NeoNetwork.MAINNET);
      expect(validateNetwork('MAINNET')).toBe(NeoNetwork.MAINNET);
      expect(validateNetwork(' mainnet ')).toBe(NeoNetwork.MAINNET);
    });

    test('should validate testnet', () => {
      expect(validateNetwork('testnet')).toBe(NeoNetwork.TESTNET);
      expect(validateNetwork('TESTNET')).toBe(NeoNetwork.TESTNET);
      expect(validateNetwork(' testnet ')).toBe(NeoNetwork.TESTNET);
    });

    test('should default to mainnet when no network provided', () => {
      expect(validateNetwork()).toBe(NeoNetwork.MAINNET);
      expect(validateNetwork('')).toBe(NeoNetwork.MAINNET);
    });

    test('should reject invalid networks', () => {
      expect(() => validateNetwork('invalid')).toThrow(ValidationError);
      expect(() => validateNetwork('bitcoin')).toThrow(ValidationError);
      expect(() => validateNetwork(123 as any)).toThrow(ValidationError);
    });
  });

  describe('sanitizeString', () => {
    test('should sanitize strings correctly', () => {
      expect(sanitizeString('  hello world  ')).toBe('hello world');
      expect(sanitizeString('hello\x00world')).toBe('helloworld'); // control chars
      expect(sanitizeString('hello<script>alert("xss")</script>world')).toBe('helloworld'); // HTML
    });

    test('should reject non-strings', () => {
      expect(() => sanitizeString(123 as any)).toThrow(ValidationError);
      expect(() => sanitizeString(null as any)).toThrow(ValidationError);
      expect(() => sanitizeString(undefined as any)).toThrow(ValidationError);
    });
  });

  describe('validateBoolean', () => {
    const truthyValues = [
      true,
      'true',
      'TRUE',
      'True',
      '1',
      1
    ];

    const falsyValues = [
      false,
      'false',
      'FALSE',
      'False',
      '0',
      0
    ];

    const invalidValues = [
      'maybe',
      'yes',
      'no',
      2,
      -1,
      null,
      undefined,
      'true ',
      ' false'
    ];

    test.each(truthyValues)('should validate truthy value: %s', (value) => {
      expect(validateBoolean(value)).toBe(true);
    });

    test.each(falsyValues)('should validate falsy value: %s', (value) => {
      expect(validateBoolean(value)).toBe(false);
    });

    test.each(invalidValues)('should reject invalid boolean: %s', (value) => {
      expect(() => validateBoolean(value as any)).toThrow(ValidationError);
    });
  });

  describe('validateInteger', () => {
    const validIntegers = [
      0,
      1,
      100,
      999999,
      '0',
      '1',
      '100',
      '999999'
    ];

    const invalidIntegers = [
      -1,
      -100,
      1.5,
      100.1,
      'abc',
      '1.5',
      '-1',
      null,
      undefined,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      String(Number.MAX_SAFE_INTEGER + 1),
    ];

    test.each(validIntegers)('should validate valid integer: %s', (value) => {
      const result = validateInteger(value);
      expect(Number.isInteger(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(0);
    });

    test.each(invalidIntegers)('should reject invalid integer: %s', (value) => {
      expect(() => validateInteger(value as any)).toThrow(ValidationError);
    });
  });

  describe('validateContractName', () => {
    const availableContracts = ['NeoFS', 'NeoBurger', 'Flamingo'];

    test('should validate existing contract names (case insensitive)', () => {
      expect(validateContractName('NeoFS', availableContracts)).toBe('NeoFS');
      expect(validateContractName('neofs', availableContracts)).toBe('NeoFS');
      expect(validateContractName('NEOFS', availableContracts)).toBe('NeoFS');
      expect(validateContractName(' neofs ', availableContracts)).toBe('NeoFS');
    });

    test('should reject non-existent contract names', () => {
      expect(() => validateContractName('NonExistent', availableContracts)).toThrow(ValidationError);
      expect(() => validateContractName('Bitcoin', availableContracts)).toThrow(ValidationError);
    });

    test('should reject invalid input types', () => {
      expect(() => validateContractName('', availableContracts)).toThrow(ValidationError);
      expect(() => validateContractName(null as any, availableContracts)).toThrow(ValidationError);
      expect(() => validateContractName(123 as any, availableContracts)).toThrow(ValidationError);
    });

    test('should handle empty available contracts list', () => {
      expect(validateContractName('AnyName', [])).toBe('AnyName');
    });
  });

  describe('validateContractOperation', () => {
    const availableOperations = ['transfer', 'balanceOf', 'totalSupply'];

    test('should validate existing operations', () => {
      expect(validateContractOperation('transfer', availableOperations)).toBe('transfer');
      expect(validateContractOperation('balanceOf', availableOperations)).toBe('balanceOf');
      expect(validateContractOperation(' transfer ', availableOperations)).toBe('transfer');
    });

    test('should reject non-existent operations', () => {
      expect(() => validateContractOperation('nonExistent', availableOperations)).toThrow(ValidationError);
      expect(() => validateContractOperation('invalidOp', availableOperations)).toThrow(ValidationError);
    });

    test('should reject invalid input types', () => {
      expect(() => validateContractOperation('', availableOperations)).toThrow(ValidationError);
      expect(() => validateContractOperation(null as any, availableOperations)).toThrow(ValidationError);
      expect(() => validateContractOperation(123 as any, availableOperations)).toThrow(ValidationError);
    });

    test('should handle empty available operations list', () => {
      expect(validateContractOperation('anyOperation', [])).toBe('anyOperation');
    });
  });

  describe('Error message quality', () => {
    test('should provide helpful error messages', () => {
      try {
        validateAddress('invalid');
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).message).toContain('Invalid Neo N3 address format');
      }

      try {
        validateAmount('abc');
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).message).toContain('Invalid amount format');
      }

      try {
        validatePassword('123');
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).message).toContain('at least 8 characters');
      }
    });
  });
  describe('validateEvmAmount', () => {
    test('rejects a wei string longer than a uint256 before it reaches BigInt', () => {
      expect(validateEvmAmount('1'.repeat(78))).toBe('1'.repeat(78));
      expect(() => validateEvmAmount('1'.repeat(79))).toThrow(ValidationError);
      expect(() => validateEvmAmount('1'.repeat(79))).toThrow(/78-digit limit/);
    });

    test('accepts decimal strings, safe integers and bigints, and canonicalises', () => {
      expect(validateEvmAmount('1000000000000000000')).toBe('1000000000000000000');
      expect(validateEvmAmount('007')).toBe('7');
      expect(validateEvmAmount(0, { allowZero: true })).toBe('0');
      expect(validateEvmAmount(1n)).toBe('1');
      expect(() => validateEvmAmount(-1n)).toThrow(/must not be negative/);
      expect(() => validateEvmAmount(0)).toThrow(/greater than zero/);
    });
  });
});
