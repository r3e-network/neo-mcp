import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { NeoMcpError, ErrorType } from './errors';
import { logger } from './logger';

/**
 * Error mapping from Neo N3 error messages to user-friendly messages
 */
const ERROR_MAPPINGS: Record<string, { message: string, code: ProtocolErrorCode }> = {
  // Connection errors
  'ECONNREFUSED': {
    message: 'Could not connect to Neo N3 node. Please check the node URL and try again.',
    code: ProtocolErrorCode.InternalError
  },
  'ETIMEDOUT': {
    message: 'Connection to Neo N3 node timed out. The network might be congested or the node might be down.',
    code: ProtocolErrorCode.InternalError
  },
  'ENOTFOUND': {
    message: 'Neo N3 node address not found. Please check the node URL.',
    code: ProtocolErrorCode.InternalError
  },

  // Transaction errors
  'Insufficient funds': {
    message: 'Insufficient funds to complete the transaction. Please ensure you have enough balance.',
    code: ProtocolErrorCode.InvalidParams
  },
  'Invalid signature': {
    message: 'Invalid signature. Please check your wallet credentials.',
    code: ProtocolErrorCode.InvalidParams
  },
  'Unknown asset': {
    message: 'Unknown asset. Please check the asset name or hash.',
    code: ProtocolErrorCode.InvalidParams
  },
  'Transaction rejected': {
    message: 'Transaction was rejected by the network. It might conflict with network rules.',
    code: ProtocolErrorCode.InternalError
  },
  'VM fault': {
    message: 'Smart contract execution failed. The operation could not be completed.',
    code: ProtocolErrorCode.InternalError
  },
  'Already exists': {
    message: 'Transaction already exists in the blockchain.',
    code: ProtocolErrorCode.InvalidParams
  },

  // Validation errors
  'Invalid address': {
    message: 'Invalid Neo N3 address format. Please provide a valid address.',
    code: ProtocolErrorCode.InvalidParams
  },
  'Invalid hash': {
    message: 'Invalid hash format. Please provide a valid transaction or block hash.',
    code: ProtocolErrorCode.InvalidParams
  },
  'Invalid amount': {
    message: 'Invalid amount. Please provide a valid positive number.',
    code: ProtocolErrorCode.InvalidParams
  },
  'Invalid network': {
    message: 'Invalid network. Please use "mainnet" or "testnet".',
    code: ProtocolErrorCode.InvalidParams
  },

  // Contract errors
  'Contract not found': {
    message: 'Smart contract not found. Please check the contract name or hash.',
    code: ProtocolErrorCode.InvalidParams
  },
  'Method not found': {
    message: 'Contract method not found. Please check the operation name.',
    code: ProtocolErrorCode.InvalidParams
  },
  'Invalid argument': {
    message: 'Invalid contract argument. Please check the argument types and values.',
    code: ProtocolErrorCode.InvalidParams
  }
};

const GENERIC_INTERNAL_MESSAGE = 'The operation could not be completed. Please retry later.';

/**
 * Find the appropriate error mapping based on error message
 * @param errorMessage The error message to match
 * @returns Matched error mapping or undefined
 */
function findErrorMapping(errorMessage: string): { message: string, code: ProtocolErrorCode } | undefined {
  if (!errorMessage) return undefined;

  // Check for exact matches first
  if (ERROR_MAPPINGS[errorMessage]) {
    return ERROR_MAPPINGS[errorMessage];
  }

  // Check for partial matches
  for (const key of Object.keys(ERROR_MAPPINGS)) {
    if (errorMessage.includes(key)) {
      return ERROR_MAPPINGS[key];
    }
  }

  return undefined;
}

function safeKnownError(errorMessage: string): { message: string; code: ProtocolErrorCode } | undefined {
  // Preserve a useful deployment diagnostic while accepting only the small,
  // validated shape emitted by ContractService. All other upstream text stays
  // behind the generic response below.
  const deployment = /^Contract ([A-Za-z0-9._-]{1,64}) is not deployed on (mainnet|testnet)$/i.exec(errorMessage);
  if (deployment) {
    return {
      message: `Contract ${deployment[1]} is not deployed on ${deployment[2]}`,
      code: ProtocolErrorCode.InvalidParams,
    };
  }
  return undefined;
}

