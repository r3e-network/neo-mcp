/**
 * Unified tool registry.
 *
 * The public MCP surface is chain-parameterized: one tool per capability, with a
 * required `chain: 'n3' | 'neox'` discriminator on every capability both chains
 * support. The registry maps a (public tool, chain) pair onto the internal
 * handler name that `callTool` already dispatches, rewriting arguments where the
 * two backends disagree on shape.
 *
 * These tests pin:
 *   - the exact public tool name list (no wallet-creation tools, ever),
 *   - which tools take `chain` and which are single-chain,
 *   - public -> internal routing for both chains,
 *   - argument rewrites (Neo X explorer network ids, cursor-paginated routes
 *     that must not receive limit/skip, catalog query parameter names),
 *   - the service/wallet requirements each route carries.
 */

import {
  PUBLIC_TOOLS,
  ToolRoute,
  isPublicTool,
  listPublicTools,
  publicToolNames,
  resolveRoute,
  supportedChains,
} from '../src/registry/tool-registry';
import { ValidationError } from '../src/utils/errors';

const EXPECTED_PUBLIC_TOOLS = [
  // meta
  'get_network_mode',
  'get_wallet',
  'inspect_neo_value',
  'convert_neo_data',
  'get_neo_service_info',
  // node reads (multi-chain)
  'get_chain_info',
  'get_block_height',
  'get_block',
  'get_transaction',
  'get_transaction_status',
  'get_balance',
  'call_contract',
  'get_contract_info',
  // node reads (Neo N3 only)
  'get_application_log',
  'wait_for_transaction',
  'get_unclaimed_gas',
  'decode_neo_script',
  'query_nns',
  'query_neofs',
  'get_oracle_info',
  'get_nep17_transfers',
  'get_nep11_balances',
  'get_nep11_transfers',
  'get_contract_status',
  'list_famous_contracts',
  'estimate_transfer_fees',
  'estimate_invoke_fees',
  // construct / simulate (multi-chain, unsigned proposals only)
  'simulate_call',
  'build_transfer',
  'build_contract_call',
  'build_vote',
  'build_nns_operation',
  // explorer / indexer reads
  'explorer_get_address',
  'analyze_neox_transaction',
  'analyze_neox_block',
  'analyze_neox_address',
  'analyze_neox_contract',
  'analyze_neox_token',
  'analyze_address',
  'analyze_address_connection',
  'analyze_account_graph',
  'analyze_consensus_health',
  'analyze_transaction',
  'investigate_transactions',
  'analyze_contract',
  'inspect_contract_code',
  'analyze_contract_upgrades',
  'get_contract_source_verification',
  'explorer_list_address_transactions',
  'explorer_list_address_transfers',
  'explorer_list_address_assets',
  'explorer_list_token_holders',
  'explorer_search',
  'query_explorer',
  'query_explorer_find',
  'query_explorer_graphql',
];

describe('public tool surface', () => {
  it('exposes exactly the unified tool list', () => {
    expect(publicToolNames()).toEqual(EXPECTED_PUBLIC_TOOLS);
  });

  it('keeps the expanded high-level surface bounded', () => {
    expect(publicToolNames().length).toBeLessThanOrEqual(56);
  });

  it('never exposes key-custody tools', () => {
    const names = publicToolNames();
    expect(names).not.toContain('create_wallet');
    expect(names).not.toContain('import_wallet');
    expect(names.some((name) => /wif|private_key|mnemonic|sign/i.test(name))).toBe(false);
  });

  it('never exposes chain-prefixed legacy names', () => {
    for (const name of publicToolNames()) {
      expect(name.startsWith('n3_')).toBe(false);
      expect(name.startsWith('x_')).toBe(false);
    }
  });

  it('recognizes public tools and rejects unknown or internal names', () => {
    expect(isPublicTool('get_block')).toBe(true);
    expect(isPublicTool('x_node_get_block')).toBe(false);
    expect(isPublicTool('n3_build_transfer')).toBe(false);
    expect(isPublicTool('nope')).toBe(false);
  });

  it('gives every tool a non-empty description and a zod input schema', () => {
    for (const spec of listPublicTools()) {
      expect(spec.name).toBeTruthy();
      expect(typeof spec.description).toBe('string');
      expect(spec.description.length).toBeGreaterThan(20);
      expect(spec.inputSchema).toBeTruthy();
      expect(typeof spec.inputSchema).toBe('object');
    }
  });

  it('exports PUBLIC_TOOLS keyed by public tool name', () => {
    for (const name of publicToolNames()) {
      expect(PUBLIC_TOOLS[name]).toBeDefined();
      expect(PUBLIC_TOOLS[name].name).toBe(name);
    }
  });
});

