[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/r3e-network-neo-mcp-badge.png)](https://mseep.ai/app/r3e-network-neo-mcp)

# Neo MCP Server

`@r3e/neo-mcp` is an MCP server for Neo N3 blockchain queries and controlled, auditable transaction submission. It ships three entrypoints:

| Entrypoint | Command | Protocol |
| --- | --- | --- |
| MCP stdio | `npm start` | MCP over stdin/stdout, for local clients such as Claude Desktop and Cursor |
| MCP HTTP | `npm run start:mcp-http` | MCP 2026-07-28 stateless HTTP, for remote MCP clients |
| REST API | `npm run start:http` | Bespoke REST/JSON; not an MCP transport |

The two HTTP servers are unrelated and configured separately. See [Remote MCP 2026 HTTP](#remote-mcp-2026-http) and [docs/remote-mcp-transport.md](./docs/remote-mcp-transport.md).

Current version: `4.1.0`. Node.js `>=22` is required. Version 4 speaks only
MCP `2026-07-28`; clients using the removed initialization/session protocol are
rejected rather than downgraded.

## Quick Start

Install and run the MCP stdio server:

```bash
npm install -g @r3e/neo-mcp
neo-mcp
```

Or run it without a global install:

```bash
npx -y @r3e/neo-mcp
```

Example Claude Desktop or Cursor configuration:

```json
{
  "mcpServers": {
    "neo-n3": {
      "command": "npx",
      "args": ["-y", "@r3e/neo-mcp"],
      "env": {
        "NEO_NETWORK": "testnet",
        "NEO_TESTNET_RPC": "https://testnet1.neo.coz.io:443",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

## Programmatic API

The package root exports the MCP server, HTTP server, services, network enums, and validated configuration:

```ts
import { NeoNetwork, NeoService } from '@r3e/neo-mcp';

const neo = new NeoService(
  'https://testnet1.neo.coz.io:443',
  NeoNetwork.TESTNET,
);

const blockCount = await neo.getBlockCount();
console.log({ blockCount, height: Math.max(0, blockCount - 1) });
```

`NeoMcpServer` exposes `run()` and `close()` for applications that manage the stdio transport lifecycle themselves.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `NEO_NETWORK` | `mainnet`, `testnet`, or `both`; HTTP requires one network | `both` |
| `NEO_MAINNET_RPC` | Mainnet RPC endpoint | `https://mainnet1.neo.coz.io:443` |
| `NEO_TESTNET_RPC` | Testnet RPC endpoint | `https://testnet1.neo.coz.io:443` |
| `NEO_RPC_TIMEOUT_MS` | Per-operation Neo RPC deadline in milliseconds | `15000` |
| `NEO_ALLOW_INSECURE_RPC` | Allow a remote plaintext HTTP RPC URL | `false` |
| `NEO_MAX_TRANSACTION_FEE_GAS` | Maximum combined system and network fee for a signed transaction, in GAS | `20` |
| `NEO_ENABLE_WRITES` | Register state-changing tools and HTTP routes | `false` |
| `NEO_SIGNER_WIF_FILE` | Owner-only regular file containing the single server signer WIF | required for writes |
| `NEO_WRITE_STATE_DIR` | Durable idempotency journal directory | `$WALLETS_DIR/.write-operations` |
| `NEO_MCP_REQUEST_STATE_KEY` | Independent HMAC key for MCP multi-round-trip approval state | required for writes |
| `HTTP_WRITE_APPROVAL_API_KEY` | Independent bearer token for HTTP write approval | required for writes |
| `NEO_ENABLE_WALLET_ADMIN` | Enable HTTP wallet create/import administration | `false` |
| `N3INDEX_API_BASE_URL` | Remote contract name lookup base URL | `https://api.n3index.dev` |
| `N3INDEX_ENABLED` | Enable N3Index-backed name resolution | `true` |
| `EXPLORER_ACCOUNT_WATCH_ENABLED` | Enable the double-opt-in Explorer account Watch request tool | `false` |
| `EXPLORER_ACCOUNT_WATCH_API_URL` | Fixed Explorer Watch API endpoint | `https://www.neo3scan.com/api/account-watches` |
| `EXPLORER_ACCOUNT_WATCH_API_TOKEN` | Dedicated bearer for the Explorer Watch API; must differ from MCP/REST bearers | required when enabled |
| `HTTP_HOST` | REST API listen address | `127.0.0.1` |
| `HTTP_API_KEY` | Bearer token for REST API routes | unset |
| `HTTP_CORS_ORIGINS` | Comma-separated exact HTTP/HTTPS origins | empty |
| `HTTP_MAX_BODY_BYTES` | Maximum HTTP request body size | `1048576` (1 MiB) |
| `MCP_HTTP_PORT` | Remote MCP transport listen port | `3001` |
| `MCP_HTTP_HOST` | Remote MCP transport listen address | `127.0.0.1` |
| `MCP_HTTP_PATH` | Remote MCP endpoint path | `/mcp` |
| `MCP_HTTP_BEARER` | Bearer token for the remote MCP endpoint; required unless `MCP_HTTP_HOST` is loopback | unset |
| `MCP_HTTP_ALLOWED_ORIGINS` | Comma-separated exact origins allowed to connect from a browser | empty |
| `MCP_HTTP_MAX_CONCURRENT_REQUESTS` | Concurrent in-flight MCP request cap | `128` |
| `MCP_HTTP_MAX_SUBSCRIPTIONS` | Concurrent `subscriptions/listen` stream cap | `128` |
| `MCP_HTTP_MAX_BODY_BYTES` | Maximum MCP POST body size | `4194304` (4 MiB) |
| `MCP_HTTP_BODY_TIMEOUT_MS` | Deadline for receiving an MCP request body | `30000` |
| `MCP_HTTP_HEADERS_TIMEOUT_MS` | Deadline for receiving MCP headers | `30000` |
| `MCP_HTTP_REQUEST_TIMEOUT_MS` | Overall MCP HTTP request deadline | `300000` |
| `MCP_HTTP_KEEP_ALIVE_MS` | SSE keepalive interval; `0` disables it | `15000` |
| `WALLETS_DIR` | Directory for persisted encrypted wallet records | `./wallets` |
| `RATE_LIMITING_ENABLED` | Enable request rate limiting | enabled outside test environments |
| `MAX_REQUESTS_PER_MINUTE` | Per-client minute limit | `60` |
| `MAX_REQUESTS_PER_HOUR` | Per-client hour limit | `1000` |
| `LOG_LEVEL` | `debug`, `info`, `warn`, or `error` | `info` |
| `LOG_CONSOLE` | Enable console logging | enabled outside test environments |
| `LOG_FILE` | Log file path; setting it enables file logging | `./logs/neo-mcp.log` |
| `LOG_FILE_ENABLED` | Enable file logging without setting `LOG_FILE` | `false` |
| `PORT` | HTTP listen port | `3000` |

The aliases `NEO_MAINNET_RPC_URL`, `NEO_TESTNET_RPC_URL`, and `NEO_NETWORK_MODE` remain supported.

Remote RPC endpoints must use HTTPS. Plain HTTP is accepted for loopback RPC endpoints; setting `NEO_ALLOW_INSECURE_RPC=true` explicitly permits remote plaintext HTTP and should be limited to controlled development environments.

When `NEO_NETWORK=both`, read-only MCP calls without an explicit network use mainnet. Every state-changing call requires an explicit network and an idempotency key. The HTTP entrypoint rejects `both`; set `NEO_NETWORK=mainnet` or `NEO_NETWORK=testnet`.

Writes are disabled by default. To enable them, create an owner-only signer file outside the repository and configure durable state:

```bash
install -m 0600 /dev/stdin /run/secrets/neo-signer-wif
export NEO_ENABLE_WRITES=true
export NEO_SIGNER_WIF_FILE=/run/secrets/neo-signer-wif
export NEO_WRITE_STATE_DIR=/var/lib/neo-mcp/write-operations
export NEO_MCP_REQUEST_STATE_KEY="$(openssl rand -hex 32)"
export HTTP_WRITE_APPROVAL_API_KEY="$(openssl rand -hex 32)"
```

The MCP and HTTP request schemas never accept WIFs, private keys, or passwords.
MCP writes use the `2026-07-28` `input_required` flow. The server signs the
opaque `requestState`, binds it to `tools/call`, expires it after ten minutes,
and executes only after the re-entered response accepts the exact intent
fingerprint. HTTP writes return a pending intent and require a separate approval
request authenticated by `HTTP_WRITE_APPROVAL_API_KEY`.

Account intelligence remains evidence-first: `analyze_account_graph` exposes
the replayable, network-scoped transfer graph and curated metadata only. The
backend's deterministic exchange-sweep, coordinated-signer,
community-affinity, and graph-similarity detector queue is deliberately not
exposed as public identity data; pending candidates require human review before
they can become curated metadata.

As of 2026-08-01, both production network detector timers have completed their
detector rerun successfully. The resulting pending queue is operational review
evidence only and is not returned by `analyze_account_graph`.

## HTTP API

This is a bespoke REST/JSON API, not an MCP transport. MCP clients cannot connect to it; they use the stdio entrypoint or the [remote MCP transport](#remote-mcp-over-streamable-http).

Build and start the HTTP entrypoint:

```bash
npm ci
npm run build
export HTTP_API_KEY="$(openssl rand -hex 32)"
NEO_NETWORK=mainnet npm run start:http
```

The server listens on `127.0.0.1:3000` by default. A non-loopback `HTTP_HOST` requires `HTTP_API_KEY`, and every configured API key must contain at least 32 bytes. When a key is configured, send it as a bearer token on every route except `GET /live` and `GET /health`:

```bash
curl http://127.0.0.1:3000/live
curl http://127.0.0.1:3000/health
curl -H "Authorization: Bearer $HTTP_API_KEY" \
  http://127.0.0.1:3000/api/blockchain/height
```

The HTTP listener does not terminate TLS. Plaintext HTTP is supported only on loopback or a trusted host-local proxy network. Remote clients must use HTTPS through a TLS-terminating reverse proxy or load balancer; direct remote plaintext HTTP is unsupported because bearer tokens traverse requests.

The height endpoint distinguishes the node's block count from the latest block index:

```json
{
  "blockCount": 12346,
  "height": 12345
}
```

`HTTP_CORS_ORIGINS` is an optional exact-origin allowlist. For example:

```bash
HTTP_CORS_ORIGINS=https://console.example.com,https://admin.example.com
```

Origins must use HTTP or HTTPS and cannot contain paths, credentials, query strings, or fragments. Wildcard CORS is not supported.

POST and PUT bodies must be JSON objects. The default body limit is 1 MiB and can be changed with `HTTP_MAX_BODY_BYTES`. A write request creates an immutable pending intent:

```bash
curl -X POST http://127.0.0.1:3000/api/transfers \
  -H "Authorization: Bearer $HTTP_API_KEY" \
  -H "Idempotency-Key: transfer-2026-07-11-001" \
  -H 'Content-Type: application/json' \
  -d '{"network":"mainnet","toAddress":"Nb...","asset":"NEO","amount":"1"}'
```

Approve only after comparing the returned fingerprint with the intended request:

```bash
curl -X POST http://127.0.0.1:3000/api/write-intents/INTENT_ID/approve \
  -H "Authorization: Bearer $HTTP_WRITE_APPROVAL_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"fingerprint":"RETURNED_64_HEX_FINGERPRINT"}'
```

See [API.md](./docs/API.md) for the tool and route reference.

## Remote MCP 2026 HTTP

The stateless MCP 2026-07-28 HTTP transport serves the same non-custodial MCP
surface as the stdio entrypoint to remote clients. It is a separate process from the
REST API, listens on its own port, and has its own configuration and bearer
token. The only default external side effect is `request_account_watch`, which
is disabled unless explicitly configured and can only send a double-opt-in
verification message; it cannot activate a subscription.

```bash
npm ci
npm run build
export MCP_HTTP_BEARER="$(openssl rand -hex 32)"
NEO_NETWORK=mainnet npm run start:mcp-http
```

The server listens on `127.0.0.1:3001` by default and exposes:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `MCP_HTTP_PATH` (default `/mcp`) | Stateless MCP `2026-07-28` requests such as `server/discover`, `tools/list`, and `tools/call` |
| `OPTIONS` | `MCP_HTTP_PATH` | CORS preflight |
| `GET` | `/healthz` | Unauthenticated liveness probe |

A non-loopback `MCP_HTTP_HOST` requires `MCP_HTTP_BEARER` and rejects a token shorter than 32 bytes, mirroring the `HTTP_API_KEY` rule for the REST entrypoint. When a token is configured, clients send `Authorization: Bearer <token>` on every request to `MCP_HTTP_PATH`; `/healthz` stays unauthenticated so probes can reach it.

Connect with the MCP TypeScript SDK:

```js
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3001/mcp'), {
  authProvider: { token: async () => process.env.MCP_HTTP_BEARER },
});
const client = new Client(
  { name: 'my-client', version: '2.0.0' },
  {
    capabilities: {},
    versionNegotiation: { mode: { pin: '2026-07-28' } },
  },
);
await client.connect(transport);
const { tools } = await client.listTools();
```

Like the REST listener, this listener serves plaintext HTTP and does not
terminate TLS. Remote clients must reach it through a TLS-terminating reverse
proxy. Requests are stateless, so replicas do not need sticky routing.

See [remote-mcp-transport.md](./docs/remote-mcp-transport.md) for the full configuration reference, an end-to-end local run against the Neo Explorer agent, production deployment guidance, and troubleshooting.

## Docker

The production Compose file is `docker/docker-compose.yml`. It defines two services from the same image: `neo-mcp` runs the REST API on port 3000, and `neo-mcp-http` runs the remote MCP transport on port 3001. Each requires its own token, binds the host port to `127.0.0.1` by default, and persists wallet records in its own volume:

```bash
export HTTP_API_KEY="$(openssl rand -hex 32)"
export MCP_HTTP_BEARER="$(openssl rand -hex 32)"
docker compose -f docker/docker-compose.yml up -d
```

Start only the remote MCP service. Compose interpolates the whole file before
selecting a service, so the REST service's mandatory `HTTP_API_KEY` must be set
to any non-empty placeholder even though its container is never started here
(the ">= 32 bytes" check only runs when that container actually starts):

```bash
HTTP_API_KEY=unused-when-starting-only-the-mcp-service \
MCP_HTTP_BEARER="$(openssl rand -hex 32)" \
  docker compose -f docker/docker-compose.yml up -d neo-mcp-http
```

To run a published image instead of building the checkout, use the digest-only registry overlay with the image repository and the release artifact's 64-character lowercase hexadecimal digest:

```bash
NEO_MCP_IMAGE_REPOSITORY=r3enetwork/neo-mcp \
NEO_MCP_IMAGE_DIGEST=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
HTTP_API_KEY="$HTTP_API_KEY" \
MCP_HTTP_BEARER="$MCP_HTTP_BEARER" \
  docker compose -f docker/docker-compose.yml \
    -f docker/docker-compose.registry.yml up -d
```

Set `HTTP_BIND_ADDRESS=0.0.0.0` (REST) or `MCP_HTTP_BIND_ADDRESS=0.0.0.0` (remote MCP) only when the service must be reachable by a TLS-terminating reverse proxy or load balancer. Do not expose either plaintext listener directly to remote clients.

The development Compose file binds locally and supplies local-development tokens by default. It defines `neo-mcp-dev` for the REST API and `neo-mcp-http-dev` for the remote MCP transport:

```bash
docker compose -f docker/docker-compose.dev.yml up -d
```

Those default tokens are for local development only. Override `HTTP_API_KEY` and `MCP_HTTP_BEARER` for any shared environment.

Build and run without Compose:

```bash
npm run docker:build
export HTTP_API_KEY="$(openssl rand -hex 32)"
npm run docker:run -- --detach
```

See [DOCKER.md](./docs/DOCKER.md) for image, volume, and helper-script details.

## MCP Tools and Resources

The default MCP surface exposes 58 non-custodial tools. Every tool that both chains implement takes a required `chain` discriminator, `"n3"` or `"neox"`, with no silent default; single-chain tools reject the chain they do not serve. The `network` parameter is always `"mainnet"` or `"testnet"`; the registry rewrites it for Neo X internally, so callers never spell out a chain-qualified network name.

- Server and data utilities: `get_network_mode`, `get_wallet`, `inspect_neo_value`, `convert_neo_data`, `get_neo_service_info`, `analyze_stablecoins`
- Chain, both chains: `get_chain_info`, `get_block_height`, `get_block`, `get_transaction`, `get_transaction_status`, `get_balance`
- Contracts, both chains: `call_contract`, `get_contract_info`, `simulate_call`
- Construct, both chains: `build_transfer`, `build_contract_call`
- Neo ecosystem reads: `decode_neo_script`, `query_nns`, `query_neofs`, `get_oracle_info`
- Dedicated Neo N3 construct: `build_vote`, `build_nns_operation`
- Explorer and intelligence: `explorer_get_address`, `analyze_address`, `analyze_account_graph`, `analyze_consensus_health`, `analyze_address_connection`, `analyze_transaction`, `investigate_transactions`, `analyze_contract`, `analyze_contract_upgrades`, `get_contract_source_verification`, `inspect_contract_code`, `analyze_neox_transaction`, `analyze_neox_block`, `analyze_neox_address`, `analyze_neox_contract`, `analyze_neox_token`, `explorer_list_address_transactions`, `explorer_list_address_transfers`, `explorer_list_token_holders`, `explorer_search`, `query_explorer`
- Verified notification action: `request_account_watch` sends a cooldown-limited verification message for one explicit Neo N3 network, address, and email. It is non-destructive and idempotent; the watch remains inactive until the recipient confirms in the Explorer.
- Neo N3 only: `get_application_log`, `wait_for_transaction`, `get_unclaimed_gas`, `get_nep17_transfers`, `get_nep11_balances`, `get_nep11_transfers`, `get_contract_status`, `list_famous_contracts`, `estimate_transfer_fees`, `estimate_invoke_fees`, `explorer_list_address_assets`, `query_explorer_find`
- Neo X only: `analyze_neox_transaction`, `analyze_neox_block`, `analyze_neox_address`, `analyze_neox_contract`, `analyze_neox_token`, `query_explorer_graphql`

`call_contract` is strictly read-only: `invokefunction` on Neo N3, `eth_call` on Neo X. The `build_*` tools run the exact read-only simulation and return UNSIGNED transaction proposals for a wallet to review and sign; no default-surface tool holds a key, signs, or broadcasts. `build_vote` pins the native NEO contract, while `build_nns_operation` pins the network-correct NameService contract and operation arguments.

`query_neofs` requires an explicit `network` field. The selected N3 network is preserved as
address context in the result, while the fixed NeoFS gateway remains global; this prevents
the assistant from presenting a mainnet/testnet N3 context as a NeoFS gateway switch.
Constructed N3 and Neo X proposals are returned with an unsigned-only boundary and are
simulated before the Explorer exposes them to a wallet.

### Explorer AI roadmap

The canonical cross-repository plan is maintained in the
[Neo OS Fura AI Plan and Roadmap](https://github.com/r3e-network/neo-os-fura#neo-explorer-ai-plan-and-roadmap).
Neo MCP is the typed orchestration boundary: it exposes deterministic Explorer
evidence and unsigned, simulated proposals to the assistant while keeping
wallet review, signing, and broadcasting outside the hosted MCP service.

`analyze_transaction` is the primary Neo N3 investigation tool. Its v2 response
adds stable evidence IDs, bounded counts, exact grouped fund flows,
conservative failure classification, and code-based findings. Clients should
cite those IDs, preserve exact decimal strings, and disclose when detailed
opcode or storage traces are unavailable.

`investigate_transactions` composes one to twelve confirmed Neo N3
transactions into a deterministic, immutable evidence set. It returns a
block-ordered timeline, complete per-transaction analyses, and observed asset
relationships with source transactions, evidence references, confidence
classes, and the `requested_transactions_only` sampling boundary. It does not
infer shared ownership, causality, hidden calls, or activity outside the set.

`analyze_contract` is the primary Neo N3 contract-intelligence tool. Its v1
response returns network-scoped ABI, Manifest permission and trust, NEF method
token, compiler, update, and source-verification facts with stable evidence
IDs. Clients must keep declared source URLs, `safe=false` ABI methods,
deterministic static findings, verified source, simulation, and vulnerability
claims distinct.

`inspect_contract_code` is the paginated code-inspection companion. It returns
bounded NeoVM operands, resolved syscall names, ABI method ownership, and
static control-flow targets with stable opcode evidence IDs. It is deterministic
disassembly, not a runtime trace, verified source, decompilation, or simulation.

`analyze_contract_upgrades` compares immutable indexed contract artifacts by
update counter. It reports exact `complete` or `partial` historical coverage,
SHA-256 artifact identities, and structural ABI method/event/standard changes.
Missing versions are never synthesized, and storage compatibility remains
`not_determined` because manifest and NEF artifacts cannot prove a storage
layout.

`get_contract_source_verification` returns the immutable reproducibility record
for each verified update counter: source bundle digest, immutable repository
commit, compiler settings, and exact manifest, NEF, binary, and script hashes.
Only a record for the current update counter verifies current code. Exact
artifact equality is not a security audit.

A locally launched stdio server with `NEO_ENABLE_WRITES=true`,
`NEO_SIGNER_WIF_FILE`, and `NEO_MCP_REQUEST_STATE_KEY` registers four
additional Neo N3 tools that sign with that owner-supplied key:
`transfer_assets`, `invoke_contract_write`, `claim_gas`, `deploy_contract`.
They require an `idempotencyKey`, an explicit `network`, a modern client that
can fulfil an embedded form request, and acceptance of the exact returned
intent fingerprint through `input_required`. The MCP HTTP transport is
read-only by design and ignores the setting.

The curated contract list is intentionally empty until each entry has a current network hash and a verified on-chain manifest. Generic contract tools accept a script hash, Neo address, exact N3Index name, or a name learned from a live manifest.

`estimate_transfer_fees` and `estimate_invoke_fees` return exact integer decimal strings in `networkFeeDatos` and `systemFeeDatos`, plus formatted GAS strings in `networkFeeGas` and `systemFeeGas`. Before any transaction is signed or broadcast, the combined system and network fee must not exceed `NEO_MAX_TRANSACTION_FEE_GAS`.

`deploy_contract` accepts compiler output as a complete serialized NEF object, `nef: { encoding: "hex" | "base64", data: string }`, together with its manifest. Raw VM bytecode is not a deployable NEF artifact.

`get_block_height` returns both `blockCount` and `height`, where `height` is `max(0, blockCount - 1)`.

For Neo N3 block analysis, pass `includeStateRoot: true` to `get_block` to
receive the exact StateService root plus local and StateValidator-validated
height boundaries. The returned `validated` flag is true only when the requested
root is at or below the validated boundary. Neo X rejects this N3-only option,
and ordinary block lookups do not incur the extra RPC calls. Neo N3 block
responses also include a deterministic ISO-8601 `timeIso` alongside the node's
millisecond `time` value.

Resources:

- `neo://network/status`
- `neo://mainnet/status`
- `neo://testnet/status`
- `neo://block/{height}`

## Security Notes

- Keep both HTTP listeners bound to loopback unless remote access is required.
- Terminate TLS before every remote HTTP connection; a bearer token authenticates requests but does not encrypt itself in transit.
- Use a randomly generated token of at least 32 bytes for `HTTP_API_KEY` and `MCP_HTTP_BEARER`.
- Keep `NEO_ENABLE_WRITES=false` on any remotely reachable MCP listener; the remote transport must never carry a transaction signer.
- Keep `EXPLORER_ACCOUNT_WATCH_ENABLED=false` unless the deployment intentionally supports verification email. When enabled, use a dedicated 32-byte-or-longer `EXPLORER_ACCOUNT_WATCH_API_TOKEN` that differs from every transport/API bearer.
- Keep the signer WIF only in the owner-only `NEO_SIGNER_WIF_FILE`; never send it through MCP or HTTP.
- Persist `WALLETS_DIR` on controlled storage with restrictive permissions.
- State-changing MCP tools require an explicit `network`, a stable idempotency
  key, and an exact `input_required` approval whose request state passes HMAC,
  expiry, method-binding, intent, network, operation, and fingerprint checks.
- Remote plaintext HTTP RPC endpoints are rejected unless `NEO_ALLOW_INSECURE_RPC=true`; prefer HTTPS.
- Signed transactions are rejected when their combined system and network fees exceed `NEO_MAX_TRANSACTION_FEE_GAS`.
- Rate limiting is enabled by default outside test-like environments.

## Testing

```bash
# Deterministic unit tests; excludes tests/mcp-*.test.ts
npm run test:unit

# Compile, then run deterministic built-server smoke and lifecycle checks
npm run build
npm run test:mcp

# Unit tests + build + deterministic MCP checks
npm run test:all

# Opt-in public RPC checks; requires a build and network access
npm run build
npm run test:mcp:live

# Explicit stress suite; requires a build
npm run test:mcp:stress
```

`npm run test:integration` is an additional built-server integration script that calls public RPC endpoints; it is not part of `test:all`.

## Release and Dependency Checks

`npm audit` and `npm audit --omit=dev` are expected to pass. The package uses a scoped `lodash@4.18.1` override for the transitive `@cityofzion/neon-core` dependency.

`./scripts/prepare-release.sh` installs the lockfile, runs type checking, deterministic tests, the build, both audits, package validation, Compose validation, and container builds. It updates the version only after verification and does not create a commit or tag.

GitHub Actions tests Node.js 22 and 24. Published GitHub releases can publish the npm package and Docker image when the required repository secrets are configured; no production deployment target is defined in this repository.

## Documentation

- [API reference](./docs/API.md)
- [Remote MCP transport](./docs/remote-mcp-transport.md)
- [Deployment guide](./docs/DEPLOYMENT.md)
- [Docker guide](./docs/DOCKER.md)
- [Testing guide](./docs/TESTING.md)
- [Production checklist](./docs/PRODUCTION_CHECKLIST.md)
- [Version management](./docs/VERSION_MANAGEMENT.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [Networks](./docs/NETWORKS.md)
- [Changelog](./docs/CHANGELOG.md)

## Troubleshooting

- Installation failures: verify `node --version` reports Node.js 22 or newer, then retry `npm ci` or the package install.
- `HTTP_API_KEY is required`: the HTTP process is listening on a non-loopback host. Set a key containing at least 32 bytes or bind `HTTP_HOST` to a loopback address.
- HTTP `401`: send `Authorization: Bearer <HTTP_API_KEY>` on all routes except `/live` and `/health`.
- HTTP `413`: reduce the request size or increase `HTTP_MAX_BODY_BYTES` to a positive integer.
- Remote MCP `401`: send `Authorization: Bearer <MCP_HTTP_BEARER>`; `/healthz` is the only unauthenticated route.
- Remote MCP `-32022`: the client did not pin `2026-07-28`, or attempted the removed legacy initialization flow. Upgrade to `@modelcontextprotocol/client` v2.
- Remote MCP `-32020`: the request's `Mcp-Method`, `Mcp-Name`, or protocol-version headers disagree with its body. Use the v2 SDK instead of hand-building the envelope.
- RPC errors: verify the selected RPC URL is reachable and supports the requested Neo RPC method.

## License

MIT. See [LICENSE](./LICENSE).
