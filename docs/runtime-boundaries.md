# Public tool dispatch and transport resources

Public MCP schemas belong to `registry/tool-registry`. The entry server registers those schemas and formats protocol responses; `handlers/public-tool-dispatch` owns route resolution followed by conditional service activation and invocation through injected callbacks. Invalid routes must not activate services or invoke handlers. The existing callTool layer remains the single rate-limit charge for delegated tools. Wallet/signing dependencies are supplied only according to the resolved route, and separately elicited write orchestration is unchanged.

`utils/request-abort-scope` owns one request attempt's parent-abort listener, timeout and idempotent cleanup. EVM and indexer transports still own their method allowlists, URL configuration, JSON-RPC envelopes, response bounds and error/retry classification. Sharing resource cleanup must not make an indexer request retryable or cause a caller abort to walk EVM fallback endpoints.

These internal modules expose no new public MCP tool, parameter or result shape. Unit tests inject handlers/fetch and use fake timers; no real chain or paid service is invoked. Run dispatcher/abort-scope tests, existing registry/handler/RPC regressions, then `npm run type-check` and the TypeScript build before deployment. No deployment is authorized by passing these tests.

The existing withRpcDeadline abstraction remains responsible for logical/non-abortable SDK operations and typed submission-unknown outcomes. It is not replaced by the fetch-attempt resource scope. Invalid JSON envelopes are serialized before resource allocation so serialization failures leave no timer or parent listener.

## Abort scope

An abort is scoped to exactly one RPC attempt. A deadline aborts that attempt only: the parent signal stays live and sibling attempts keep running. A parent abort is forwarded to every live attempt and each attempt detaches its listener on dispose. Disposal is idempotent and clears the attempt's timer. Logical, non-abortable SDK work under `withRpcDeadline` is out of scope and is never cancelled by a transport timeout.

## Error surface

`utils/error-handler` returns server-authored text only. A typed `NeoMcpError` keeps its own message and its `InvalidParams`/`InternalError` code, so a caller can still tell a rejected input from an internal failure. Unknown upstream or infrastructure text is replaced by one generic retry message; the full detail and stack go to the protected server logger. One narrow, fully-anchored deployment diagnostic (`Contract <name> is not deployed on <network>`) is preserved because its shape cannot carry anything else.

## Indexer availability

`utils/indexer-availability` is the single switch for the n3index analytical surface (`api.n3index.dev`). Every n3index entry point — the REST transport, the JSON-RPC transport, the metadata client, and each handler — calls `assertIndexerAvailable` before any URL is built or any host is resolved. With `N3INDEX_ENABLED` off, no tool contacts the indexer host and `analyze_address` fails closed with `analyze_address is disabled; enable N3INDEX_ENABLED` rather than calling out. The gate covers the n3index host only; the Neo X Blockscout surface keeps its own switches (`NEOX_GRAPHQL_ENABLED`).
