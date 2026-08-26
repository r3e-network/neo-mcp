/**
 * Unified, chain-parameterized MCP tool registry.
 *
 * The public surface exposes ONE tool per capability. Every capability both
 * chains implement carries a required `chain: 'n3' | 'neox'` discriminator; the
 * registry maps the (public tool, chain) pair onto the internal handler name
 * that `callTool` / `dispatchNeoxNodeTool` already dispatch, rewriting arguments
 * where the two backends disagree on shape:
 *
 *   - Neo X explorer + construct handlers take `network: 'neox-mainnet' |
 *     'neox-testnet'`, while Neo X *node* handlers take the public
 *     `'mainnet' | 'testnet'`. Callers only ever say `mainnet`/`testnet`.
 *   - Blockscout list endpoints are cursor-paginated, so `limit`/`skip` are
 *     dropped on Neo X explorer routes and kept on the curated Neo N3 ones.
 *   - `query_indexer` selects a REST endpoint with `method`; `x_query` uses
 *     `endpoint`. Neither (nor `query_indexer_find` / `x_graphql`) takes a
 *     `network` field for explicit network-scoped reads.
 *
 * Non-custodial invariant: no route in this table can reach a key-custody tool
 * (`create_wallet` / `import_wallet`) or a server-signed write tool
 * (`transfer_assets` / `invoke_contract_write` / `claim_gas` /
 * `deploy_contract`). Construct tools return UNSIGNED proposals only.
 */

import { z } from 'zod';
import { ValidationError } from '../utils/errors';

export type Chain = 'n3' | 'neox';

export const CHAINS: readonly Chain[] = ['n3', 'neox'] as const;

/** A resolved dispatch target for one (public tool, chain) pair. */
export interface ToolRoute {
  /** Public tool name the caller asked for. */
  publicName: string;
  /** Internal handler name understood by callTool / dispatchNeoxNodeTool. */
  internalName: string;
  /** Resolved chain, or undefined for chain-less meta tools. */
  chain?: Chain;
  /** Arguments to hand the internal handler (fresh object, `chain` stripped). */
  args: Record<string, unknown>;
  /** Whether Neo N3 services must be initialized before dispatch. */
  requiresServices: boolean;
  /** Whether the wallet service must be passed to callTool. */
  requiresWallet: boolean;
}

type ArgMapper = (args: Record<string, unknown>) => Record<string, unknown>;

interface RouteSpec {
  internalName: string;
  requiresServices?: boolean;
  requiresWallet?: boolean;
  mapArgs?: ArgMapper;
}

export interface PublicToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  /** Chains this tool supports; empty for chain-less meta tools. */
  chains: readonly Chain[];
  routes: Partial<Record<Chain, RouteSpec>> & { meta?: RouteSpec };
}

// --- shared schema fragments -------------------------------------------------

const chainField = (chains: readonly Chain[]) => ({
  chain: z.enum(chains as unknown as [Chain, ...Chain[]]).describe(
    `Target chain: ${chains.map((c) => `"${c}"`).join(' or ')} (required, no default)`,
  ),
});

const networkField = {
  network: z.enum(['mainnet', 'testnet']).optional().describe(
    'Network for the selected chain: "mainnet" (default) or "testnet"',
  ),
};

const paginationFields = {
  limit: z.number().int().min(1).max(100).optional().describe(
    'Max rows to return (1-100, default 20). Ignored on Neo X, which is cursor-paginated.',
  ),
  skip: z.number().int().nonnegative().optional().describe(
    'Rows to skip (default 0). Ignored on Neo X, which is cursor-paginated.',
  ),
};

// --- argument helpers --------------------------------------------------------

/** Copy only the keys present in `args`, preserving absence (never inject undefined). */
function pick(args: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in args && args[key] !== undefined) out[key] = args[key];
  }
  return out;
}

/** Rename `from` to `to` when present. */
function rename(
  args: Record<string, unknown>,
  from: string,
  to: string,
): Record<string, unknown> {
  const out = { ...args };
  if (from in out) {
    if (out[from] !== undefined) out[to] = out[from];
    delete out[from];
  }
  return out;
}

/** Rewrite the public mainnet/testnet network onto the Neo X `neox-*` form. */
function neoxNetwork(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  const network = out.network;
  if (network === undefined) {
    delete out.network;
    return out;
  }
  if (network === 'mainnet' || network === 'neox-mainnet') out.network = 'neox-mainnet';
  else if (network === 'testnet' || network === 'neox-testnet') out.network = 'neox-testnet';
  else {
    throw new ValidationError(
      `Invalid network "${String(network)}" for chain "neox": expected "mainnet" or "testnet".`,
    );
  }
  return out;
}

/** Keep the public mainnet/testnet form (Neo X node handlers read it directly). */
function passNetwork(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  if (out.network === undefined) delete out.network;
  else if (out.network !== 'mainnet' && out.network !== 'testnet') {
    throw new ValidationError(
      `Invalid network "${String(out.network)}": expected "mainnet" or "testnet".`,
    );
  }
  return out;
}

function dropPagination(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  delete out.limit;
  delete out.skip;
  return out;
}

/** n3 curated/node handler args: identity, minus undefined network. */
const n3Args: ArgMapper = (args) => passNetwork(args);

/** Neo X explorer route: neox-* network, no cursor-incompatible pagination. */
const xExplorerArgs = (keys: readonly string[]): ArgMapper => (args) =>
  neoxNetwork(dropPagination(pick(args, [...keys, 'network'])));

// --- public tool table -------------------------------------------------------

