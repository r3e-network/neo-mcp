# Release Record

The reproducible release archive of the Neo MCP deployable surface and the hash that
identifies it. Rebuild and verify with:

```bash
npm run build
node scripts/build-release-archive.mjs --check-record docs/RELEASE-RECORD.md
```

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
  "archiveSha256": "a00e059f9faeb23f85aeba3d89ab851d63a930a9037d71db169109a0f8f4d362",
  "archiveBytes": 373066,
  "sourceCommit": "08ab6e97524a9b07ed48c98682bde2a3f177d08b",
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
value above, if two builds disagree, or if the archive holds anything outside `contents`.
`tests/version-consistency.test.ts` fails if `version` disagrees with `package.json`.

## Scope

This record describes a local reproducible build of the branch. It does not assert a
deployment: the Hetzner deploy and the new bearer are the owner's step (OP-05,
DEC-DS-16) and are deliberately out of scope here. An operator who deploys this archive
should record the deployed host's own `sha256sum` of the file alongside this value.

## Updating this record

Rewrite the JSON block whenever the build output or version changes: bump `version`, re-run
`node scripts/build-release-archive.mjs` after `npm run build`, and copy the printed
`sha256` and `bytes`. Then run `--check-record` before anything is deployed.
