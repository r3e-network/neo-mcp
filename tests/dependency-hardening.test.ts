import fs from 'fs';
import path from 'path';

// GHSA-mh99-v99m-4gvg and GHSA-rgw5-rvv9-x895: brace-expansion <= 5.0.8 can
// produce unbounded intermediate arrays, so a repeated `{a,b}` pattern can end the
// process with an uncatchable OOM. Version 5.0.9 applies the complete cap, but its
// CommonJS build is not callable, which is why every consumer is routed through
// tools/brace-expansion-cjs. These checks fail if that wiring is dropped or a
// vulnerable copy returns to the tree.
const MINIMUM_PATCHED_VERSION = [5, 0, 9] as const;
const WRAPPER_SPEC = 'file:./tools/brace-expansion-cjs';
const SELF_REFERENCE_OVERRIDE = '$brace-expansion';

function parseVersion(version: string): number[] {
  return version
    .split('-')[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10));
}

function isAtLeastPatched(version: string): boolean {
  const parsed = parseVersion(version);
  for (let index = 0; index < MINIMUM_PATCHED_VERSION.length; index += 1) {
    const actual = parsed[index] ?? 0;
    const required = MINIMUM_PATCHED_VERSION[index];
    if (actual > required) return true;
    if (actual < required) return false;
  }
  return true;
}

function collectInstalledManifests(repoRoot: string): string[] {
  const manifests: string[] = [];
  const pending = [path.join(repoRoot, 'node_modules')];

  while (pending.length > 0) {
    const directory = pending.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

      const entryPath = path.join(directory, entry.name);
      if (entry.name.startsWith('@')) {
        pending.push(entryPath);
        continue;
      }

      const manifestPath = path.join(entryPath, 'package.json');
      if (fs.existsSync(manifestPath)) manifests.push(manifestPath);

      const nestedRoot = path.join(entryPath, 'node_modules');
      if (fs.existsSync(nestedRoot)) pending.push(nestedRoot);
    }
  }

  return manifests;
}

