// src/handlers/tool-handler.ts
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import {
  MAX_TRANSACTION_WAIT_TIMEOUT_MS,
  MIN_TRANSACTION_POLL_INTERVAL_MS,
  NeoService,
  NeoNetwork,
} from '../services/neo-service';
import { ContractService } from '../contracts/contract-service';
import { sanitizeWalletMetadata, WalletService } from '../services/wallet-service';
import { config, NetworkMode } from '../config';
import {
  validateAddress,
  validateHash,
  validateScriptHash,
  validateNetwork,
  validateInteger,
  validateTokenAmount,
  validateEvmAddress,
  validateEvmHash,
  validateEvmBlockRef,
  sanitizeString,
} from '../utils/validation';
import { handleError, createSuccessResponse } from '../utils/error-handler';
import { chargeClientRateLimit } from '../utils/client-rate-limit';
import { callIndexerRpc } from '../contracts/indexer-rpc-client';
import { assertAllowedEndpoint, buildEndpointRequest } from '../indexer/blockscout-query-guard';
import { assertAllowedCollection, validateFind } from '../indexer/indexer-find-guard';
import { validateGraphqlQuery } from '../indexer/blockscout-graphql-guard';
import { fetchBlockscout, resolveNeoxNetwork, NeoxNetwork } from '../contracts/blockscout-client';
import { fetchN3Index } from '../contracts/n3index-rest-client';
import { assertAllowedN3Endpoint, buildN3EndpointRequest } from '../indexer/n3-rest-guard';
import { postBlockscoutGraphql } from '../contracts/blockscout-graphql-client';
import { ValidationError } from '../utils/errors';
import {
  N3_PROPOSAL_TOOLS,
  NEOX_PROPOSAL_TOOLS,
  dispatchN3ProposalTool,
  dispatchNeoxProposalTool,
} from './proposal-tools';
import { NEOX_NODE_TOOLS, dispatchNeoxNodeTool } from './neox-node-tools';
import { handleN3TransactionStatus } from './n3-transaction-status';
import { NEO_DATA_TOOLS, dispatchNeoDataTool } from './neo-data-tools';
import {
  ECOSYSTEM_META_TOOLS,
  ECOSYSTEM_N3_TOOLS,
  dispatchEcosystemMetaTool,
  dispatchEcosystemN3Tool,
} from './ecosystem-tools';
import { NEOX_ANALYSIS_TOOLS, dispatchNeoxAnalysisTool } from './neox-analysis-tools';

// --- Individual Tool Handlers ---

async function handleGetNetworkMode(): Promise<Record<string, unknown>> {
  const availableNetworks = [];

  if (config.networkMode === NetworkMode.MAINNET_ONLY || config.networkMode === NetworkMode.BOTH) {
    availableNetworks.push(NeoNetwork.MAINNET);
  }

  if (config.networkMode === NetworkMode.TESTNET_ONLY || config.networkMode === NetworkMode.BOTH) {
    availableNetworks.push(NeoNetwork.TESTNET);
  }

  const defaultNetwork = config.networkMode === NetworkMode.TESTNET_ONLY
    ? NeoNetwork.TESTNET
    : NeoNetwork.MAINNET;

  return createSuccessResponse({
    networkMode: config.networkMode,
    mode: config.networkMode,
    availableNetworks,
    defaultNetwork
  });
}

async function handleGetBlockchainInfo(input: Record<string, unknown>, neoService: NeoService): Promise<unknown> {
  try {
    const info = await neoService.getBlockchainInfo();
    return createSuccessResponse(info);
  } catch (error) {
    return handleError(error);
  }
}

async function handleGetBlockCount(input: Record<string, unknown>, neoService: NeoService): Promise<unknown> {
  try {
    const count = await neoService.getBlockCount();
    return createSuccessResponse({
      blockCount: count,
      height: Math.max(0, count - 1),
      network: neoService.getNetwork(),
    });
  } catch (error) {
    return handleError(error);
  }
}

function addBlockTimeIso(block: Record<string, unknown>): Record<string, unknown> {
  const rawTime = block.time;
  if (
    (typeof rawTime !== 'number' && typeof rawTime !== 'string')
    || (typeof rawTime === 'string' && !/^\d+$/.test(rawTime))
  ) {
    return block;
  }
  const timestampMs = Number(rawTime);
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0 || timestampMs > 8_640_000_000_000_000) {
    return block;
  }
  return {
    ...block,
    timeIso: new Date(timestampMs).toISOString(),
  };
}

async function handleGetBlock(input: Record<string, unknown>, neoService: NeoService): Promise<unknown> {
  try {
    let blockReference: string | number;
    if (typeof input.hashOrHeight === 'string') {
      blockReference = validateHash(input.hashOrHeight);
    } else if (typeof input.hashOrHeight === 'number') {
      blockReference = validateInteger(input.hashOrHeight);
    } else {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'hashOrHeight must be a string or number');
    }
    const block = addBlockTimeIso(await neoService.getBlock(blockReference));
    if (input.includeStateRoot === undefined || input.includeStateRoot === false) {
      return createSuccessResponse(block);
    }
    if (input.includeStateRoot !== true) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'includeStateRoot must be a boolean');
    }

    const returnedIndex = block.index;
    if (
      typeof blockReference === 'string'
      && typeof returnedIndex !== 'number'
      && typeof returnedIndex !== 'string'
    ) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        'Block response does not contain a valid index for state-root lookup',
      );
    }
    const blockHeight = typeof blockReference === 'number'
      ? blockReference
      : validateInteger(returnedIndex as string | number);
    const stateRootValidation = await neoService.getStateRootValidation(blockHeight);
    return createSuccessResponse({
      ...block,
      stateRootValidation,
    });
  } catch (error) {
    return handleError(error);
  }
}

