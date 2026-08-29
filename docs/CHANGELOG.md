# Changelog

All notable changes to the Neo MCP project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [4.2.0] - 2026-08-29

### Added
- Added the opt-in `request_account_watch` MCP action for Neo N3. It validates
  the explicit network, address, and email, calls one fixed Explorer endpoint
  with an independent bearer, and returns a pending-confirmation boundary.

### Security
- Marked the Watch tool as non-read-only, non-destructive, and idempotent while
  keeping all remotely reachable transaction signing disabled.

## [4.1.0] - 2026-08-29

### Added
- Added `analyze_stablecoins`, a bounded Neo N3 and Neo X candidate discovery
  tool with network pinning and explicit issuer, reserve, redemption, bridge,
  and peg-evidence boundaries.
- Added bounded Neo X transaction, block, address, contract, and token intelligence
  tools that aggregate Blockscout evidence in parallel for mainnet and testnet.
- Added deterministic Neo value inspection, encoding conversion, and NeoVM
  script disassembly tools.
- Added network-correct NNS reads and unsigned writes, native Oracle price
  reads, bounded NeoFS reads, and official Neo X bridge integration metadata.
- Added a dedicated unsigned native NEO vote/unvote constructor with exact
  simulation and Boolean-success enforcement.
- Added deterministic transaction analysis with exact fee arithmetic,
  decimals-aware transfer amounts, signers, VM outcome, and contract events.
- Expanded the default non-custodial public surface to 57 tools.

## [4.0.2] - 2026-07-30

### Changed
- Replaced long-lived npm publish tokens and candidate dist-tags with npm
  Trusted Publishing over GitHub Actions OIDC.
- Upgraded release automation to Node.js 24, npm 11+, and the current major
  versions of GitHub and Docker actions.

## [4.0.1] - 2026-07-30

### Fixed
- Made the release workflow pass the validated npm tarball as an explicit local
  path, preventing npm from interpreting it as a Git dependency.
- Added a fail-closed local-file check before publishing the package candidate.

## [4.0.0] - 2026-07-30

### Breaking Changes
- Upgraded the server and clients to MCP `2026-07-28` and the split SDK v2
  packages.
- Removed initialization, session IDs, HTTP `GET`/`DELETE` lifecycle routes,
  sticky-session assumptions, and every older-protocol compatibility path.
- Replaced MCP form elicitation with signed `input_required` multi-round trips
  for state-changing tools.
- Added mandatory `NEO_MCP_REQUEST_STATE_KEY` validation when writes are
  enabled.

### Added
- Stateless per-request HTTP serving with explicit request, subscription,
  body-size, header, body, whole-request, and keepalive limits.
- Strict MCP routing-header validation, cache hints, and fail-closed protocol
  version enforcement.
- `analyze_address`, bringing the read-only public tool surface to 33 tools.

### Changed
- Split dependencies across `@modelcontextprotocol/server`,
  `@modelcontextprotocol/node`, and `@modelcontextprotocol/client`.
- Made horizontal MCP HTTP replicas independent of sticky routing or shared
  session storage.
- Updated the Neo Explorer client to pin MCP `2026-07-28`, enforce strict
  capabilities, honor tool-cache TTL hints, and refuse automatic write input.

## [3.1.0] - 2026-07-25

### Breaking Changes
- Renamed the package from `@r3e/neo-n3-mcp` to `@r3e/neo-mcp` and the binary to `neo-mcp`.
- Renamed `get_blockchain_info` to `get_chain_info`, `get_block_count` to `get_block_height`, and the read-only `invoke_contract` to `call_contract`.
- Tools that both chains implement now require an explicit `chain` argument, `n3` or `neox`, with no silent default.

### Added
- Neo X (EVM) read support across chain, block, transaction, balance, contract, and explorer tools.
- Neo X mainnet and testnet RPC configuration plus Blockscout-backed explorer analytics.
- `query_explorer_graphql` for Neo X, registered only when `NEOX_GRAPHQL_ENABLED=true`.
- A single tool registry that resolves every public tool to a chain-specific route.

### Changed
- Collapsed the tool surface to 32 public tools shared across both chains.
- Added durable write-operation recovery, idempotency, exact approval fingerprints, server-only signing, and fail-closed defaults.
- Kept the remote MCP HTTP surface read-only and write tools registered only when explicitly enabled.

## [3.0.0] - 2026-07-11

- Made all state-changing operations fail closed and disabled by default.
- Replaced request-supplied WIFs with one owner-only server signer file.
- Added durable idempotency journals, exact fingerprint approval, reconciliation, and byte-identical replay.
- Split the read-only contract call, then named `invoke_contract`, from `invoke_contract_write`.
- Removed model-facing wallet creation and import.
- Added independent HTTP write approval and intent status routes.
- Hardened RPC deadlines, response bounds, VM-state checks, network validation, fees, Docker, and release workflows.

