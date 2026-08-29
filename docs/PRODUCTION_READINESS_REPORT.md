# Production Readiness Status

This report summarizes repository-level hardening for Neo MCP `3.1.0`. It is an evidence record, not a certification of any external deployment.

## Current Assessment

The repository is prepared for controlled release and operator-managed deployment when the checks in this document pass. Runtime security defaults, deterministic validation, dependency audits, package boundaries, and container assets are implemented and covered by automated tests.

Production readiness remains conditional on the operator's RPC capacity, secrets management, network controls, wallet backup policy, external observability, rollout, and rollback procedures.

## Verified Repository Controls

### Runtime and Toolchain

- Node.js `>=22` is required.
- CI tests Node.js 22 and 24.
- TypeScript builds with `tsc`; Jest uses `ts-jest`.
- The npm package publishes only `dist/`, `README.md`, and `LICENSE`.
- Babel and obsolete example configuration are not build inputs.

### Deterministic Validation

```bash
npm run verify
```

`verify` runs type checking, deterministic unit tests, a clean build, and deterministic built-server MCP tests. The MCP set covers smoke startup, stdio lifecycle, and tool registration.

The following suites are deliberately separate:

```bash
npm run build
npm run test:mcp:live
npm run test:mcp:stress
npm run test:integration
```

They exercise public RPC or load-sensitive behavior and are not represented as skipped or expected unit-test failures.

### Dependency Security

Both audits are expected to pass:

```bash
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high
```

The dependency graph uses a scoped `lodash@4.18.1` override under `@cityofzion/neon-core`.

### HTTP Security

- `HTTP_HOST` defaults to `127.0.0.1`.
- A non-loopback host requires `HTTP_API_KEY`.
- Configured API keys must contain at least 32 bytes.
- Bearer authentication protects every route except `/live` and `/health` when a key is configured.
- `HTTP_CORS_ORIGINS` is an optional exact-origin allowlist.
- `HTTP_MAX_BODY_BYTES` defaults to 1 MiB.
- POST and PUT bodies must be JSON objects.
- State-changing MCP requests require an explicit network, a durable `idempotencyKey`, and form-elicited approval of the exact intent fingerprint; HTTP writes return `202 awaiting_approval` and need an independent approval call.
- The remote MCP HTTP transport is read-only by design; write tools are reachable only over stdio when `NEO_ENABLE_WRITES=true`.
- Rate limiting is active outside test-like environments by default.
- `NEO_RPC_TIMEOUT_MS` defaults to 15000 milliseconds for each underlying RPC attempt.
- Testnet RPC defaults to `https://testnet1.neo.coz.io:443`; remote plaintext HTTP RPC endpoints are rejected unless `NEO_ALLOW_INSECURE_RPC=true`.
- `NEO_MAX_TRANSACTION_FEE_GAS` defaults to 20 GAS and caps the combined system and network fees before signing while leaving headroom above Neo's 10 GAS native deployment minimum.

### Wallet Storage

- `WALLETS_DIR` is configurable and defaults to `./wallets`.
- The wallet directory is created with restrictive permissions.
- Persisted wallet files contain encrypted private-key material and use restrictive file modes.
- Container deployments persist `/app/wallets` in a named volume.

### Container Assets

`docker/docker-compose.yml` is the production Compose definition. It requires an API key, publishes the host port on loopback by default, persists wallet storage, configures a health check, and limits Docker JSON log files. The registry overlay requires a repository plus a 64-character lowercase hexadecimal image digest and does not accept mutable tags.

`docker/docker-compose.dev.yml` binds locally and supplies a local-development key. That key is not suitable for production or shared environments.

Both Dockerfiles use Node.js 22 Alpine images and run as the non-root `node` user.

### CI and Publishing

The GitHub Actions workflow validates unit tests, coverage generation, build artifacts, deterministic MCP behavior, package contents, dependency audits, Compose files, and both images.

Published GitHub releases can publish npm and Docker artifacts when repository secrets are configured. The workflow does not deploy to a production host or automate rollback.

## Functional Surface

The server registers 58 public MCP tools spanning Neo N3 and Neo X, three fixed network resources, and one parameterized block resource. Tools that both chains implement require an explicit `chain` argument with no default. Tool registration, chain routing, and generic contract-reference handling are tested. The N3-only `request_account_watch` action is disabled by default, requires a dedicated integration token, and can only request double-opt-in verification. The N3-only `analyze_consensus_health` tool exposes deterministic expected-primary attribution and returns `unknown` for incomplete or stale evidence. Five Neo X intelligence tools aggregate network-scoped Blockscout evidence with bounded collections, explicit optional-section availability, and no exhaustive-history claim. The cross-chain `analyze_stablecoins` tool performs bounded name/symbol discovery while refusing to treat contract metadata as proof of backing, redemption, or peg safety.

Local contract metadata and name resolution do not certify that a named third-party contract is deployed, current, audited, or compatible on a particular network. Verify contract status, script hash, manifest, operations, and transaction behavior on-chain before relying on any third-party integration.

`get_block_height` and HTTP blockchain-height responses distinguish the RPC `blockCount` from the latest height, calculated as `max(0, blockCount - 1)`.

Fee estimates expose exact decimal-string `networkFeeDatos` and `systemFeeDatos` values plus formatted `networkFeeGas` and `systemFeeGas` values. Contract deployment accepts a complete compiler-produced serialized NEF object with explicit hex or base64 encoding; raw VM bytecode is not a NEF artifact.

## Deliberate Non-Claims

This repository does not provide or certify:

- a Prometheus or Grafana deployment
- dashboards, alerts, tracing, or an external error-tracking backend
- cloud-provider or Kubernetes manifests
- automated production rollout or rollback
- performance, latency, memory, CPU, or throughput service-level guarantees
- a fixed coverage percentage or security grade
- deployment and behavior guarantees for named third-party protocols

The HTTP `/metrics` route exposes a small Prometheus-text-compatible process/network/block-height surface. Operators must supply collection, storage, dashboards, and alerting.

## Production Gate

Before enabling production traffic:

- [ ] Run `npm run verify` from the release commit.
- [ ] Run both dependency audits.
- [ ] Validate npm package contents.
- [ ] Validate the production Compose file with a generated API key.
- [ ] Run live RPC checks against the intended node when those methods are required.
- [ ] Run stress checks when expected load justifies them.
- [ ] Keep HTTP on loopback or place remote exposure behind explicit network controls.
- [ ] Store the API key and wallet credentials outside source control and image layers.
- [ ] Persist and back up `WALLETS_DIR` according to operator policy.
- [ ] Verify `/live`, `/health`, authenticated `/metrics`, and one authenticated read-only route.
- [ ] Record the previous known-good artifact and rollback procedure.
- [ ] Configure operator-owned logs, metrics collection, alerts, and incident response.

## Residual Risks

- Public RPC availability and plugin support vary by node.
- RPC deadlines reject timed-out calls but cannot cancel an already-started Neon SDK or underlying HTTP request.
- Live and stress suites are not part of the default CI workflow.
- Contract names can resolve to stale, unavailable, or unexpected deployments; script hashes must be verified.
- WIF-based write operations carry inherent key-handling risk.
- Rate limiting is process-local and is not a substitute for upstream network controls.
- Container wallet persistence requires an operator-managed backup and restore test.

## Conclusion

The repository provides a hardened release baseline with conservative HTTP defaults and deterministic validation. Approval of a production deployment must be based on the operator's environment-specific checks and risk acceptance, not on this document alone.