async function handleGetTransaction(input: Record<string, unknown>, neoService: NeoService): Promise<unknown> {
  try {
    validateHash(input.txid as string);
    const tx = await neoService.getTransaction(input.txid as string);
    return createSuccessResponse(tx);
  } catch (error) {
    return handleError(error);
  }
}


async function handleGetApplicationLog(input: Record<string, unknown>, neoService: NeoService): Promise<unknown> {
  try {
    validateHash(input.txid as string);
    const applicationLog = await neoService.getApplicationLog(input.txid as string);
    return createSuccessResponse(applicationLog);
  } catch (error) {
    return handleError(error);
  }
}

async function handleWaitForTransaction(input: Record<string, unknown>, neoService: NeoService): Promise<unknown> {
  try {
    validateHash(input.txid as string);
    const timeoutMs = input.timeoutMs !== undefined ? validateInteger(input.timeoutMs as string | number) : 30000;
    const pollIntervalMs = input.pollIntervalMs !== undefined ? validateInteger(input.pollIntervalMs as string | number) : 1000;

    if (timeoutMs <= 0) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'timeoutMs must be greater than zero.');
    }

    if (pollIntervalMs <= 0) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'pollIntervalMs must be greater than zero.');
    }
    if (timeoutMs > MAX_TRANSACTION_WAIT_TIMEOUT_MS) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `timeoutMs must not exceed ${MAX_TRANSACTION_WAIT_TIMEOUT_MS}.`
      );
    }
    if (pollIntervalMs < MIN_TRANSACTION_POLL_INTERVAL_MS) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `pollIntervalMs must be at least ${MIN_TRANSACTION_POLL_INTERVAL_MS}.`
      );
    }

    const result = await neoService.waitForTransaction(input.txid as string, {
      timeoutMs,
      pollIntervalMs,
      includeApplicationLog: Boolean(input.includeApplicationLog),
    });
    return createSuccessResponse(result);
  } catch (error) {
    return handleError(error);
  }
}

async function handleGetUnclaimedGas(input: Record<string, unknown>, neoService: NeoService): Promise<unknown> {
  try {
    validateAddress(input.address as string);
    const result = await neoService.getUnclaimedGas(input.address as string);
    return createSuccessResponse(result);
  } catch (error) {
    return handleError(error);
  }
}

async function handleGetNep17Transfers(input: Record<string, unknown>, neoService: NeoService): Promise<unknown> {
  try {
    validateAddress(input.address as string);
    const fromTimestampMs = input.fromTimestampMs !== undefined ? validateInteger(input.fromTimestampMs as string | number) : undefined;
    const toTimestampMs = input.toTimestampMs !== undefined ? validateInteger(input.toTimestampMs as string | number) : undefined;

    if (fromTimestampMs !== undefined && toTimestampMs !== undefined && fromTimestampMs > toTimestampMs) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'fromTimestampMs must be less than or equal to toTimestampMs.');
    }

    const result = await neoService.getNep17Transfers(input.address as string, {
      ...(fromTimestampMs !== undefined ? { fromTimestampMs } : {}),
      ...(toTimestampMs !== undefined ? { toTimestampMs } : {}),
    });
    return createSuccessResponse(result);
  } catch (error) {
    return handleError(error);
  }
}

async function handleGetNep11Balances(input: Record<string, unknown>, neoService: NeoService): Promise<unknown> {
  try {
    validateAddress(input.address as string);
    const result = await neoService.getNep11Balances(input.address as string);
    return createSuccessResponse(result);
  } catch (error) {
    return handleError(error);
  }
}

async function handleGetNep11Transfers(input: Record<string, unknown>, neoService: NeoService): Promise<unknown> {
  try {
    validateAddress(input.address as string);
    const fromTimestampMs = input.fromTimestampMs !== undefined ? validateInteger(input.fromTimestampMs as string | number) : undefined;
    const toTimestampMs = input.toTimestampMs !== undefined ? validateInteger(input.toTimestampMs as string | number) : undefined;

    if (fromTimestampMs !== undefined && toTimestampMs !== undefined && fromTimestampMs > toTimestampMs) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'fromTimestampMs must be less than or equal to toTimestampMs.');
    }

    const result = await neoService.getNep11Transfers(input.address as string, {
      ...(fromTimestampMs !== undefined ? { fromTimestampMs } : {}),
      ...(toTimestampMs !== undefined ? { toTimestampMs } : {}),
    });
    return createSuccessResponse(result);
  } catch (error) {
    return handleError(error);
  }
}

