import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve(__dirname, '..');

interface VersionSurface {
  readonly name: string;
  readonly read: () => string;
}

function readText(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function firstMatch(pattern: RegExp, text: string, surfaceName: string): string {
  const match = text.match(pattern);
  if (!match || match[1] === undefined) {
    throw new Error(`version surface "${surfaceName}" no longer matches ${pattern}`);
  }
  return match[1];
}

const packageVersion = (
  JSON.parse(readText('package.json')) as { version: string }
).version;

/**
 * Every surface that declares the *current* package version. Historical version
 * headings (docs/CHANGELOG.md older entries, website/changelog.html) are not
 * current-version declarations and are deliberately absent.
 */
const VERSION_SURFACES: readonly VersionSurface[] = [
  {
    name: 'package.json',
    read: () => packageVersion,
  },
  {
    name: 'package-lock.json',
    read: () => (JSON.parse(readText('package-lock.json')) as { version: string }).version,
  },
  {
    // src/version.ts derives SERVER_VERSION from package.json at runtime, so it
    // cannot disagree by construction; the check is that the derivation is real.
    name: 'src/version.ts (SERVER_VERSION derivation)',
    read: () => {
      const source = readText('src/version.ts');
      if (!source.includes("from '../package.json'") && !source.includes('from "../package.json"')) {
        throw new Error('src/version.ts must derive SERVER_VERSION from package.json');
      }
      return packageVersion;
    },
  },
  {
    name: 'docs/CHANGELOG.md (latest released heading)',
    read: () => {
      const headings = [...readText('docs/CHANGELOG.md').matchAll(/^## \[([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\]/gm)].map(
        (match) => match[1] as string,
      );
      if (headings.length === 0) {
        throw new Error('docs/CHANGELOG.md has no released version heading');
      }
      return headings[0] as string;
    },
  },
  {
    name: 'README.md (Current version)',
    read: () => firstMatch(/Current version:\s*`([^`]+)`/, readText('README.md'), 'README.md'),
  },
  {
    name: 'docs/VERSION_MANAGEMENT.md (Current version)',
    read: () =>
      firstMatch(
        /Current version:\s*`([^`]+)`/,
        readText('docs/VERSION_MANAGEMENT.md'),
        'docs/VERSION_MANAGEMENT.md',
      ),
  },
  {
    name: 'docs/RELEASE-RECORD.md (version field)',
    read: () => {
      const record = readText('docs/RELEASE-RECORD.md');
      const block = record.match(/```json\s*([\s\S]*?)```/);
      if (!block || block[1] === undefined) {
        throw new Error('docs/RELEASE-RECORD.md has no machine-readable json block');
      }
      const parsed = JSON.parse(block[1]) as { version?: unknown };
      if (typeof parsed.version !== 'string') {
        throw new Error('docs/RELEASE-RECORD.md json block has no string version');
      }
      return parsed.version;
    },
  },
];

/**
 * The production version grammar lives in `scripts/build-release-archive.mjs`
 * (`readPackageVersion`). The builder is an ES module that Jest cannot import
 * without `--experimental-vm-modules`, so the export is read through a short
 * node child. The test asserts against that export, not against a local copy,
 * so a loosened production grammar is a caught mutant.
 */
function loadProductionVersionGrammar(): {
  pattern: RegExp;
  accepted: Readonly<Record<string, boolean>>;
} {
  const entry = path.join(repoRoot, 'scripts/build-release-archive.mjs');
  const probes = ['4.2.0', '4.2.0-rc.1', '4.2', '4.2.0+build', 'v4.2.0', ''];
  const script = `
    import { PACKAGE_VERSION_PATTERN, isPlainPackageVersion } from ${JSON.stringify(entry)};
    const probes = ${JSON.stringify(probes)};
    const accepted = {};
    for (const probe of probes) accepted[probe] = isPlainPackageVersion(probe);
    process.stdout.write(JSON.stringify({
      source: PACKAGE_VERSION_PATTERN.source,
      flags: PACKAGE_VERSION_PATTERN.flags,
      accepted,
    }));
  `;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const parsed = JSON.parse(stdout) as {
    source: string;
    flags: string;
    accepted: Record<string, boolean>;
  };
  return {
    pattern: new RegExp(parsed.source, parsed.flags),
    accepted: parsed.accepted,
  };
}

describe('version string agreement', () => {
  test('package.json declares a plain semver version', () => {
    const { pattern } = loadProductionVersionGrammar();
    expect(packageVersion).toMatch(pattern);
  });

  test('every declared current-version surface agrees with package.json', () => {
    const disagreements: string[] = [];
    for (const surface of VERSION_SURFACES) {
      let actual: string;
      try {
        actual = surface.read();
      } catch (error) {
        disagreements.push(
          `${surface.name}: unreadable (${error instanceof Error ? error.message : String(error)})`,
        );
        continue;
      }
      if (actual !== packageVersion) {
        disagreements.push(`${surface.name}: "${actual}" != "${packageVersion}"`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  test('the changelog extractor skips Unreleased and takes the first released heading', () => {
    const headings = [
      ...readText('docs/CHANGELOG.md').matchAll(
        /^## \[([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\]/gm,
      ),
    ].map((match) => match[1] as string);
    expect(headings[0]).toBe(packageVersion);
    expect(headings).not.toContain('Unreleased');
    expect(readText('docs/CHANGELOG.md')).toMatch(/^## \[Unreleased\]/m);
  });

  test('the production version grammar covers a semver prerelease and rejects debris', () => {
    const { pattern, accepted } = loadProductionVersionGrammar();

    expect('4.2.0-rc.1').toMatch(pattern);
    expect('4.2.0').toMatch(pattern);
    expect('4.2').not.toMatch(pattern);
    expect('4.2.0+build').not.toMatch(pattern);
    expect('v4.2.0').not.toMatch(pattern);
    expect('').not.toMatch(pattern);

    // the predicate the builder actually calls must agree with the pattern
    expect(accepted['4.2.0']).toBe(true);
    expect(accepted['4.2.0-rc.1']).toBe(true);
    expect(accepted['4.2']).toBe(false);
    expect(accepted['4.2.0+build']).toBe(false);
    expect(accepted['v4.2.0']).toBe(false);
    expect(accepted['']).toBe(false);
  });

  test('readPackageVersion rejects a debris version at the builder boundary', () => {
    // Fixture name deliberately avoids the words the pin matches, so the
    // assertion cannot pass on the scratch path alone (the F6 self-finding).
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-mcp-debris-grammar-'));
    try {
      fs.writeFileSync(
        path.join(fixture, 'package.json'),
        JSON.stringify({ name: '@r3e/neo-mcp', version: 'v4.2.0' }),
      );
      fs.writeFileSync(path.join(fixture, 'README.md'), '# fixture\n');
      fs.writeFileSync(path.join(fixture, 'LICENSE'), 'MIT\n');
      fs.mkdirSync(path.join(fixture, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(fixture, 'dist', 'index.js'), 'module.exports = {};\n');
      fs.writeFileSync(path.join(fixture, 'dist', 'mcp-http.js'), 'module.exports = {};\n');
      expect(() =>
        execFileSync(
          process.execPath,
          [path.join(repoRoot, 'scripts/build-release-archive.mjs'), '--root', fixture],
          { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' },
        ),
      ).toThrow(/package\.json version must be a plain semver/i);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});
