import { jest } from '@jest/globals';
import path from 'path';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import type { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { Client } from "@modelcontextprotocol/client";
import { startMcpTestClient, stopMcpTestClient } from './mcp-test-utils';
import { TEST_WIF } from './test-wallet';
/**
 * The exact tool surface the server advertises when writes are disabled (the default).
 *
 * This is deliberately an explicit, sorted inventory rather than a count: adding or
 * renaming a tool then fails with a diff that names the tool, instead of an opaque
 * "expected 40, received 41". Update this list in the same commit that registers a tool.
 */
const DEFAULT_TOOL_NAMES = [
  'analyze_account_graph',
  'analyze_address',
  'analyze_address_connection',
  'analyze_consensus_health',
  'analyze_contract',
  'analyze_contract_upgrades',
  'analyze_neox_address',
  'analyze_neox_block',
  'analyze_neox_contract',
  'analyze_neox_token',
  'analyze_neox_transaction',
  'analyze_stablecoins',
  'analyze_transaction',
  'build_contract_call',
  'build_nns_operation',
  'build_transfer',
  'build_vote',
  'call_contract',
  'convert_neo_data',
  'decode_neo_script',
  'estimate_invoke_fees',
  'estimate_transfer_fees',
  'explorer_get_address',
  'explorer_list_address_assets',
  'explorer_list_address_transactions',
  'explorer_list_address_transfers',
  'explorer_list_token_holders',
  'explorer_search',
  'get_application_log',
  'get_balance',
  'get_block',
  'get_block_height',
  'get_chain_info',
  'get_contract_info',
  'get_contract_source_verification',
  'get_contract_status',
  'get_neo_service_info',
  'get_nep11_balances',
  'get_nep11_transfers',
  'get_nep17_transfers',
  'get_network_mode',
  'get_oracle_info',
  'get_transaction',
  'get_transaction_status',
  'get_unclaimed_gas',
  'get_wallet',
  'inspect_contract_code',
  'inspect_neo_value',
  'investigate_transactions',
  'list_famous_contracts',
  'query_explorer',
  'query_explorer_find',
  'query_explorer_graphql',
  'query_neofs',
  'query_nns',
  'request_account_watch',
  'simulate_call',
  'wait_for_transaction',
];

/**
 * Public tools that must accept a `chain` selector because both Neo N3 and Neo X
 * implement the operation. A tool losing its selector would silently pin callers
 * to one chain, so the enum values are pinned here too.
 */
const CHAIN_SELECTING_TOOL_NAMES = [
  'analyze_stablecoins',
  'build_contract_call',
  'build_transfer',
  'call_contract',
  'explorer_get_address',
  'explorer_list_address_transactions',
  'explorer_list_address_transfers',
  'explorer_list_token_holders',
  'explorer_search',
  'get_balance',
  'get_block',
  'get_block_height',
  'get_chain_info',
  'get_contract_info',
  'get_transaction',
  'get_transaction_status',
  'query_explorer',
  'simulate_call',
];

/** The only secret-free write tools, added exclusively when NEO_ENABLE_WRITES is set. */
const WRITE_TOOL_NAMES = [
  'claim_gas',
  'deploy_contract',
  'invoke_contract_write',
  'transfer_assets',
];

/** Full surface with writes enabled; the count is derived, never hand-maintained. */
const WRITE_ENABLED_TOOL_NAMES = [...DEFAULT_TOOL_NAMES, ...WRITE_TOOL_NAMES].sort();

/**
 * Non-custodial tools that build or simulate transactions without ever holding a key.
 * They must stay on the default read-only surface: the caller signs in their own wallet.
 */
const NON_CUSTODIAL_CONSTRUCTION_TOOL_NAMES = [
  'build_contract_call',
  'build_nns_operation',
  'build_transfer',
  'build_vote',
  'simulate_call',
];

const sortedToolNames = (tools: Array<{ name: string }>): string[] =>
  tools.map(tool => tool.name).sort();

const MCP_TEST_REQUEST_OPTIONS = {
  timeout: 90_000,
  maxTotalTimeout: 90_000,
};

const listTools = (target: Client) =>
  target.listTools(undefined, MCP_TEST_REQUEST_OPTIONS);

const callTool = (target: Client, request: Parameters<Client['callTool']>[0]) =>
  target.callTool(request, MCP_TEST_REQUEST_OPTIONS);

describe('Modern MCP tool registration', () => {
  const TEST_TIMEOUT = 120_000;
  const serverPath = path.join(__dirname, '../dist/index.js');
  let client: Client | null = null;
  let transport: StdioClientTransport | null = null;

  jest.setTimeout(TEST_TIMEOUT);

  beforeEach(async () => {
    const session = await startMcpTestClient({
      serverPath,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        LOG_CONSOLE: 'false',
        LOG_FILE_ENABLED: 'false',
        RATE_LIMITING_ENABLED: 'true',
        MAX_REQUESTS_PER_MINUTE: '1',
        MAX_REQUESTS_PER_HOUR: '100',
      },
      clientInfo: { name: 'MCP Tool Registration Test Client', version: '1.0.0' },
    });

    client = session.client;
    transport = session.transport;
  });

  afterEach(async () => {
    await stopMcpTestClient(client, transport);
    client = null;
    transport = null;
  });

  test('applies one shared rate limit across the whole public tool surface', async () => {
    const first = await callTool(client!, { name: 'get_network_mode', arguments: {} });
    const second = await callTool(client!, {
      name: 'get_balance',
      arguments: { chain: 'n3', address: 'invalid-address' },
    });

    expect(first.isError).not.toBe(true);
    expect(second.isError).toBe(true);
    expect(second.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringMatching(/rate limit exceeded/i),
        }),
      ]),
    );
  });

  test('charges each registry-routed tool call exactly once', async () => {
    const first = await callTool(client!, {
      name: 'get_wallet',
      arguments: { address: 'NaMLm1hwCaQitxmLboJGo2XJkG8PSYvuyr' },
    });
    const second = await callTool(client!, {
      name: 'get_wallet',
      arguments: { address: 'NaMLm1hwCaQitxmLboJGo2XJkG8PSYvuyr' },
    });

    expect(first.isError).toBe(true);
    expect(first.content).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringMatching(/rate limit exceeded/i) }),
      ]),
    );
    expect(second.isError).toBe(true);
    expect(second.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringMatching(/rate limit exceeded/i),
        }),
      ]),
    );
  });

  test('advertises call_contract as strictly read-only', async () => {
    const response = await listTools(client!);
    const callContract = response.tools.find(tool => tool.name === 'call_contract');

    expect(callContract).toBeDefined();
    expect(callContract?.inputSchema.properties).not.toHaveProperty('signers');
    expect(callContract?.inputSchema.properties).not.toHaveProperty('fromWIF');
    expect(callContract?.inputSchema.properties).not.toHaveProperty('wif');
    expect(callContract?.inputSchema.properties).not.toHaveProperty('confirm');
  });

  test('requires an explicit chain on every dual-chain tool', async () => {
    const response = await listTools(client!);

    for (const name of CHAIN_SELECTING_TOOL_NAMES) {
      const tool = response.tools.find(candidate => candidate.name === name);
      expect(tool).toBeDefined();
      const properties = tool?.inputSchema.properties as
        | Record<string, { enum?: unknown[] }>
        | undefined;
      expect(properties).toHaveProperty('chain');
      expect(properties?.chain?.enum).toEqual(['n3', 'neox']);
      expect(tool?.inputSchema.required).toEqual(expect.arrayContaining(['chain']));
    }
  });

  test('routes a dual-chain tool to the chain the caller selected', async () => {
    const rejected = await callTool(client!, {
      name: 'get_block',
      arguments: { chain: 'ethereum', hashOrHeight: 1 },
    });

    expect(rejected.isError).toBe(true);
    expect(rejected.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringMatching(/chain/i) }),
      ]),
    );
  });

  test('advertises optional Neo N3 state-root evidence on get_block', async () => {
    const response = await listTools(client!);
    const getBlock = response.tools.find(tool => tool.name === 'get_block');

    expect(getBlock).toBeDefined();
    expect(getBlock?.inputSchema.properties).toHaveProperty('includeStateRoot');
    expect(getBlock?.inputSchema.required).not.toContain('includeStateRoot');
  });

  test('does not advertise unsupported estimate_invoke_fees signers', async () => {
    const response = await listTools(client!);
    const estimateInvokeFees = response.tools.find(tool => tool.name === 'estimate_invoke_fees');

    expect(estimateInvokeFees).toBeDefined();
    expect(estimateInvokeFees?.inputSchema.properties).not.toHaveProperty('signers');
  });

  test('defaults to a read-only tool surface with no secret-bearing administration', async () => {
    const response = await listTools(client!);
    const toolNames = response.tools.map(tool => tool.name);

    expect(sortedToolNames(response.tools)).toEqual(DEFAULT_TOOL_NAMES);
    expect(response.tools).toHaveLength(DEFAULT_TOOL_NAMES.length);
    expect(toolNames).toEqual(expect.arrayContaining(NON_CUSTODIAL_CONSTRUCTION_TOOL_NAMES));

    expect(toolNames).not.toContain('neofs_create_container');
    expect(toolNames).not.toContain('neofs_get_containers');
    expect(toolNames).not.toContain('set_network_mode');
    expect(toolNames).not.toContain('create_wallet');
    expect(toolNames).not.toContain('import_wallet');
    expect(toolNames).not.toContain('transfer_assets');
    expect(toolNames).not.toContain('invoke_contract_write');
    expect(toolNames).not.toContain('claim_gas');
    expect(toolNames).not.toContain('deploy_contract');
  });

  test('advertises account watch as a non-destructive idempotent external action', async () => {
    const response = await listTools(client!);
    const watch = response.tools.find(tool => tool.name === 'request_account_watch');

    expect(watch?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(watch?.inputSchema.required).toEqual(
      expect.arrayContaining(['address', 'email', 'network']),
    );
  });

  test('advertises four annotated secret-free write tools only when explicitly enabled', async () => {
    await stopMcpTestClient(client, transport);
    client = null;
    transport = null;
    const directory = mkdtempSync(path.join(tmpdir(), 'neo-mcp-write-tools-'));
    const signerFile = path.join(directory, 'signer.wif');
    const stateDirectory = path.join(directory, 'state');
    // A write state directory keeps a durable .writer.lock that is intentionally never
    // released, so the second server process below needs its own directory. It only
    // exercises the input-required capability refusal and never reads the first journal.
    const noElicitationStateDirectory = path.join(directory, 'state-no-elicitation');
    writeFileSync(signerFile, `${TEST_WIF}\n`, { mode: 0o600 });
    chmodSync(signerFile, 0o600);

    try {
      const session = await startMcpTestClient({
        serverPath,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          LOG_CONSOLE: 'false',
          LOG_FILE_ENABLED: 'false',
          RATE_LIMITING_ENABLED: 'false',
          NEO_ENABLE_WRITES: 'true',
          NEO_SIGNER_WIF_FILE: signerFile,
          NEO_WRITE_STATE_DIR: stateDirectory,
          NEO_MCP_REQUEST_STATE_KEY: 'mcp-write-test-request-state-key-000000000000000000',
          HTTP_WRITE_APPROVAL_API_KEY: 'independent-approval-key-1234567890',
          NEO_TESTNET_RPC: 'http://127.0.0.1:1',
        },
        clientInfo: { name: 'MCP Write Registration Test Client', version: '1.0.0' },
        capabilities: { tools: {}, elicitation: { form: {} } },
      });
      client = session.client;
      transport = session.transport;

      const response = await listTools(client);
      const writeToolNames = WRITE_TOOL_NAMES;
      expect(sortedToolNames(response.tools)).toEqual(WRITE_ENABLED_TOOL_NAMES);
      expect(response.tools).toHaveLength(WRITE_ENABLED_TOOL_NAMES.length);
      expect(response.tools.map(tool => tool.name)).toEqual(
        expect.arrayContaining(NON_CUSTODIAL_CONSTRUCTION_TOOL_NAMES),
      );
      for (const name of writeToolNames) {
        const tool = response.tools.find((candidate) => candidate.name === name);
        expect(tool).toBeDefined();
        expect(tool?.annotations).toMatchObject({
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
        });
        expect(tool?.inputSchema.properties).toHaveProperty('idempotencyKey');
        expect(tool?.inputSchema.properties).toHaveProperty('network');
        expect(tool?.inputSchema.properties).not.toHaveProperty('fromWIF');
        expect(tool?.inputSchema.properties).not.toHaveProperty('wif');
        expect(tool?.inputSchema.properties).not.toHaveProperty('privateKey');
        expect(tool?.inputSchema.properties).not.toHaveProperty('password');
        expect(tool?.inputSchema.properties).not.toHaveProperty('confirm');
      }

      let approvalMessage = '';
      client.setRequestHandler('elicitation/create', async (request) => {
        approvalMessage = request.params.message;
        const fingerprint = /Fingerprint: ([0-9a-f]{64})/.exec(approvalMessage)?.[1];
        return {
          action: 'accept' as const,
          content: { fingerprint: fingerprint as string, approve: true },
        };
      });
      const attempted = await callTool(client, {
        name: 'transfer_assets',
        arguments: {
          idempotencyKey: 'mcp-positive-approval-flow',
          network: 'testnet',
          toAddress: 'NR8vZB6LijzinRcjbc1y8mZ8gbqrERbGpr',
          asset: 'GAS',
          amount: '1',
        },
      });
      expect(approvalMessage).toMatch(/Payload:[\s\S]*toAddress[\s\S]*asset[\s\S]*amount/);
      expect(attempted.isError).toBe(true);
      const journalFile = readdirSync(stateDirectory).find((name) => /^[0-9a-f]{64}\.json$/.test(name));
      expect(journalFile).toBeDefined();
      expect(JSON.parse(readFileSync(path.join(stateDirectory, journalFile as string), 'utf8')))
        .toMatchObject({ state: 'failed_before_submission' });

      await stopMcpTestClient(client, transport);
      client = null;
      transport = null;
      const unsupportedSession = await startMcpTestClient({
        serverPath,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          LOG_CONSOLE: 'false',
          LOG_FILE_ENABLED: 'false',
          RATE_LIMITING_ENABLED: 'false',
          NEO_ENABLE_WRITES: 'true',
          NEO_SIGNER_WIF_FILE: signerFile,
          NEO_WRITE_STATE_DIR: noElicitationStateDirectory,
          NEO_MCP_REQUEST_STATE_KEY: 'mcp-write-test-request-state-key-000000000000000000',
          HTTP_WRITE_APPROVAL_API_KEY: 'independent-approval-key-1234567890',
        },
        clientInfo: { name: 'MCP No-Elicitation Client', version: '1.0.0' },
        capabilities: { tools: {} },
      });
      client = unsupportedSession.client;
      transport = unsupportedSession.transport;
      await expect(callTool(client, {
          name: 'claim_gas',
          arguments: {
            idempotencyKey: 'claim-request-without-elicitation',
            network: 'testnet',
          },
        }))
        .rejects.toThrow(/capabilit|elicitation/i);
    } finally {
      await stopMcpTestClient(client, transport);
      client = null;
      transport = null;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