async function handleGetBalance(input: Record<string, unknown>, neoService: NeoService): Promise<unknown> {
  try {
    validateAddress(input.address as string);
    const balance = await neoService.getBalance(input.address as string); 
    return createSuccessResponse({ ...balance });
  } catch (error) {
    return handleError(error);
  }
}

function resolveContractReference(input: Record<string, unknown>): string {
  const reference = input?.contract ?? input?.contractReference ?? input?.contractName ?? input?.nameOrHash;
  if (typeof reference === 'string' && reference.trim()) {
    return reference.trim();
  }

  throw new ProtocolError(
    ProtocolErrorCode.InvalidParams,
    'Either scriptHash or a contract reference must be provided.'
  );
}

async function resolveInvocationScriptHash(input: Record<string, unknown>, contractService: ContractService): Promise<string> {
  if (typeof input?.scriptHash === 'string' && input.scriptHash.trim()) {
    return validateScriptHash(input.scriptHash);
  }

  return await contractService.resolveContractScriptHash(resolveContractReference(input));
}

async function handleInvokeReadContract(input: Record<string, unknown>, neoService: NeoService, contractService: ContractService): Promise<unknown> {
  try {
    const namedContractReference = !input?.scriptHash && (() => {
      try {
        return resolveContractReference(input);
      } catch {
        return undefined;
      }
    })();

    if (namedContractReference) {
      await contractService.assertContractDeployed(namedContractReference);
    }

    const result = namedContractReference
      ? await contractService.invokeReadContract(namedContractReference, input.operation as string, (input.args as unknown[]) || [])
      : await neoService.invokeReadContract(await resolveInvocationScriptHash(input, contractService), input.operation as string, (input.args as unknown[]) || []);

    return createSuccessResponse(result);
  } catch (error) {
    return handleError(error);
  }
}

async function handleGetWallet(input: Record<string, unknown>, walletService?: WalletService): Promise<unknown> {
  try {
    validateAddress(input.address as string);
    if (!walletService) {
      throw new ProtocolError(ProtocolErrorCode.InternalError, 'Wallet service is not available.');
    }
    const wallet = await walletService.getWallet(input.address as string);
    return createSuccessResponse(sanitizeWalletMetadata(wallet));
  } catch (error) {
    return handleError(error);
  }
}

async function handleEstimateTransferFees(input: Record<string, unknown>, neoService: NeoService): Promise<unknown> {
  try {
    validateAddress(input.fromAddress as string);
    validateAddress(input.toAddress as string);
    const amount = validateTokenAmount(input.amount);
    const fees = await neoService.calculateTransferFee(input.fromAddress as string, input.toAddress as string, input.asset as string, amount);
    return createSuccessResponse(fees);
  } catch (error) {
    return handleError(error);
  }
}

async function handleEstimateInvokeFees(input: Record<string, unknown>, neoService: NeoService, contractService: ContractService): Promise<unknown> {
  try {
    if (!input.signerAddress) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Signer address is required to estimate invocation fees.');
    }

    const namedContractReference = !input?.scriptHash && (() => {
      try {
        return resolveContractReference(input);
      } catch {
        return undefined;
      }
    })();

    if (namedContractReference) {
      await contractService.assertContractDeployed(namedContractReference);
    }

    const scriptHash = await resolveInvocationScriptHash(input, contractService);
    validateAddress(input.signerAddress as string);
    const fees = await neoService.calculateInvokeFee(input.signerAddress as string, scriptHash, input.operation as string, (input.args as unknown[]) || []);
    return createSuccessResponse(fees);
  } catch (error) {
    return handleError(error);
  }
}

async function handleListFamousContracts(input: Record<string, unknown>, contractService: ContractService): Promise<unknown> {
  try {
    const contracts = await contractService.listSupportedContracts();
    const availableContracts = contracts.filter(contract => contract.available);
    return {
      contracts: availableContracts,
      network: contractService.getNetwork()
    };
  } catch (error) {
    return handleError(error);
  }
}

async function handleGetContractInfo(input: Record<string, unknown>, contractService: ContractService): Promise<unknown> {
  try {
    const contractReference = resolveContractReference(input);
    return await contractService.getContractInfo(contractReference);
  } catch (error) {
    return handleError(error);
  }
}

async function handleGetContractStatus(input: Record<string, unknown>, contractService: ContractService): Promise<unknown> {
  try {
    const contractReference = resolveContractReference(input);
    return createSuccessResponse(await contractService.getContractStatus(contractReference));
  } catch (error) {
    return handleError(error);
  }
}

// --- Analytical indexer (n3index REST) read tools ---
//
// The DEPLOYED n3index indexer (api.n3index.dev) is a REST API returning { data, meta }
// envelopes at GET `${base}/${network}/<path>` — NOT the neo3fura JSON-RPC gateway (which is
// currently unreachable). These tools therefore mirror the working Neo X x_query layer:
// resolveIndexerNetwork (mainnet-default) -> assertAllowedN3Endpoint -> buildN3EndpointRequest
// -> fetchN3Index. The model supplies an endpoint KEY + typed params; a raw path is NEVER
// constructed, so the request is SSRF/traversal-proof by construction.