## [2.0.0] - 2026-03-27

### Breaking Changes
- Replaced vendored neon-js 3.x with `@cityofzion/neon-js@5.x` from npm
- Configuration validation now rejects invalid values at startup
- Rate limiting now enforced (was previously configured but ignored)
- Package no longer bundles neon-js or ships config/examples in npm tarball

### Improvements
- Full TypeScript type safety — zero `any` types in production code
- Proper neon-js types flow through entire codebase
- Rate limiting integrated into HTTP and MCP request pipelines
- Log rotation (10MB max, 3 rotated files)
- Config validation at startup with clear error messages
- Clean npm package surface (only dist/, README, LICENSE)

### Fixes
- Fixed rate limiter config access (was reading wrong config path)
- Fixed logger config access (was casting config to any)

## [1.7.3] - 2026-03-10

### 🐛 Fixes
- Updated the Docker build contexts to copy the vendored NeonJS runtime before `npm ci`, so CI release workflows can build and publish from the patched dependency graph.
- Preserved the zero-vulnerability dependency graph while fixing the remaining `v1.7.2` workflow blocker.

## [1.7.2] - 2026-03-10

### 🐛 Fixes
- Added the vendored NeonJS runtime bundle files to source control so CI and npm installs can resolve the local `file:vendor/neon-js` dependency during build and publish workflows.
- Preserved the dependency vulnerability remediation from the previous patch while fixing the broken `v1.7.1` release packaging path.

## [1.7.1] - 2026-03-10

### 🐛 Fixes
- Remediated all GitHub-reported and `npm audit` dependency vulnerabilities in the published dependency graph.
- Vendored the NeonJS runtime bundle to remove the vulnerable published `@cityofzion/neon-js` transitive dependency chain while preserving the existing runtime API used by the server.
- Updated MCP protocol-compliance and stress tests to align with the current SDK error-response semantics after the dependency refresh.

## [1.7.0] - 2026-03-10

### 🚀 New Features
- Added exact-name contract resolution through `https://api.n3index.dev` so contracts can be addressed by local known name, exact remote name, Neo address, or script hash.
- Added a public `get_contract_status` MCP tool and matching HTTP status route for on-chain contract inspection.

### ✨ Enhancements
- Expanded the live MCP stdio surface to 27 tools and aligned the handler, HTTP, and stdio registrations.
- Hardened HTTP contract routes to support encoded contract names such as `Flamingo%20USD`.
- Refreshed the website and docs so active public pages reflect the shipped tool/resource counts and contract interaction flow.

### 🐛 Fixes
- Fixed unsafe fuzzy remote name matches by failing closed on ambiguous or partial contract names.
- Fixed N3Index metadata cache poisoning after transient upstream failures by allowing retry after rejected fetches.
- Fixed contract status handling so RPC/network failures are surfaced instead of being mislabeled as `not_deployed`.
- Fixed unresolved HTTP contract references to return a resource-level `404` response instead of a generic `500`.

## [1.6.4] - 2026-03-06

### ✨ Enhancements
- Hardened the published npm package surface with explicit entry metadata and a tight runtime file allowlist.
- Added a built-artifact MCP smoke test to CI so the compiled `dist/index.js` server is validated after each build.
- Extracted MCP resource registration into `src/handlers/resource-handler.ts` while preserving public resource URIs and payload shapes.

### 🐛 Fixes
- Fixed clean-checkout packaging by rebuilding `dist` during `prepack`, so `npm pack --dry-run` and releases always include compiled output.
- Refreshed release docs and scripts to reflect package-driven server versioning via `src/version.ts` instead of manual `src/index.ts` edits.

## [1.6.0] - 2025-06-25

### 🚀 Major Features Added
- **Enterprise-Grade CI/CD Pipeline**: Complete GitHub Actions workflow with multi-stage testing, building, and deployment
- **Comprehensive Docker Infrastructure**: Production and development Docker environments with multi-stage builds
- **Project Organization**: Restructured project with proper folder hierarchy (docker/, docs/, scripts/)
- **Automated Publishing**: NPM and Docker Hub publishing on releases with proper versioning

### ✨ New Features
- **Multi-Environment Docker Support**: Separate development and production Docker configurations
- **Automated Build Scripts**: Smart Docker build scripts with environment-specific .dockerignore handling
- **Monitoring Stack**: Prometheus and Grafana integration for production deployments
- **Security Auditing**: Automated vulnerability scanning and dependency checks in CI/CD
- **Modern Docker Compose**: Updated to use `docker compose` syntax (Docker Compose V2)

