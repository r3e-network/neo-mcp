/**
 * Configuration for the Neo MCP server
 */

import { assertValidRpcUrl } from './utils/rpc-url';
import { createTrustedProxyBlockList } from './utils/trusted-proxy';
import * as path from 'path';
import {
  DEFAULT_MAX_TRANSACTION_FEE_GAS,
  parseGasAmountToDatos,
} from './utils/transaction-preparation';

export enum NetworkMode {
  MAINNET_ONLY = 'mainnet_only',
  TESTNET_ONLY = 'testnet_only',
  BOTH = 'both'
}

// Neo N3 JSON-RPC seeds. Multiple entries per network are REQUIRED, not a
// nicety: a single seed going down (mainnet1.neo.coz.io returned Cloudflare 520
// for days) otherwise takes every read with it. Entries are tried in order and
// only advanced past on transport faults; see utils/rpc-client.ts. All hosts
// below were verified to answer getversion with the correct network magic
// (mainnet 860833102, testnet 894710606).
const DEFAULT_MAINNET_RPC_URLS = [
  'https://mainnet3.neo.coz.io:443',
  'https://mainnet4.neo.coz.io:443',
  'https://mainnet5.neo.coz.io:443',
  'https://rpc10.n3.nspcc.ru:10331',
  'https://n3seed1.ngd.network:10332',
];
const DEFAULT_TESTNET_RPC_URLS = [
  'https://testnet1.neo.coz.io:443',
  'https://testnet2.neo.coz.io:443',
  'https://rpc.t5.n3.nspcc.ru:20331',
];
const DEFAULT_NEO_RPC_TIMEOUT_MS = 15_000;
const DEFAULT_NETWORK_MODE = NetworkMode.BOTH;
const DEFAULT_N3INDEX_BASE_URL = 'https://api.n3index.dev';
const DEFAULT_EXPLORER_ACCOUNT_WATCH_API_URL = 'https://www.neo3scan.com/api/account-watches';
// Neo X (EVM sidechain) Blockscout v2 explorer API hosts. The mainnet host is
// the production explorer used by Neo-Explorer-UI (xexplorer.neo.org). The
// testnet host is derived from the same UI's chain metadata
// (xt4scan.ngd.network) and is NOT independently verified to expose a Blockscout
// /api/v2 surface; override it (or disable testnet) via the env var below.
const DEFAULT_NEOX_MAINNET_EXPLORER_API_BASE_URL = 'https://xexplorer.neo.org';
const DEFAULT_NEOX_TESTNET_EXPLORER_API_BASE_URL = 'https://xt4scan.ngd.network';
// Neo X (EVM sidechain) JSON-RPC nodes and chain ids, sourced from
// Neo-Explorer-UI/src/utils/neoxEnv.js. Chain ids are the EIP-155 magic used in
// transaction proposals; the RPC hosts back read-only simulate/estimate calls
// (eth_call, eth_estimateGas, eth_gasPrice, ...). Never used to broadcast.
const DEFAULT_NEOX_MAINNET_CHAIN_ID = 47763;
const DEFAULT_NEOX_TESTNET_CHAIN_ID = 12227332;
const DEFAULT_NEOX_MAINNET_RPC_URLS = [
  'https://mainnet-1.rpc.banelabs.org',
  'https://mainnet-2.rpc.banelabs.org',
];
const DEFAULT_NEOX_TESTNET_RPC_URLS = [
  'https://testnet-1.rpc.banelabs.org',
  'https://neoxt4seed1.ngd.network',
];
const DEFAULT_HTTP_HOST = '127.0.0.1';
const DEFAULT_HTTP_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_WALLETS_DIR = './wallets';

function readEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

function readBooleanEnv(...keys: string[]): boolean | undefined {
  const value = readEnv(...keys);
  if (value === undefined) {
    return undefined;
  }

  switch (value.toLowerCase()) {
    case 'true':
    case '1':
    case 'yes':
    case 'on':
      return true;
    case 'false':
    case '0':
    case 'no':
    case 'off':
      return false;
    default:
      return undefined;
  }
}

