# Release Record

The reproducible release archive of the Neo MCP deployable surface and the hash that
identifies it. Rebuild and verify with:

```bash
npm run build
node scripts/build-release-archive.mjs
node scripts/build-release-archive.mjs --check-record docs/RELEASE-RECORD.md
```

`--check-record` never writes or repairs the shipped artifact. It rebuilds in memory,
compares every record field to that rebuild (`version`, `archiveFileName`, `archiveBytes`,
`archiveSha256`), verifies `sourceCommit` names a real commit whose `src/`, `package.json`,
`README.md` and `LICENSE` match this working tree, and then hashes
`release-artifacts/*.tar.gz` as found on disk: a missing or corrupt artifact fails the
check and names its path. A wrong value in any checked field fails with a message naming
the field and the record path.

The archive holds exactly `dist/**`, `package.json`, `README.md`, and `LICENSE`. It is
built deterministically (sorted paths, zero mtimes, uid/gid 0, gzip without a timestamp),
so two builds of the same bytes share one SHA-256. The record is not part of the archive,
so it is free to name that hash in the same tree that produces it.

`sourceCommit` is the commit whose tree the archive was built from. The record itself
lands in the following commit.

## Current release

```json
{
  "package": "@r3e/neo-mcp",
  "version": "4.2.0",
  "archiveFileName": "neo-mcp-4.2.0.tar.gz",
  "archiveSha256": "c8b77e4f847be16105b610e55b13f7d92ed3d3ab3867cb1925cf920dd8597d33",
  "archiveBytes": 373431,
  "sourceCommit": "d24c5993f3de0d84c5cd7a7700aae74f3b81dbec",
  "contents": [
    "dist/",
    "package.json",
    "README.md",
    "LICENSE"
  ],
  "toolchain": {
    "node": ">=22",
    "typescript": "5.9.3"
  }
}
```

| Field | Meaning |
| --- | --- |
| `package` | npm package name |
| `version` | the package version; must equal `package.json` and every other current-version surface |
| `archiveFileName` | `neo-mcp-<version>.tar.gz` |
| `archiveSha256` | SHA-256 of the deterministic tar.gz |
| `archiveBytes` | archive length in bytes |
| `sourceCommit` | the git commit whose tree the archive was built from |
| `contents` | the deployable surface the archive is allowed to hold |
| `toolchain` | the toolchain the build is expected to use |

## Verification

`tests/release-archive.test.ts` rebuilds the archive and fails if it does not hash to the
value above, if two builds disagree under different injected wall clocks, if the gzip
header is not fully pinned (MTIME, XFL and OS all fixed), if any tar member carries a
non-zero mtime/uid/gid, or if the archive holds anything outside `contents`.
`--check-record` additionally hashes the shipped `release-artifacts/*.tar.gz`, compares
every record field, binds `sourceCommit` to the build-input tree, and fails rather than
repairing the artifact. `tests/version-consistency.test.ts` fails if `version`
disagrees with `package.json`.

## Scope

This record describes a local reproducible build of the branch. It does not assert a
deployment: the Hetzner deploy and the new bearer are the owner's step (OP-05,
DEC-DS-16) and are deliberately out of scope here. An operator who deploys this archive
should record the deployed host's own `sha256sum` of the file alongside this value.

## Updating this record

Rewrite the JSON block whenever the build output or version changes: bump `version`, re-run
`node scripts/build-release-archive.mjs` after `npm run build`, and copy the printed
`sha256` and `bytes`. Then run `--check-record` before anything is deployed.
