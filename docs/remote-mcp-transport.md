# Remote MCP 2026-07-28 Transport

The remote entrypoint supports only MCP `2026-07-28`. It intentionally rejects
the removed initialization and session protocol. There is no compatibility
mode, `Mcp-Session-Id`, or legacy SDK endpoint.

## Entrypoints

| Entrypoint | Command | Protocol | Listener |
| --- | --- | --- | --- |
| MCP stdio | `npm start` | MCP 2026-07-28 over stdio | none |
| MCP HTTP | `npm run start:mcp-http` | MCP 2026-07-28 over stateless HTTP | `127.0.0.1:3001` |
| REST API | `npm run start:http` | Project-specific REST/JSON, not MCP | `127.0.0.1:3000` |

Each MCP request is self-contained. The server creates request-scoped protocol
state, so replicas do not need sticky sessions or a shared session store.

## Endpoints

`MCP_HTTP_PATH` defaults to `/mcp`.

| Method | Path | Purpose | Auth |
| --- | --- | --- | --- |
| `POST` | `/mcp` | `server/discover`, tool, resource, prompt, and subscription requests | Bearer when configured |
| `OPTIONS` | `/mcp` | Browser CORS preflight | None |
| `GET` | `/healthz` | Process liveness and protocol metadata | None |

`GET`, `PUT`, `PATCH`, and `DELETE` on `/mcp` return `405`. The liveness
endpoint exposes no credentials or blockchain data.

## JavaScript Client

Use the split v2 package and pin the protocol version:

```js
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

const transport = new StreamableHTTPClientTransport(
  new URL('https://mcp.n3index.dev/mcp'),
  {
    authProvider: {
      token: async () => process.env.NEOX_MCP_BEARER,
    },
  },
);

const client = new Client(
  { name: 'neo-explorer', version: '2.0.0' },
  {
    protocolVersion: '2026-07-28',
    enforceStrictCapabilities: true,
    inputRequired: { autoFulfill: false },
  },
);

await client.connect(transport);
const tools = await client.listTools();
const height = await client.callTool({
  name: 'get_block_count',
  arguments: { network: 'mainnet' },
});
await client.close();
```

Remote Explorer access has no chain-write capability. The optional
`request_account_watch` action can only send a double-opt-in verification email
through a fixed, authenticated Explorer endpoint. A client must not auto-approve
`input_required` requests from an untrusted source.

## Raw Discovery Request

MCP 2026 uses `server/discover`; it does not use `initialize`:

```bash
curl -sS https://mcp.n3index.dev/mcp \
  -H "Authorization: Bearer $NEOX_MCP_BEARER" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: server/discover' \
  --data '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "server/discover",
    "params": {
      "_meta": {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": {
          "name": "curl-audit",
          "version": "1.0.0"
        },
        "io.modelcontextprotocol/clientCapabilities": {}
      }
    }
  }'
```

The response reports server capabilities and protocol metadata without issuing
a session identifier.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_HTTP_PORT` | `3001` | Listener port |
| `MCP_HTTP_HOST` | `127.0.0.1` | Listener address |
| `MCP_HTTP_PATH` | `/mcp` | MCP POST path |
| `MCP_HTTP_BEARER` | unset | Shared bearer; required for non-loopback binds and at least 32 bytes there |
| `MCP_HTTP_ALLOWED_ORIGINS` | empty | Exact browser-origin allowlist |
| `MCP_HTTP_ALLOWED_HOSTS` | empty | Optional Host-header allowlist |
| `MCP_HTTP_MAX_CONCURRENT_REQUESTS` | `128` | In-flight request cap |
| `MCP_HTTP_MAX_SUBSCRIPTIONS` | `128` | Concurrent `subscriptions/listen` cap |
| `MCP_HTTP_MAX_BODY_BYTES` | `4194304` | Maximum request body |
| `MCP_HTTP_BODY_TIMEOUT_MS` | `30000` | Request-body deadline |
| `MCP_HTTP_HEADERS_TIMEOUT_MS` | `30000` | Header deadline |
| `MCP_HTTP_REQUEST_TIMEOUT_MS` | `300000` | Whole-request deadline |
| `MCP_HTTP_KEEP_ALIVE_MS` | `15000` | Subscription keepalive interval; `0` disables it |
| `EXPLORER_ACCOUNT_WATCH_ENABLED` | `false` | Enable the double-opt-in account Watch request action |
| `EXPLORER_ACCOUNT_WATCH_API_URL` | `https://www.neo3scan.com/api/account-watches` | Fixed Explorer Watch endpoint |
| `EXPLORER_ACCOUNT_WATCH_API_TOKEN` | unset | Dedicated 32-byte-or-longer bearer required when Watch is enabled |

An incoming `Origin` is rejected unless it is on the exact allowlist. Server
clients normally omit `Origin`. The bearer is compared in constant time.

The process also uses shared Neo RPC, logging, and rate-limit configuration.
Keep `NEO_ENABLE_WRITES=false` on the public remote deployment.
The Watch API token must differ from `MCP_HTTP_BEARER` and `HTTP_API_KEY`.

## Write Approval

Private deployments may enable writes only with all required signer,
idempotency, and approval controls. MCP writes use the 2026 multi-round-trip
`input_required` result:

1. The server returns the exact transaction intent and a signed, expiring
   `requestState`.
2. The client presents that intent to the human.
3. The client re-enters the same `tools/call` with `inputResponse`.
4. The server verifies the signature, expiry, method binding, intent ID,
   network, operation, and canonical fingerprint before broadcasting.

Set `NEO_MCP_REQUEST_STATE_KEY` to an independent random value of at least 32
bytes. It must differ from `MCP_HTTP_BEARER`, `HTTP_API_KEY`, and
`HTTP_WRITE_APPROVAL_API_KEY`. No legacy form-elicitation fallback exists.

## Reverse Proxy

Terminate TLS at nginx or another trusted proxy and keep the Node listener on
loopback. Preserve these request headers:

- `Authorization`
- `Content-Type`
- `Accept`
- `MCP-Protocol-Version`
- `Mcp-Method`
- `Mcp-Name`

Use a read timeout of at least 300 seconds for ordinary calls. For
`subscriptions/listen`, disable response buffering and allow a long-lived
stream. Horizontal replicas can use normal load balancing because requests do
not depend on process-local session state.

## Explorer Integration

The Neo Explorer serverless API reads:

```bash
NEOX_MCP_URL=https://mcp.n3index.dev/mcp
NEOX_MCP_BEARER=<same secret as MCP_HTTP_BEARER>
```

The bearer remains server-side. `api/lib/mcpClient.js` pins MCP `2026-07-28`,
uses strict capability checks, refuses automatic input approval, and caches
tool definitions only within a live connection.

## Troubleshooting

| Symptom | Meaning |
| --- | --- |
| `401` | Bearer is missing or mismatched |
| `403` | Origin or Host is not allowed |
| `405` | A removed HTTP method such as `GET /mcp` or `DELETE /mcp` was used |
| `408` | Body or request deadline elapsed |
| `413` | Request body exceeded `MCP_HTTP_MAX_BODY_BYTES` |
| `503` | Per-process concurrent request/subscription capacity is exhausted |
| JSON-RPC `-32022` | Client attempted a removed protocol era, usually `initialize` |
| JSON-RPC `-32020` | MCP routing headers disagree with the JSON-RPC method/name |

Do not recover from these errors by retrying an older protocol. Upgrade the
client to the v2 SDK and MCP `2026-07-28`.