/** Resolve and validate the N3 network for an indexer read (defaults to mainnet). */
function resolveIndexerNetwork(input: Record<string, unknown>): NeoNetwork {
  if (typeof input.network === 'string' && input.network.trim().length > 0) {
    return validateNetwork(input.network);
  }
  return NeoNetwork.MAINNET;
}

/**
 * Shared REST dispatch for the N3 analytical tools. Resolves the (mainnet-default) network,
 * asserts `endpoint` is a vetted N3_REST_CATALOG key, rebuilds { path, params } field-by-field
 * from the descriptor (the caller-supplied typed segment is validated + substituted and unknown
 * keys are rejected — SSRF/traversal-proof), then GETs the live REST resource. This is the same
 * three-step shape as the Neo X x_query -> fetchBlockscout wiring. `fetchN3Index` returns the raw
 * { data, meta } envelope, or null on 404 (surfaced as an empty/not-found success result).
 */
async function dispatchN3RestEndpoint(
  input: Record<string, unknown>,
  endpoint: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  try {
    const network = resolveIndexerNetwork(input);
    const desc = assertAllowedN3Endpoint(endpoint);
    const { path, params: query } = buildN3EndpointRequest(desc, params);
    const result = await fetchN3Index(network, path, query);
    return createSuccessResponse(result);
  } catch (error) {
    return handleError(error);
  }
}

async function handleN3GetAddress(input: Record<string, unknown>): Promise<unknown> {
  return dispatchN3RestEndpoint(input, 'get_address_summary', { address: input.address });
}

async function handleN3ListTransactionsByAddress(input: Record<string, unknown>): Promise<unknown> {
  return dispatchN3RestEndpoint(input, 'list_address_transactions', {
    address: input.address,
    limit: input.limit,
    offset: input.skip,
  });
}

async function handleN3ListTransfersByAddress(input: Record<string, unknown>): Promise<unknown> {
  return dispatchN3RestEndpoint(input, 'list_address_transfers', {
    address: input.address,
    limit: input.limit,
    offset: input.skip,
  });
}

async function handleN3AssetHolders(input: Record<string, unknown>): Promise<unknown> {
  return dispatchN3RestEndpoint(input, 'list_token_holders', {
    hash: input.contractHash,
    limit: input.limit,
    offset: input.skip,
  });
}

async function handleN3AssetsHeldByAddress(input: Record<string, unknown>): Promise<unknown> {
  return dispatchN3RestEndpoint(input, 'list_address_balances', {
    address: input.address,
    limit: input.limit,
    offset: input.skip,
  });
}

async function handleN3ContractByName(input: Record<string, unknown>): Promise<unknown> {
  // n3index has no by-name contract search endpoint; the global `search` returns typed hits
  // (including contract matches), so this repoints to `search` (q = name). Live data; the
  // tool name/schema are unchanged (its limit/skip do not apply to search and are ignored).
  return dispatchN3RestEndpoint(input, 'search', { q: input.name });
}

// --- Generic catalog-driven indexer query (Phase 1: no client-authored Mongo) ---

/**
 * Generic vetted-endpoint indexer query over the live n3index REST API. `input.method` MUST be
 * a member of the immutable N3_REST_CATALOG (assertAllowedN3Endpoint) — it is now a REST
 * endpoint KEY (e.g. "get_address_summary"), NOT a JSON-RPC method — and the concrete request
 * path + query params are rebuilt field-by-field from the descriptor by buildN3EndpointRequest,
 * so no caller string is ever spread into the path and no unknown query key is forwarded —
 * SSRF/path-traversal-proof by construction (fetchN3Index also blocks redirects and caps the
 * body at 4 MiB).
 *
 * The tool input interface stays { method, params } so the frontend/query-builder contract is
 * unchanged.
 *
 * Network is supplied and pinned by the public tool registry. Internal callers
 * that omit it retain mainnet as the default.
 */
async function handleQueryIndexer(input: Record<string, unknown>): Promise<unknown> {
  try {
    const network = resolveIndexerNetwork(input);
    const desc = assertAllowedN3Endpoint(typeof input.method === 'string' ? input.method : '');
    // Prefer an explicit `params` object; otherwise fall back to the flat input MINUS the
    // `method` discriminator. The N3 REST guard tolerates network/endpoint/params but not
    // `method`, so it must be stripped before the strict per-endpoint whitelist runs.
    const { method: _method, ...flat } = input;
    const source = (input.params && typeof input.params === 'object' && !Array.isArray(input.params))
      ? (input.params as Record<string, unknown>)
      : flat;
    const { path, params } = buildN3EndpointRequest(desc, source);
    const result = await fetchN3Index(network, path, params);
    return createSuccessResponse(result);
  } catch (error) {
    return handleError(error);
  }
}

// --- Generic constrained-filter indexer query (Phase 2, GATED OFF by default) ---

