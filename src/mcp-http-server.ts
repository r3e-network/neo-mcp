/**
 * MCP 2026-07-28 Streamable HTTP transport for the Neo MCP server.
 *
 * The protocol is modern-only and stateless: every request carries its version,
 * client identity, and capabilities; there is no initialize handshake, session
 * id, standalone GET stream, or DELETE lifecycle. A fresh read-only
 * `NeoMcpServer` is created for each request through the official SDK v2 entry.
 */

import * as http from 'http';
import { createHash, timingSafeEqual } from 'crypto';
import { AddressInfo } from 'net';

import {
  createMcpHandler,
  McpHttpHandler,
  McpRequestContext,
} from '@modelcontextprotocol/server';
import {
  NodeMcpRequestHandler,
  toNodeHandler,
} from '@modelcontextprotocol/node';

import { config } from './config';
import { NeoMcpServer } from './index';
import { logger } from './utils/logger';
import { rejectOversizedToolInput } from './utils/tool-input-limit';
import { SERVER_VERSION } from './version';

export const MCP_PROTOCOL_VERSION = '2026-07-28';
export const DEFAULT_MCP_HTTP_PORT = 3001;
export const DEFAULT_MCP_HTTP_HOST = '127.0.0.1';
export const DEFAULT_MCP_HTTP_PATH = '/mcp';
export const DEFAULT_MCP_HTTP_MAX_CONCURRENT_REQUESTS = 128;
export const DEFAULT_MCP_HTTP_MAX_SUBSCRIPTIONS = 128;
export const DEFAULT_MCP_HTTP_MAX_BODY_BYTES = 1024 * 1024;

const DEFAULT_BODY_TIMEOUT_MS = 30_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const DEFAULT_KEEP_ALIVE_MS = 15_000;
const MIN_MAX_CONNECTIONS = 256;
const MIN_REMOTE_BEARER_BYTES = 32;
const HEALTH_PATH = '/healthz';
const ALLOWED_METHODS = 'POST, OPTIONS';
const ALLOWED_REQUEST_HEADERS = [
  'Authorization',
  'Content-Type',
  'Accept',
  'MCP-Protocol-Version',
  'Mcp-Method',
  'Mcp-Name',
].join(', ');
const PREFLIGHT_MAX_AGE_SECONDS = 600;
const INTERNAL_RATE_LIMIT_HEADER = 'x-neo-mcp-rate-key';

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_INTERNAL_ERROR = -32603;

export interface McpHttpServerOptions {
  /** TCP port to bind. Use 0 to let the OS pick a free port in tests. */
  port?: number;
  /** Bind address. A non-loopback address requires a bearer token. */
  host?: string;
  /** Path that serves the modern MCP POST endpoint. */
  path?: string;
  /** Bearer token required on every MCP request. */
  bearerToken?: string;
  /** Exact browser origins allowed to call the endpoint. */
  allowedOrigins?: string[];
  /** Optional Host header allowlist. */
  allowedHosts?: string[];
  /** Maximum number of in-flight requests, including request-body reads. */
  maxConcurrentRequests?: number;
  /** Maximum number of open subscriptions/listen streams. */
  maxSubscriptions?: number;
  /** Maximum number of concurrent TCP connections. */
  maxConnections?: number;
  /** Hard cap on a POST body in bytes. */
  maxBodyBytes?: number;
  /** Deadline for reading a POST body. */
  bodyTimeoutMs?: number;
  /** Deadline for receiving complete request headers. */
  headersTimeoutMs?: number;
  /** Finite request deadline for slow/partial requests. */
  requestTimeoutMs?: number;
  /** SSE keepalive interval for subscriptions/listen and streamed responses. */
  keepAliveMs?: number;
  /** Factory for the per-request MCP server. Defaults to a read-only Neo server. */
  createMcpServer?: () => NeoMcpServer;
}

