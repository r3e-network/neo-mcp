/**
 * Protocol-level tests for the MCP 2026-07-28 modern-only HTTP surface.
 */

import * as net from 'net';

import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

import {
  MCP_PROTOCOL_VERSION,
  McpHttpServer,
  McpHttpServerOptions,
  resolveMcpHttpOptionsFromEnv,
  withWritesDisabled,
} from '../src/mcp-http-server';
import { config } from '../src/config';

jest.setTimeout(30_000);

const BEARER = 'test-bearer-token-000102030405060708090a0b0c';
const ACCEPT = 'application/json, text/event-stream';
const WRITE_TOOL_NAMES = [
  'claim_gas',
  'deploy_contract',
  'invoke_contract_write',
  'transfer_assets',
];

interface StartedServer {
  server: McpHttpServer;
  port: number;
  url: string;
}

const startedServers: McpHttpServer[] = [];
const openClients: Array<{ client: Client; transport: StreamableHTTPClientTransport }> = [];

async function startServer(options: McpHttpServerOptions = {}): Promise<StartedServer> {
  const server = new McpHttpServer({
    port: 0,
    host: '127.0.0.1',
    bearerToken: BEARER,
    ...options,
  });
  startedServers.push(server);
  const port = await server.start();
  return { server, port, url: `http://127.0.0.1:${port}${server.endpointPath}` };
}

async function connectModernClient(
  started: StartedServer,
  token: string | undefined = BEARER,
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const requestInit = token
    ? { headers: { Authorization: `Bearer ${token}` } }
    : undefined;
  const transport = new StreamableHTTPClientTransport(new URL(started.url), { requestInit });
  const client = new Client(
    { name: 'neo-mcp-modern-test', version: '1.0.0' },
    {
      capabilities: {},
      versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
    },
  );
  openClients.push({ client, transport });
  await client.connect(transport);
  return { client, transport };
}

function modernMeta() {
  return {
    'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientInfo': {
      name: 'raw-modern-test',
      version: '1.0.0',
    },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
}

function discoverBody(id: number | string = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'server/discover',
    params: { _meta: modernMeta() },
  };
}