### 🔧 Infrastructure Improvements
- **GitHub Actions Workflow**: 
  - Matrix testing across Node.js 18.x, 20.x, 22.x
  - Multi-stage pipeline: Test → Build → Security → Docker → Publish → Deploy
  - Environment protection for production deployments
  - Automated Docker image building and testing
- **Docker Enhancements**:
  - Multi-stage production builds with security best practices
  - Development images with hot reload and debugging support
  - Optimized .dockerignore files for different build contexts
  - Health checks and proper signal handling with dumb-init
- **Build System**:
  - Automated build scripts with multiple options
  - Environment-specific configuration handling
  - Proper TypeScript compilation in Docker builds

### 📚 Documentation
- **Comprehensive Guides**: 
  - `DOCKER.md` - Complete Docker usage guide (318 lines)
  - `WORKFLOW.md` - CI/CD pipeline documentation (120 lines)
  - `EXAMPLES.md` - Practical usage examples (334 lines)
  - `PRODUCTION_CHECKLIST.md` - Deployment checklist (285 lines)
- **Project Structure**: Clear organization with docs/, docker/, scripts/ folders
- **API Documentation**: Updated with new deployment and usage patterns

### 🛠️ Technical Improvements
- **Test Infrastructure**: 
  - Separated unit tests from integration tests
  - Improved test validation (191 tests passing with robust error handling)
  - Coverage reporting integration with Codecov
- **Build Process**:
  - Fixed TypeScript compilation in Docker builds
  - Proper dependency management for production vs development
  - Optimized build caching and layer management
- **Configuration Management**:
  - Enhanced configuration with rate limiting and logging options
  - Environment-specific Docker configurations
  - Proper secrets management for CI/CD

### 🔒 Security Enhancements
- **Container Security**: Non-root user execution, minimal attack surface
- **Dependency Auditing**: Automated security scanning in CI/CD pipeline
- **Secrets Management**: Proper handling of NPM tokens and Docker credentials
- **Network Security**: Isolated container networking with proper port exposure

### 🐛 Bug Fixes
- **Docker Build Issues**: 
  - Fixed `tsc: not found` error in production builds
  - Resolved tests directory exclusion in development builds
  - Fixed `docker-compose: command not found` in GitHub Actions
- **Test Validation**: Corrected test scenarios to properly validate error conditions
- **Asset Hash Consistency**: Fixed Neo N3 testnet asset hash inconsistencies
- **Version Synchronization**: Aligned server version with package.json

### 📦 Dependencies
- **Updated MCP SDK**: Using @modelcontextprotocol/sdk ^1.9.0
- **Modern Docker**: Support for Docker Compose V2 syntax
- **Node.js Support**: Tested compatibility with Node.js 18.x, 20.x, 22.x
- **Build Tools**: Enhanced TypeScript and Jest configurations

### 🔄 Breaking Changes
- **Docker Compose**: Changed from `docker-compose` to `docker compose` command
- **File Structure**: Moved Docker files to `docker/` folder, documentation to `docs/`
- **Build Scripts**: Updated paths and references due to file reorganization

### 📈 Performance Improvements
- **Docker Builds**: Multi-stage builds reduce final image size
- **CI/CD Pipeline**: Parallel job execution and optimized caching
- **Test Execution**: Separated test types for faster feedback loops

### 🎯 Developer Experience
- **Automated Scripts**: One-command Docker builds and deployments
- **Hot Reload**: Development Docker environment with live code reloading
- **Debugging Support**: Development containers with debugging capabilities
- **Clear Documentation**: Step-by-step guides for all deployment scenarios

---

## [1.5.0] - Previous Release

### Features
- Neo N3 blockchain integration with MCP protocol
- Multi-network support (mainnet/testnet)
- Comprehensive tool and resource implementations
- Robust validation and error handling

### Technical Details
- MCP SDK 1.9.0 integration
- TypeScript implementation with comprehensive testing
- Neo N3 asset management and transaction handling
- Contract interaction capabilities

---

## Version Numbering

This project follows [Semantic Versioning](https://semver.org/):
- **MAJOR** version for incompatible API changes
- **MINOR** version for backwards-compatible functionality additions  
- **PATCH** version for backwards-compatible bug fixes

## Release Process

1. Update version in `package.json` and `package-lock.json`
2. Confirm `src/version.ts` still derives the server version from `package.json`
3. Update this CHANGELOG.md with new features and changes
4. Create a GitHub release with the version tag
5. Automated CI/CD pipeline handles building and publishing
6. Docker images are automatically published to Docker Hub
7. NPM package is automatically published to npm registry

## Contributing

See our contribution guidelines for information on how to contribute to this project and follow our release process.