class BodyReadError extends Error {
  constructor(
    readonly statusCode: number,
    readonly jsonRpcCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'BodyReadError';
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '[::1]';
}

export function resolveMcpHttpBearer(
  host: string,
  bearerToken: string | undefined,
): string | undefined {
  if (isLoopbackHost(host)) {
    return bearerToken;
  }
  if (!bearerToken) {
    throw new Error('MCP_HTTP_BEARER is required when MCP_HTTP_HOST is not a loopback address');
  }
  if (Buffer.byteLength(bearerToken, 'utf8') < MIN_REMOTE_BEARER_BYTES) {
    throw new Error(
      `MCP_HTTP_BEARER must contain at least ${MIN_REMOTE_BEARER_BYTES} bytes when MCP_HTTP_HOST is not a loopback address`,
    );
  }
  return bearerToken;
}

function normalizeOrigin(origin: string): string {
  const parsed = new URL(origin);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`Invalid origin: ${origin}`);
  }
  return parsed.origin;
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function requireNonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function readHeader(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isJsonContentType(value: string | undefined): boolean {
  return value?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

function normalizePeerAddress(value: string | undefined): string {
  if (!value) return '';
  return value.startsWith('::ffff:') ? value.slice(7) : value;
}

function firstForwardedAddress(value: string | undefined): string {
  return value?.split(',', 1)[0]?.trim() ?? '';
}

/**
 * Resolve the source identity only at the trusted listener boundary. Forwarded
 * headers are trusted solely when the TCP peer is loopback (the production
 * nginx layout); a direct remote client cannot choose its own bucket.
 */
function deriveRateLimitKey(req: http.IncomingMessage): string {
  const peer = normalizePeerAddress(req.socket.remoteAddress);
  const forwarded = isLoopbackHost(peer)
    ? readHeader(req, 'cf-connecting-ip')
      || readHeader(req, 'x-real-ip')
      || firstForwardedAddress(readHeader(req, 'x-forwarded-for'))
    : '';
  const source = forwarded || peer || 'unknown-client';
  return createHash('sha256').update(source).digest('hex').slice(0, 24);
}

function rateLimitKeyFromContext(ctx: McpRequestContext): string {
  return ctx.requestInfo?.headers.get(INTERNAL_RATE_LIMIT_HEADER) || 'unknown-client';
}

/**
 * Modern-only, stateless MCP HTTP server.
 */
export class McpHttpServer {
  private readonly port: number;
  private readonly host: string;
  private readonly path: string;
  private readonly bearerToken?: string;
  private readonly allowedOrigins: string[];
  private readonly allowedHosts: string[];
  private readonly maxConcurrentRequests: number;
  private readonly maxConnections: number;
  private readonly maxBodyBytes: number;
  private readonly bodyTimeoutMs: number;
  private readonly headersTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly createMcpServer: () => NeoMcpServer;
  private readonly mcpHandler: McpHttpHandler;
  private readonly nodeHandler: NodeMcpRequestHandler;

  private httpServer: http.Server | null = null;
  private boundPort: number | null = null;
  private activeRequests = 0;

  constructor(options: McpHttpServerOptions = {}) {
    const port = options.port ?? DEFAULT_MCP_HTTP_PORT;
    if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
      throw new Error(`Invalid MCP HTTP port: ${options.port}`);
    }
    const host = options.host?.trim() || DEFAULT_MCP_HTTP_HOST;
    const path = options.path?.trim() || DEFAULT_MCP_HTTP_PATH;
    if (!path.startsWith('/') || (path.length > 1 && path.endsWith('/'))) {
      throw new Error(`Invalid MCP HTTP path: ${path}. Use an absolute path without a trailing slash.`);
    }
    if (path === HEALTH_PATH) {
      throw new Error(`Invalid MCP HTTP path: ${path} is reserved for the health endpoint.`);
    }

    this.port = port;
    this.host = host;
    this.path = path;
    this.bearerToken = resolveMcpHttpBearer(host, options.bearerToken);
    this.allowedOrigins = (options.allowedOrigins ?? []).map((origin) => {
      try {
        return normalizeOrigin(origin);
      } catch {
        throw new Error(
          `Invalid MCP_HTTP_ALLOWED_ORIGINS entry "${origin}". Use comma-separated HTTP/HTTPS origins.`,
        );
      }
    });
    this.allowedHosts = (options.allowedHosts ?? [])
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    this.maxConcurrentRequests = requirePositiveInteger(
      options.maxConcurrentRequests ?? DEFAULT_MCP_HTTP_MAX_CONCURRENT_REQUESTS,
      'maxConcurrentRequests',
    );
    this.maxConnections = requirePositiveInteger(
      options.maxConnections ?? Math.max(MIN_MAX_CONNECTIONS, this.maxConcurrentRequests * 4),
      'maxConnections',
    );
    this.maxBodyBytes = requirePositiveInteger(
      options.maxBodyBytes ?? DEFAULT_MCP_HTTP_MAX_BODY_BYTES,
      'maxBodyBytes',
    );
    this.bodyTimeoutMs = requirePositiveInteger(
      options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS,
      'bodyTimeoutMs',
    );
    this.headersTimeoutMs = requirePositiveInteger(
      options.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS,
      'headersTimeoutMs',
    );
    this.requestTimeoutMs = requirePositiveInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    );
    const maxSubscriptions = requirePositiveInteger(
      options.maxSubscriptions ?? DEFAULT_MCP_HTTP_MAX_SUBSCRIPTIONS,
      'maxSubscriptions',
    );
    const keepAliveMs = requireNonNegativeInteger(
      options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS,
      'keepAliveMs',
    );
    this.createMcpServer = options.createMcpServer ?? createReadOnlyNeoServer;

    this.mcpHandler = createMcpHandler(
      (ctx) => {
        const neoServer = this.createMcpServer();
        neoServer.bindRateLimitClientId(rateLimitKeyFromContext(ctx));
        return neoServer.getProtocolServer();
      },
      {
        legacy: 'reject',
        responseMode: 'auto',
        maxSubscriptions,
        keepAliveMs,
        onerror: (error) => logger.warn('MCP 2026 protocol request rejected', {
          error: error.message,
        }),
      },
    );
    this.nodeHandler = toNodeHandler({
      fetch: async (request, options) => rejectOversizedToolInput(
        request,
        options?.parsedBody,
        MCP_PROTOCOL_VERSION,
      ) ?? this.mcpHandler.fetch(request, options),
    }, {
      onerror: (error) => logger.error('MCP Node adapter error', { error: error.message }),
    });
  }

  get address(): number | null {
    return this.boundPort;
  }

  get endpointPath(): string {
    return this.path;
  }

  get activeRequestCount(): number {
    return this.activeRequests;
  }

  async start(): Promise<number> {
    if (this.httpServer) {
      throw new Error('The MCP HTTP server is already started');
    }

    const server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    server.requestTimeout = this.requestTimeoutMs;
    server.headersTimeout = this.headersTimeoutMs;
    server.maxConnections = this.maxConnections;

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.removeListener('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(this.port, this.host);
      });
    } catch (error) {
      server.close();
      throw error;
    }

    server.on('error', (error) => {
      logger.error('MCP HTTP server error', { error: errorMessage(error) });
    });
    this.httpServer = server;
    this.boundPort = (server.address() as AddressInfo).port;

    logger.info('MCP 2026-07-28 stateless HTTP transport listening', {
      port: this.boundPort,
      host: this.host,
      path: this.path,
      authenticated: Boolean(this.bearerToken),
      maxConcurrentRequests: this.maxConcurrentRequests,
    });
    return this.boundPort;
  }

  async stop(): Promise<void> {
    const server = this.httpServer;
    this.httpServer = null;
    this.boundPort = null;

    await this.mcpHandler.close();
    if (!server) return;

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    logger.info('MCP stateless HTTP transport stopped');
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const method = (req.method ?? 'GET').toUpperCase();
      const requestPath = new URL(req.url ?? '/', 'http://mcp.invalid').pathname;
      const origin = readHeader(req, 'origin');

      if (!this.isHostAllowed(readHeader(req, 'host'))) {
        this.sendJsonRpcError(res, 403, JSON_RPC_INTERNAL_ERROR, 'Forbidden: host not allowed', true);
        return;
      }
      if (!this.isOriginAllowed(origin)) {
        this.sendJsonRpcError(res, 403, JSON_RPC_INTERNAL_ERROR, 'Forbidden: origin not allowed', true);
        return;
      }
      this.applyCorsHeaders(res, origin);

      if (method === 'OPTIONS') {
        res.writeHead(204, {
          Allow: ALLOWED_METHODS,
          'Access-Control-Allow-Methods': ALLOWED_METHODS,
          'Access-Control-Allow-Headers': ALLOWED_REQUEST_HEADERS,
          'Access-Control-Max-Age': String(PREFLIGHT_MAX_AGE_SECONDS),
        });
        res.end();
        return;
      }

      if (requestPath === HEALTH_PATH) {
        if (method !== 'GET') {
          this.sendMethodNotAllowed(res, 'GET, OPTIONS');
          return;
        }
        this.sendJson(res, 200, {
          status: 'ok',
          version: SERVER_VERSION,
          protocolVersion: MCP_PROTOCOL_VERSION,
          protocolEra: 'modern',
          stateless: true,
          activeRequests: this.activeRequests,
        });
        return;
      }

      if (requestPath !== this.path) {
        this.sendJsonRpcError(res, 404, JSON_RPC_INTERNAL_ERROR, 'Not Found', true);
        return;
      }
      if (!this.isAuthorized(readHeader(req, 'authorization'))) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="neo-mcp"');
        this.sendJsonRpcError(res, 401, JSON_RPC_INTERNAL_ERROR, 'Unauthorized', true);
        return;
      }
      if (method !== 'POST') {
        this.sendMethodNotAllowed(res, ALLOWED_METHODS);
        return;
      }
      if (!isJsonContentType(readHeader(req, 'content-type'))) {
        this.sendJsonRpcError(
          res,
          415,
          JSON_RPC_INVALID_REQUEST,
          'Unsupported Media Type: Content-Type must be application/json',
          true,
        );
        return;
      }
      if (this.activeRequests >= this.maxConcurrentRequests) {
        this.sendJsonRpcError(
          res,
          503,
          JSON_RPC_INTERNAL_ERROR,
          'Server request capacity reached',
          true,
        );
        return;
      }

      this.activeRequests += 1;
      try {
        const body = await this.readJsonBody(req);
        req.headers[INTERNAL_RATE_LIMIT_HEADER] = deriveRateLimitKey(req);
        await this.nodeHandler(req, res, body);
      } finally {
        this.activeRequests -= 1;
      }
    } catch (error) {
      if (error instanceof BodyReadError) {
        this.sendJsonRpcError(res, error.statusCode, error.jsonRpcCode, error.message, true);
        return;
      }
      logger.error('MCP HTTP request failed', { error: errorMessage(error) });
      this.sendJsonRpcError(res, 500, JSON_RPC_INTERNAL_ERROR, 'Internal server error');
    }
  }

  private isAuthorized(authorization: string | undefined): boolean {
    if (!this.bearerToken) return true;
    if (!authorization) return false;

    const match = /^Bearer[ \t]+(\S+)$/i.exec(authorization.trim());
    if (!match) return false;

    const provided = Buffer.from(match[1], 'utf8');
    const expected = Buffer.from(this.bearerToken, 'utf8');
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }

  private isOriginAllowed(origin: string | undefined): boolean {
    if (!origin) return true;
    try {
      return this.allowedOrigins.includes(normalizeOrigin(origin));
    } catch {
      return false;
    }
  }

  private isHostAllowed(host: string | undefined): boolean {
    if (this.allowedHosts.length === 0) return true;
    if (!host) return false;
    const normalized = host.trim().toLowerCase();
    if (this.allowedHosts.includes(normalized)) return true;
    try {
      const hostname = new URL(`http://${normalized}`).hostname.toLowerCase();
      return this.allowedHosts.includes(hostname);
    } catch {
      return false;
    }
  }

  private applyCorsHeaders(res: http.ServerResponse, origin: string | undefined): void {
    res.setHeader('Vary', 'Origin');
    if (origin && this.allowedOrigins.length > 0) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
  }

  private readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const declaredLength = Number(readHeader(req, 'content-length'));
      if (Number.isSafeInteger(declaredLength) && declaredLength > this.maxBodyBytes) {
        reject(new BodyReadError(413, JSON_RPC_INVALID_REQUEST, 'Payload Too Large'));
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const timer = setTimeout(() => {
        fail(new BodyReadError(408, JSON_RPC_INTERNAL_ERROR, 'Request Timeout: body was not received in time'));
      }, this.bodyTimeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        req.removeListener('data', onData);
        req.removeListener('end', onEnd);
        req.removeListener('error', onError);
      };
      const fail = (error: BodyReadError) => {
        if (settled) return;
        settled = true;
        cleanup();
        req.pause();
        reject(error);
      };
      const onData = (chunk: Buffer) => {
        size += chunk.length;
        if (size > this.maxBodyBytes) {
          fail(new BodyReadError(413, JSON_RPC_INVALID_REQUEST, 'Payload Too Large'));
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = () => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new BodyReadError(400, JSON_RPC_PARSE_ERROR, 'Parse error: Invalid JSON'));
        }
      };
      const onError = (error: Error) => {
        fail(new BodyReadError(400, JSON_RPC_INVALID_REQUEST, `Bad Request: ${error.message}`));
      };

      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onError);
    });
  }

  private sendMethodNotAllowed(res: http.ServerResponse, allow: string): void {
    res.setHeader('Allow', allow);
    this.sendJsonRpcError(res, 405, JSON_RPC_INVALID_REQUEST, 'Method Not Allowed', true);
  }

  private sendJsonRpcError(
    res: http.ServerResponse,
    statusCode: number,
    code: number,
    message: string,
    closeConnection = false,
  ): void {
    this.sendJson(res, statusCode, {
      jsonrpc: '2.0',
      error: { code, message },
      id: null,
    }, closeConnection);
  }

  private sendJson(
    res: http.ServerResponse,
    statusCode: number,
    payload: unknown,
    closeConnection = false,
  ): void {
    if (res.writableEnded || res.headersSent) return;

    const body = JSON.stringify(payload);
    const headers: Record<string, string | number> = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    };
    if (closeConnection) headers.Connection = 'close';
    res.writeHead(statusCode, headers);
    res.end(body);
    if (closeConnection) res.socket?.end();
  }
}