/**
 * Handle errors and convert them to MCP-compatible error responses
 * @param error Error to handle
 * @returns MCP-compatible error response
 */
export function handleError(error: unknown): { error: { message: string, code: ProtocolErrorCode } } {
  // Log the error for debugging
  const errObj = error as Record<string, unknown>;
  logger.error('Error occurred:', { error: String(error), stack: typeof errObj?.stack === 'string' ? errObj.stack : undefined });

  // If it's already an MCP error, use it directly
  if (error instanceof ProtocolError) {
    return {
      error: {
        message: error.message,
        code: error.code
      }
    };
  }

  // If it's a Neo MCP error, convert it
  if (error instanceof NeoMcpError) {
    const code = error.type === ErrorType.VALIDATION_ERROR ?
      ProtocolErrorCode.InvalidParams :
      ProtocolErrorCode.InternalError;

    return {
      error: {
        message: error.message,
        code: code
      }
    };
  }

  // Handle connection errors
  if (errObj.code && typeof errObj.code === 'string') {
    const mapping = ERROR_MAPPINGS[errObj.code];
    if (mapping) {
      return {
        error: {
          message: mapping.message,
          code: mapping.code
        }
      };
    }
  }

  // Handle errors with messages
  if (errObj.message && typeof errObj.message === 'string') {
    const mapping = findErrorMapping(errObj.message);
    if (mapping) {
      return {
        error: {
          message: mapping.message,
          code: mapping.code
        }
      };
    }

    const safe = safeKnownError(errObj.message);
    if (safe) return { error: safe };

    // Do not return upstream or infrastructure details to callers. Diagnostics
    // are already recorded by the protected server logger above.
    return {
      error: {
        message: GENERIC_INTERNAL_MESSAGE,
        code: ProtocolErrorCode.InternalError
      }
    };
  }

  // Handle string errors
  if (typeof error === 'string') {
    const mapping = findErrorMapping(error);
    if (mapping) {
      return {
        error: {
          message: mapping.message,
          code: mapping.code
        }
      };
    }

    return {
      error: {
        message: GENERIC_INTERNAL_MESSAGE,
        code: ProtocolErrorCode.InternalError
      }
    };
  }

  // Generic error handler for unknown error types
  return {
    error: {
      message: 'Unknown error',
      code: ProtocolErrorCode.InternalError
    }
  };
}

/**
 * Create a success response
 * @param data Data to include in the response
 * @returns MCP-compatible success response
 */
export function createSuccessResponse(data: unknown): { result: unknown } {
  return {
    result: data
  };
}

/**
 * Serialize a payload into the JSON `text` body of an MCP content block.
 *
 * This is the single render boundary at which untrusted response fields (transfer counterparties,
 * hashes, amounts) leave the process as text. `JSON.stringify` performs the structural escaping:
 * quotes, backslashes and control characters inside a value cannot break the JSON frame or inject a
 * sibling key. Every text response goes through here so the escaping is pinned in one place.
 *
 * @param data Payload to render
 * @returns Pretty-printed JSON text
 */
export function renderJsonText(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

/**
 * Create a tool response in the correct MCP format
 * @param data Data to include in the response
 * @returns MCP-compatible tool response
 */
export function createToolResponse(data: unknown): { content: Array<{ type: string; text: string }> } {
  return {
    content: [
      {
        type: "text",
        text: renderJsonText(data)
      }
    ]
  };
}

/**
 * Create an error response
 * @param message Error message
 * @param code Error code
 * @returns MCP-compatible error response
 */
export function createErrorResponse(
  message: string,
  code: ProtocolErrorCode = ProtocolErrorCode.InternalError,
): { error: { message: string; code: ProtocolErrorCode } } {
  return {
    error: {
      message,
      code
    }
  };
}

/**
 * Create a resource response in the correct MCP format
 * @param uri Resource URI
 * @param data Data to include in the response
 * @param mimeType Optional MIME type (defaults to application/json)
 * @returns MCP-compatible resource response
 */
export function createResourceResponse(uri: string, data: unknown, mimeType: string = 'application/json'): { contents: Array<{ uri: string; mimeType: string; text: string }> } {
  return {
    contents: [
      {
        uri,
        mimeType,
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}