describe('chain discriminator', () => {
  it('declares a chain field on every multi-chain tool', () => {
    const multiChain = [
      'get_chain_info',
      'get_block_height',
      'get_block',
      'get_transaction',
      'get_transaction_status',
      'get_balance',
      'call_contract',
      'get_contract_info',
      'simulate_call',
      'build_transfer',
      'build_contract_call',
      'explorer_get_address',
      'explorer_list_address_transactions',
      'explorer_list_address_transfers',
      'explorer_list_token_holders',
      'explorer_search',
      'query_explorer',
    ];
    for (const name of multiChain) {
      expect(supportedChains(name)).toEqual(['n3', 'neox']);
      expect(Object.keys(PUBLIC_TOOLS[name].inputSchema)).toContain('chain');
    }
  });

  it('omits the chain field from single-chain tools', () => {
    const n3Only = [
      'get_application_log',
      'wait_for_transaction',
      'get_unclaimed_gas',
      'decode_neo_script',
      'query_nns',
      'query_neofs',
      'get_oracle_info',
      'get_nep17_transfers',
      'get_nep11_balances',
      'get_nep11_transfers',
      'get_contract_status',
      'list_famous_contracts',
      'estimate_transfer_fees',
      'estimate_invoke_fees',
      'build_vote',
      'build_nns_operation',
      'explorer_list_address_assets',
      'analyze_address',
      'analyze_contract',
      'inspect_contract_code',
      'analyze_transaction',
      'query_explorer_find',
    ];
    for (const name of n3Only) {
      expect(supportedChains(name)).toEqual(['n3']);
      expect(Object.keys(PUBLIC_TOOLS[name].inputSchema)).not.toContain('chain');
    }
    const neoxOnly = [
      'analyze_neox_transaction',
      'analyze_neox_block',
      'analyze_neox_address',
      'analyze_neox_contract',
      'analyze_neox_token',
      'query_explorer_graphql',
    ];
    for (const name of neoxOnly) {
      expect(supportedChains(name)).toEqual(['neox']);
      expect(Object.keys(PUBLIC_TOOLS[name].inputSchema)).not.toContain('chain');
    }
    for (const name of [
      'get_network_mode',
      'get_wallet',
      'inspect_neo_value',
      'convert_neo_data',
      'get_neo_service_info',
    ]) {
      expect(supportedChains(name)).toEqual([]);
    }
  });

  it('requires an explicit N3 network context for NeoFS reads', () => {
    expect(Object.keys(PUBLIC_TOOLS.query_neofs.inputSchema)).toContain('network');
    expect(PUBLIC_TOOLS.query_neofs.inputSchema.network).toBeDefined();
    expect(() => resolveRoute('query_neofs', {
      network: 'testnet',
      operation: 'object_link',
      containerId: '3'.repeat(44),
      objectId: '4'.repeat(44),
    })).not.toThrow();
  });

  it('requires chain (no silent default) on multi-chain tools', () => {
    expect(() => resolveRoute('get_block', {})).toThrow(ValidationError);
    expect(() => resolveRoute('get_block', { chain: '' })).toThrow(ValidationError);
    expect(() => resolveRoute('get_block', { chain: 'ethereum' })).toThrow(ValidationError);
    expect(() => resolveRoute('get_block', { chain: 'N3' })).toThrow(ValidationError);
  });

  it('rejects an unsupported chain on a single-chain tool with a clear message', () => {
    expect(() => resolveRoute('get_unclaimed_gas', { chain: 'neox', address: '0x1' }))
      .toThrow(/does not support/i);
    expect(() => resolveRoute('query_explorer_graphql', { chain: 'n3', query: '{}' }))
      .toThrow(/does not support/i);
  });

  it('rejects unknown public tool names', () => {
    expect(() => resolveRoute('x_node_get_block', { chain: 'neox' })).toThrow(ValidationError);
  });

  it('strips the chain discriminator from the arguments handed to callTool', () => {
    const route = resolveRoute('get_block', { chain: 'n3', hashOrHeight: 100 });
    expect(route.args.chain).toBeUndefined();
  });
});