function parseNetworkMode(value: string | undefined): NetworkMode {
  if (!value) return DEFAULT_NETWORK_MODE;

  switch (value.toLowerCase()) {
    case 'mainnet':
    case 'mainnet_only':
      return NetworkMode.MAINNET_ONLY;
    case 'testnet':
    case 'testnet_only':
      return NetworkMode.TESTNET_ONLY;
    case 'both':
    default:
      return NetworkMode.BOTH;
  }
}

function readListEnv(key: string): string[] {
  const value = readEnv(key);
  return value
    ? value.split(',').map((entry) => entry.trim()).filter(Boolean)
    : [];
}

/**
 * Resolves the ordered endpoint list for one Neo N3 network.
 *
 * Precedence: the plural list env wins, then the legacy singular env (which
 * becomes the only entry, so an operator pinning one node keeps getting exactly
 * that node), then the built-in multi-endpoint defaults.
 */
function resolveRpcUrlList(
  listKey: string,
  singularKeys: string[],
  defaults: string[]
): string[] {
  const configured = readListEnv(listKey);
  if (configured.length > 0) {
    return [...new Set(configured)];
  }

  const singular = readEnv(...singularKeys);
  if (singular) {
    return [singular];
  }

  return [...defaults];
}

const mainnetRpcUrls = resolveRpcUrlList(
  'NEO_MAINNET_RPC_URLS',
  ['NEO_MAINNET_RPC', 'NEO_MAINNET_RPC_URL'],
  DEFAULT_MAINNET_RPC_URLS
);
const testnetRpcUrls = resolveRpcUrlList(
  'NEO_TESTNET_RPC_URLS',
  ['NEO_TESTNET_RPC', 'NEO_TESTNET_RPC_URL'],
  DEFAULT_TESTNET_RPC_URLS
);

const logFilePath = readEnv('LOG_FILE') || './logs/neo-mcp.log';
const logToConsole = readBooleanEnv('LOG_CONSOLE');
const isTestLikeEnvironment = (process.env.NODE_ENV || '').toLowerCase().includes('test');
const walletsDirectory = readEnv('WALLETS_DIR') || DEFAULT_WALLETS_DIR;

