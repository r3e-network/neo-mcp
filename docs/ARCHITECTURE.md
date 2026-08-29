# Neo MCP Architecture

This document provides an overview of the architecture of the Neo Model Context Protocol (MCP) implementation, which serves both Neo N3 and Neo X (EVM) from one tool surface.

## Table of Contents

- [Overview](#overview)
- [Components](#components)
- [Data Flow](#data-flow)
- [Error Handling](#error-handling)
- [Security](#security)
- [Extensibility](#extensibility)

## Overview

The Neo MCP provides a standardized way to interact with both Neo chains. It follows a modular architecture that separates concerns and makes it easy to extend and maintain.

Two axes describe every request:

- **Chain**: `n3` (Neo N3) or `neox` (Neo X, EVM-compatible).
- **Backend**: live node RPC (`mainnet` or `testnet`) or explorer analytics (n3index for Neo N3, Blockscout for Neo X; mainnet-only).

One public tool covers a capability on both chains. Tools that both chains implement take a required `chain` argument with no default; single-chain tools serve one chain and reject the other.

### Key Design Principles

1. **Modularity**: The implementation is divided into separate modules with clear responsibilities.
2. **One surface, two chains**: A single registry maps each public tool and chain pair onto a chain-specific handler, so adding a chain never duplicates a registration.
3. **Extensibility**: The architecture allows for easy addition of new features and tools.
4. **Security**: The server is non-custodial. It never holds keys for default traffic, transaction writes are opt-in and explicitly approved, and the optional account Watch action can only request double-opt-in email verification.
5. **Error Handling**: Comprehensive error handling ensures that errors are properly reported and handled.
6. **Testability**: The architecture is designed to be easily testable.

## Components

The Neo MCP consists of the following main components:

### Tool Registry

`src/registry/tool-registry.ts` is the single source of truth for the public surface. For each public tool it declares the description, the Zod input schema, the chains it supports, and one route per chain. `resolveRoute(name, args)` validates the requested chain, strips `chain` from the arguments, applies any per-chain argument mapping, and returns the internal handler name plus whether Neo N3 services or the wallet service are needed.

Argument mapping exists because the backends disagree on shape. Neo X explorer and construct handlers take `neox-mainnet` or `neox-testnet` while Neo X node handlers take `mainnet` or `testnet`, Blockscout list endpoints are cursor-paginated so `limit` and `skip` are dropped there, and the generic query tools name their target with different fields. Callers only ever say `mainnet` or `testnet`.

### MCP Server

`src/index.ts` registers every public tool in one loop over `listPublicTools()`. Each registration resolves the route, lazily initializes Neo N3 services when the route needs them, and delegates to `callTool`. Registry metadata distinguishes read-only tools from the non-destructive, idempotent account Watch verification action. Transaction write tools are registered separately and only when writes are explicitly enabled.

### Tool Handler

`src/handlers/tool-handler.ts` dispatches an internal handler name to the right backend:

- Chain-less meta tools answer directly.
- Neo N3 analytics and Neo X explorer reads go to their HTTP clients and never touch the RPC layer.
- Account Watch requests go to one configured Explorer HTTPS endpoint, use a dedicated bearer, and return only the pending-confirmation boundary.
- Neo X simulate and construct tools use the allowlisted EVM RPC client and return unsigned proposals.
- Neo X node reads go to the allowlisted EVM JSON-RPC client, dispatched before Neo N3 network resolution.
- Everything else resolves a Neo N3 network and uses the Neo and contract services.

### Neo Service

The Neo Service is responsible for:
- Interacting with the Neo N3 blockchain over node RPC
- Querying chain information
- Getting blocks and transactions
- Getting account balances

### Neo X Adapter

`src/chains/neox-node-adapter.ts` exposes Neo X node RPC through an allowlist of read-only EVM methods; any method outside that set is rejected. `src/handlers/neox-node-tools.ts` builds the Neo X node read tools on top of it, and `src/handlers/proposal-tools.ts` builds the unsigned Neo X proposals.

### Explorer Clients

- `src/contracts/n3index-client.ts` and `n3index-rest-client.ts` reach n3index for Neo N3 analytics.
- `src/contracts/blockscout-client.ts` and `blockscout-graphql-client.ts` reach Blockscout for Neo X analytics.
- The catalogs and guards in `src/indexer/` allowlist every endpoint, collection, and GraphQL query shape, so a generic query tool cannot be pointed at an arbitrary URL.

### Wallet Service

The Wallet Service is responsible for:
- Reporting the configured server signer, when one exists
- Signing server-side writes when writes are enabled

Key-custody tools are neither registered nor dispatchable.

### Contract Service

The Contract Service is responsible for:
- Managing famous contracts
- Providing contract information
- Performing read-only contract calls

### HTTP Server

The HTTP Server is responsible for:
- Exposing the MCP functionality via HTTP
- Handling HTTP requests and responses
- Setting CORS headers
- Handling preflight requests

The remote MCP HTTP transport is read-only by design; write tools are reachable only over stdio.

## Data Flow

The data flow in the Neo MCP is as follows:

1. The client calls a public tool over stdio or the MCP HTTP endpoint.
2. The transport hands the tool name and arguments to the registered handler.
3. `resolveRoute` validates the `chain` argument, maps arguments to the backend's shape, and returns an internal handler name.
4. Neo N3 services are initialized on first use if the route needs them.
5. `callTool` dispatches the internal name to node RPC, an explorer client, or a chain-less meta handler.
6. The result or error is formatted according to the MCP specification and returned to the client.

### Sequence Diagram

```
Client              MCP Server          Tool Registry        Handler / Backend
  |                     |                     |                     |
  | call_contract       |                     |                     |
  | {chain: "neox"}     |                     |                     |
  |-------------------->|                     |                     |
  |                     | resolveRoute        |                     |
  |                     |-------------------->|                     |
  |                     |  internalName,      |                     |
  |                     |  mapped args        |                     |
  |                     |<--------------------|                     |
  |                     | callTool            |                     |
  |                     |------------------------------------------>|
  |                     |                     |        result       |
  |                     |<------------------------------------------|
  |      response       |                     |                     |
  |<--------------------|                     |                     |
  |                     |                     |                     |
```

An unsupported or missing `chain` fails at step 3, before any network call.

## Error Handling

The Neo MCP implements comprehensive error handling to ensure that errors are properly reported and handled.

### Error Types

All errors derive from `NeoMcpError` in `src/utils/errors.ts`, which carries a machine-readable `type` and optional `details`:

- **ValidationError**: Invalid or missing input, including an unsupported or absent `chain`.
- **ContractError**: A contract call or script execution failed.
- **TransactionError**: A transaction could not be built, signed, or submitted.
- **NetworkError**: An RPC endpoint or explorer API was unreachable or returned a transport failure.
- **RateLimitError**: The client's request budget was exceeded.
- **WalletError**: The configured server signer is missing or unusable.
- **InternalError**: An unexpected server-side failure.

### Error Propagation

Errors are propagated through the system as follows:

1. The registry throws a `ValidationError` for an unknown tool or an unsupported `chain`, before any network call.
2. Services and handlers throw the specific error type matching the failure.
3. The registered tool handler catches the error and returns an MCP tool result with `isError: true` and the message as text content.
4. Over HTTP, the transport layer sends that result back to the client; process-level failures become HTTP error responses.

## Security

The Neo MCP implements several security measures to protect sensitive information and prevent unauthorized access.

### Key Management

- The server is non-custodial. It never accepts a key, WIF, or password in a tool argument; requests carrying such fields are rejected.
- Key-custody tools are neither registered nor dispatchable.
- Writes are disabled by default. When enabled, the signer key is read from a file on the server and never crosses the tool boundary.
- Construct tools return unsigned proposals for the caller to sign elsewhere.

### Write Approval

- Every state-changing call requires an explicit network and an `idempotencyKey`, so a retry can never produce a second transaction.
- The server computes a fingerprint over the canonical intent and only proceeds once the caller approves that exact fingerprint.
- Over MCP, approval uses an `input_required` multi-round trip with signed,
  expiring request state; over REST, a separate approval endpoint uses its own
  API key.

### Input Validation

- All input is validated before processing.
- Parameters are checked for correct types and values.
- The `chain` argument is validated against the tool's supported chains, with no silent default.
- Generic query tools accept only allowlisted endpoints, collections, and query shapes, so no caller-supplied URL or path reaches an HTTP client.
- Malformed requests are rejected with appropriate error messages.

### Network Security

- The HTTP Server sets appropriate CORS headers to prevent cross-origin attacks.
- HTTP binds to `127.0.0.1` by default and is intended to sit behind a TLS-terminating reverse proxy.
- HTTP requests are rate limited by a privacy-preserving client key derived at
  the trusted proxy boundary; stateless per-request server instances for the
  same client share one process-wide bucket.

## Extensibility

The Neo MCP is designed to be easily extensible to support new features and tools.

### Adding New Tools

To add a new tool to the MCP:

1. Implement the tool's functionality in the appropriate service or handler, and add its internal name to the `callTool` dispatch.
2. Add a `PublicToolSpec` to `src/registry/tool-registry.ts` with the description, Zod input schema, supported chains, and one route per chain. Registration in `src/index.ts` picks it up automatically.
3. Where the backend's argument shape differs from the public schema, give that route a `mapArgs` function rather than leaking the difference to callers.
4. Add tests for the new tool, including one per chain it supports and one asserting the error when `chain` is missing or unsupported.

### Adding a Chain

Adding a chain means extending `Chain` and `CHAINS`, providing an adapter and client layer for it, and adding a route to each public tool that chain implements. No tool registration is duplicated, because `src/index.ts` registers from the registry.

### Supporting New Contracts

The contract layer now supports three resolution paths:

1. Local famous-contract registry for curated aliases and hand-authored operation metadata.
2. Direct Neo address or script-hash references.
3. Remote name lookup through `https://api.n3index.dev`, using the documented `contract_metadata_cache` and `contracts` REST surfaces.

That means new contracts do not need a code change if the caller already knows the contract hash, address, or a name that N3Index can resolve. The local registry remains useful for curated operation descriptions and compatibility aliases, but it is no longer the only way a contract can be addressed.

On Neo X, contracts are addressed by their EVM address, and verified source and compiler metadata comes from the Blockscout explorer, so a Neo X contract needs no code change either.

### Custom Extensions

The Neo MCP can be extended with custom functionality by:

1. Creating a new service or client for the custom functionality.
2. Implementing the internal handlers and adding them to the `callTool` dispatch.
3. Declaring the public tools in the registry with their per-chain routes.
4. Adding tests covering each chain the new tools support.