describe('node read routing', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['get_chain_info', { chain: 'n3' }, 'get_blockchain_info'],
    ['get_chain_info', { chain: 'neox' }, 'x_node_get_chain_info'],
    ['get_block_height', { chain: 'n3' }, 'get_block_count'],
    ['get_block_height', { chain: 'neox' }, 'x_node_get_block_height'],
    ['get_block', { chain: 'n3', hashOrHeight: 1 }, 'get_block'],
    ['get_block', { chain: 'neox', hashOrHeight: 1 }, 'x_node_get_block'],
    ['get_transaction', { chain: 'n3', hash: '0xabc' }, 'get_transaction'],
    ['get_transaction', { chain: 'neox', hash: '0xabc' }, 'x_node_get_transaction'],
    ['get_transaction_status', { chain: 'n3', hash: '0xabc' }, 'n3_node_get_transaction_status'],
    ['get_transaction_status', { chain: 'neox', hash: '0xabc' }, 'x_node_get_transaction_status'],
    ['get_balance', { chain: 'n3', address: 'N1' }, 'get_balance'],
    ['get_balance', { chain: 'neox', address: '0x1' }, 'x_node_get_balance'],
    ['call_contract', { chain: 'n3', contract: '0x1', operation: 'x' }, 'invoke_contract'],
    ['call_contract', { chain: 'neox', contract: '0x1', data: '0x' }, 'x_node_call_contract'],
    ['get_contract_info', { chain: 'n3', contract: 'neo' }, 'get_contract_info'],
    ['get_application_log', { hash: '0xabc' }, 'get_application_log'],
    ['wait_for_transaction', { hash: '0xabc' }, 'wait_for_transaction'],
    ['get_unclaimed_gas', { address: 'N1' }, 'get_unclaimed_gas'],
    ['get_nep17_transfers', { address: 'N1' }, 'get_nep17_transfers'],
    ['get_nep11_balances', { address: 'N1' }, 'get_nep11_balances'],
    ['get_nep11_transfers', { address: 'N1' }, 'get_nep11_transfers'],
    ['get_contract_status', { contractName: 'neo' }, 'get_contract_status'],
    ['list_famous_contracts', {}, 'list_famous_contracts'],
    ['estimate_transfer_fees', { from: 'N1', to: 'N2', asset: 'NEO', amount: '1' }, 'estimate_transfer_fees'],
    ['estimate_invoke_fees', { scriptHash: '0x1', operation: 'x' }, 'estimate_invoke_fees'],
    ['get_network_mode', {}, 'get_network_mode'],
    ['get_wallet', {}, 'get_wallet'],
  ];

  it.each(cases)('routes %s (%j) to the internal handler %s', (tool, args, internal) => {
    expect(resolveRoute(tool, args).internalName).toBe(internal);
  });

  it('routes Neo X contract info to the Blockscout smart-contract endpoint', () => {
    const route = resolveRoute('get_contract_info', { chain: 'neox', address: '0xdead' });
    expect(route.internalName).toBe('x_query');
    expect(route.args.endpoint).toBe('get_smart_contract');
    expect(route.args.params).toEqual({ address: '0xdead' });
  });

  it('passes optional state-root evidence through only on Neo N3', () => {
    const route = resolveRoute('get_block', {
      chain: 'n3',
      hashOrHeight: 42,
      includeStateRoot: true,
      network: 'testnet',
    });
    expect(route.args).toEqual({
      hashOrHeight: 42,
      includeStateRoot: true,
      network: 'testnet',
    });
    expect(() => resolveRoute('get_block', {
      chain: 'neox',
      hashOrHeight: 42,
      includeStateRoot: true,
    })).toThrow(/Neo N3/i);
  });

  it('feeds the Neo X node block handler the alias it reads', () => {
    const route = resolveRoute('get_block', {
      chain: 'neox',
      hashOrHeight: '0xfeed',
      includeTransactions: true,
      network: 'testnet',
    });
    expect(route.internalName).toBe('x_node_get_block');
    expect(route.args.blockHashOrHeight).toBe('0xfeed');
    expect(route.args.includeTransactions).toBe(true);
    expect(route.args.network).toBe('testnet');
  });

  it('keeps the public mainnet/testnet form on Neo X node routes', () => {
    for (const tool of ['get_chain_info', 'get_block_height', 'get_balance', 'get_transaction']) {
      const route = resolveRoute(tool, { chain: 'neox', network: 'testnet', address: '0x1', hash: '0x2' });
      expect(route.args.network).toBe('testnet');
    }
  });

  it('maps the unified contract argument onto the Neo X call target', () => {
    const route = resolveRoute('call_contract', {
      chain: 'neox',
      contract: '0xdead',
      functionSignature: 'balanceOf(address)',
      args: ['0xbeef'],
      network: 'mainnet',
    });
    expect(route.internalName).toBe('x_node_call_contract');
    expect(route.args.contract).toBe('0xdead');
    expect(route.args.functionSignature).toBe('balanceOf(address)');
    expect(route.args.args).toEqual(['0xbeef']);
  });
});