export const config = {
  mainnetRpcUrls,
  testnetRpcUrls,
  // Kept as the primary endpoint for callers (and logs) that only need one URL.
  // Always identical to the first list entry.
  mainnetRpcUrl: mainnetRpcUrls[0],
  testnetRpcUrl: testnetRpcUrls[0],
  rpcTimeoutMs: Number.parseInt(
    readEnv('NEO_RPC_TIMEOUT_MS') || String(DEFAULT_NEO_RPC_TIMEOUT_MS),
    10
  ),
  allowInsecureRpc: readBooleanEnv('NEO_ALLOW_INSECURE_RPC') ?? false,
  maxTransactionFeeGas: readEnv('NEO_MAX_TRANSACTION_FEE_GAS') || DEFAULT_MAX_TRANSACTION_FEE_GAS,
  networkMode: parseNetworkMode(readEnv('NEO_NETWORK', 'NEO_NETWORK_MODE')),
  writes: {
    enabled: readBooleanEnv('NEO_ENABLE_WRITES') ?? false,
    signerWifFile: readEnv('NEO_SIGNER_WIF_FILE'),
    stateDirectory: readEnv('NEO_WRITE_STATE_DIR') || path.join(walletsDirectory, '.write-operations'),
    requestStateKey: readEnv('NEO_MCP_REQUEST_STATE_KEY'),
    httpApprovalApiKey: readEnv('HTTP_WRITE_APPROVAL_API_KEY'),
  },
  n3index: {
    baseUrl: readEnv('N3INDEX_API_BASE_URL') || DEFAULT_N3INDEX_BASE_URL,
    enabled: readBooleanEnv('N3INDEX_ENABLED') ?? true,
    // Phase 2, gated OFF by default: the constrained-filter `query_indexer_find`
    // tool only EXECUTES when this flag is true. The tool is always advertised;
    // when disabled it returns a clear "disabled" error before any network call.
    findEnabled: readBooleanEnv('N3INDEX_FIND_ENABLED') ?? false,
  },

  accountWatch: {
    enabled: readBooleanEnv('EXPLORER_ACCOUNT_WATCH_ENABLED') ?? false,
    apiUrl:
      readEnv('EXPLORER_ACCOUNT_WATCH_API_URL') || DEFAULT_EXPLORER_ACCOUNT_WATCH_API_URL,
    apiToken: readEnv('EXPLORER_ACCOUNT_WATCH_API_TOKEN'),
  },

  neox: {
    mainnetExplorerApiBaseUrl:
      readEnv('NEOX_MAINNET_EXPLORER_API_BASE_URL') || DEFAULT_NEOX_MAINNET_EXPLORER_API_BASE_URL,
    testnetExplorerApiBaseUrl:
      readEnv('NEOX_TESTNET_EXPLORER_API_BASE_URL') || DEFAULT_NEOX_TESTNET_EXPLORER_API_BASE_URL,
    testnetEnabled: readBooleanEnv('NEOX_TESTNET_ENABLED') ?? true,
    mainnetChainId: Number.parseInt(
      readEnv('NEOX_MAINNET_CHAIN_ID') || String(DEFAULT_NEOX_MAINNET_CHAIN_ID),
      10
    ),
    testnetChainId: Number.parseInt(
      readEnv('NEOX_TESTNET_CHAIN_ID') || String(DEFAULT_NEOX_TESTNET_CHAIN_ID),
      10
    ),
    mainnetRpcUrls: (() => {
      const configured = readListEnv('NEOX_MAINNET_RPC_URLS');
      return configured.length > 0 ? configured : DEFAULT_NEOX_MAINNET_RPC_URLS;
    })(),
    testnetRpcUrls: (() => {
      const configured = readListEnv('NEOX_TESTNET_RPC_URLS');
      return configured.length > 0 ? configured : DEFAULT_NEOX_TESTNET_RPC_URLS;
    })(),
    // Phase 2, gated OFF by default: the arbitrary GraphQL `x_graphql` tool only
    // EXECUTES when this flag is true. The tool is always advertised; when disabled
    // it returns a clear "disabled" error before any network call.
    graphqlEnabled: readBooleanEnv('NEOX_GRAPHQL_ENABLED') ?? false,
  },

  http: {
    host: readEnv('HTTP_HOST') || DEFAULT_HTTP_HOST,
    apiKey: readEnv('HTTP_API_KEY'),
    corsOrigins: readListEnv('HTTP_CORS_ORIGINS'),
    trustedProxies: readListEnv('HTTP_TRUSTED_PROXIES'),
    maxBodyBytes: Number.parseInt(
      readEnv('HTTP_MAX_BODY_BYTES') || String(DEFAULT_HTTP_MAX_BODY_BYTES),
      10
    ),
  },

  wallets: {
    directory: walletsDirectory,
    administrationEnabled: readBooleanEnv('NEO_ENABLE_WALLET_ADMIN') ?? false,
  },

  rateLimiting: {
    enabled: (readBooleanEnv('RATE_LIMITING_ENABLED') ?? true) && !isTestLikeEnvironment,
    maxRequestsPerMinute: parseInt(process.env.MAX_REQUESTS_PER_MINUTE || '60', 10),
    maxRequestsPerHour: parseInt(process.env.MAX_REQUESTS_PER_HOUR || '1000', 10),
  },

  logging: {
    level: process.env.LOG_LEVEL || 'info',
    console: logToConsole ?? !isTestLikeEnvironment,
    fileEnabled: (readBooleanEnv('LOG_FILE_ENABLED') ?? false) || Boolean(readEnv('LOG_FILE')),
    filePath: logFilePath,
  },
};

/**
 * Validate configuration values at startup.
 * Throws descriptive errors for invalid values.
 */