/**
 * Constrained arbitrary-filter indexer query. Unlike `handleQueryIndexer` (fixed method +
 * typed scalar params), this lets a caller author a SMALL Mongo-shaped filter over an
 * allowlisted collection. It is GATED: execution only happens when config.n3index.findEnabled
 * is true (env N3INDEX_FIND_ENABLED); otherwise it refuses with a clear message BEFORE any
 * network call. When enabled, validateFind (indexer-find-guard) rebuilds the entire
 * { Filter, Sort, Limit, Skip } request field-by-field from the collection's indexed-field
 * allowlist — no caller object is spread, unknown fields/operators ($where/$or/…) are rejected,
 * and limit/skip are clamped — so the path is injection/DoS-proof by construction.
 *
 * MAINNET ONLY: the tool schema exposes no network field, so resolveIndexerNetwork -> mainnet.
 */
async function handleQueryIndexerFind(input: Record<string, unknown>): Promise<unknown> {
  try {
    if (!config.n3index.findEnabled) {
      return handleError(
        new ValidationError('query_indexer_find is disabled; enable N3INDEX_FIND_ENABLED'),
      );
    }
    const network = resolveIndexerNetwork(input);
    const collection = typeof input.collection === 'string' ? input.collection : '';
    const desc = assertAllowedCollection(collection);
    const sanitized = validateFind(collection, input.filter, input.sort, input.limit, input.skip);
    const result = await callIndexerRpc(
      network,
      desc.rpcMethod,
      sanitized as unknown as Record<string, unknown>,
    );
    return createSuccessResponse(result);
  } catch (error) {
    return handleError(error);
  }
}

// --- Curated thin wrappers (ergonomic NL over the generic REST catalog path) ---
// Each forwards a fixed REST catalog endpoint via dispatchN3RestEndpoint, inheriting the exact
// same allowlist / param-whitelist / mainnet guarantees. The tool `skip` param maps to the REST
// `offset` query key.

async function handleN3ListBlocks(input: Record<string, unknown>): Promise<unknown> {
  return dispatchN3RestEndpoint(input, 'list_blocks', { limit: input.limit, offset: input.skip });
}

async function handleN3ListTransactions(input: Record<string, unknown>): Promise<unknown> {
  return dispatchN3RestEndpoint(input, 'list_transactions', { limit: input.limit, offset: input.skip });
}

async function handleN3GetTransactionIndexer(input: Record<string, unknown>): Promise<unknown> {
  return dispatchN3RestEndpoint(input, 'get_transaction', {
    txid: input.transactionHash ?? input.txid ?? input.hash,
  });
}

async function handleN3GetBlockIndexer(input: Record<string, unknown>): Promise<unknown> {
  // The REST get_block endpoint accepts either a height (integer) or a 0x block hash in the one
  // {blockRef} segment (validateN3BlockRef in the guard resolves both), so no branch is needed.
  return dispatchN3RestEndpoint(input, 'get_block', {
    blockRef: input.block ?? input.blockHash ?? input.blockHeight ?? input.hashOrHeight,
  });
}

async function handleN3ListNep17TransfersByContract(input: Record<string, unknown>): Promise<unknown> {
  // n3index has NO transfers-by-token-contract endpoint; repointed to the token's holders
  // (list_token_holders), the closest live per-contract resource. Tool name/schema unchanged.
  return dispatchN3RestEndpoint(input, 'list_token_holders', {
    hash: input.contractHash,
    limit: input.limit,
    offset: input.skip,
  });
}

async function handleN3ListAssets(input: Record<string, unknown>): Promise<unknown> {
  // REST list_tokens has no `standard` filter; the schema still accepts `standard` (contract
  // unchanged) but it is not forwarded. Pagination is honoured.
  return dispatchN3RestEndpoint(input, 'list_tokens', { limit: input.limit, offset: input.skip });
}

// --- Neo X (Blockscout v2) read tools ---

function resolveNeoxNetworkParam(input: Record<string, unknown>): NeoxNetwork {
  const raw = typeof input.network === 'string' && input.network.trim().length > 0
    ? input.network
    : 'neox-mainnet';
  return resolveNeoxNetwork(raw);
}

async function handleXSearch(input: Record<string, unknown>): Promise<unknown> {
  try {
    const network = resolveNeoxNetworkParam(input);
    const query = typeof input.q === 'string' ? sanitizeString(input.q) : '';
    if (!query) {
      throw new ValidationError('Search query "q" must be a non-empty string');
    }
    const result = await fetchBlockscout(network, 'search', { q: query });
    return createSuccessResponse(result);
  } catch (error) {
    return handleError(error);
  }
}

async function handleXGetAddress(input: Record<string, unknown>): Promise<unknown> {
  try {
    const network = resolveNeoxNetworkParam(input);
    const address = validateEvmAddress(input.address as string);
    const result = await fetchBlockscout(network, `addresses/${address}`);
    return createSuccessResponse(result);
  } catch (error) {
    return handleError(error);
  }
}

async function handleXListTransactionsByAddress(input: Record<string, unknown>): Promise<unknown> {
  try {
    const network = resolveNeoxNetworkParam(input);
    const address = validateEvmAddress(input.address as string);
    const result = await fetchBlockscout(network, `addresses/${address}/transactions`);
    return createSuccessResponse(result);
  } catch (error) {
    return handleError(error);
  }
}

async function handleXListTokenTransfers(input: Record<string, unknown>): Promise<unknown> {
  try {
    const network = resolveNeoxNetworkParam(input);
    const address = validateEvmAddress(input.address as string);
    const result = await fetchBlockscout(network, `addresses/${address}/token-transfers`);
    return createSuccessResponse(result);
  } catch (error) {
    return handleError(error);
  }
}