describe('construct and simulate routing', () => {
  it('routes simulate_call per chain', () => {
    expect(resolveRoute('simulate_call', { chain: 'n3', scriptHash: '0x1', operation: 'x' }).internalName)
      .toBe('n3_test_invoke');
    expect(resolveRoute('simulate_call', { chain: 'neox', to: '0x1', data: '0x' }).internalName)
      .toBe('x_simulate_call');
  });

  it('routes build_transfer per chain', () => {
    expect(resolveRoute('build_transfer', {
      chain: 'n3', from: 'N1', to: 'N2', asset: 'NEO', amount: '1',
    }).internalName).toBe('n3_build_transfer');
    expect(resolveRoute('build_transfer', {
      chain: 'neox', from: '0x1', to: '0x2', amountWei: '1',
    }).internalName).toBe('x_build_transfer');
  });

  it('routes build_contract_call per chain', () => {
    expect(resolveRoute('build_contract_call', {
      chain: 'n3', scriptHash: '0x1', operation: 'x', from: 'N1',
    }).internalName).toBe('n3_build_invoke');
    expect(resolveRoute('build_contract_call', {
      chain: 'neox', from: '0x1', to: '0x2', data: '0x',
    }).internalName).toBe('x_build_contract_call');
  });

  it('rewrites the network for Neo X construct routes', () => {
    for (const tool of ['simulate_call', 'build_transfer', 'build_contract_call']) {
      const mainnet = resolveRoute(tool, { chain: 'neox', network: 'mainnet', from: '0x1', to: '0x2', amountWei: '1' });
      expect(mainnet.args.network).toBe('neox-mainnet');
      const testnet = resolveRoute(tool, { chain: 'neox', network: 'testnet', from: '0x1', to: '0x2', amountWei: '1' });
      expect(testnet.args.network).toBe('neox-testnet');
    }
  });

  it('leaves the network absent when the caller omits it', () => {
    const route = resolveRoute('build_transfer', { chain: 'neox', from: '0x1', to: '0x2', amountWei: '1' });
    expect('network' in route.args).toBe(false);
  });
});

