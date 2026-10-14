import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const repoRoot = path.resolve(__dirname, '..');
const builderPath = path.join(repoRoot, 'scripts/build-release-archive.mjs');
const recordPath = path.join(repoRoot, 'docs/RELEASE-RECORD.md');
const tsc = path.join(repoRoot, 'node_modules', '.bin', 'tsc');

const packageVersion = (
  JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string }
).version;

interface BuildResult {
  readonly version: string;
  readonly archive: string;
  readonly sha256: string;
  readonly bytes: number;
}

function runBuilder(args: string[]): string {
  return execFileSync(process.execPath, [builderPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env },
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

function buildOnce(): BuildResult {
  return parseBuildLine(runBuilder([]));
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
    const first = buildOnce();
    const second = buildOnce();
    expect(second.sha256).toBe(first.sha256);
    expect(second.bytes).toBe(first.bytes);
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

    for (const forbiddenPrefix of ['node_modules/', '.git', 'src/', 'tests/', 'docs/', 'scripts/', 'release-artifacts/']) {
      expect(members.some((member) => member.startsWith(forbiddenPrefix))).toBe(false);
    }
    expect(members).not.toContain('docs/RELEASE-RECORD.md');

    // tar member order must be deterministic so the gzip stream is too
    expect([...members].sort()).toEqual(members);
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
    const stdout = runBuilder(['--check-record', recordPath]);
    expect(stdout).toMatch(/record matches/i);
  });

  test('--check-record rejects a record naming the wrong hash', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-mcp-bad-record-'));
    try {
      const record = fs.readFileSync(recordPath, 'utf8');
      const corrupted = record.replace(/"archiveSha256":\s*"[0-9a-f]{64}"/, '"archiveSha256": "' + '0'.repeat(64) + '"');
      expect(corrupted).not.toBe(record);
      const badPath = path.join(scratch, 'bad-record.md');
      fs.writeFileSync(badPath, corrupted);

      expect(() => runBuilder(['--check-record', badPath])).toThrow(/mismatch/i);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