export function validateConfig(): void {
  const validLogLevels = ['debug', 'info', 'warn', 'error'];
  if (process.env.LOG_LEVEL && !validLogLevels.includes(process.env.LOG_LEVEL.toLowerCase())) {
    throw new Error(
      `Invalid LOG_LEVEL "${process.env.LOG_LEVEL}". Must be one of: ${validLogLevels.join(', ')}`
    );
  }

  const networkMode = readEnv('NEO_NETWORK', 'NEO_NETWORK_MODE');
  const validNetworkModes = ['mainnet', 'mainnet_only', 'testnet', 'testnet_only', 'both'];
  if (networkMode && !validNetworkModes.includes(networkMode.toLowerCase())) {
    throw new Error(
      `Invalid NEO_NETWORK "${networkMode}". Must be one of: ${validNetworkModes.join(', ')}.`
    );
  }

  for (const key of [
    'NEO_ALLOW_INSECURE_RPC',
    'N3INDEX_ENABLED',
    'N3INDEX_FIND_ENABLED',
    'EXPLORER_ACCOUNT_WATCH_ENABLED',
    'NEOX_GRAPHQL_ENABLED',
    'LOG_CONSOLE',
    'LOG_FILE_ENABLED',
    'RATE_LIMITING_ENABLED',
    'NEO_ENABLE_WRITES',
    'NEO_ENABLE_WALLET_ADMIN',
  ] as const) {
    if (process.env[key] !== undefined && readBooleanEnv(key) === undefined) {
      throw new Error(`Invalid ${key} "${process.env[key]}". Must be true or false.`);
    }
  }

  const accountWatchEnabled = readBooleanEnv('EXPLORER_ACCOUNT_WATCH_ENABLED') === true;
  const accountWatchToken = readEnv('EXPLORER_ACCOUNT_WATCH_API_TOKEN');
  if (accountWatchEnabled && !accountWatchToken) {
    throw new Error(
      'EXPLORER_ACCOUNT_WATCH_API_TOKEN is required when EXPLORER_ACCOUNT_WATCH_ENABLED=true.',
    );
  }
  if (accountWatchToken && Buffer.byteLength(accountWatchToken, 'utf8') < 32) {
    throw new Error('Invalid EXPLORER_ACCOUNT_WATCH_API_TOKEN. Must contain at least 32 bytes.');
  }
  try {
    assertValidRpcUrl(config.accountWatch.apiUrl);
    const watchUrl = new URL(config.accountWatch.apiUrl);
    if (watchUrl.search || watchUrl.hash || watchUrl.pathname !== '/api/account-watches') {
      throw new Error('invalid account watch url');
    }
  } catch {
    throw new Error(
      'Invalid EXPLORER_ACCOUNT_WATCH_API_URL. Use an HTTPS /api/account-watches URL without credentials, query, or fragment.',
    );
  }

  const writesEnabled = readBooleanEnv('NEO_ENABLE_WRITES') === true;
  if (writesEnabled && !readEnv('NEO_SIGNER_WIF_FILE')) {
    throw new Error('NEO_SIGNER_WIF_FILE is required when NEO_ENABLE_WRITES=true.');
  }

  const requestStateKey = readEnv('NEO_MCP_REQUEST_STATE_KEY');
  if (writesEnabled && !requestStateKey) {
    throw new Error('NEO_MCP_REQUEST_STATE_KEY is required when NEO_ENABLE_WRITES=true.');
  }
  if (requestStateKey && Buffer.byteLength(requestStateKey, 'utf8') < 32) {
    throw new Error('Invalid NEO_MCP_REQUEST_STATE_KEY. Must contain at least 32 bytes.');
  }

  const writeApprovalApiKey = readEnv('HTTP_WRITE_APPROVAL_API_KEY');
  if (writeApprovalApiKey && Buffer.byteLength(writeApprovalApiKey, 'utf8') < 32) {
    throw new Error('Invalid HTTP_WRITE_APPROVAL_API_KEY. Must contain at least 32 bytes.');
  }

  try {
    createTrustedProxyBlockList(readListEnv('HTTP_TRUSTED_PROXIES'));
  } catch {
    throw new Error(
      'Invalid HTTP_TRUSTED_PROXIES. Use comma-separated IP addresses or CIDR ranges.'
    );
  }

  for (const key of ['MAX_REQUESTS_PER_MINUTE', 'MAX_REQUESTS_PER_HOUR', 'NEO_RPC_TIMEOUT_MS'] as const) {
    const rawValue = process.env[key];
    if (rawValue !== undefined) {
      const value = Number(rawValue);
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Invalid ${key} "${rawValue}". Must be a positive integer.`);
      }
    }
  }

  if (process.env.HTTP_MAX_BODY_BYTES) {
    const maxBodyBytes = Number(process.env.HTTP_MAX_BODY_BYTES);
    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
      throw new Error(
        `Invalid HTTP_MAX_BODY_BYTES "${process.env.HTTP_MAX_BODY_BYTES}". Must be a positive integer.`
      );
    }
  }

  try {
    parseGasAmountToDatos(readEnv('NEO_MAX_TRANSACTION_FEE_GAS') || DEFAULT_MAX_TRANSACTION_FEE_GAS);
  } catch {
    throw new Error(
      'Invalid NEO_MAX_TRANSACTION_FEE_GAS. Must be a positive GAS amount with at most 8 decimal places.'
    );
  }

  for (const key of ['NEOX_MAINNET_CHAIN_ID', 'NEOX_TESTNET_CHAIN_ID'] as const) {
    const rawValue = process.env[key];
    if (rawValue !== undefined) {
      const value = Number(rawValue);
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Invalid ${key} "${rawValue}". Must be a positive integer.`);
      }
    }
  }

  for (const key of ['NEOX_MAINNET_RPC_URLS', 'NEOX_TESTNET_RPC_URLS'] as const) {
    for (const url of readListEnv(key)) {
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
          throw new Error('invalid url');
        }
      } catch {
        throw new Error(
          `Invalid ${key} entry "${url}". Use comma-separated HTTP/HTTPS URLs without embedded credentials.`
        );
      }
    }
  }

  const apiKey = readEnv('HTTP_API_KEY');
  const mcpHttpBearer = readEnv('MCP_HTTP_BEARER');
  if (
    accountWatchToken
    && (accountWatchToken === apiKey || accountWatchToken === mcpHttpBearer)
  ) {
    throw new Error(
      'EXPLORER_ACCOUNT_WATCH_API_TOKEN must differ from HTTP_API_KEY and MCP_HTTP_BEARER.',
    );
  }
  if (apiKey && writeApprovalApiKey === apiKey) {
    throw new Error('HTTP_WRITE_APPROVAL_API_KEY must differ from HTTP_API_KEY.');
  }
  if (
    requestStateKey
    && (requestStateKey === apiKey || requestStateKey === writeApprovalApiKey)
  ) {
    throw new Error(
      'NEO_MCP_REQUEST_STATE_KEY must differ from HTTP_API_KEY and HTTP_WRITE_APPROVAL_API_KEY.'
    );
  }
  if (apiKey && Buffer.byteLength(apiKey, 'utf8') < 32) {
    throw new Error('Invalid HTTP_API_KEY. Must contain at least 32 bytes.');
  }

  for (const origin of readListEnv('HTTP_CORS_ORIGINS')) {
    try {
      const parsed = new URL(origin);
      if (
        origin === '*' ||
        !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== '/' ||
        parsed.search ||
        parsed.hash
      ) {
        throw new Error('invalid origin');
      }
    } catch {
      throw new Error(
        `Invalid HTTP_CORS_ORIGINS entry "${origin}". Use comma-separated HTTP/HTTPS origins without paths.`
      );
    }
  }

  // Every entry of every list is validated, not just the first: a bad URL in
  // position three is silently unreachable until the first two seeds fail, i.e.
  // exactly when the failover is needed most.
  const rpcUrlLists = [
    ['NEO_MAINNET_RPC', config.mainnetRpcUrls],
    ['NEO_TESTNET_RPC', config.testnetRpcUrls],
  ] as const;
  for (const [name, urls] of rpcUrlLists) {
    for (const value of urls) {
      try {
        assertValidRpcUrl(value, { allowInsecureRemote: config.allowInsecureRpc });
      } catch {
        throw new Error(
          `Invalid ${name}. Use HTTPS with a hostname and no embedded credentials. ` +
          'Plain HTTP requires a loopback host or NEO_ALLOW_INSECURE_RPC=true.'
        );
      }
    }
  }
}
