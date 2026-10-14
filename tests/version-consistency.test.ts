import fs from 'fs';
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

describe('version string agreement', () => {
  test('package.json declares a plain semver version', () => {
    expect(packageVersion).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/);
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

  test('the accepted version grammar covers a semver prerelease and rejects debris', () => {
    const semver = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
    expect('4.2.0-rc.1').toMatch(semver);
    expect('4.2.0').toMatch(semver);
    expect('4.2').not.toMatch(semver);
    expect('4.2.0+build').not.toMatch(semver);
    expect('v4.2.0').not.toMatch(semver);
  });
});
