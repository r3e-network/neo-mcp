import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve(__dirname, '..');
const builderPath = path.join(repoRoot, 'scripts/build-release-archive.mjs');
const recordPath = path.join(repoRoot, 'docs/RELEASE-RECORD.md');
const fakeNowPreload = path.join(repoRoot, 'tests/helpers/fake-now.cjs');
const tsc = path.join(repoRoot, 'node_modules', '.bin', 'tsc');

const packageVersion = (
  JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string }
).version;

function shippedArchivePath(): string {
  return path.join(repoRoot, 'release-artifacts', `neo-mcp-${packageVersion}.tar.gz`);
}

interface BuildResult {
  readonly version: string;
  readonly archive: string;
  readonly sha256: string;
  readonly bytes: number;
}

interface BuilderGrammar {
  readonly pattern: RegExp;
  readonly accepted: Readonly<Record<string, boolean>>;
}

interface BuilderGuard {
  readonly forbiddenPrefixes: readonly string[];
  /** Result of `assertMemberAllowed` for the probe path: 'ok' or 'threw'. */
  readonly memberAllowed: Readonly<Record<string, string>>;
}

function loadBuilderGrammarAndGuard(): { grammar: BuilderGrammar; guard: BuilderGuard } {
  const entry = path.join(repoRoot, 'scripts/build-release-archive.mjs');
  const grammarProbes = ['4.2.0', '4.2.0-rc.1', '4.2', '4.2.0+build', 'v4.2.0', ''];
  const memberProbes = [
    'package.json',
    'README.md',
    'LICENSE',
    'dist/index.js',
    'src/foo.ts',
    'src/',
    'tests/foo.test.ts',
    'tests/',
    'docs/RELEASE-RECORD.md',
    'docs/',
    'scripts/build-release-archive.mjs',
    'scripts/',
    'node_modules/x',
    'node_modules/',
    'release-artifacts/x.tar.gz',
    'release-artifacts/',
    '.git',
  ];
  const script = `
    import * as mod from ${JSON.stringify(entry)};
    const grammarProbes = ${JSON.stringify(grammarProbes)};
    const memberProbes = ${JSON.stringify(memberProbes)};
    const accepted = {};
    for (const probe of grammarProbes) accepted[probe] = mod.isPlainPackageVersion(probe);
    const memberAllowed = {};
    for (const probe of memberProbes) {
      try {
        mod.assertMemberAllowed(probe);
        memberAllowed[probe] = 'ok';
      } catch (error) {
        memberAllowed[probe] = 'threw';
      }
    }
    process.stdout.write(JSON.stringify({
      patternSource: mod.PACKAGE_VERSION_PATTERN.source,
      patternFlags: mod.PACKAGE_VERSION_PATTERN.flags,
      accepted,
      forbiddenPrefixes: mod.FORBIDDEN_PREFIXES,
      memberAllowed,
    }));
  `;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const parsed = JSON.parse(stdout) as {
    patternSource: string;
    patternFlags: string;
    accepted: Record<string, boolean>;
    forbiddenPrefixes: string[];
    memberAllowed: Record<string, string>;
  };
  return {
    grammar: {
      pattern: new RegExp(parsed.patternSource, parsed.patternFlags),
      accepted: parsed.accepted,
    },
    guard: {
      forbiddenPrefixes: parsed.forbiddenPrefixes,
      memberAllowed: parsed.memberAllowed,
    },
  };
}

