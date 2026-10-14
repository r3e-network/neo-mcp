# Network Identities, Identity Registry, and Reproducible Release Record

## Problem

Three gaps sit between the server's runtime and a verifiable deployment:

1. The two Neo N3 network magics are hardcoded literals in `src/services/neo-service.ts`.
   There is no reviewed, machine-readable source for the network identity material the
   server signs with, and no way to regenerate it from pinned inputs.
2. Nothing validates identity material before the server reads it. A hand-edited or
   truncated artifact would be consumed silently and could sign against the wrong network.
3. There is no reproducible archive of a branch build and no record naming its hash, so a
   deployed tree cannot be compared against a known-good artifact (risk R8). The version
   strings the repo declares already disagree (`package.json` says `4.2.0`, `README.md`
   says `4.1.0`, `docs/VERSION_MANAGEMENT.md` says `4.0.2`).

## Purpose

Land the generated Neo N3 network identities, the identity registry the server reads, the
release scripts that build a reproducible archive of the branch, and a release record that
pins that archive's hash. Make version-string agreement a failing test.

## Interfaces

### Generated identity artifact

Path: `src/config/generated/network-identities.v1.json`

Produced only by `scripts/generate-network-identities.mjs`. Committed. Not hand-edited.

```json
{
  "schemaVersion": 1,
  "networks": {
    "mainnet": {
      "network": "mainnet",
      "magic": 860833102,
      "genesisHash": "0x1f4d1defa46faa5e7b9b8d3f79a06bec777d7c26c4aa5f6f5899a291daa87c15",
      "provenance": "neo-go/6d7bd0c7d612c1e9eeaf08efbb8788efef5a449b/config/protocol.mainnet.yml#CreateGenesisBlock"
    },
    "testnet": { "...": "same shape" }
  }
}
```

Generator: `node scripts/generate-network-identities.mjs` rewrites the artifact from the
inputs pinned inside the script. `--check` verifies the committed bytes match and exits
non-zero on any drift. Generation is deterministic: the inputs are reviewed constants
(both magics, both genesis hashes, and the neo-go provenance string for each), so the
output is a pure function of the script. The method is recorded here because the genesis
hashes are protocol facts that cannot be recomputed from the magic alone.

### Identity registry

Path: `src/registry/network-identity-registry.ts`

The only module the rest of the server reads for Neo N3 network identity. It loads the
generated artifact, validates every field fail-closed at module load, and exposes:

| Export | Shape |
| --- | --- |
| `NetworkIdentity` | `{ network, magic, genesisHash, provenance }` (all readonly) |
| `NETWORK_IDENTITIES` | frozen map of network name to identity |
| `networkIdentity(network)` | one identity; throws `ValidationError` on an unknown name |
| `neoNetworkMagic(network)` | the magic integer; throws `ValidationError` on an unknown name |

`src/services/neo-service.ts` re-exports `NEO_NETWORK_MAGIC` from the registry so existing
consumers (`src/contracts/contract-service.ts`) keep their import. The literals
`860833102` and `894710606` must not appear in `src/services/neo-service.ts`.

### Release archive

Script: `scripts/build-release-archive.mjs`

Builds `release-artifacts/neo-mcp-<version>.tar.gz` from the deployable surface of the
branch: `dist/**`, `package.json`, `README.md`, `LICENSE`. The tar is deterministic —
sorted paths, zero mtimes, uid/gid 0, gzip with no embedded timestamp — so two builds of
the same bytes produce the same SHA-256. The script prints one JSON line
(`{"version","archive","sha256","bytes"}`) and exits non-zero if `dist/` is missing or a
required file is absent. `--check-record <path>` rebuilds and compares against the record.

`release-artifacts/` is a build output directory and is gitignored.

### Release record

Path: `docs/RELEASE-RECORD.md`

A checked-in record whose machine-readable block names the archive file, its SHA-256, its
byte length, the source commit, the package version, and the toolchain. The record is not
part of the archive, so it can be committed in the same tree as the code that builds it.

### Version agreement

`tests/version-consistency.test.ts` fails if any of these disagree with
`package.json` `"version"`:

| Surface | How it is read |
| --- | --- |
| `package-lock.json` | root `version` field |
| `src/version.ts` | `SERVER_VERSION` (derived from `package.json` at runtime) |
| `docs/CHANGELOG.md` | the highest `## [X.Y.Z]` heading that is not `Unreleased` |
| `README.md` | `Current version: \`X.Y.Z\`` |
| `docs/VERSION_MANAGEMENT.md` | `Current version: \`X.Y.Z\`` |
| `docs/RELEASE-RECORD.md` | `version` field in the JSON block |

Historical version headings in `docs/CHANGELOG.md` and `website/changelog.html` are not
current-version declarations and are out of scope.

## Data structures

See the interface tables above. All identity fields are validated on load:

- `schemaVersion` must be exactly `1`
- `networks` must have exactly the keys `mainnet` and `testnet`
- `magic` must be a safe positive integer
- `genesisHash` must match `^0x[0-9a-f]{64}$`
- `provenance` must match `^neo-go/[0-9a-f]{40}/`
- each entry's `network` field must equal its key

## Error handling

| Failure | Behaviour |
| --- | --- |
| Identity artifact missing, unparseable, or wrong shape | `Error` at module load naming the field; the server does not start |
| Unknown network name passed to `networkIdentity` / `neoNetworkMagic` | `ValidationError` |
| Release script run without `dist/` | exit 2, message naming the build step |
| Release script run with a required file missing | exit 2, message naming the file |
| `--check-record` hash mismatch | exit 1, message naming expected and actual SHA-256 |
| Generator `--check` drift | exit 1, message naming the artifact path |

Nothing swallows an exception. No fallback magic is provided.

## Performance considerations

Registry load is a single JSON read at module init, frozen afterwards. The release archive
walks `dist/` once and streams into gzip; no file is held in memory beyond one chunk.

## Security implications

Network magic decides which chain a signature is valid on. Sourcing it from one validated
artifact removes the possibility that two call sites drift apart. The release record lets
an operator verify the deployed tree against a pinned hash without trusting the transport
that delivered it. The archive contains no credentials; the record names no secret.

## Usage

```bash
# regenerate identities from pinned inputs
node scripts/generate-network-identities.mjs

# verify committed identities match the generator
node scripts/generate-network-identities.mjs --check

# build dist, then build the reproducible archive
npm run build
node scripts/build-release-archive.mjs

# verify the checked-in record against a fresh build
node scripts/build-release-archive.mjs --check-record docs/RELEASE-RECORD.md
```

Expected output (build-release-archive):

```json
{"version":"4.2.0","archive":"release-artifacts/neo-mcp-4.2.0.tar.gz","sha256":"<64 hex>","bytes":123456}
```

## Migration

No breaking API change. `NEO_NETWORK_MAGIC` keeps its name, shape, and values; only its
source moves. Deployments that pin a git commit see no behavioural difference.

## Deployment

Not in this change. The Hetzner deploy and the new bearer are the owner's step (OP-05,
DEC-DS-16). This slice only makes that deploy verifiable.
