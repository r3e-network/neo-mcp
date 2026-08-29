# Production Checklist

Use this checklist before deploying `@r3e/neo-mcp` in MCP stdio or HTTP mode.

## Runtime and Build

- [ ] Node.js is version 22 or newer.
- [ ] Dependencies were installed with `npm ci` from the committed lockfile.
- [ ] `npm run verify` passes.
- [ ] `npm audit --audit-level=high` passes.
- [ ] `npm audit --omit=dev --audit-level=high` passes.
- [ ] `npm pack --dry-run` contains only the intended package files.
- [ ] Live RPC checks were run separately when the target RPC service is in scope: `npm run build && npm run test:mcp:live`.
- [ ] Stress checks were run explicitly when required: `npm run build && npm run test:mcp:stress`.

`test:all` and `verify` are deterministic. Live and stress suites are intentionally opt-in and must not be represented as skipped unit-test failures.

## Network Configuration

- [ ] `NEO_NETWORK` is explicit.
- [ ] HTTP deployments use `mainnet` or `testnet`, not `both`.
- [ ] Each configured RPC URL is reachable from the runtime environment.
- [ ] The selected node supports every RPC plugin method required by the deployment.
- [ ] N3Index name resolution is enabled or disabled intentionally.
- [ ] Explorer account Watch is disabled unless this deployment intentionally sends verification email.

Baseline:

```bash
NEO_NETWORK=mainnet
NEO_MAINNET_RPC=https://mainnet1.neo.coz.io:443
NEO_TESTNET_RPC=https://testnet1.neo.coz.io:443
NEO_ALLOW_INSECURE_RPC=false
NEO_MAX_TRANSACTION_FEE_GAS=20
N3INDEX_ENABLED=true
EXPLORER_ACCOUNT_WATCH_ENABLED=false
```

- [ ] Every remote RPC endpoint uses HTTPS; `NEO_ALLOW_INSECURE_RPC` remains `false` in production.
- [ ] `NEO_MAX_TRANSACTION_FEE_GAS` is set to the approved maximum combined system and network fee.

## HTTP Security

- [ ] `HTTP_HOST` remains `127.0.0.1` unless remote binding is required.
- [ ] `HTTP_API_KEY` contains at least 32 random bytes.
- [ ] A non-loopback `HTTP_HOST` is never used without `HTTP_API_KEY`.
- [ ] Clients send `Authorization: Bearer <HTTP_API_KEY>` on every route except `/live` and `/health`.
- [ ] Every remote client connects over HTTPS through a TLS-terminating reverse proxy or load balancer.
- [ ] The plaintext backend HTTP hop is restricted to loopback or a trusted host-local proxy network.
- [ ] `HTTP_CORS_ORIGINS` contains only the exact browser origins that require access.
- [ ] Wildcard CORS is not expected; it is not supported.
- [ ] `HTTP_MAX_BODY_BYTES` is appropriate for expected requests; the default is 1 MiB.
- [ ] Rate limiting remains enabled and both thresholds are positive integers.
- [ ] When account Watch is enabled, `EXPLORER_ACCOUNT_WATCH_API_URL` is the approved HTTPS `/api/account-watches` endpoint and `EXPLORER_ACCOUNT_WATCH_API_TOKEN` is independent from all transport/API bearers.
- [ ] Firewall rules restrict the backend listener to the TLS terminator; direct remote plaintext HTTP is unsupported because bearer tokens and WIFs traverse requests.

Baseline:

```bash
HTTP_HOST=127.0.0.1
HTTP_API_KEY=replace-with-at-least-32-random-bytes
HTTP_CORS_ORIGINS=https://console.example.com
HTTP_MAX_BODY_BYTES=1048576
RATE_LIMITING_ENABLED=true
MAX_REQUESTS_PER_MINUTE=60
MAX_REQUESTS_PER_HOUR=1000
PORT=3000
```

## Wallet and Secret Handling