async function rawModernRequest(
  started: StartedServer,
  body: unknown = discoverBody(),
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(started.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${BEARER}`,
      'Content-Type': 'application/json',
      Accept: ACCEPT,
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
      'Mcp-Method': 'server/discover',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  while (openClients.length > 0) {
    const entry = openClients.pop();
    if (!entry) continue;
    try {
      await entry.client.close();
    } catch {
      // The server may already be stopped.
    }
  }
  while (startedServers.length > 0) {
    const server = startedServers.pop();
    if (!server) continue;
    await server.stop();
  }
});

describe('MCP 2026-07-28 stateless HTTP transport', () => {
  describe('modern protocol', () => {
    test('discovers, lists, and calls tools without creating a session', async () => {
      const started = await startServer();
      const { client, transport } = await connectModernClient(started);

      expect(client.getProtocolEra()).toBe('modern');
      expect(client.getServerVersion()).toEqual(expect.objectContaining({
        name: 'neo-mcp-server',
        version: expect.any(String),
      }));
      expect(transport.sessionId).toBeUndefined();

      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(57);
      expect(listed.tools.map((tool) => tool.name)).toContain('analyze_address');
      expect(listed.tools.map((tool) => tool.name)).toContain('analyze_account_graph');
      expect(listed.tools.map((tool) => tool.name)).toContain('analyze_transaction');
      expect(listed.tools.map((tool) => tool.name)).toContain('investigate_transactions');
      expect(listed.tools.map((tool) => tool.name)).toContain('analyze_contract');
      expect(listed.tools.map((tool) => tool.name)).toContain('analyze_stablecoins');
      expect(listed.tools.map((tool) => tool.name)).toContain('analyze_contract_upgrades');
      expect(listed.tools.map((tool) => tool.name)).toContain('get_contract_source_verification');
      expect(listed.tools.map((tool) => tool.name)).toContain('inspect_contract_code');
      expect(listed.tools.map((tool) => tool.name)).toContain('analyze_neox_transaction');
      expect(listed.tools.map((tool) => tool.name)).toContain('analyze_neox_contract');
      expect(listed.ttlMs).toBe(300_000);
      expect(listed.cacheScope).toBe('public');

      const result = await client.callTool({
        name: 'get_network_mode',
        arguments: {},
      });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(JSON.parse(content[0].text)).toEqual(expect.objectContaining({
        mode: expect.any(String),
        availableNetworks: expect.any(Array),
        defaultNetwork: expect.any(String),
      }));
      expect(started.server.activeRequestCount).toBe(0);
    });

    test('server/discover exposes only 2026-07-28 with cache and identity metadata', async () => {
      const started = await startServer();
      const response = await rawModernRequest(started);
      const payload = await response.json() as any;

      expect(response.status).toBe(200);
      expect(response.headers.get('mcp-session-id')).toBeNull();
      expect(payload.result).toEqual(expect.objectContaining({
        supportedVersions: [MCP_PROTOCOL_VERSION],
        resultType: 'complete',
        ttlMs: 300_000,
        cacheScope: 'public',
      }));
      expect(payload.result._meta['io.modelcontextprotocol/serverInfo']).toEqual(
        expect.objectContaining({
          name: 'neo-mcp-server',
          description: expect.any(String),
        }),
      );
    });

    test('rejects the removed initialize handshake instead of downgrading', async () => {
      const started = await startServer();
      const response = await fetch(started.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${BEARER}`,
          'Content-Type': 'application/json',
          Accept: ACCEPT,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'legacy-client', version: '1.0.0' },
          },
        }),
      });
      const payload = await response.json() as any;

      expect(response.status).toBe(400);
      expect(payload.error).toEqual(expect.objectContaining({
        code: -32022,
        data: {
          requested: '2025-11-25',
          supported: [MCP_PROTOCOL_VERSION],
        },
      }));
      expect(response.headers.get('mcp-session-id')).toBeNull();
    });

    test('rejects Mcp-Method/body mismatches at the protocol edge', async () => {
      const started = await startServer();
      const response = await rawModernRequest(
        started,
        discoverBody(9),
        { 'Mcp-Method': 'tools/list' },
      );
      const payload = await response.json() as any;

      expect(response.status).toBe(400);
      expect(payload.error.code).toBe(-32020);
      expect(payload.error.message).toMatch(/headers and body disagree/i);
    });

    test('rejects a legacy SDK client pinned to the old era', async () => {
      const started = await startServer();
      const transport = new StreamableHTTPClientTransport(new URL(started.url), {
        requestInit: { headers: { Authorization: `Bearer ${BEARER}` } },
      });
      const client = new Client(
        { name: 'legacy-test', version: '1.0.0' },
        { capabilities: {}, versionNegotiation: { mode: 'legacy' } },
      );
      openClients.push({ client, transport });

      await expect(client.connect(transport)).rejects.toThrow(/unsupported protocol version/i);
    });

    test('serves separate stateless calls concurrently', async () => {
      const started = await startServer();
      const first = await connectModernClient(started);
      const second = await connectModernClient(started);

      const [a, b] = await Promise.all([
        first.client.callTool({ name: 'get_network_mode', arguments: {} }),
        second.client.callTool({ name: 'get_network_mode', arguments: {} }),
      ]);

      expect(a.isError).not.toBe(true);
      expect(b.isError).not.toBe(true);
      expect(first.transport.sessionId).toBeUndefined();
      expect(second.transport.sessionId).toBeUndefined();
      expect(started.server.activeRequestCount).toBe(0);
    });
  });

  describe('authentication and request security', () => {
    test('rejects missing and incorrect bearer tokens', async () => {
      const started = await startServer();
      const noToken = await fetch(started.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(discoverBody()),
      });
      expect(noToken.status).toBe(401);
      expect(noToken.headers.get('www-authenticate')).toMatch(/^Bearer/);

      const wrongToken = await rawModernRequest(
        started,
        discoverBody(),
        { Authorization: 'Bearer definitely-wrong' },
      );
      expect(wrongToken.status).toBe(401);
    });

    test('requires a strong bearer on non-loopback listeners', () => {
      expect(() => new McpHttpServer({ host: '0.0.0.0', port: 0 }))
        .toThrow(/MCP_HTTP_BEARER is required/);
      expect(() => new McpHttpServer({
        host: '0.0.0.0',
        port: 0,
        bearerToken: 'short',
      })).toThrow(/at least 32 bytes/);
    });

    test('enforces exact Origin and Host allowlists', async () => {
      const started = await startServer({
        allowedOrigins: ['https://explorer.example'],
        allowedHosts: ['127.0.0.1'],
      });

      const allowed = await rawModernRequest(started, discoverBody(), {
        Origin: 'https://explorer.example',
        Host: '127.0.0.1',
      });
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get('access-control-allow-origin')).toBe(
        'https://explorer.example',
      );

      const deniedOrigin = await rawModernRequest(started, discoverBody(), {
        Origin: 'https://evil.example',
      });
      expect(deniedOrigin.status).toBe(403);

      const hostRestricted = await startServer({
        allowedHosts: ['mcp.example'],
      });
      const deniedHost = await rawModernRequest(hostRestricted);
      expect(deniedHost.status).toBe(403);
    });

    test('advertises only modern POST headers in CORS preflight', async () => {
      const started = await startServer({ allowedOrigins: ['https://explorer.example'] });
      const response = await fetch(started.url, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://explorer.example',
          'Access-Control-Request-Method': 'POST',
        },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
      const allowedHeaders = response.headers.get('access-control-allow-headers') ?? '';
      expect(allowedHeaders).toContain('MCP-Protocol-Version');
      expect(allowedHeaders).toContain('Mcp-Method');
      expect(allowedHeaders).toContain('Mcp-Name');
      expect(allowedHeaders).not.toContain('Mcp-Session-Id');
    });
  });

  describe('HTTP hardening', () => {
    test('allows only POST on the MCP path', async () => {
      const started = await startServer();
      for (const method of ['GET', 'DELETE', 'PUT']) {
        const response = await fetch(started.url, {
          method,
          headers: { Authorization: `Bearer ${BEARER}` },
        });
        expect(response.status).toBe(405);
        expect(response.headers.get('allow')).toBe('POST, OPTIONS');
      }
    });

    test('rejects non-JSON content and malformed JSON', async () => {
      const started = await startServer();
      const nonJson = await fetch(started.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${BEARER}`,
          'Content-Type': 'text/plain',
        },
        body: '{}',
      });
      expect(nonJson.status).toBe(415);

      const malformed = await fetch(started.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${BEARER}`,
          'Content-Type': 'application/json',
        },
        body: '{bad-json',
      });
      expect(malformed.status).toBe(400);
      expect((await malformed.json() as any).error.code).toBe(-32700);
    });

    test('enforces the request-body byte cap', async () => {
      const started = await startServer({ maxBodyBytes: 64 });
      const response = await fetch(started.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${BEARER}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ payload: 'x'.repeat(256) }),
      });
      expect(response.status).toBe(413);
    });

    test('times out a partial request body', async () => {
      const started = await startServer({ bodyTimeoutMs: 75 });
      const responseText = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(started.port, '127.0.0.1');
        let data = '';
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error('Timed out waiting for partial-body rejection'));
        }, 2_000);
        socket.on('connect', () => {
          socket.write(
            `POST /mcp HTTP/1.1\r\n`
            + `Host: 127.0.0.1\r\n`
            + `Authorization: Bearer ${BEARER}\r\n`
            + `Content-Type: application/json\r\n`
            + `Content-Length: 100\r\n\r\n{"`,
          );
        });
        socket.on('data', (chunk) => {
          data += chunk.toString('utf8');
        });
        socket.on('end', () => {
          clearTimeout(timer);
          resolve(data);
        });
        socket.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });

      expect(responseText).toContain('408 Request Timeout');
      expect(responseText).toContain('body was not received in time');
      expect(started.server.activeRequestCount).toBe(0);
    });

    test('returns a modern protocol health contract', async () => {
      const started = await startServer();
      const response = await fetch(`http://127.0.0.1:${started.port}/healthz`);
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload).toEqual(expect.objectContaining({
        status: 'ok',
        protocolVersion: MCP_PROTOCOL_VERSION,
        protocolEra: 'modern',
        stateless: true,
        activeRequests: 0,
      }));
    });
  });

  describe('read-only boundary and configuration', () => {
    test('withWritesDisabled restores configuration after synchronous construction', () => {
      const previous = config.writes.enabled;
      config.writes.enabled = true;
      try {
        const observed = withWritesDisabled(() => config.writes.enabled);
        expect(observed).toBe(false);
        expect(config.writes.enabled).toBe(true);
      } finally {
        config.writes.enabled = previous;
      }
    });

    test('remote modern surface never exposes signing or broadcast tools', async () => {
      const previous = config.writes.enabled;
      config.writes.enabled = true;
      try {
        const started = await startServer();
        const { client } = await connectModernClient(started);
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        for (const name of WRITE_TOOL_NAMES) {
          expect(names).not.toContain(name);
        }
      } finally {
        config.writes.enabled = previous;
      }
    });

    test('parses modern-only environment variables', () => {
      const options = resolveMcpHttpOptionsFromEnv({
        MCP_HTTP_PORT: '3999',
        MCP_HTTP_HOST: '0.0.0.0',
        MCP_HTTP_PATH: '/mcp-modern',
        MCP_HTTP_BEARER: BEARER,
        MCP_HTTP_ALLOWED_ORIGINS: 'https://a.example, https://b.example',
        MCP_HTTP_ALLOWED_HOSTS: 'mcp.example, mcp.internal',
        MCP_HTTP_MAX_CONCURRENT_REQUESTS: '17',
        MCP_HTTP_MAX_SUBSCRIPTIONS: '9',
        MCP_HTTP_MAX_BODY_BYTES: '8192',
        MCP_HTTP_KEEP_ALIVE_MS: '0',
      });

      expect(options).toEqual(expect.objectContaining({
        port: 3999,
        host: '0.0.0.0',
        path: '/mcp-modern',
        maxConcurrentRequests: 17,
        maxSubscriptions: 9,
        maxBodyBytes: 8192,
        keepAliveMs: 0,
      }));
      expect(options.allowedOrigins).toEqual(['https://a.example', 'https://b.example']);
      expect(options.allowedHosts).toEqual(['mcp.example', 'mcp.internal']);
    });

    test('rejects invalid modern server options', () => {
      expect(() => resolveMcpHttpOptionsFromEnv({ MCP_HTTP_PORT: 'nope' }))
        .toThrow(/MCP_HTTP_PORT/);
      expect(() => resolveMcpHttpOptionsFromEnv({
        MCP_HTTP_MAX_CONCURRENT_REQUESTS: '0',
      })).toThrow(/MCP_HTTP_MAX_CONCURRENT_REQUESTS/);
      expect(() => resolveMcpHttpOptionsFromEnv({
        MCP_HTTP_MAX_SUBSCRIPTIONS: '-1',
      })).toThrow(/MCP_HTTP_MAX_SUBSCRIPTIONS/);
      expect(() => resolveMcpHttpOptionsFromEnv({
        MCP_HTTP_KEEP_ALIVE_MS: '-1',
      })).toThrow(/MCP_HTTP_KEEP_ALIVE_MS/);
      expect(() => new McpHttpServer({ path: '/healthz' }))
        .toThrow(/reserved/);
    });

    test('does not allow the same listener to start twice', async () => {
      const started = await startServer();
      await expect(started.server.start()).rejects.toThrow(/already started/);
    });
  });
});