const SPECS: PublicToolSpec[] = [
  // ---------- meta ----------
  {
    name: 'get_network_mode',
    description:
      'Get the active network mode (mainnet-only, testnet-only, or both) and the list of '
      + 'Neo networks this server will talk to.',
    inputSchema: {},
    chains: [],
    routes: { meta: { internalName: 'get_network_mode' } },
  },
  {
    name: 'get_wallet',
    description:
      'Get sanitized metadata for a locally stored wallet by address. Never returns private '
      + 'keys, WIFs, or mnemonics — this server holds no signing material.',
    inputSchema: { address: z.string().describe('Neo N3 address') },
    chains: [],
    routes: {
      meta: {
        internalName: 'get_wallet',
        requiresWallet: true,
        mapArgs: (args) => pick(args, ['address']),
      },
    },
  },
  {
    name: 'inspect_neo_value',
    description:
      'Deterministically classify a Neo-related value as an N3/Neo X address, script hash, '
      + 'transaction hash, public key, NNS name, NeoFS URI, integer, hex, base64, JSON, or UTF-8.',
    inputSchema: {
      value: z.string().min(1).max(65_536).describe('Value to classify without changing it'),
    },
    chains: [],
    routes: {
      meta: {
        internalName: 'inspect_neo_value',
        mapArgs: (args) => pick(args, ['value']),
      },
    },
  },
  {
    name: 'convert_neo_data',
    description:
      'Convert UTF-8, hex, base64, and NeoVM signed little-endian integers, or convert a '
      + 'checksum-valid Neo N3 address to/from its UInt160 script hash.',
    inputSchema: {
      value: z.string().min(1).max(65_536).describe('Source value'),
      inputFormat: z.enum([
        'auto', 'utf8', 'hex', 'base64', 'integer', 'neo_address', 'script_hash',
      ]).optional().describe('Source encoding or semantic type (default auto)'),
      outputFormat: z.enum([
        'utf8', 'hex', 'base64', 'integer', 'neo_address', 'script_hash',
      ]).describe('Required output encoding or semantic type'),
    },
    chains: [],
    routes: {
      meta: {
        internalName: 'convert_neo_data',
        mapArgs: (args) => pick(args, ['value', 'inputFormat', 'outputFormat']),
      },
    },
  },
  {
    name: 'get_neo_service_info',
    description:
      'Get verified integration metadata and safe operation boundaries for NNS, NeoFS, the '
      + 'Neo N3 Oracle, or the official Neo N3/Neo X bridge.',
    inputSchema: {
      service: z.enum(['nns', 'neofs', 'oracle', 'bridge']).describe('Neo ecosystem service'),
      ...networkField,
    },
    chains: [],
    routes: {
      meta: {
        internalName: 'get_neo_service_info',
        mapArgs: (args) => passNetwork(pick(args, ['service', 'network'])),
      },
    },
  },
  {
    name: 'analyze_stablecoins',
    description:
      'PRIMARY stablecoin-discovery tool for Neo N3 or Neo X. Returns network-pinned token '
      + 'candidates whose indexed name or symbol matches USD, with bounded contract/token '
      + 'metadata and explicit verification boundaries. A name match, verified source, or '
      + 'on-chain supply does not prove fiat backing, redemption, issuer identity, or peg safety.',
    inputSchema: {
      ...chainField(CHAINS),
      ...networkField,
    },
    chains: CHAINS,
    routes: {
      n3: {
        internalName: 'n3_analyze_stablecoins',
        mapArgs: (args) => n3Args(pick(args, ['network'])),
      },
      neox: {
        internalName: 'x_analyze_stablecoins',
        mapArgs: (args) => neoxNetwork(pick(args, ['network'])),
      },
    },
  },

  // ---------- node reads (multi-chain) ----------
  {
    name: 'get_chain_info',
    description:
      'Get chain summary information: current height plus network identity (Neo N3 validators, '
      + 'or the Neo X EVM chain id).',
    inputSchema: { ...chainField(CHAINS), ...networkField },
    chains: CHAINS,
    routes: {
      n3: {
        internalName: 'get_blockchain_info',
        requiresServices: true,
        mapArgs: (args) => n3Args(pick(args, ['network'])),
      },
      neox: {
        internalName: 'x_node_get_chain_info',
        mapArgs: (args) => passNetwork(pick(args, ['network'])),
      },
    },
  },
  {
    name: 'get_block_height',
    description: 'Get the current block height (and block count) for the selected chain and network.',
    inputSchema: { ...chainField(CHAINS), ...networkField },
    chains: CHAINS,
    routes: {
      n3: {
        internalName: 'get_block_count',
        requiresServices: true,
        mapArgs: (args) => n3Args(pick(args, ['network'])),
      },
      neox: {
        internalName: 'x_node_get_block_height',
        mapArgs: (args) => passNetwork(pick(args, ['network'])),
      },
    },
  },
  {
    name: 'get_block',
    description: 'Get block details by block height/number or block hash.',
    inputSchema: {
      ...chainField(CHAINS),
      hashOrHeight: z.union([z.string(), z.number()]).describe(
        'Block hash (0x + 64 hex) or block height/number',
      ),
      includeTransactions: z.boolean().optional().describe(
        'Neo X only: include full transaction objects in the block',
      ),
      includeStateRoot: z.boolean().optional().describe(
        'Neo N3 only: include the StateService root, StateValidator boundary, and validated status',
      ),
      ...networkField,
    },
    chains: CHAINS,
    routes: {
      n3: {
        internalName: 'get_block',
        requiresServices: true,
        mapArgs: (args) => n3Args(pick(args, ['hashOrHeight', 'includeStateRoot', 'network'])),
      },
      neox: {
        internalName: 'x_node_get_block',
        mapArgs: (args) => {
          if (args.includeStateRoot === true) {
            throw new ValidationError('get_block includeStateRoot is supported only on Neo N3');
          }
          return passNetwork(
            rename(pick(args, ['hashOrHeight', 'includeTransactions', 'network']),
              'hashOrHeight', 'blockHashOrHeight'),
          );
        },
      },
    },
  },
  {
    name: 'get_transaction',
    description: 'Get transaction details by transaction hash.',
    inputSchema: {
      ...chainField(CHAINS),
      hash: z.string().describe('Transaction hash (0x + 64 hex)'),
      ...networkField,
    },
    chains: CHAINS,
    routes: {
      n3: {
        internalName: 'get_transaction',
        requiresServices: true,
        mapArgs: (args) => n3Args(rename(pick(args, ['hash', 'network']), 'hash', 'txid')),
      },
      neox: {
        internalName: 'x_node_get_transaction',
        mapArgs: (args) => passNetwork(pick(args, ['hash', 'network'])),
      },
    },
  },
  {
    name: 'get_transaction_status',
    description:
      'Get the confirmation status of a transaction: whether it is known, confirmed, and '
      + 'whether execution succeeded (with the revert/fault reason when it did not).',
    inputSchema: {
      ...chainField(CHAINS),
      hash: z.string().describe('Transaction hash (0x + 64 hex)'),
      ...networkField,
    },
    chains: CHAINS,
    routes: {
      n3: {
        internalName: 'n3_node_get_transaction_status',
        requiresServices: true,
        mapArgs: (args) => n3Args(pick(args, ['hash', 'network'])),
      },
      neox: {
        internalName: 'x_node_get_transaction_status',
        mapArgs: (args) => passNetwork(pick(args, ['hash', 'network'])),
      },
    },
  },
  {
    name: 'get_balance',
    description:
      'Get balances for an address: NEO, GAS, and NEP-17 tokens on Neo N3, or the native '
      + 'GAS balance on Neo X.',
    inputSchema: {
      ...chainField(CHAINS),
      address: z.string().describe('Neo N3 address (base58) or Neo X 0x address'),
      ...networkField,
    },
    chains: CHAINS,
    routes: {
      n3: {
        internalName: 'get_balance',
        requiresServices: true,
        mapArgs: (args) => n3Args(pick(args, ['address', 'network'])),
      },
      neox: {
        internalName: 'x_node_get_balance',
        mapArgs: (args) => passNetwork(pick(args, ['address', 'network'])),
      },
    },
  },
  {
    name: 'call_contract',
    description:
      'Run a read-only contract call without signing or broadcasting: invokefunction on '
      + 'Neo N3, eth_call on Neo X.',
    inputSchema: {
      ...chainField(CHAINS),
      contract: z.string().optional().describe(
        'Contract reference: script hash, Neo address, or known contract name (Neo N3); '
        + '0x contract address (Neo X)',
      ),
      scriptHash: z.string().optional().describe('Neo N3: contract script hash (0x + 40 hex)'),
      operation: z.string().optional().describe('Neo N3: contract method name'),
      args: z.array(z.unknown()).optional().describe('Method arguments'),
      data: z.string().optional().describe('Neo X: pre-encoded 0x-hex calldata'),
      functionSignature: z.string().optional().describe(
        'Neo X: canonical signature to ABI-encode, e.g. "balanceOf(address)"',
      ),
      from: z.string().optional().describe('Neo X: caller 0x address'),
      ...networkField,
    },
    chains: CHAINS,
    routes: {
      n3: {
        internalName: 'invoke_contract',
        requiresServices: true,
        mapArgs: (args) => n3Args(
          pick(args, ['contract', 'scriptHash', 'operation', 'args', 'network']),
        ),
      },
      neox: {
        internalName: 'x_node_call_contract',
        mapArgs: (args) => passNetwork(
          pick(args, ['contract', 'data', 'functionSignature', 'args', 'from', 'network']),
        ),
      },
    },
  },
  {
    name: 'get_contract_info',
    description:
      'Get contract metadata: manifest, ABI operations, and known-name resolution on Neo N3, '
      + 'or verified source/compiler metadata from the Neo X explorer. Neo X explorer metadata '
      + 'is mainnet only; Neo N3 supports both networks.',
    inputSchema: {
      ...chainField(CHAINS),
      contract: z.string().optional().describe(
        'Neo N3: known contract name, script hash, or Neo address',
      ),
      address: z.string().optional().describe('Neo X: 0x contract address (40 hex chars)'),
      ...networkField,
    },
    chains: CHAINS,
    routes: {
      n3: {
        internalName: 'get_contract_info',
        requiresServices: true,
        mapArgs: (args) => n3Args(pick(args, ['contract', 'network'])),
      },
      neox: {
        internalName: 'x_query',
        mapArgs: (args) => {
          if (args.network === 'testnet') {
            throw new ValidationError(
              'get_contract_info on chain "neox" is mainnet only; testnet explorer metadata is unavailable.',
            );
          }
          const address = args.address ?? args.contract;
          if (typeof address !== 'string' || !address.trim()) {
            throw new ValidationError(
              'get_contract_info on chain "neox" requires a 0x contract address.',
            );
          }
          return { endpoint: 'get_smart_contract', params: { address: address.trim() } };
        },
      },
    },
  },

  // ---------- node reads (Neo N3 only) ----------
  {
    name: 'get_application_log',
    description:
      'Neo N3: get the application log (executions, notifications, and consumed GAS) for a '
      + 'transaction hash.',
    inputSchema: {
      hash: z.string().describe('Transaction hash (0x + 64 hex)'),
      ...networkField,
    },
    chains: ['n3'],
    routes: {
      n3: {
        internalName: 'get_application_log',
        requiresServices: true,
        mapArgs: (args) => n3Args(rename(pick(args, ['hash', 'network']), 'hash', 'txid')),
      },
    },
  },
  {
    name: 'wait_for_transaction',
    description:
      'Neo N3: poll until a transaction is confirmed on-chain (or the timeout elapses), '
      + 'optionally returning its application log.',
    inputSchema: {
      hash: z.string().describe('Transaction hash (0x + 64 hex)'),
      timeoutMs: z.number().int().positive().optional().describe('Timeout in milliseconds'),
      pollIntervalMs: z.number().int().positive().optional().describe('Poll interval in milliseconds'),
      includeApplicationLog: z.boolean().optional().describe(
        'Include the application log once the transaction confirms',
      ),
      ...networkField,
    },
    chains: ['n3'],
    routes: {
      n3: {
        internalName: 'wait_for_transaction',
        requiresServices: true,
        mapArgs: (args) => n3Args(rename(
          pick(args, ['hash', 'timeoutMs', 'pollIntervalMs', 'includeApplicationLog', 'network']),
          'hash', 'txid',
        )),
      },
    },
  },
  {
    name: 'get_unclaimed_gas',
    description: 'Neo N3: get the amount of GAS currently claimable by an address.',
    inputSchema: { address: z.string().describe('Neo N3 address'), ...networkField },
    chains: ['n3'],
    routes: {
      n3: {
        internalName: 'get_unclaimed_gas',
        requiresServices: true,
        mapArgs: (args) => n3Args(pick(args, ['address', 'network'])),
      },
    },
  },
  {
    name: 'decode_neo_script',
    description:
      'Neo N3: tokenize a NeoVM script into opcodes, operands, offsets, syscall names, '
      + 'instruction categories, and concise deterministic explanations.',
    inputSchema: {
      script: z.string().min(1).max(131_072).describe('NeoVM script as hex or canonical base64'),
      inputFormat: z.enum(['auto', 'hex', 'base64']).optional().describe(
        'Script encoding (default auto)',
      ),
    },
    chains: ['n3'],
    routes: {
      n3: {
        internalName: 'decode_neo_script',
        mapArgs: (args) => pick(args, ['script', 'inputFormat']),
      },
    },
  },
  {
    name: 'query_nns',
    description:
      'Neo N3: query a .neo name against the network-correct NameService contract, including '
      + 'availability, price, owner, properties, expiration, and one DNS-style record.',
    inputSchema: {
      domain: z.string().min(3).max(255).describe('Fully-qualified .neo domain'),
      recordType: z.enum(['A', 'CNAME', 'TXT', 'AAAA']).optional().describe(
        'Record to resolve (default TXT, which commonly stores an N3 address)',
      ),
      ...networkField,
    },
    chains: ['n3'],
    routes: {
      n3: {
        internalName: 'query_nns',
        requiresServices: true,
        mapArgs: (args) => n3Args(pick(args, ['domain', 'recordType', 'network'])),
      },
    },
  },
  {
    name: 'query_neofs',
    description:
      'NeoFS: query network information, fixed-gateway container metadata, an N3 account '
      + 'storage balance, or generate canonical NeoFS object links. Requires an explicit N3 '
      + 'network context; the context does not switch the global NeoFS gateway. Read-only and bounded.',
    inputSchema: {
      network: z.enum(['mainnet', 'testnet']).describe(
        'N3 network context for this request (required; NeoFS gateway remains global)',
      ),
      operation: z.enum([
        'network_info', 'container', 'account_balance', 'object_link',
      ]).describe('NeoFS read operation'),
      containerId: z.string().optional().describe('NeoFS container id'),
      objectId: z.string().optional().describe('NeoFS object id'),
      address: z.string().optional().describe('Neo N3 account for accounting balance'),
    },
    chains: ['n3'],
    routes: {
      n3: {
        internalName: 'query_neofs',
        mapArgs: (args) => pick(args, ['network', 'operation', 'containerId', 'objectId', 'address']),
      },
    },
  },
  {
    name: 'get_oracle_info',
    description:
      'Neo N3: read the native Oracle contract response price and explain the asynchronous '
      + 'contract-callback request boundary for the selected network.',
    inputSchema: { ...networkField },
    chains: ['n3'],
    routes: {
      n3: {
        internalName: 'get_oracle_info',
        requiresServices: true,
        mapArgs: (args) => n3Args(pick(args, ['network'])),
      },
    },
  },
  {
    name: 'get_nep17_transfers',
    description: 'Neo N3: get NEP-17 token transfer history for an address, from live RPC.',
    inputSchema: {
      address: z.string().describe('Neo N3 address'),
      fromTimestampMs: z.number().int().nonnegative().optional().describe(
        'Optional start timestamp in Unix epoch milliseconds',
      ),
      toTimestampMs: z.number().int().nonnegative().optional().describe(
        'Optional end timestamp in Unix epoch milliseconds',
      ),
      ...networkField,
    },
    chains: ['n3'],
    routes: {
      n3: {
        internalName: 'get_nep17_transfers',
        requiresServices: true,
        mapArgs: (args) => n3Args(
          pick(args, ['address', 'fromTimestampMs', 'toTimestampMs', 'network']),
        ),
      },
    },
  },
  {
    name: 'get_nep11_balances',
    description: 'Neo N3: get NEP-11 (NFT) balances for an address, from live RPC.',
    inputSchema: { address: z.string().describe('Neo N3 address'), ...networkField },
    chains: ['n3'],
    routes: {
      n3: {
        internalName: 'get_nep11_balances',
        requiresServices: true,
        mapArgs: (args) => n3Args(pick(args, ['address', 'network'])),
      },
    },
  },
  {
    name: 'get_nep11_transfers',
    description: 'Neo N3: get NEP-11 (NFT) transfer history for an address, from live RPC.',
    inputSchema: {
      address: z.string().describe('Neo N3 address'),
      fromTimestampMs: z.number().int().nonnegative().optional().describe(
        'Optional start timestamp in Unix epoch milliseconds',
      ),
      toTimestampMs: z.number().int().nonnegative().optional().describe(
        'Optional end timestamp in Unix epoch milliseconds',
      ),
      ...networkField,
    },
    chains: ['n3'],
    routes: {
      n3: {
        internalName: 'get_nep11_transfers',
        requiresServices: true,
        mapArgs: (args) => n3Args(
          pick(args, ['address', 'fromTimestampMs', 'toTimestampMs', 'network']),
        ),
      },
    },
  },
  {
    name: 'get_contract_status',
    description:
      'Neo N3: check whether a contract is deployed and inspect its current on-chain status '
      + 'by known name, script hash, or Neo address.',
    inputSchema: {
      contract: z.string().optional().describe(
        'Contract reference: known name, script hash, or Neo address',
      ),
      contractName: z.string().optional().describe('Supported contract name'),
      ...networkField,
    },
    chains: ['n3'],
    routes: {
      n3: {
        internalName: 'get_contract_status',
        requiresServices: true,
        mapArgs: (args) => n3Args(pick(args, ['contract', 'contractName', 'network'])),
      },
    },
  },
  {
    name: 'list_famous_contracts',
    description: 'Neo N3: list the well-known contracts this server can resolve by name.',
    inputSchema: { ...networkField },
    chains: ['n3'],
    routes: {
      n3: {
        internalName: 'list_famous_contracts',
        requiresServices: true,
        mapArgs: (args) => n3Args(pick(args, ['network'])),
      },
    },
  },
  {
    name: 'estimate_transfer_fees',
    description: 'Neo N3: estimate the network and system fees for a NEP-17 transfer.',
    inputSchema: {
      from: z.string().describe('Sender Neo N3 address'),
      to: z.string().describe('Recipient Neo N3 address'),
      asset: z.string().describe('"NEO", "GAS", or a NEP-17 contract script hash'),
      amount: z.string().describe('Human-readable decimal amount (e.g. "1.5")'),
      ...networkField,
    },
    chains: ['n3'],
    routes: {
      n3: {
        internalName: 'estimate_transfer_fees',
        requiresServices: true,
        mapArgs: (args) => n3Args(rename(
          rename(pick(args, ['from', 'to', 'asset', 'amount', 'network']), 'from', 'fromAddress'),
          'to', 'toAddress',
        )),
      },
    },
  },
  {
    name: 'estimate_invoke_fees',
    description: 'Neo N3: estimate the network and system fees for a contract invocation.',
    inputSchema: {
      from: z.string().describe('Signer Neo N3 address'),
      contract: z.string().optional().describe(
        'Contract reference: known name, script hash, or Neo address',
      ),
      scriptHash: z.string().optional().describe('Contract script hash (0x + 40 hex)'),
      operation: z.string().describe('Contract method name'),
      args: z.array(z.unknown()).optional().describe('Method arguments'),
      ...networkField,
    },
    chains: ['n3'],
    routes: {
      n3: {
        internalName: 'estimate_invoke_fees',
        requiresServices: true,
        mapArgs: (args) => n3Args(rename(
          pick(args, ['from', 'contract', 'scriptHash', 'operation', 'args', 'network']),
          'from', 'signerAddress',
        )),
      },
    },
  },

  // ---------- construct / simulate (unsigned only) ----------
  {
    name: 'simulate_call',
    description:
      'SIMULATE a contract call read-only and return the preview (Neo N3 test-invoke state, '
      + 'gasConsumed, stack; Neo X eth_call result plus gas estimate). Never signs or broadcasts.',
    inputSchema: {
      ...chainField(CHAINS),
      scriptHash: z.string().optional().describe('Neo N3: contract script hash (0x + 40 hex)'),
      operation: z.string().optional().describe('Neo N3: contract method name to simulate'),
      args: z.array(z.unknown()).optional().describe('Method arguments'),
      signers: z.array(z.object({
        account: z.string().describe('Neo N3 address or 0x script hash'),
        scopes: z.string().optional().describe('Witness scope (default CalledByEntry)'),
      })).optional().describe('Neo N3: optional witness signers for CheckWitness-gated methods'),
      to: z.string().optional().describe('Neo X: target contract/account 0x address'),
      data: z.string().optional().describe('Neo X: 0x-hex calldata'),
      from: z.string().optional().describe('Neo X: caller 0x address'),
      value: z.string().optional().describe('Neo X: wei value as a decimal string'),
      ...networkField,
    },
    chains: CHAINS,
    routes: {
      n3: {
        internalName: 'n3_test_invoke',
        requiresServices: true,
        mapArgs: (args) => n3Args(
          pick(args, ['scriptHash', 'operation', 'args', 'signers', 'network']),
        ),
      },
      neox: {
        internalName: 'x_simulate_call',
        mapArgs: (args) => neoxNetwork(pick(args, ['to', 'data', 'from', 'value', 'network'])),
      },
    },
  },
  {
    name: 'build_transfer',
    description:
      'CONSTRUCT an UNSIGNED transfer proposal: a NeoLine dapi invoke payload on Neo N3, or an '
      + 'unsigned EVM value transfer on Neo X. It runs the exact read-only simulation first and '
      + 'returns a proposal only when that simulation succeeds. The user signs it in their own wallet.',
    inputSchema: {
      ...chainField(CHAINS),
      from: z.string().describe('Sender address (Neo N3 base58, or Neo X 0x)'),
      to: z.string().describe('Recipient address (Neo N3 base58, or Neo X 0x)'),
      asset: z.string().optional().describe(
        'Neo N3: "NEO", "GAS", or a NEP-17 contract script hash',
      ),
      amount: z.string().optional().describe('Neo N3: human-readable decimal amount (e.g. "1.5")'),
      decimals: z.number().int().min(0).max(255).optional().describe('Neo N3: token decimals'),
      amountWei: z.string().optional().describe('Neo X: amount in wei as a decimal string'),
      ...networkField,
    },
    chains: CHAINS,
    routes: {
      n3: {
        internalName: 'n3_build_transfer',
        requiresServices: true,
        mapArgs: (args) => n3Args(
          pick(args, ['from', 'to', 'asset', 'amount', 'decimals', 'network']),
        ),
      },
      neox: {
        internalName: 'x_build_transfer',
        mapArgs: (args) => neoxNetwork(pick(args, ['from', 'to', 'amountWei', 'network'])),
      },
    },
  },
  {
    name: 'build_contract_call',
    description:
      'CONSTRUCT an UNSIGNED contract-invocation proposal: a NeoLine dapi invoke payload on '
      + 'Neo N3, or an unsigned EVM transaction on Neo X. It runs the exact read-only simulation '
      + 'first and returns a proposal only when that simulation succeeds. The user signs it in their own wallet.',
    inputSchema: {
      ...chainField(CHAINS),
      from: z.string().describe('Signer address (Neo N3 base58, or Neo X 0x)'),
      scriptHash: z.string().optional().describe('Neo N3: contract script hash (0x + 40 hex)'),
      operation: z.string().optional().describe('Neo N3: contract method name'),
      args: z.array(z.unknown()).optional().describe('Method arguments'),
      signers: z.array(z.object({
        account: z.string().describe('Neo N3 address or 0x script hash'),
        scopes: z.string().optional().describe('Witness scope (default CalledByEntry)'),
      })).optional().describe('Neo N3: optional explicit witness signers'),
      to: z.string().optional().describe('Neo X: target contract 0x address'),
      data: z.string().optional().describe('Neo X: pre-encoded 0x-hex calldata'),
      functionSignature: z.string().optional().describe(
        'Neo X: canonical signature to ABI-encode, e.g. "transfer(address,uint256)"',
      ),
      valueWei: z.string().optional().describe('Neo X: wei value to attach as a decimal string'),
      ...networkField,
    },
    chains: CHAINS,
    routes: {
      n3: {
        internalName: 'n3_build_invoke',
        requiresServices: true,
        mapArgs: (args) => n3Args(
          pick(args, ['from', 'scriptHash', 'operation', 'args', 'signers', 'network']),
        ),
      },
      neox: {
        internalName: 'x_build_contract_call',
        mapArgs: (args) => neoxNetwork(
          pick(args, ['from', 'to', 'data', 'functionSignature', 'args', 'valueWei', 'network']),
        ),
      },
    },
  },
  {
    name: 'build_vote',
    description:
      'Neo N3: construct and simulate an UNSIGNED NEO governance vote or unvote proposal for '
      + 'the connected wallet. The proposal is returned only when vote() returns true.',
    inputSchema: {
      from: z.string().describe('Connected Neo N3 voter address'),
      candidate: z.string().optional().describe(
        'Compressed candidate public key (02/03 + 64 hex); omit to remove the current vote',
      ),
      ...networkField,
    },
    chains: ['n3'],
    routes: {
      n3: {
        internalName: 'n3_build_vote',
        requiresServices: true,
        mapArgs: (args) => n3Args(pick(args, ['from', 'candidate', 'network'])),
      },
    },
  },
  {
    name: 'build_nns_operation',
    description:
      'Neo N3: construct and simulate an UNSIGNED NNS register, renew, record update/delete, '
      + 'or domain transfer proposal against the network-correct NameService contract.',
    inputSchema: {
      from: z.string().describe('Connected Neo N3 signer address'),
      action: z.enum([
        'register', 'renew', 'set_record', 'delete_record', 'transfer',
      ]).describe('NNS state-changing operation'),
      domain: z.string().min(3).max(255).describe('Fully-qualified .neo domain'),
      years: z.number().int().min(1).max(10).optional().describe('Renewal years (default 1)'),
      recordType: z.enum(['A', 'CNAME', 'TXT', 'AAAA']).optional().describe(
        'Required for set_record/delete_record',
      ),
      data: z.string().max(1024).optional().describe('Required record value for set_record'),
      to: z.string().optional().describe('Recipient Neo N3 address for transfer'),
      ...networkField,
    },
    chains: ['n3'],
    routes: {
      n3: {
        internalName: 'n3_build_nns_operation',
        requiresServices: true,
        mapArgs: (args) => n3Args(
          pick(args, [
            'from', 'action', 'domain', 'years', 'recordType', 'data', 'to', 'network',
          ]),
        ),
      },
    },
  },

  // ---------- explorer / indexer reads ----------
  {
    name: 'explorer_get_address',
    description:
      'Explorer analytics: get the indexed account summary for an address (balances, type, '
      + 'tags, first-seen).',
    inputSchema: {
      ...chainField(CHAINS),
      address: z.string().describe('Neo N3 address/script hash, or Neo X 0x address'),
      ...networkField,
    },
    chains: CHAINS,
    routes: {
      n3: {
        internalName: 'n3_get_address',
        mapArgs: (args) => n3Args(pick(args, ['address', 'network'])),
      },
      neox: { internalName: 'x_get_address', mapArgs: xExplorerArgs(['address']) },
    },
  },
  {
    name: 'analyze_neox_transaction',
    description:
      'PRIMARY Neo X transaction-intelligence tool. Aggregates the indexed transaction, '
      + 'event logs, internal calls, token transfers, and state changes in one bounded read. '
      + 'Report unavailable sections and pagination boundaries; indexed traces are evidence, '
      + 'not proof of intent or identity.',
    inputSchema: {
      hash: z.string().describe('Neo X transaction hash (0x + 64 hex characters)'),
      ...networkField,
    },
    chains: ['neox'],
    routes: {
      neox: {
        internalName: 'x_analyze_transaction',
        mapArgs: (args) => neoxNetwork(pick(args, ['hash', 'network'])),
      },
    },
  },
  {
    name: 'analyze_neox_block',
    description:
      'PRIMARY Neo X block-intelligence tool. Returns indexed block facts and a bounded newest '
      + 'page of included transactions with explicit pagination and availability boundaries. '
      + 'Do not infer activity outside the returned page.',
    inputSchema: {
      blockNumberOrHash: z.union([z.string(), z.number().int().nonnegative()]).describe(
        'Neo X block height or 0x block hash',
      ),
      ...networkField,
    },
    chains: ['neox'],
    routes: {
      neox: {
        internalName: 'x_analyze_block',
        mapArgs: (args) => neoxNetwork(pick(args, ['blockNumberOrHash', 'network'])),
      },
    },
  },
  {
    name: 'analyze_neox_address',
    description:
      'PRIMARY Neo X account-intelligence tool. Aggregates the indexed account summary, counters, '
      + 'recent transactions, token transfers, internal calls, and current token balances in one '
      + 'bounded read. Observed activity and public tags never prove a real-world owner.',
    inputSchema: {
      address: z.string().describe('Neo X account or contract address (0x + 40 hex characters)'),
      ...networkField,
    },
    chains: ['neox'],
    routes: {
      neox: {
        internalName: 'x_analyze_address',
        mapArgs: (args) => neoxNetwork(pick(args, ['address', 'network'])),
      },
    },
  },
  {
    name: 'analyze_neox_contract',
    description:
      'PRIMARY Neo X contract-intelligence tool. Aggregates account/proxy metadata, verified '
      + 'source and ABI when available, counters, recent transactions, token transfers, and logs. '
      + 'Source verification is not a security audit, and missing optional evidence stays explicit.',
    inputSchema: {
      address: z.string().describe('Neo X contract address (0x + 40 hex characters)'),
      ...networkField,
    },
    chains: ['neox'],
    routes: {
      neox: {
        internalName: 'x_analyze_contract',
        mapArgs: (args) => neoxNetwork(pick(args, ['address', 'network'])),
      },
    },
  },
  {
    name: 'analyze_neox_token',
    description:
      'PRIMARY Neo X token-intelligence tool. Aggregates token metadata, counters, a bounded '
      + 'holder sample, recent transfers, and NFT instances when available. Preserve exact raw '
      + 'values and pagination boundaries; a holder page is not an exhaustive distribution audit.',
    inputSchema: {
      address: z.string().describe('Neo X ERC-20/ERC-721/ERC-1155 contract address'),
      ...networkField,
    },
    chains: ['neox'],
    routes: {
      neox: {
        internalName: 'x_analyze_token',
        mapArgs: (args) => neoxNetwork(pick(args, ['address', 'network'])),
      },
    },
  },
  {
    name: 'analyze_address',
    description:
      'PRIMARY Neo N3 account-intelligence tool for address identity or relationship analysis. '
      + 'Use this first instead of fanning out across summary, balance, transaction, transfer, '
      + 'and search tools. Returns curated identity evidence, on-chain names, bounded transfer '
      + 'relationships, co-signers, contract interactions, behavior signals, confidence, and '
      + 'explicit sample boundaries; observed behavior never proves a real-world owner.',
    inputSchema: {
      address: z.string().describe('Canonical Base58 Neo N3 account address'),
      sample: z.number().int().min(20).max(200).optional().describe(
        'Recent transfer rows sampled per direction (20-200, default 100)',
      ),
      limit: z.number().int().min(4).max(24).optional().describe(
        'Maximum ranked relationships to return (4-24, default 12)',
      ),
      ...networkField,
    },
    chains: ['n3'],
    routes: {
      n3: {
        internalName: 'query_indexer',
        mapArgs: (args) => ({
          method: 'analyze_address',
          params: pick(args, ['address', 'sample', 'limit']),
          ...n3Args(pick(args, ['network'])),
        }),
      },
    },
  },
  {
    name: 'analyze_address_connection',
    description:
      'PRIMARY Neo N3 tool for explaining how two addresses are connected. Returns '
      + 'network-scoped, bounded evidence for direct transfers, co-signed transactions, '
      + 'and one-intermediary shared-counterparty paths, with endpoint/intermediary identity '
      + 'provenance and explicit non-exhaustive sample boundaries. Connections never prove '
      + 'common ownership.',
    inputSchema: {
      source: z.string().describe('Source canonical Base58 Neo N3 account address'),
      target: z.string().describe('Target canonical Base58 Neo N3 account address'),
      sample: z.number().int().min(20).max(200).optional().describe(
        'Recent transfer rows sampled per direction and address (20-200, default 100)',
      ),
      limit: z.number().int().min(1).max(12).optional().describe(
        'Maximum connection evidence paths to return (1-12, default 8)',
      ),
      ...networkField,
    },
    chains: ['n3'],
    routes: {
      n3: {
        internalName: 'query_indexer',
        mapArgs: (args) => ({
          method: 'analyze_address_connection',
          params: {
            address: args.source,
            target: args.target,
            ...pick(args, ['sample', 'limit']),
          },
          ...n3Args(pick(args, ['network'])),
        }),
      },
    },
  },
  {
    name: 'analyze_account_graph',
    description:
      'PRIMARY Neo N3 account-relationship graph tool. Returns ranked counterparties from the '
      + 'offline, replayable transfer graph, exact per-contract/per-standard asset flows, curated '
      + 'identity metadata, and explicit indexed/materialized coverage boundaries. Observed transfer '
      + 'relationships do not prove common ownership or real-world identity; never treat a partial '
      + 'coverage window or a truncated per-counterparty asset list as exhaustive history.',
    inputSchema: {
      address: z.string().describe('Canonical Base58 Neo N3 account address'),
      limit: z.number().int().min(4).max(50).optional().describe(
        'Maximum ranked counterparties to return (4-50, default 12)',
      ),
      ...networkField,
    },
    chains: ['n3'],
    routes: {
      n3: {
        internalName: 'query_indexer',
        mapArgs: (args) => ({
          method: 'analyze_account_graph',
          params: pick(args, ['address', 'limit']),
          ...n3Args(pick(args, ['network'])),
        }),
      },
    },
  },
  {
    name: 'analyze_consensus_health',
    description:
      'PRIMARY Neo N3 consensus diagnosis tool. Returns deterministic evidence for expected-primary '
      + 'misses, view-change streaks, actual block producers, validator names, and block-data freshness '
      + 'on one explicit network. Incomplete, non-contiguous, or stale windows return unknown; do not '
      + 'infer a node failure beyond the returned evidence or treat a fallback producer as the missed primary.',
    inputSchema: {
      lookback: z.number().int().min(8).max(200).optional().describe(
        'Number of recent contiguous blocks to inspect (8-200, default 160)',
      ),
      streak_threshold: z.number().int().min(1).max(100).optional().describe(
        'Consecutive expected-primary misses needed to mark a node failing (1-100, default 5)',
      ),
      duration_threshold_s: z.number().int().min(1).max(3600).optional().describe(
        'Seconds since the current miss streak began before marking a node failing (1-3600, default 120)',
      ),
      max_data_age_s: z.number().int().min(1).max(86400).optional().describe(
        'Maximum accepted age of the latest indexed block data in seconds (1-86400, default 180)',
      ),
      max_clock_skew_s: z.number().int().min(0).max(3600).optional().describe(
        'Allowed future timestamp skew for the freshness check in seconds (0-3600, default 30)',
      ),
      ...networkField,
    },
    chains: ['n3'],
    routes: {
      n3: {
        internalName: 'query_indexer',
        mapArgs: (args) => ({
          method: 'analyze_consensus_health',
          params: pick(args, [
            'lookback',
            'streak_threshold',
            'duration_threshold_s',
            'max_data_age_s',
            'max_clock_skew_s',
          ]),
          ...n3Args(pick(args, ['network'])),
        }),
      },
    },
  },
  {
    name: 'analyze_transaction',
    description:
      'PRIMARY Neo N3 transaction-explanation tool. Use this first for transaction meaning, '
      + 'fees, asset flows, signers, VM outcome, or contract events. Returns deterministic '
      + 'indexed facts with stable evidence IDs, evidence-backed participant identities, '
      + 'exact decimal strings, grouped fund flows, conservative failure classification, '
      + 'and code-based findings. Preserve returned values and cite evidence IDs; do not '
      + 'perform token scaling or arithmetic, or claim opcode/storage trace depth not present.',
    inputSchema: {
      txid: z.string().describe('Neo N3 transaction hash (0x + 64 hex characters)'),
      ...networkField,
    },
    chains: ['n3'],
    routes: {
      n3: {
        internalName: 'query_indexer',
        mapArgs: (args) => ({
          method: 'analyze_transaction',
          params: pick(args, ['txid']),
          ...n3Args(pick(args, ['network'])),
        }),
      },
    },
  },
  {
    name: 'investigate_transactions',
    description:
      'Neo N3 multi-transaction investigation workbench. Returns a deterministic, bounded '
      + 'evidence set for 1-12 transaction hashes on one explicit network, including a stable '
      + 'investigation ID, chronological timeline, exact observed asset-transfer relationships, '
      + 'source transaction references, confidence class, and sampling boundary. Use this to '
      + 'compare or explain a known set of transactions. Do not infer shared ownership, causality, '
      + 'hidden calls, or activity outside the requested set.',
    inputSchema: {
      txids: z.array(
        z.string().regex(/^0x[0-9a-f]{64}$/i, 'Expected a Neo N3 transaction hash (0x + 64 hex characters)'),
      ).min(1).max(12).describe('One to twelve Neo N3 transaction hashes'),
      ...networkField,
    },
    chains: ['n3'],
    routes: {
      n3: {
        internalName: 'query_indexer',
        mapArgs: (args) => ({
          method: 'investigate_transactions',
          params: { txids: args.txids },
          ...n3Args(pick(args, ['network'])),
        }),
      },
    },
  },
  {
    name: 'analyze_contract',
    description:
      'PRIMARY Neo N3 contract-intelligence tool. Use this first for contract purpose, ABI, '
      + 'permissions, trusts, update state, compiler metadata, or static risk signals. Returns '
      + 'deterministic indexed facts with stable evidence IDs and conservative code-based '
      + 'findings. A declared source URL, unsafe ABI method, or decompiled output is not proof '
      + 'of verified source or a vulnerability; preserve that distinction and cite evidence IDs.',
    inputSchema: {
      contractHash: z.string().describe('Neo N3 contract script hash (0x + 40 hex characters)'),
      ...networkField,
    },
    chains: ['n3'],
    routes: {
      n3: {
        internalName: 'query_indexer',
        mapArgs: (args) => ({
          method: 'analyze_contract',
          params: { hash: args.contractHash },
          ...n3Args(pick(args, ['network'])),
        }),
      },
    },
  },
  {
    name: 'inspect_contract_code',
    description:
      'Neo N3 contract-code inspection companion to analyze_contract. Returns paginated '
      + 'deterministic NeoVM opcode annotations, ABI method ownership, bounded operands, '
      + 'resolved syscall names, and static control-flow targets with stable evidence IDs. '
      + 'This is static disassembly, not a runtime trace, verified source, decompilation, '
      + 'simulation, or proof of a vulnerability.',
    inputSchema: {
      contractHash: z.string().describe('Neo N3 contract script hash (0x + 40 hex characters)'),
      ...paginationFields,
      ...networkField,
    },
    chains: ['n3'],
    routes: {
      n3: {
        internalName: 'query_indexer',
        mapArgs: (args) => ({
          method: 'inspect_contract_code',
          params: {
            hash: args.contractHash,
            ...rename(pick(args, ['limit', 'skip']), 'skip', 'offset'),
          },
          ...n3Args(pick(args, ['network'])),
        }),
      },
    },
  },
  {
    name: 'analyze_contract_upgrades',
    description:
      'Neo N3 contract-upgrade history companion to analyze_contract. Compares immutable indexed '
      + 'manifest and NEF artifacts by update counter, reports exact history coverage, artifact '
      + 'hashes, and structural ABI method/event/standard changes with stable evidence IDs. '
      + 'Missing versions remain explicit. Storage compatibility cannot be proven from ABI or NEF '
      + 'artifacts and is always reported as not_determined.',
    inputSchema: {
      contractHash: z.string().describe('Neo N3 contract script hash (0x + 40 hex characters)'),
      ...networkField,
    },
    chains: ['n3'],
    routes: {
      n3: {
        internalName: 'query_indexer',
        mapArgs: (args) => ({
          method: 'analyze_contract_upgrades',
          params: { hash: args.contractHash },
          ...n3Args(pick(args, ['network'])),
        }),
      },
    },
  },
  {
    name: 'get_contract_source_verification',
    description:
      'Read-only Neo N3 reproducible source-verification evidence for a contract. Returns '
      + 'network- and update-counter-scoped source bundle, compiler settings, manifest, NEF, '
      + 'binary, and script hashes produced by exact artifact matching. A historical verified '
      + 'version never verifies newer current code. Verification is not a security audit.',
    inputSchema: {
      contractHash: z.string().describe('Neo N3 contract script hash (0x + 40 hex characters)'),
      ...networkField,
    },
    chains: ['n3'],
    routes: {
      n3: {
        internalName: 'query_indexer',
        mapArgs: (args) => ({
          method: 'get_contract_source_verification',
          params: { hash: args.contractHash },
          ...n3Args(pick(args, ['network'])),
        }),
      },
    },
  },
  {
    name: 'explorer_list_address_transactions',
    description: 'Explorer analytics: list transactions involving an address, newest first.',
    inputSchema: {
      ...chainField(CHAINS),
      address: z.string().describe('Neo N3 address/script hash, or Neo X 0x address'),
      ...paginationFields,
      ...networkField,
    },
    chains: CHAINS,
    routes: {
      n3: {
        internalName: 'n3_list_transactions_by_address',
        mapArgs: (args) => n3Args(pick(args, ['address', 'limit', 'skip', 'network'])),
      },
      neox: {
        internalName: 'x_list_transactions_by_address',
        mapArgs: xExplorerArgs(['address']),
      },
    },
  },
  {
    name: 'explorer_list_address_transfers',
    description:
      'Explorer analytics: list token transfers for an address (NEP-17 on Neo N3, '
      + 'ERC-20/721/1155 on Neo X).',
    inputSchema: {
      ...chainField(CHAINS),
      address: z.string().describe('Neo N3 address/script hash, or Neo X 0x address'),
      ...paginationFields,
      ...networkField,
    },
    chains: CHAINS,
    routes: {
      n3: {
        internalName: 'n3_list_transfers_by_address',
        mapArgs: (args) => n3Args(pick(args, ['address', 'limit', 'skip', 'network'])),
      },
      neox: { internalName: 'x_list_token_transfers', mapArgs: xExplorerArgs(['address']) },
    },
  },
  {
    name: 'explorer_list_address_assets',
    description: 'Neo N3 explorer analytics: list the assets (with balances) held by an address.',
    inputSchema: {
      address: z.string().describe('Neo N3 address or 0x script hash'),
      ...paginationFields,
      ...networkField,
    },
    chains: ['n3'],
    routes: {
      n3: {
        internalName: 'n3_assets_held_by_address',
        mapArgs: (args) => n3Args(pick(args, ['address', 'limit', 'skip', 'network'])),
      },
    },
  },
  {
    name: 'explorer_list_token_holders',
    description:
      'Explorer analytics: list the holders of a token contract, with balances (NEP-17 on '
      + 'Neo N3, ERC-20 on Neo X).',
    inputSchema: {
      ...chainField(CHAINS),
      contractHash: z.string().describe(
        'Token contract script hash (Neo N3) or 0x token contract address (Neo X)',
      ),
      ...paginationFields,
      ...networkField,
    },
    chains: CHAINS,
    routes: {
      n3: {
        internalName: 'n3_asset_holders',
        mapArgs: (args) => n3Args(pick(args, ['contractHash', 'limit', 'skip', 'network'])),
      },
      neox: {
        internalName: 'x_token_holders',
        mapArgs: (args) => neoxNetwork(
          rename(dropPagination(pick(args, ['contractHash', 'network'])),
            'contractHash', 'address'),
        ),
      },
    },
  },
  {
    name: 'explorer_search',
    description:
      'Explorer analytics: full-text search across blocks, transactions, addresses, tokens, '
      + 'and contracts. Neo N3 index search is mainnet only; Neo X supports both networks.',
    inputSchema: {
      ...chainField(CHAINS),
      q: z.string().describe('Search query (address, token name/symbol, block, or tx hash)'),
      ...networkField,
    },
    chains: CHAINS,
    routes: {
      n3: {
        internalName: 'query_indexer',
        mapArgs: (args) => {
          if (args.network === 'testnet') {
            throw new ValidationError(
              'explorer_search on chain "n3" is mainnet only; use node tools for testnet lookups.',
            );
          }
          const q = args.q;
          if (typeof q !== 'string' || !q.trim()) {
            throw new ValidationError('explorer_search requires a non-empty "q" query string.');
          }
          return { method: 'search', params: { q: q.trim() } };
        },
      },
      neox: { internalName: 'x_search', mapArgs: xExplorerArgs(['q']) },
    },
  },
  {
    name: 'query_explorer',
    description:
      'Generic explorer query: pick one vetted read-only endpoint from the chain catalog '
      + '(n3index REST for Neo N3, Blockscout v2 for Neo X) and pass its typed params. '
      + 'Unknown endpoints and params are rejected before any network call.',
    inputSchema: {
      ...chainField(CHAINS),
      endpoint: z.string().describe('One of the vetted catalog endpoints for the selected chain'),
      params: z.record(z.string(), z.unknown()).optional().describe(
        'Typed params for the chosen endpoint. Only that endpoint\'s declared keys are accepted; '
        + 'Neo N3 pagination uses `offset` here (not `skip`).',
      ),
      ...networkField,
    },
    chains: CHAINS,
    routes: {
      n3: {
        internalName: 'query_indexer',
        mapArgs: (args) => rename(
          n3Args(pick(args, ['endpoint', 'params', 'network'])),
          'endpoint',
          'method',
        ),
      },
      neox: {
        internalName: 'x_query',
        mapArgs: (args) => neoxNetwork(pick(args, ['endpoint', 'params', 'network'])),
      },
    },
  },
  {
    name: 'query_explorer_find',
    description:
      'Neo N3 constrained-filter indexer query: author a small vetted filter over one '
      + 'allowlisted collection. Gated off by default (N3INDEX_FIND_ENABLED); mainnet only.',
    inputSchema: {
      collection: z.string().describe('One of the vetted indexer collections'),
      filter: z.record(z.string(), z.unknown()).optional().describe(
        'Small Mongo-shaped filter over the collection\'s indexed fields only',
      ),
      sort: z.record(z.string(), z.unknown()).optional().describe(
        'Optional sort spec over sortable fields: { field: 1 | -1 | "asc" | "desc" }',
      ),
      limit: z.number().int().min(1).max(100).optional().describe('Max rows (default 20, capped)'),
      skip: z.number().int().nonnegative().optional().describe('Rows to skip (default 0, capped)'),
    },
    chains: ['n3'],
    routes: {
      n3: {
        internalName: 'query_indexer_find',
        mapArgs: (args) => pick(args, ['collection', 'filter', 'sort', 'limit', 'skip']),
      },
    },
  },
  {
    name: 'query_explorer_graphql',
    description:
      'Neo X arbitrary Blockscout GraphQL read query. Gated off by default '
      + '(NEOX_GRAPHQL_ENABLED); mutations, subscriptions, introspection, and directives are '
      + 'rejected. Mainnet only.',
    inputSchema: {
      query: z.string().describe('A read-only GraphQL query document'),
      variables: z.record(z.string(), z.unknown()).optional().describe(
        'Optional GraphQL variables as a plain, bounded JSON object',
      ),
    },
    chains: ['neox'],
    routes: {
      neox: {
        internalName: 'x_graphql',
        mapArgs: (args) => pick(args, ['query', 'variables']),
      },
    },
  },
];