- [ ] Real WIFs, private keys, API keys, and wallet passwords are absent from source control, shell history, and logs.
- [ ] `WALLETS_DIR` points to persistent, access-controlled storage.
- [ ] The wallet directory is writable by the service account and not broadly readable.
- [ ] Backup and retention behavior for encrypted wallet records is defined by the operator.
- [ ] Every state-changing MCP request includes an explicit `network` and uses `confirm` as the JSON boolean `true`; strings and numbers are not accepted.
- [ ] HTTP state-changing requests use `confirm` as the JSON boolean `true` on the server's configured network.

For containers, use `WALLETS_DIR=/app/wallets` and persist `/app/wallets` with a volume.

## Logging and Operations

- [ ] `LOG_LEVEL` is appropriate for production.
- [ ] Console or file logging is enabled intentionally.
- [ ] File logging uses a writable path; the built-in 10 MiB/three-file rotation policy is acceptable or replaced deliberately.
- [ ] Container logging limits are retained or replaced with an operator-managed policy.
- [ ] No assumption is made that this repository provides dashboards, alerts, or an automated production deployment.
- [ ] A rollback target is recorded before rollout.

Example process logging:

```bash
LOG_LEVEL=info
LOG_CONSOLE=false
LOG_FILE=/var/log/neo-mcp/server.log
WALLETS_DIR=/var/lib/neo-mcp/wallets
```

## Container Deployment

- [ ] Production uses `docker/docker-compose.yml`.
- [ ] `HTTP_API_KEY` is exported before running Compose.
- [ ] The default host bind `127.0.0.1` is retained unless a TLS-terminating proxy requires wider exposure.
- [ ] The `neo-mcp-wallets` volume is present and included in backup planning.
- [ ] `docker compose -f docker/docker-compose.yml config` succeeds.
- [ ] Registry deployments set `NEO_MCP_IMAGE_REPOSITORY` and a verified 64-character lowercase hexadecimal `NEO_MCP_IMAGE_DIGEST`; mutable tags and combined image references are not used.
- [ ] The development Compose default key is never used in production.

```bash
export HTTP_API_KEY="$(openssl rand -hex 32)"
docker compose -f docker/docker-compose.yml config
docker compose -f docker/docker-compose.yml up -d
```

## Smoke Checks

The liveness and readiness routes are unauthenticated:

```bash
curl --fail http://127.0.0.1:3000/live
curl --fail http://127.0.0.1:3000/health
```

Authenticated checks:

```bash
curl --fail \
  -H "Authorization: Bearer $HTTP_API_KEY" \
  http://127.0.0.1:3000/metrics

curl --fail \
  -H "Authorization: Bearer $HTTP_API_KEY" \
  http://127.0.0.1:3000/api/blockchain/height
```

- [ ] `/live` returns `200` without calling Neo RPC.
- [ ] `/health` returns `200` and identifies the intended network.
- [ ] `/metrics` rejects a missing or incorrect key and succeeds with the configured key.
- [ ] `/api/blockchain/height` returns `blockCount` and `height`, with `height = max(0, blockCount - 1)`.
- [ ] An oversized JSON body returns `413`.
- [ ] A non-JSON POST body returns `415`.
- [ ] A representative read-only request succeeds against the intended RPC node.
- [ ] A controlled MCP testnet write rejects a missing network and missing, string, or numeric confirmation values.
- [ ] A fee estimate contains exact decimal-string `networkFeeDatos` and `systemFeeDatos` values plus formatted `networkFeeGas` and `systemFeeGas` values.
- [ ] A transaction whose combined fees exceed `NEO_MAX_TRANSACTION_FEE_GAS` is rejected before signing or broadcast.

## Rollout

- [ ] The deployed npm or image version matches the approved release.
- [ ] The previous known-good version is available for rollback.
- [ ] Health and authenticated read-only checks pass before traffic is enabled.
- [ ] Runtime logs contain no secrets or repeated startup/configuration errors.
- [ ] Rollback means redeploying the previous artifact; this repository does not automate that action.

See [DEPLOYMENT.md](./DEPLOYMENT.md) and [DOCKER.md](./DOCKER.md) for detailed procedures.