describe('explorer routing', () => {
  it('routes curated address tools per chain', () => {
    expect(resolveRoute('explorer_get_address', { chain: 'n3', address: 'N1' }).internalName)
      .toBe('n3_get_address');
    expect(resolveRoute('explorer_get_address', { chain: 'neox', address: '0x1' }).internalName)
      .toBe('x_get_address');
    expect(resolveRoute('analyze_address', { address: 'N1' }).internalName)
      .toBe('query_indexer');
    expect(resolveRoute('analyze_account_graph', { address: 'N1' }).internalName)
      .toBe('query_indexer');
    expect(resolveRoute('analyze_consensus_health', { network: 'testnet' }).internalName)
      .toBe('query_indexer');
    expect(resolveRoute('analyze_contract', { contractHash: `0x${'1'.repeat(40)}` }).internalName)
      .toBe('query_indexer');
    expect(resolveRoute('inspect_contract_code', { contractHash: `0x${'1'.repeat(40)}` }).internalName)
      .toBe('query_indexer');
    expect(resolveRoute('analyze_transaction', { txid: `0x${'1'.repeat(64)}` }).internalName)
      .toBe('query_indexer');
    expect(resolveRoute('investigate_transactions', { txids: [`0x${'1'.repeat(64)}`] }).internalName)
      .toBe('query_indexer');
    expect(resolveRoute('explorer_list_address_transactions', { chain: 'n3', address: 'N1' }).internalName)
      .toBe('n3_list_transactions_by_address');
    expect(resolveRoute('explorer_list_address_transactions', { chain: 'neox', address: '0x1' }).internalName)
      .toBe('x_list_transactions_by_address');
    expect(resolveRoute('explorer_list_address_transfers', { chain: 'n3', address: 'N1' }).internalName)
      .toBe('n3_list_transfers_by_address');
    expect(resolveRoute('explorer_list_address_transfers', { chain: 'neox', address: '0x1' }).internalName)
      .toBe('x_list_token_transfers');
    expect(resolveRoute('explorer_list_token_holders', { chain: 'n3', contractHash: '0x1' }).internalName)
      .toBe('n3_asset_holders');
    expect(resolveRoute('explorer_list_token_holders', { chain: 'neox', contractHash: '0x1' }).internalName)
      .toBe('x_token_holders');
    expect(resolveRoute('explorer_list_address_assets', { address: 'N1' }).internalName)
      .toBe('n3_assets_held_by_address');
  });

  it('routes each bounded Neo X intelligence tool with an isolated network', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['analyze_neox_transaction', { hash: `0x${'1'.repeat(64)}` }, 'x_analyze_transaction'],
      ['analyze_neox_block', { blockNumberOrHash: 42 }, 'x_analyze_block'],
      ['analyze_neox_address', { address: `0x${'2'.repeat(40)}` }, 'x_analyze_address'],
      ['analyze_neox_contract', { address: `0x${'3'.repeat(40)}` }, 'x_analyze_contract'],
      ['analyze_neox_token', { address: `0x${'4'.repeat(40)}` }, 'x_analyze_token'],
    ];
    for (const [name, args, internalName] of cases) {
      const route = resolveRoute(name, { ...args, network: 'testnet' });
      expect(route.internalName).toBe(internalName);
      expect(route.args.network).toBe('neox-testnet');
      expect(route.requiresServices).toBe(false);
    }
  });

  it('maps the dedicated address analysis tool to the bounded catalog endpoint', () => {
    const route = resolveRoute('analyze_address', {
      address: 'N1',
      sample: 40,
      limit: 8,
      network: 'testnet',
    });
    expect(route.internalName).toBe('query_indexer');
    expect(route.args).toEqual({
      method: 'analyze_address',
      params: { address: 'N1', sample: 40, limit: 8 },
      network: 'testnet',
    });
    expect(route.requiresServices).toBe(false);
  });

  it('maps address-to-address analysis without exposing an arbitrary URL', () => {
    const route = resolveRoute('analyze_address_connection', {
      source: 'NSource',
      target: 'NTarget',
      sample: 80,
      limit: 6,
      network: 'testnet',
    });
    expect(route.internalName).toBe('query_indexer');
    expect(route.args).toEqual({
      method: 'analyze_address_connection',
      params: {
        address: 'NSource',
        target: 'NTarget',
        sample: 80,
        limit: 6,
      },
      network: 'testnet',
    });
    expect(route.requiresServices).toBe(false);
  });

  it('maps account graph analysis to the bounded graph catalog endpoint', () => {
    const route = resolveRoute('analyze_account_graph', {
      address: 'N1',
      limit: 20,
      network: 'testnet',
    });
    expect(route.internalName).toBe('query_indexer');
    expect(route.args).toEqual({
      method: 'analyze_account_graph',
      params: { address: 'N1', limit: 20 },
      network: 'testnet',
    });
    expect(route.requiresServices).toBe(false);
  });

  it('maps consensus health analysis to the bounded network endpoint', () => {
    const route = resolveRoute('analyze_consensus_health', {
      lookback: 32,
      streak_threshold: 5,
      duration_threshold_s: 120,
      max_data_age_s: 180,
      max_clock_skew_s: 30,
      network: 'testnet',
    });
    expect(route.internalName).toBe('query_indexer');
    expect(route.args).toEqual({
      method: 'analyze_consensus_health',
      params: {
        lookback: 32,
        streak_threshold: 5,
        duration_threshold_s: 120,
        max_data_age_s: 180,
        max_clock_skew_s: 30,
      },
      network: 'testnet',
    });
    expect(route.requiresServices).toBe(false);
  });

  it('maps the dedicated transaction analysis tool to exact indexed facts', () => {
    const txid = `0x${'1'.repeat(64)}`;
    const route = resolveRoute('analyze_transaction', {
      txid,
      network: 'testnet',
    });
    expect(route.internalName).toBe('query_indexer');
    expect(route.args).toEqual({
      method: 'analyze_transaction',
      params: { txid },
      network: 'testnet',
    });
    expect(route.requiresServices).toBe(false);
  });

  it('maps a bounded multi-transaction investigation to one explicit N3 network', () => {
    const txids = [`0x${'1'.repeat(64)}`, `0x${'2'.repeat(64)}`];
    const route = resolveRoute('investigate_transactions', {
      txids,
      network: 'testnet',
    });
    expect(route.internalName).toBe('query_indexer');
    expect(route.args).toEqual({
      method: 'investigate_transactions',
      params: { txids },
      network: 'testnet',
    });
    expect(route.requiresServices).toBe(false);
  });

  it('maps the dedicated contract analysis tool to exact indexed facts', () => {
    const contractHash = `0x${'1'.repeat(40)}`;
    const route = resolveRoute('analyze_contract', {
      contractHash,
      network: 'testnet',
    });
    expect(route.internalName).toBe('query_indexer');
    expect(route.args).toEqual({
      method: 'analyze_contract',
      params: { hash: contractHash },
      network: 'testnet',
    });
    expect(route.requiresServices).toBe(false);
  });

  it('maps reproducible source verification to the exact network-scoped registry', () => {
    const contractHash = `0x${'1'.repeat(40)}`;
    const route = resolveRoute('get_contract_source_verification', {
      contractHash,
      network: 'testnet',
    });
    expect(route.internalName).toBe('query_indexer');
    expect(route.args).toEqual({
      method: 'get_contract_source_verification',
      params: { hash: contractHash },
      network: 'testnet',
    });
    expect(route.requiresServices).toBe(false);
  });

  it('maps contract code inspection pagination without exposing a raw path', () => {
    const contractHash = `0x${'1'.repeat(40)}`;
    const route = resolveRoute('inspect_contract_code', {
      contractHash,
      limit: 50,
      skip: 100,
      network: 'testnet',
    });
    expect(route.internalName).toBe('query_indexer');
    expect(route.args).toEqual({
      method: 'inspect_contract_code',
      params: { hash: contractHash, limit: 50, offset: 100 },
      network: 'testnet',
    });
    expect(route.requiresServices).toBe(false);
  });

  it('maps the unified token argument onto each backend name', () => {
    const n3 = resolveRoute('explorer_list_token_holders', { chain: 'n3', contractHash: '0xn3' });
    expect(n3.args.contractHash).toBe('0xn3');
    const neox = resolveRoute('explorer_list_token_holders', { chain: 'neox', contractHash: '0xevm' });
    expect(neox.args.address).toBe('0xevm');
  });

  it('routes search per chain', () => {
    const n3 = resolveRoute('explorer_search', { chain: 'n3', q: 'neo' });
    expect(n3.internalName).toBe('query_indexer');
    expect(n3.args.method).toBe('search');
    expect(n3.args.params).toEqual({ q: 'neo' });
    const neox = resolveRoute('explorer_search', { chain: 'neox', q: 'neo' });
    expect(neox.internalName).toBe('x_search');
    expect(neox.args.q).toBe('neo');
  });

  it('rejects explorer routes that cannot honor a requested testnet', () => {
    expect(() => resolveRoute('explorer_search', {
      chain: 'n3', q: 'neo', network: 'testnet',
    })).toThrow(/mainnet only/);
    expect(() => resolveRoute('get_contract_info', {
      chain: 'neox', address: '0xdead', network: 'testnet',
    })).toThrow(/mainnet only/);
  });

  it('routes the generic catalog query per chain, renaming the selector', () => {
    const n3 = resolveRoute('query_explorer', {
      chain: 'n3', endpoint: 'analyze_address', params: { address: 'N1', sample: 100 }, network: 'testnet',
    });
    expect(n3.internalName).toBe('query_indexer');
    expect(n3.args.method).toBe('analyze_address');
    expect(n3.args.params).toEqual({ address: 'N1', sample: 100 });
    expect(n3.args.network).toBe('testnet');
    expect('endpoint' in n3.args).toBe(false);

    const neox = resolveRoute('query_explorer', {
      chain: 'neox', endpoint: 'list_blocks', params: { type: 'block' }, network: 'testnet',
    });
    expect(neox.internalName).toBe('x_query');
    expect(neox.args.endpoint).toBe('list_blocks');
    expect(neox.args.params).toEqual({ type: 'block' });
    expect(neox.args.network).toBe('neox-testnet');
    expect('method' in neox.args).toBe(false);
  });

  it('routes the constrained finder and GraphQL escape hatch', () => {
    expect(resolveRoute('query_explorer_find', { collection: 'blocks' }).internalName)
      .toBe('query_indexer_find');
    expect(resolveRoute('query_explorer_graphql', { query: '{ block { hash } }' }).internalName)
      .toBe('x_graphql');
  });

  it('rewrites the network to the Neo X explorer form', () => {
    const route = resolveRoute('explorer_get_address', { chain: 'neox', address: '0x1', network: 'testnet' });
    expect(route.args.network).toBe('neox-testnet');
    const mainnet = resolveRoute('explorer_get_address', { chain: 'neox', address: '0x1', network: 'mainnet' });
    expect(mainnet.args.network).toBe('neox-mainnet');
  });

  it('drops limit/skip on cursor-paginated Blockscout routes', () => {
    const routes = [
      resolveRoute('explorer_list_address_transactions', { chain: 'neox', address: '0x1', limit: 10, skip: 20 }),
      resolveRoute('explorer_list_address_transfers', { chain: 'neox', address: '0x1', limit: 10, skip: 20 }),
      resolveRoute('explorer_list_token_holders', { chain: 'neox', contractHash: '0x1', limit: 10, skip: 20 }),
    ];
    for (const route of routes) {
      expect('limit' in route.args).toBe(false);
      expect('skip' in route.args).toBe(false);
    }
  });

  it('keeps limit/skip on Neo N3 curated routes', () => {
    const route = resolveRoute('explorer_list_address_transactions', {
      chain: 'n3', address: 'N1', limit: 10, skip: 20,
    });
    expect(route.args.limit).toBe(10);
    expect(route.args.skip).toBe(20);
  });
});

