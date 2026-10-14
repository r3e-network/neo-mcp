# Version Management Guide

Neo MCP follows [Semantic Versioning](https://semver.org/) using `MAJOR.MINOR.PATCH`.

Current version: `4.2.0`.

## Version Source

`package.json` is the source of truth. `package-lock.json` is updated with it, and `src/version.ts` reads the package version at runtime. Rebuild after a version change so `dist/` reflects the new package metadata.

Update release notes in `docs/CHANGELOG.md`. Do not maintain a separate Docker configuration version; container tags are derived by the release workflow or supplied to the build helper.

Check the current version:

```bash
npm run version:check
```

## Recommended Release Preparation

The release script requires a clean working tree and Node.js `>=22`:

```bash
./scripts/prepare-release.sh --type patch --dry-run
./scripts/prepare-release.sh --type patch
```

Supported version types are `patch`, `minor`, and `major`. Supported options:

```text
--type TYPE     patch, minor, or major
--dry-run       verify without changing the version
--skip-docker   skip local image builds
```

The script performs these checks before changing the version:

1. Installs the lockfile with `npm ci`.
2. Runs type checking and deterministic unit tests.
3. Builds `dist/` and runs deterministic MCP smoke and lifecycle tests.
4. Runs full and production-only dependency audits at `high` severity.
5. Validates the npm package with `npm pack --dry-run`.
6. Validates both Compose files.
7. Builds production and development images unless `--skip-docker` is set.

On a non-dry run it then runs `npm version <type> --no-git-tag-version`. It does not create a commit, tag, GitHub release, or deployment.

## Release Procedure

1. Start from the intended release branch with a clean working tree.
2. Run a dry run:

   ```bash
   ./scripts/prepare-release.sh --type patch --dry-run
   ```

3. Prepare the version:

   ```bash
   ./scripts/prepare-release.sh --type patch
   ```

4. Update `docs/CHANGELOG.md` and any version-specific user-facing documentation.
5. Review `package.json`, `package-lock.json`, generated package contents, and documentation. The preparation checks ran immediately before the version change; run any additional checks needed for the documentation-only follow-up edits.
6. Commit using the repository's Lore commit format, then create and push the matching tag:

   ```bash
   git tag v2.0.1
   git push origin HEAD
   git push origin v2.0.1
   ```

7. Publish a GitHub release for that tag:

   ```bash
   gh release create v2.0.1 --generate-notes
   ```

Publishing the GitHub release triggers the npm and Docker publishing jobs. A pushed tag by itself does not run those publish jobs.

## Reproducible Release Archive and Release Record

`scripts/build-release-archive.mjs` builds a deterministic tar.gz of the deployable
surface (`dist/**`, `package.json`, `README.md`, `LICENSE`) and prints one JSON line
naming the archive, its SHA-256, and its byte length. Paths are sorted, tar headers are
normalized (zero mtimes, uid/gid 0), and the gzip container carries no timestamp, so two
builds of the same bytes produce the same hash.

```bash
npm run build
node scripts/build-release-archive.mjs
node scripts/build-release-archive.mjs --check-record docs/RELEASE-RECORD.md
```

`docs/RELEASE-RECORD.md` is the checked-in record naming that hash, the archive file, the
package version, and the source commit the archive was built from. The record is not part
of the archive, so it can be committed in the same tree as the code that builds it. Update
it in the same change that bumps the version or alters the build output, and re-run
`--check-record` before deploying.

`tests/version-consistency.test.ts` fails when any current-version surface (`package.json`,
`package-lock.json`, `src/version.ts`, `docs/CHANGELOG.md`, `README.md`, this file, and the
release record) disagrees with `package.json`. `tests/release-archive.test.ts` fails when
the archive is not reproducible or the record names a different hash.

`release-artifacts/` is a build output directory and is gitignored.

## Version Types

| Type | Example | Use for |
| --- | --- | --- |
| Patch | `2.0.0` to `2.0.1` | Compatible fixes and security updates |
| Minor | `2.0.0` to `2.1.0` | Backward-compatible features |
| Major | `2.0.0` to `3.0.0` | Breaking API, configuration, or behavior changes |

The convenience scripts `npm run version:patch`, `version:minor`, and `version:major` call `npm version` directly. In a Git repository, npm may create a version commit and tag. Prefer `prepare-release.sh` when you want verification first and explicit control of the commit and tag.

## CI and Publishing

`.github/workflows/ci.yml` validates pushes and pull requests with:

- unit tests on Node.js 22 and 24
- type checking and coverage
- a clean TypeScript build
- deterministic built MCP tests
- npm package-content validation
- full and production-only dependency audits
- Compose validation and both container builds

On a published GitHub release, successful validation can publish:

- the npm package using Trusted Publishing over GitHub Actions OIDC
- Docker images using `DOCKER_USERNAME` and `DOCKER_PASSWORD`

A shared release gate requires the tag, after an optional leading `v`, to match
`package.json`. The workflow publishes the validated npm tarball directly to its
final channel through OIDC and publishes a health-tested versioned container
candidate. Only after both succeed does a serialized, monotonic promotion move
floating Docker channels. Stable versions use npm `latest` and full, minor,
major, and `latest` Docker tags. SemVer prereleases require a GitHub prerelease
and use npm `next` plus only the full prerelease Docker tag.

The repository does not define an automated production deployment, monitoring target, or rollback workflow. Operators must deploy and observe the published artifact in their own environment.

## Dependency Audit

Both audit commands are expected to pass:

```bash
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high
```

The lockfile uses a scoped override that pins the `lodash` dependency under `@cityofzion/neon-core` to `4.18.1`. Keep the override scoped and re-run both audits whenever Neo dependencies or the lockfile change.

## Manual Version Update

When the release script is unavailable:

```bash
npm ci
npm run verify
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high
npm pack --dry-run
npm version patch --no-git-tag-version
```

Then update the changelog, review `package.json` and `package-lock.json`, rebuild, and follow the commit, tag, and GitHub release steps above.

## Failure and Recovery

- Verification failure: fix the cause and rerun the preparation script; do not bypass deterministic tests or audits.
- npm publish failure: verify the tag, package version, registry status, OIDC
  permission, and the npm Trusted Publisher binding to `r3e-network/neo-mcp`
  workflow `ci.yml`.
- Docker publish failure: verify Docker Hub credentials, repository access, and the image-build job.
- Partial release: do not reuse a published version. Correct the issue and prepare a new patch version.
- Deployment rollback: redeploy the prior known-good npm or image version in the operator-managed environment.

See [CHANGELOG.md](./CHANGELOG.md) for historical release notes.
