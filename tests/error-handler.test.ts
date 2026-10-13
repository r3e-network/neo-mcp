import { ProtocolErrorCode } from '@modelcontextprotocol/server';
import { handleError } from '../src/utils/error-handler';
import { NetworkError, ValidationError } from '../src/utils/errors';

describe('error surface: diagnose without leaking', () => {
  test('does not expose unknown upstream error text to MCP callers', () => {
    const result = handleError(new Error('upstream secret=do-not-return rpc payload details'));
    expect(result.error.message).toBe('The operation could not be completed. Please retry later.');
    expect(result.error.message).not.toContain('do-not-return');
  });

  test('does not expose unknown string error text to MCP callers', () => {
    const result = handleError('provider response contained private operational detail');
    expect(result.error.message).toBe('The operation could not be completed. Please retry later.');
    expect(result.error.message).not.toContain('private operational detail');
  });

  test('does not expose upstream credentials, URLs or headers to MCP callers', () => {
    const leaking = new Error(
      'request to https://user:pass@indexer.internal/v1?key=AKIA-tainted failed '
      + 'with header authorization=Bearer eyJhbGciOi.tainted-signature',
    );
    const result = handleError(leaking);
    expect(result.error.message).toBe('The operation could not be completed. Please retry later.');
    for (const fragment of ['pass@', 'AKIA-tainted', 'tainted-signature', 'Bearer', 'indexer.internal']) {
      expect(result.error.message).not.toContain(fragment);
    }
  });

  test('a server-authored validation error keeps its specific message and InvalidParams code', () => {
    // This is the diagnosable half: a message we wrote ourselves is not blanked, so the
    // caller learns exactly which input was rejected and which flag to flip.
    const result = handleError(new ValidationError('analyze_address is disabled; enable N3INDEX_ENABLED'));
    expect(result.error.message).toBe('analyze_address is disabled; enable N3INDEX_ENABLED');
    expect(result.error.code).toBe(ProtocolErrorCode.InvalidParams);
  });

  test('a server-authored network error keeps its typed code so the failure class stays distinct', () => {
    const result = handleError(new NetworkError('N3 indexer responded 503'));
    expect(result.error.message).toBe('N3 indexer responded 503');
    expect(result.error.code).toBe(ProtocolErrorCode.InternalError);
  });

  test('the generic response still distinguishes an internal failure through its protocol code', () => {
    const generic = handleError(new Error('opaque upstream detail'));
    expect(generic.error.code).toBe(ProtocolErrorCode.InternalError);
    const rejected = handleError(new ValidationError('Invalid network'));
    expect(rejected.error.code).toBe(ProtocolErrorCode.InvalidParams);
    expect(generic.error.code).not.toBe(rejected.error.code);
  });

  test('the deployment diagnostic is preserved for its exact shape only', () => {
    const result = handleError(new Error('Contract TokenSale is not deployed on testnet'));
    expect(result.error.message).toBe('Contract TokenSale is not deployed on testnet');
    expect(result.error.code).toBe(ProtocolErrorCode.InvalidParams);
  });

  test('the deployment diagnostic does not widen into a general echo channel', () => {
    for (const nearMiss of [
      'Contract TokenSale is not deployed on testnet and leaked=do-not-return',
      'Contract Token Sale is not deployed on testnet',
      'Contract TokenSale is not deployed on devnet',
      'Contract TokenSale is not deployed on mainnet.',
      'prefix Contract TokenSale is not deployed on mainnet',
    ]) {
      const result = handleError(new Error(nearMiss));
      expect(result.error.message).toBe('The operation could not be completed. Please retry later.');
      expect(result.error.message).not.toContain('do-not-return');
    }
  });
});