async function handleXTokenInfo(input: Record<string, unknown>): Promise<unknown> {
  try {
    const network = resolveNeoxNetworkParam(input);
    const token = validateEvmAddress(input.address as string);
    const result = await fetchBlockscout(network, `tokens/${token}`);
    return createSuccessResponse(result);
  } catch (error) {
    return handleError(error);
  }
}

async function handleXTokenHolders(input: Record<string, unknown>): Promise<unknown> {
  try {
    const network = resolveNeoxNetworkParam(input);
    const token = validateEvmAddress(input.address as string);
    const result = await fetchBlockscout(network, `tokens/${token}/holders`);
    return createSuccessResponse(result);
  } catch (error) {
    return handleError(error);
  }
}

async function handleXBlock(input: Record<string, unknown>): Promise<unknown> {
  try {
    const network = resolveNeoxNetworkParam(input);
    const blockRef = validateEvmBlockRef(input.blockNumberOrHash as string | number);
    const result = await fetchBlockscout(network, `blocks/${blockRef}`);
    return createSuccessResponse(result);
  } catch (error) {
    return handleError(error);
  }
}

async function handleXTransaction(input: Record<string, unknown>): Promise<unknown> {
  try {
    const network = resolveNeoxNetworkParam(input);
    const hash = validateEvmHash(input.hash as string);
    const result = await fetchBlockscout(network, `transactions/${hash}`);
    return createSuccessResponse(result);
  } catch (error) {
    return handleError(error);
  }
}

// --- Generic catalog-driven Neo X query (Blockscout v2, mainnet-only) ---

/**
 * Generic vetted-endpoint Neo X query. `input.endpoint` MUST be a member of the
 * immutable X_ENDPOINT_CATALOG (assertAllowedEndpoint); the concrete request path and
 * query params are rebuilt field-by-field from the endpoint descriptor by
 * buildEndpointRequest, so no caller string is ever spread into the path and no unknown
 * query key is forwarded — SSRF/path-traversal-proof by construction (fetchBlockscout
 * also blocks redirects and caps the body at 4 MiB).
 *
 * MAINNET ONLY: the tool schema exposes no network field, so resolveNeoxNetworkParam
 * resolves to neox-mainnet.
 */
async function handleXQuery(input: Record<string, unknown>): Promise<unknown> {
  try {
    const network = resolveNeoxNetworkParam(input);
    const desc = assertAllowedEndpoint(typeof input.endpoint === 'string' ? input.endpoint : '');
    // Prefer an explicit `params` object; fall back to the flat input (the guard rejects
    // any key outside the endpoint's allowlist, and tolerates endpoint/params/network).
    const source = (input.params && typeof input.params === 'object' && !Array.isArray(input.params))
      ? (input.params as Record<string, unknown>)
      : input;
    const { path, params } = buildEndpointRequest(desc, source);
    const result = await fetchBlockscout(network, path, params);
    return createSuccessResponse(result);
  } catch (error) {
    return handleError(error);
  }
}

// --- Generic Neo X GraphQL query (Blockscout, Phase 2, GATED OFF by default) ---

/**
 * Arbitrary GraphQL query against the Neo X Blockscout GraphQL endpoint. This is the
 * truly-arbitrary Neo X layer (unlike x_query, whose every request is assembled from the
 * vetted endpoint catalog). It is GATED: execution only happens when config.neox.graphqlEnabled
 * is true (env NEOX_GRAPHQL_ENABLED); otherwise it refuses with a clear message BEFORE any
 * network call. When enabled, validateGraphqlQuery (blockscout-graphql-guard) enforces a
 * read-only envelope — no mutation/subscription, no introspection, no directives, bounded
 * depth/complexity/length, and JSON-only bounded variables — and only the vetted { query,
 * variables } is posted (the client is transport-only). SSRF is impossible: the URL is a
 * fixed constant, the caller never supplies a path.
 *
 * MAINNET ONLY: the tool schema exposes no network field, so resolveNeoxNetworkParam ->
 * neox-mainnet.
 */
async function handleXGraphql(input: Record<string, unknown>): Promise<unknown> {
  try {
    if (!config.neox.graphqlEnabled) {
      return handleError(
        new ValidationError('x_graphql is disabled; enable NEOX_GRAPHQL_ENABLED'),
      );
    }
    const network = resolveNeoxNetworkParam(input);
    const { query, variables } = validateGraphqlQuery(
      input.query as string,
      input.variables as object | undefined,
    );
    const result = await postBlockscoutGraphql(network, query, variables);
    return createSuccessResponse(result);
  } catch (error) {
    return handleError(error);
  }
}

const N3_INDEXER_TOOLS = new Set([
  'n3_get_address',
  'n3_list_transactions_by_address',
  'n3_list_transfers_by_address',
  'n3_asset_holders',
  'n3_assets_held_by_address',
  // n3_application_log has NO n3index REST endpoint; it is registered in index.ts as a thin
  // alias to the working NeoService-backed get_application_log tool, so it never reaches here.
  'n3_contract_by_name',
  // Generic catalog-driven query + curated wrappers (task #39, mainnet-only).
  'query_indexer',
  'n3_list_blocks',
  'n3_list_transactions',
  'n3_get_transaction',
  'n3_get_block',
  'n3_list_nep17_transfers_by_contract',
  'n3_list_assets',
  // Phase 2 constrained-filter query (gated behind N3INDEX_FIND_ENABLED, mainnet-only).
  'query_indexer_find',
]);