/**
 * Pin writes off synchronously while constructing the remotely reachable
 * server. The HTTP tool surface remains non-custodial and read-only regardless
 * of `NEO_ENABLE_WRITES`.
 */
export function withWritesDisabled<T>(construct: () => T): T {
  const previousWritesEnabled = config.writes.enabled;
  config.writes.enabled = false;
  try {
    return construct();
  } finally {
    config.writes.enabled = previousWritesEnabled;
  }
}

function createReadOnlyNeoServer(): NeoMcpServer {
  return withWritesDisabled(() => new NeoMcpServer());
}

function readIntEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid ${key} "${raw}". Must be a positive integer.`);
  }
  return value;
}

function readNonNegativeIntEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${key} "${raw}". Must be a non-negative integer.`);
  }
  return value;
}

export function resolveMcpHttpOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): McpHttpServerOptions {
  const rawPort = env.MCP_HTTP_PORT?.trim();
  let port = DEFAULT_MCP_HTTP_PORT;
  if (rawPort) {
    const parsed = Number(rawPort);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
      throw new Error(`Invalid MCP_HTTP_PORT "${rawPort}". Must be an integer between 0 and 65535.`);
    }
    port = parsed;
  }

  return {
    port,
    host: env.MCP_HTTP_HOST?.trim() || DEFAULT_MCP_HTTP_HOST,
    path: env.MCP_HTTP_PATH?.trim() || DEFAULT_MCP_HTTP_PATH,
    bearerToken: env.MCP_HTTP_BEARER?.trim() || undefined,
    allowedOrigins: (env.MCP_HTTP_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    allowedHosts: (env.MCP_HTTP_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
    maxConcurrentRequests: readIntEnv(
      env,
      'MCP_HTTP_MAX_CONCURRENT_REQUESTS',
      DEFAULT_MCP_HTTP_MAX_CONCURRENT_REQUESTS,
    ),
    maxSubscriptions: readIntEnv(
      env,
      'MCP_HTTP_MAX_SUBSCRIPTIONS',
      DEFAULT_MCP_HTTP_MAX_SUBSCRIPTIONS,
    ),
    maxBodyBytes: readIntEnv(
      env,
      'MCP_HTTP_MAX_BODY_BYTES',
      DEFAULT_MCP_HTTP_MAX_BODY_BYTES,
    ),
    bodyTimeoutMs: readIntEnv(env, 'MCP_HTTP_BODY_TIMEOUT_MS', DEFAULT_BODY_TIMEOUT_MS),
    headersTimeoutMs: readIntEnv(env, 'MCP_HTTP_HEADERS_TIMEOUT_MS', DEFAULT_HEADERS_TIMEOUT_MS),
    requestTimeoutMs: readIntEnv(env, 'MCP_HTTP_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS),
    keepAliveMs: readNonNegativeIntEnv(env, 'MCP_HTTP_KEEP_ALIVE_MS', DEFAULT_KEEP_ALIVE_MS),
  };
}
