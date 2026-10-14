# Neo N3 Network Identities

The server signs and validates against two Neo N3 networks. Each network's identity —
its network magic, genesis hash, and the reviewed source those values came from — lives
in one generated artifact and is read through one registry. No other module restates a
magic.

## Files

| Path | Role |
| --- | --- |
| `scripts/generate-network-identities.mjs` | the only writer of the artifact; pinned inputs live here |
| `src/config/generated/network-identities.v1.json` | generated, committed, never hand-edited |
| `src/registry/network-identity-registry.ts` | the registry the server reads |
| `tests/network-identity-source.test.ts` | generator, artifact, and registry tests |

## The generated artifact

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
    "testnet": {
      "network": "testnet",
      "magic": 894710606,
      "genesisHash": "0x9d3276785e7306daf59a3f3b9e31912c095598bbfb8a4476b821b0e59be4c57a",
      "provenance": "neo-go/6d7bd0c7d612c1e9eeaf08efbb8788efef5a449b/config/protocol.testnet.yml#CreateGenesisBlock"
    }
  }
}
```

## Method

Generation is deterministic and the inputs are pinned inside the generator:

- **magic** — the `Magic` value of the named neo-go protocol config.
- **genesisHash** — the hash of the genesis block that config produces. It is a protocol
  fact and cannot be recomputed from the magic alone, so it is pinned alongside it.
- **provenance** — the reviewed neo-go commit, the config file, and the function that
  derives the genesis hash.

Because the inputs are reviewed constants, the output is a pure function of the script.
Re-running it always produces the same bytes.

## Operator commands

```bash
# regenerate the artifact from the pinned inputs
node scripts/generate-network-identities.mjs

# verify the committed artifact has not drifted from the generator
node scripts/generate-network-identities.mjs --check

# run the identity, registry, and magic-re-sourcing tests
npx jest tests/network-identity-source.test.ts --runInBand
```

`--check` exits 1 on drift and names the artifact path. It is safe to run in CI.

## Registry contract

`src/registry/network-identity-registry.ts` is the only local authority. It validates the
artifact at module load and refuses to start on any malformed shape:

| Field | Rule |
| --- | --- |
| `schemaVersion` | exactly `1` |
| `networks` | exactly the keys `mainnet` and `testnet` |
| `network` | equals its key |
| `magic` | positive safe integer |
| `genesisHash` | `^0x[0-9a-f]{64}$` |
| `provenance` | `^neo-go/[0-9a-f]{40}/` |

Exports:

| Export | Behaviour |
| --- | --- |
| `NETWORK_IDENTITIES` | frozen map of network name to identity |
| `networkIdentity(network)` | one identity; throws `ValidationError` on an unknown name |
| `neoNetworkMagic(network)` | the magic integer; throws `ValidationError` on an unknown name |
| `parseNetworkIdentities(raw)` | validate an untrusted document; throws on any malformed shape |

`src/services/neo-service.ts` re-exports `NEO_NETWORK_MAGIC` from the registry, so existing
consumers keep their import and the literals `860833102` and `894710606` no longer appear
in that file.

## Error handling

| Failure | Behaviour |
| --- | --- |
| Artifact missing, unparseable, or wrong shape | `Error` at module load naming the field; the server does not start |
| Unknown network name passed to `networkIdentity` / `neoNetworkMagic` | `ValidationError` |
| Generator `--check` drift | exit 1, message naming the artifact path |
| Generator write failure | exit 2 |

There is no fallback magic. A server that cannot prove its network identity does not run.

## Security

The network magic decides which chain a signature is valid on. Sourcing it from one
validated artifact removes the possibility that two call sites drift apart and sign
against different networks. The artifact carries no secret; the provenance string is
public review evidence.