const NEOX_TOOLS = new Set([
  'x_search',
  'x_get_address',
  'x_list_transactions_by_address',
  'x_list_token_transfers',
  'x_token_info',
  'x_token_holders',
  'x_block',
  'x_transaction',
  // Generic catalog-driven Blockscout query (mainnet-only).
  'x_query',
  // Phase 2 arbitrary GraphQL query (gated behind NEOX_GRAPHQL_ENABLED, mainnet-only).
  'x_graphql',
]);

async function dispatchAnalyticalTool(name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  switch (name) {
    case 'n3_get_address':
      return await handleN3GetAddress(input) as Record<string, unknown>;
    case 'n3_list_transactions_by_address':
      return await handleN3ListTransactionsByAddress(input) as Record<string, unknown>;
    case 'n3_list_transfers_by_address':
      return await handleN3ListTransfersByAddress(input) as Record<string, unknown>;
    case 'n3_asset_holders':
      return await handleN3AssetHolders(input) as Record<string, unknown>;
    case 'n3_assets_held_by_address':
      return await handleN3AssetsHeldByAddress(input) as Record<string, unknown>;
    case 'n3_contract_by_name':
      return await handleN3ContractByName(input) as Record<string, unknown>;
    case 'query_indexer':
      return await handleQueryIndexer(input) as Record<string, unknown>;
    case 'n3_list_blocks':
      return await handleN3ListBlocks(input) as Record<string, unknown>;
    case 'n3_list_transactions':
      return await handleN3ListTransactions(input) as Record<string, unknown>;
    case 'n3_get_transaction':
      return await handleN3GetTransactionIndexer(input) as Record<string, unknown>;
    case 'n3_get_block':
      return await handleN3GetBlockIndexer(input) as Record<string, unknown>;
    case 'n3_list_nep17_transfers_by_contract':
      return await handleN3ListNep17TransfersByContract(input) as Record<string, unknown>;
    case 'n3_list_assets':
      return await handleN3ListAssets(input) as Record<string, unknown>;
    case 'query_indexer_find':
      return await handleQueryIndexerFind(input) as Record<string, unknown>;
    case 'x_search':
      return await handleXSearch(input) as Record<string, unknown>;
    case 'x_get_address':
      return await handleXGetAddress(input) as Record<string, unknown>;
    case 'x_list_transactions_by_address':
      return await handleXListTransactionsByAddress(input) as Record<string, unknown>;
    case 'x_list_token_transfers':
      return await handleXListTokenTransfers(input) as Record<string, unknown>;
    case 'x_token_info':
      return await handleXTokenInfo(input) as Record<string, unknown>;
    case 'x_token_holders':
      return await handleXTokenHolders(input) as Record<string, unknown>;
    case 'x_block':
      return await handleXBlock(input) as Record<string, unknown>;
    case 'x_transaction':
      return await handleXTransaction(input) as Record<string, unknown>;
    case 'x_query':
      return await handleXQuery(input) as Record<string, unknown>;
    case 'x_graphql':
      return await handleXGraphql(input) as Record<string, unknown>;
    default:
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${name} not found.`);
  }
}

export async function callTool(name: string, input: Record<string, unknown>, neoServices: Map<NeoNetwork, NeoService>, contractServices: Map<NeoNetwork, ContractService>, walletService?: WalletService): Promise<Record<string, unknown>> {
  chargeClientRateLimit(neoServices);
  if (name === 'create_wallet' || name === 'import_wallet') {
    return handleError(new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `${name} is not available through MCP. Provision signing wallets outside the model-facing channel.`
    ));
  }

  const legacyWriteRequested = name === 'transfer_assets'
    || name === 'invoke_contract_write'
    || name === 'claim_gas'
    || name === 'deploy_contract';
  const secretBearingInvocation = name === 'invoke_contract' && [
    'fromWIF',
    'wif',
    'privateKey',
    'password',
    'confirm',
  ].some((field) => Object.prototype.hasOwnProperty.call(input, field));
  if (legacyWriteRequested || secretBearingInvocation) {
    return handleError(new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      'State-changing calls must use the registered idempotent write tools with a server-held signer and elicited approval.'
    ));
  }

  switch (name) {
    case 'get_network_mode':
      return await handleGetNetworkMode();
    case 'get_wallet':
      return await handleGetWallet(input, walletService) as Record<string, unknown>;
  }

  if (!input || typeof input !== 'object') {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid input parameters. Expected an object.');
  }

  if (NEO_DATA_TOOLS.has(name)) {
    try {
      return await dispatchNeoDataTool(name, input);
    } catch (error) {
      return handleError(error);
    }
  }

  if (ECOSYSTEM_META_TOOLS.has(name)) {
    try {
      return await dispatchEcosystemMetaTool(name, input);
    } catch (error) {
      return handleError(error);
    }
  }

  if (NEOX_ANALYSIS_TOOLS.has(name)) {
    try {
      return createSuccessResponse(await dispatchNeoxAnalysisTool(name, input));
    } catch (error) {
      return handleError(error);
    }
  }

  // Analytical indexer (neo3fura) and Neo X (Blockscout) reads go straight to
  // their HTTP clients and never touch the NeoService/ContractService RPC layer.
  if (N3_INDEXER_TOOLS.has(name) || NEOX_TOOLS.has(name)) {
    return await dispatchAnalyticalTool(name, input);
  }

  // Neo X (EVM) simulate/construct tools use the read-only, allowlisted EVM RPC
  // client and never touch the N3 RPC layer. They return UNSIGNED proposals and
  // never sign or broadcast.
  if (NEOX_PROPOSAL_TOOLS.has(name)) {
    try {
      return await dispatchNeoxProposalTool(name, input);
    } catch (error) {
      return handleError(error);
    }
  }

  // Neo X node reads go to the allowlisted EVM JSON-RPC client. They must be
  // dispatched before the N3 network resolution below, which would otherwise
  // reject them for asking after a Neo N3 service they never use.
  if (NEOX_NODE_TOOLS.has(name)) {
    try {
      return await dispatchNeoxNodeTool(name, input) as Record<string, unknown>;
    } catch (error) {
      return handleError(error);
    }
  }

  let neoService: NeoService | undefined;
  let contractService: ContractService | undefined;
  try {
    const requestedNetwork = typeof input.network === 'string' && input.network.trim().length > 0
      ? validateNetwork(input.network as string)
      : undefined;

    if (requestedNetwork) {
      neoService = neoServices.get(requestedNetwork);
      contractService = contractServices.get(requestedNetwork);
    } else if (neoServices.size === 1 && contractServices.size === 1) {
      neoService = neoServices.values().next().value;
      contractService = contractServices.values().next().value;
    } else {
      neoService = neoServices.get(NeoNetwork.MAINNET) || neoServices.get(NeoNetwork.TESTNET);
      contractService = contractServices.get(NeoNetwork.MAINNET) || contractServices.get(NeoNetwork.TESTNET);
    }

    if (!neoService || !contractService) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Requested network is not enabled or service unavailable.');
    }
  } catch (error) {
    return handleError(error);
  }

  // Neo N3 simulate/construct tools reuse the read-only NeoService RPC path
  // (invokefunction test mode) and return UNSIGNED proposals — no signing, no
  // sendrawtransaction.
  if (N3_PROPOSAL_TOOLS.has(name)) {
    try {
      return await dispatchN3ProposalTool(name, input, neoService);
    } catch (error) {
      return handleError(error);
    }
  }

  if (ECOSYSTEM_N3_TOOLS.has(name)) {
    try {
      return await dispatchEcosystemN3Tool(name, input, neoService);
    } catch (error) {
      return handleError(error);
    }
  }

  try {
    switch (name) {
      case 'get_blockchain_info':
        return await handleGetBlockchainInfo(input, neoService) as Record<string, unknown>;
      case 'get_block_count':
        return await handleGetBlockCount(input, neoService) as Record<string, unknown>;
      case 'get_block':
        return await handleGetBlock(input, neoService) as Record<string, unknown>;
      case 'get_transaction':
        return await handleGetTransaction(input, neoService) as Record<string, unknown>;
      case 'get_application_log':
        return await handleGetApplicationLog(input, neoService) as Record<string, unknown>;
      case 'n3_node_get_transaction_status':
        return await handleN3TransactionStatus(input, neoService) as Record<string, unknown>;
      case 'wait_for_transaction':
        return await handleWaitForTransaction(input, neoService) as Record<string, unknown>;
      case 'get_balance':
        return await handleGetBalance(input, neoService) as Record<string, unknown>;
      case 'get_unclaimed_gas':
        return await handleGetUnclaimedGas(input, neoService) as Record<string, unknown>;
      case 'get_nep17_transfers':
        return await handleGetNep17Transfers(input, neoService) as Record<string, unknown>;
      case 'get_nep11_balances':
        return await handleGetNep11Balances(input, neoService) as Record<string, unknown>;
      case 'get_nep11_transfers':
        return await handleGetNep11Transfers(input, neoService) as Record<string, unknown>;
      case 'invoke_contract':
        return await handleInvokeReadContract(input, neoService, contractService) as Record<string, unknown>;
      case 'estimate_transfer_fees':
        return await handleEstimateTransferFees(input, neoService) as Record<string, unknown>;
      case 'estimate_invoke_fees':
        return await handleEstimateInvokeFees(input, neoService, contractService) as Record<string, unknown>;
      case 'list_famous_contracts':
        return await handleListFamousContracts(input, contractService) as Record<string, unknown>;
      case 'get_contract_info':
        return await handleGetContractInfo(input, contractService) as Record<string, unknown>;
      case 'get_contract_status':
        return await handleGetContractStatus(input, contractService) as Record<string, unknown>;
      default:
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${name} not found or requires network parameter.`);
    }
  } catch (error) {
    return handleError(error);
  }
}