function runBuilder(args: string[], options: { fakeNow?: number } = {}): string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (options.fakeNow !== undefined) {
    env.FAKE_NOW = String(options.fakeNow);
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --require ${fakeNowPreload}`.trim();
  }
  return execFileSync(process.execPath, [builderPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
  });
}

function parseBuildLine(stdout: string): BuildResult {
  const lines = stdout.trim().split('\n');
  const last = lines[lines.length - 1] as string;
  const parsed = JSON.parse(last) as BuildResult;
  return parsed;
}

function listMembers(archivePath: string): string[] {
  const stdout = execFileSync(process.execPath, [builderPath, '--list', '--archive', archivePath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return stdout
    .trim()
    .split('\n')
    .filter((line) => line.length > 0);
}

function buildOnce(options: { fakeNow?: number } = {}): BuildResult {
  return parseBuildLine(runBuilder([], options));
}

describe('reproducible release archive', () => {
  // dist/ is shared with the MCP suites and package-surface; build only when it
  // is missing and never via `npm run build`, whose clean step deletes it first.
  beforeAll(() => {
    if (fs.existsSync(path.join(repoRoot, 'dist', 'mcp-http.js'))) {
      return;
    }
    execFileSync(tsc, [], { cwd: repoRoot, encoding: 'utf8' });
  }, 120_000);

  test('builder exists and emits a machine-readable build line', () => {
    expect(fs.existsSync(builderPath)).toBe(true);

    const result = buildOnce();
    expect(result.version).toBe(packageVersion);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isInteger(result.bytes)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    expect(path.basename(result.archive)).toBe(`neo-mcp-${packageVersion}.tar.gz`);
    expect(fs.existsSync(path.join(repoRoot, result.archive))).toBe(true);
  });

  test('two builds of the same bytes produce the same hash', () => {
    // The two builds run under two *different* injected wall clocks. A gzip
    // MTIME (or any other timestamp) taken from Date.now() therefore cannot
    // hide behind the two builds landing in the same Unix second.
    const first = buildOnce({ fakeNow: 1_000_000_000_000 });
    const second = buildOnce({ fakeNow: 2_000_000_000_000 });
    expect(second.sha256).toBe(first.sha256);
    expect(second.bytes).toBe(first.bytes);
  });

  test('the gzip container carries MTIME=0', () => {
    const result = buildOnce();
    const gz = fs.readFileSync(path.join(repoRoot, result.archive));
    expect(gz[0]).toBe(0x1f);
    expect(gz[1]).toBe(0x8b);
    expect(gz[2]).toBe(0x08); // deflate
    expect(gz[3]).toBe(0x00); // no extra fields
    expect(gz.readUInt32LE(4)).toBe(0);
    expect([...gz.subarray(4, 8)]).toEqual([0, 0, 0, 0]);
  });

  test('archive holds exactly the deployable surface', () => {
    const result = buildOnce();
    const members = listMembers(path.join(repoRoot, result.archive));

    expect(members).toContain('package.json');
    expect(members).toContain('README.md');
    expect(members).toContain('LICENSE');
    expect(members.some((member) => member.startsWith('dist/'))).toBe(true);
    expect(members).toContain('dist/mcp-http.js');
    expect(members).toContain('dist/index.js');

    // Collection is a whitelist, so a loosened FORBIDDEN_PREFIXES would not
    // change the members list on its own. The behavioural half is real: feed
    // the production guard a forbidden path and require it to reject.
    expect(members.some((member) => member.startsWith('src/'))).toBe(false);
    expect(members).not.toContain('docs/RELEASE-RECORD.md');

    // tar member order must be deterministic so the gzip stream is too
    expect([...members].sort()).toEqual(members);
  });

  test('the forbidden-member guard rejects every forbidden family', () => {
    const { guard } = loadBuilderGrammarAndGuard();
    expect(guard.forbiddenPrefixes).toEqual([
      'node_modules/',
      '.git',
      'src/',
      'tests/',
      'docs/',
      'scripts/',
      'release-artifacts/',
    ]);
    for (const prefix of guard.forbiddenPrefixes) {
      expect(guard.memberAllowed[prefix]).toBe('threw');
    }
    expect(guard.memberAllowed['src/foo.ts']).toBe('threw');
    expect(guard.memberAllowed['tests/foo.test.ts']).toBe('threw');
    expect(guard.memberAllowed['package.json']).toBe('ok');
    expect(guard.memberAllowed['README.md']).toBe('ok');
    expect(guard.memberAllowed['LICENSE']).toBe('ok');
    expect(guard.memberAllowed['dist/index.js']).toBe('ok');
  });

  test('builder fails closed when dist/ is absent', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-mcp-no-dist-'));
    try {
      fs.writeFileSync(
        path.join(fixture, 'package.json'),
        JSON.stringify({ name: '@r3e/neo-mcp', version: packageVersion }),
      );
      fs.writeFileSync(path.join(fixture, 'README.md'), '# fixture\n');
      fs.writeFileSync(path.join(fixture, 'LICENSE'), 'MIT\n');
      expect(() =>
        execFileSync(process.execPath, [builderPath, '--root', fixture], {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: 'pipe',
        }),
      ).toThrow(/dist/);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  test('builder fails closed when a required member is absent', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-mcp-no-license-'));
    try {
      fs.writeFileSync(
        path.join(fixture, 'package.json'),
        JSON.stringify({ name: '@r3e/neo-mcp', version: packageVersion }),
      );
      fs.writeFileSync(path.join(fixture, 'README.md'), '# fixture\n');
      fs.mkdirSync(path.join(fixture, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(fixture, 'dist', 'mcp-http.js'), 'module.exports = {};\n');
      expect(() =>
        execFileSync(process.execPath, [builderPath, '--root', fixture], {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: 'pipe',
        }),
      ).toThrow(/LICENSE/);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  test('builder rejects a missing --check-record argument', () => {
    expect(() => runBuilder(['--check-record'])).toThrow();
  });

  test('builder rejects an empty --root', () => {
    expect(() => runBuilder(['--root', ''])).toThrow();
  });
});

describe('release record', () => {
  test('record exists and names the archive hash of a fresh build', () => {
    expect(fs.existsSync(recordPath)).toBe(true);

    const record = fs.readFileSync(recordPath, 'utf8');
    const block = record.match(/```json\s*([\s\S]*?)```/);
    expect(block).not.toBeNull();
    const parsed = JSON.parse((block as RegExpMatchArray)[1] as string) as {
      version?: unknown;
      archiveFileName?: unknown;
      archiveSha256?: unknown;
      archiveBytes?: unknown;
      sourceCommit?: unknown;
    };

    expect(parsed.version).toBe(packageVersion);
    expect(parsed.archiveFileName).toBe(`neo-mcp-${packageVersion}.tar.gz`);
    expect(parsed.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isInteger(parsed.archiveBytes)).toBe(true);
    expect(parsed.sourceCommit).toMatch(/^[0-9a-f]{40}$/);

    const fresh = buildOnce();
    expect(parsed.archiveSha256).toBe(fresh.sha256);
    expect(parsed.archiveBytes).toBe(fresh.bytes);
    expect(parsed.archiveFileName).toBe(path.basename(fresh.archive));
  });

  test('--check-record accepts the checked-in record', () => {
    buildOnce();
    const stdout = runBuilder(['--check-record', recordPath]);
    expect(stdout).toMatch(/record matches/i);
  });

  test('--check-record rejects a record naming the wrong hash', () => {
    buildOnce();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-mcp-bad-record-'));
    try {
      const record = fs.readFileSync(recordPath, 'utf8');
      const corrupted = record.replace(/"archiveSha256":\s*"[0-9a-f]{64}"/, '"archiveSha256": "' + '0'.repeat(64) + '"');
      expect(corrupted).not.toBe(record);
      const badPath = path.join(scratch, 'bad-record.md');
      fs.writeFileSync(badPath, corrupted);

      expect(() => runBuilder(['--check-record', badPath])).toThrow(/record mismatch: expected/i);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('--check-record rejects a record naming the wrong version', () => {
    buildOnce();
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-mcp-bad-version-'));
    try {
      const record = fs.readFileSync(recordPath, 'utf8');
      const corrupted = record.replace(
        new RegExp(`"version":\\s*"${packageVersion.replace(/\./g, '\\.')}"`),
        '"version": "0.0.0-wrong"',
      );
      expect(corrupted).not.toBe(record);
      const badPath = path.join(scratch, 'bad-version-record.md');
      fs.writeFileSync(badPath, corrupted);

      expect(() => runBuilder(['--check-record', badPath])).toThrow(/record mismatch: version/i);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('--check-record rejects a corrupt shipped artifact and does not repair it', () => {
    buildOnce();
    const archivePath = shippedArchivePath();
    const good = fs.readFileSync(archivePath);
    const corrupt = Buffer.from(good);
    corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] as number) ^ 0xff;
    expect(corrupt.equals(good)).toBe(false);
    try {
      fs.writeFileSync(archivePath, corrupt);
      expect(() => runBuilder(['--check-record', recordPath])).toThrow();
      // the whole point of F4: verification must not overwrite the evidence
      expect(fs.readFileSync(archivePath).equals(corrupt)).toBe(true);
    } finally {
      fs.writeFileSync(archivePath, good);
    }
  });

  test('--check-record fails closed when the shipped artifact is missing', () => {
    buildOnce();
    const archivePath = shippedArchivePath();
    const good = fs.readFileSync(archivePath);
    try {
      fs.rmSync(archivePath);
      expect(() => runBuilder(['--check-record', recordPath])).toThrow();
      expect(fs.existsSync(archivePath)).toBe(false);
    } finally {
      fs.writeFileSync(archivePath, good);
    }
  });
});