describe('route metadata', () => {
  it('requires initialized Neo N3 services only where the handler needs one', () => {
    const needsServices: Array<[string, Record<string, unknown>]> = [
      ['get_chain_info', { chain: 'n3' }],
      ['get_block', { chain: 'n3', hashOrHeight: 1 }],
      ['get_transaction_status', { chain: 'n3', hash: '0x1' }],
      ['call_contract', { chain: 'n3', scriptHash: '0x1', operation: 'x' }],
      ['simulate_call', { chain: 'n3', scriptHash: '0x1', operation: 'x' }],
      ['build_transfer', { chain: 'n3', from: 'N1', to: 'N2', asset: 'NEO', amount: '1' }],
      ['estimate_transfer_fees', { from: 'N1', to: 'N2', asset: 'NEO', amount: '1' }],
    ];
    for (const [tool, args] of needsServices) {
      expect(resolveRoute(tool, args).requiresServices).toBe(true);
    }

    const analytical: Array<[string, Record<string, unknown>]> = [
      ['explorer_get_address', { chain: 'n3', address: 'N1' }],
      ['explorer_get_address', { chain: 'neox', address: '0x1' }],
      ['analyze_neox_transaction', { hash: `0x${'1'.repeat(64)}` }],
      ['analyze_neox_block', { blockNumberOrHash: 1 }],
      ['analyze_neox_address', { address: `0x${'1'.repeat(40)}` }],
      ['analyze_neox_contract', { address: `0x${'1'.repeat(40)}` }],
      ['analyze_neox_token', { address: `0x${'1'.repeat(40)}` }],
      ['analyze_address', { address: 'N1' }],
      ['analyze_contract', { contractHash: `0x${'1'.repeat(40)}` }],
      ['inspect_contract_code', { contractHash: `0x${'1'.repeat(40)}` }],
      ['analyze_transaction', { txid: `0x${'1'.repeat(64)}` }],
      ['investigate_transactions', { txids: [`0x${'1'.repeat(64)}`] }],
      ['query_explorer', { chain: 'n3', endpoint: 'list_blocks' }],
      ['query_explorer_graphql', { query: '{}' }],
      ['get_chain_info', { chain: 'neox' }],
      ['get_block', { chain: 'neox', hashOrHeight: 1 }],
      ['simulate_call', { chain: 'neox', to: '0x1', data: '0x' }],
      ['get_network_mode', {}],
    ];
    for (const [tool, args] of analytical) {
      expect(resolveRoute(tool, args).requiresServices).toBe(false);
    }
  });

  it('marks get_wallet as the only wallet-service consumer', () => {
    for (const name of publicToolNames()) {
      const chains = supportedChains(name);
      const args: Record<string, unknown> = chains.length > 0 ? { chain: chains[0] } : {};
      const route: ToolRoute = resolveRoute(name, {
        ...args,
        address: 'N1',
        hash: '0x1',
        hashOrHeight: 1,
        txid: '0x1',
        from: 'N1',
        to: 'N2',
        asset: 'NEO',
        amount: '1',
        amountWei: '1',
        scriptHash: '0x1',
        operation: 'x',
        contract: '0x1',
        contractHash: '0x1',
        contractName: 'neo',
        data: '0x',
        endpoint: 'list_blocks',
        collection: 'blocks',
        query: '{}',
        q: 'neo',
      });
      expect(route.requiresWallet).toBe(name === 'get_wallet');
    }
  });

  it('reports the resolved chain on every route', () => {
    expect(resolveRoute('get_block', { chain: 'neox', hashOrHeight: 1 }).chain).toBe('neox');
    expect(resolveRoute('get_block', { chain: 'n3', hashOrHeight: 1 }).chain).toBe('n3');
    expect(resolveRoute('get_unclaimed_gas', { address: 'N1' }).chain).toBe('n3');
    expect(resolveRoute('query_explorer_graphql', { query: '{}' }).chain).toBe('neox');
    expect(resolveRoute('get_network_mode', {}).chain).toBeUndefined();
  });

  it('never routes to a wallet-creation handler', () => {
    for (const name of publicToolNames()) {
      for (const chain of supportedChains(name).length > 0 ? supportedChains(name) : [undefined]) {
        const route = resolveRoute(name, {
          ...(chain ? { chain } : {}),
          address: 'N1', hash: '0x1', hashOrHeight: 1, txid: '0x1', from: 'N1', to: 'N2',
          asset: 'NEO', amount: '1', amountWei: '1', scriptHash: '0x1', operation: 'x',
          contract: '0x1', contractHash: '0x1', contractName: 'neo', data: '0x',
          endpoint: 'list_blocks', collection: 'blocks', query: '{}', q: 'neo',
        });
        expect(route.internalName).not.toBe('create_wallet');
        expect(route.internalName).not.toBe('import_wallet');
        expect(route.internalName).not.toMatch(/transfer_assets|invoke_contract_write|claim_gas|deploy_contract/);
      }
    }
  });

  it('produces a fresh argument object per call (no shared mutable state)', () => {
    const input = { chain: 'neox', hashOrHeight: 1 } as Record<string, unknown>;
    const first = resolveRoute('get_block', input);
    first.args.blockHashOrHeight = 999;
    const second = resolveRoute('get_block', input);
    expect(second.args.blockHashOrHeight).toBe(1);
    expect(input.chain).toBe('neox');
  });
});