// --- exported surface --------------------------------------------------------

export const PUBLIC_TOOLS: Readonly<Record<string, PublicToolSpec>> = Object.freeze(
  SPECS.reduce<Record<string, PublicToolSpec>>((acc, spec) => {
    acc[spec.name] = spec;
    return acc;
  }, {}),
);

const PUBLIC_TOOL_NAMES: readonly string[] = SPECS.map((spec) => spec.name);

export function publicToolNames(): string[] {
  return [...PUBLIC_TOOL_NAMES];
}

export function listPublicTools(): PublicToolSpec[] {
  return [...SPECS];
}

export function isPublicTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(PUBLIC_TOOLS, name);
}

export function supportedChains(name: string): Chain[] {
  const spec = PUBLIC_TOOLS[name];
  if (!spec) {
    throw new ValidationError(`Unknown tool "${name}".`);
  }
  return [...spec.chains];
}

function resolveChain(spec: PublicToolSpec, args: Record<string, unknown>): Chain | undefined {
  const requested = args.chain;

  // Chain-less meta tools: ignore any chain the caller sends.
  if (spec.chains.length === 0) return undefined;

  // Single-chain tools: chain is optional, but a wrong one is an error.
  if (spec.chains.length === 1) {
    const only = spec.chains[0];
    if (requested !== undefined && requested !== only) {
      throw new ValidationError(
        `Tool "${spec.name}" does not support chain "${String(requested)}"; `
        + `it is ${only === 'n3' ? 'Neo N3' : 'Neo X'} only.`,
      );
    }
    return only;
  }

  // Multi-chain tools: chain is required, with no silent default.
  if (typeof requested !== 'string' || requested.length === 0) {
    throw new ValidationError(
      `Tool "${spec.name}" requires a "chain" argument: `
      + `${spec.chains.map((c) => `"${c}"`).join(' or ')}.`,
    );
  }
  if (!(spec.chains as readonly string[]).includes(requested)) {
    throw new ValidationError(
      `Tool "${spec.name}" does not support chain "${requested}"; `
      + `supported: ${spec.chains.join(', ')}.`,
    );
  }
  return requested as Chain;
}

/**
 * Resolve a public tool call onto its internal handler and argument shape.
 * Throws ValidationError for unknown tools, missing/unsupported chains, and
 * invalid network values.
 */
export function resolveRoute(name: string, args: Record<string, unknown> = {}): ToolRoute {
  const spec = PUBLIC_TOOLS[name];
  if (!spec) {
    throw new ValidationError(`Unknown tool "${name}".`);
  }

  const chain = resolveChain(spec, args);
  const route = chain ? spec.routes[chain] : spec.routes.meta;
  if (!route) {
    throw new ValidationError(
      `Tool "${name}" does not support chain "${String(chain)}".`,
    );
  }

  const incoming: Record<string, unknown> = { ...args };
  delete incoming.chain;

  const mapped = route.mapArgs ? route.mapArgs(incoming) : incoming;

  return {
    publicName: name,
    internalName: route.internalName,
    chain,
    args: { ...mapped },
    requiresServices: route.requiresServices === true,
    requiresWallet: route.requiresWallet === true,
  };
}