describe('dependency hardening', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    devDependencies: Record<string, string>;
    overrides: Record<string, unknown>;
  };

  test('routes brace-expansion through the CommonJS-callable wrapper', () => {
    expect(packageJson.devDependencies['brace-expansion']).toBe(WRAPPER_SPEC);
    // The override must be the self-reference form: a bare `file:` spec inside overrides
    // resolves relative to the dependent package, which produces a dangling symlink.
    expect(packageJson.overrides['brace-expansion']).toBe(SELF_REFERENCE_OVERRIDE);
  });

  test('the wrapper aliases the patched upstream instead of shadowing itself', () => {
    const wrapperRoot = path.join(repoRoot, 'tools', 'brace-expansion-cjs');
    const wrapperManifest = JSON.parse(
      fs.readFileSync(path.join(wrapperRoot, 'package.json'), 'utf8')
    ) as { dependencies: Record<string, string> };
    const alias = wrapperManifest.dependencies['brace-expansion-upstream'];

    expect(alias).toMatch(/^npm:brace-expansion@/);
    expect(isAtLeastPatched(alias.replace('npm:brace-expansion@', ''))).toBe(true);
    // An un-aliased dependency would be caught by the root override and resolve back
    // into this wrapper, so the alias is what keeps the indirection acyclic.
    expect(wrapperManifest.dependencies['brace-expansion']).toBeUndefined();

    // Comments in the wrapper quote the broken consumer calls verbatim, so only the
    // executable lines are checked for a require of the un-aliased name.
    const wrapperCode = fs
      .readFileSync(path.join(wrapperRoot, 'index.js'), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    expect(wrapperCode).toMatch(/require\((['"])brace-expansion-upstream\1\)/);
    expect(wrapperCode).not.toMatch(/require\((['"])brace-expansion\1\)/);
  });

  test('exposes a callable module export for every consumer calling convention', () => {
    const braceExpansion = require('brace-expansion');

    // minimatch@3 calls the module export directly; minimatch@9 reads `.default`.
    expect(typeof braceExpansion).toBe('function');
    expect(typeof braceExpansion.expand).toBe('function');
    expect(typeof braceExpansion.default).toBe('function');
    expect(braceExpansion('a{1,2}b')).toEqual(['a1b', 'a2b']);
  });

  test('bounds the expansion the advisory exploits', () => {
    const braceExpansion = require('brace-expansion');

    expect(typeof braceExpansion.EXPANSION_MAX).toBe('number');
    expect(typeof braceExpansion.EXPANSION_MAX_LENGTH).toBe('number');

    // 2^20 combinations unbounded; the patched implementation truncates at the cap
    // rather than exhausting memory.
    expect(braceExpansion('{a,b}'.repeat(20))).toHaveLength(braceExpansion.EXPANSION_MAX);
    expect(braceExpansion('{0..1000000}')).toHaveLength(braceExpansion.EXPANSION_MAX);
  });

  test('keeps the brace expansion consumers working', () => {
    const minimatch = require('minimatch');

    expect(minimatch('a1.js', 'a{1,2}.js')).toBe(true);
    expect(minimatch('a3.js', 'a{1,2}.js')).toBe(false);
  });

  test('installs no brace-expansion copy below the patched version', () => {
    const vulnerable = collectInstalledManifests(repoRoot)
      .map((manifestPath) => ({
        manifestPath,
        manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
          name?: string;
          version?: string;
        },
      }))
      .filter(({ manifest }) => manifest.name === 'brace-expansion')
      .filter(({ manifest }) => !isAtLeastPatched(manifest.version ?? '0.0.0'))
      .map(({ manifest, manifestPath }) =>
        `${path.relative(repoRoot, manifestPath)} @ ${manifest.version}`
      );

    expect(vulnerable).toEqual([]);
  });

  test.each(['docker/Dockerfile', 'docker/Dockerfile.dev'])(
    '%s copies the wrapper before installing dependencies',
    (relativePath) => {
      const dockerfile = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
      const copyIndex = dockerfile.indexOf('COPY tools ./tools');
      const installIndex = dockerfile.indexOf('RUN npm ci');

      expect(copyIndex).toBeGreaterThanOrEqual(0);
      expect(installIndex).toBeGreaterThan(copyIndex);
    }
  );

  // GHSA-frvp-7c67-39w9: @hono/node-server < 2.0.5 resolves encoded backslashes in
  // serveStatic paths on Windows. The MCP SDK's streamableHttp transport - the one this
  // server runs on - depends on `^1.19.9`, a range that can never reach the patched line,
  // and npm does not propagate `overrides` to downstream installers. So our own installs
  // and images are patched by the override below, while anyone who runs
  // `npm install @r3e/neo-mcp` inherits the vulnerable copy and sees the advisory. These
  // checks keep the override in place and keep that asymmetry documented.
  describe('hono node server advisory', () => {
    const MINIMUM_PATCHED_HONO = [2, 0, 5] as const;

    function isAtLeastHonoPatched(version: string): boolean {
      const parsed = parseVersion(version);
      for (let index = 0; index < MINIMUM_PATCHED_HONO.length; index += 1) {
        const actual = parsed[index] ?? 0;
        const required = MINIMUM_PATCHED_HONO[index];
        if (actual > required) return true;
        if (actual < required) return false;
      }
      return true;
    }

    test('overrides the transport dependency onto the patched line', () => {
      const override = packageJson.overrides['@hono/node-server'];

      expect(typeof override).toBe('string');
      expect(isAtLeastHonoPatched((override as string).replace(/^[^0-9]*/, ''))).toBe(true);
    });

    test('installs no @hono/node-server copy below the patched version', () => {
      const vulnerable = collectInstalledManifests(repoRoot)
        .map((manifestPath) => ({
          manifestPath,
          manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
            name?: string;
            version?: string;
          },
        }))
        .filter(({ manifest }) => manifest.name === '@hono/node-server')
        .filter(({ manifest }) => !isAtLeastHonoPatched(manifest.version ?? '0.0.0'))
        .map(
          ({ manifest, manifestPath }) =>
            `${path.relative(repoRoot, manifestPath)} @ ${manifest.version}`
        );

      expect(vulnerable).toEqual([]);
    });

    test('never reaches the serveStatic surface the advisory covers', () => {
      const sources = fs
        .readdirSync(path.join(repoRoot, 'src'), { recursive: true, encoding: 'utf8' })
        .filter((entry) => entry.endsWith('.ts'))
        .map((entry) => fs.readFileSync(path.join(repoRoot, 'src', entry), 'utf8'));

      expect(sources.length).toBeGreaterThan(0);
      expect(sources.filter((source) => /serveStatic|serve-static/.test(source))).toEqual([]);
    });

    test('tells downstream installers to apply the override themselves', () => {
      const guide = fs.readFileSync(path.join(repoRoot, 'docs', 'DEPLOYMENT.md'), 'utf8');

      expect(guide).toContain('GHSA-frvp-7c67-39w9');
      expect(guide).toContain('@hono/node-server');
      expect(guide).toContain('overrides');
    });
  });
});
