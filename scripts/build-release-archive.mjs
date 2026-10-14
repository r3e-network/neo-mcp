#!/usr/bin/env node
/**
 * Build a reproducible release archive of the branch build.
 *
 * The archive is a deterministic tar.gz of the deployable surface: `dist/**`,
 * `package.json`, `README.md`, `LICENSE`. Paths are sorted, every header field
 * that varies per machine (mtime, uid, gid, uname, gname) is normalized, and
 * the gzip container carries no timestamp or original filename, so two builds
 * of the same bytes produce the same SHA-256. The hash is what
 * `docs/RELEASE-RECORD.md` pins.
 *
 * Usage:
 *   node scripts/build-release-archive.mjs
 *   node scripts/build-release-archive.mjs --root DIR --out DIR
 *   node scripts/build-release-archive.mjs --list --archive FILE
 *   node scripts/build-release-archive.mjs --check-record FILE
 *
 * `--check-record` verifies the record against a fresh in-memory build *and*
 * against the shipped artifact on disk. It never writes or repairs the
 * artifact: a missing or corrupt artifact is a failure naming its path.
 *
 * Exit codes: 0 success, 1 record/hash mismatch, 2 usage or missing input.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ARCHIVE_MEMBERS = ['package.json', 'README.md', 'LICENSE'];
const REQUIRED_DIST_ENTRIES = ['index.js', 'mcp-http.js'];

/**
 * Families that must never enter the archive. Collection is a whitelist, so
 * this guard is defence in depth: `assertMemberAllowed` is exported and the
 * tests feed it forbidden paths directly.
 */
export const FORBIDDEN_PREFIXES = ['node_modules/', '.git', 'src/', 'tests/', 'docs/', 'scripts/', 'release-artifacts/'];

/**
 * The only accepted `package.json` version shape: a plain semver release with
 * an optional prerelease. Exported so tests assert against this exact pattern
 * rather than a private copy that can drift from `readPackageVersion`.
 */
export const PACKAGE_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

export function isPlainPackageVersion(value) {
  return typeof value === 'string' && PACKAGE_VERSION_PATTERN.test(value);
}

export function assertMemberAllowed(relativePath) {
  for (const forbidden of FORBIDDEN_PREFIXES) {
    if (relativePath === forbidden || relativePath.startsWith(forbidden)) {
      throw new Error(`refusing to archive ${relativePath}`);
    }
  }
}

const TAR_BLOCK = 512;

function usageError(message) {
  process.stderr.write(`build-release-archive: ${message}\n`);
  process.exit(2);
}

function mismatchError(message) {
  process.stderr.write(`build-release-archive: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    root: null,
    out: null,
    list: false,
    archive: null,
    checkRecord: null,
    help: false,
  };
  const args = argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      index += 1;
      const value = args[index];
      if (value === undefined || value === '') {
        usageError(`missing value for ${arg}`);
      }
      return value;
    };
    if (arg === '--root') {
      options.root = next();
    } else if (arg === '--out') {
      options.out = next();
    } else if (arg === '--list') {
      options.list = true;
    } else if (arg === '--archive') {
      options.archive = next();
    } else if (arg === '--check-record') {
      options.checkRecord = next();
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      usageError(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function readPackageVersion(root) {
  const packagePath = path.join(root, 'package.json');
  if (!fs.existsSync(packagePath)) {
    usageError(`missing ${packagePath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  } catch (error) {
    usageError(`cannot parse package.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  const version = parsed && parsed.version;
  if (!isPlainPackageVersion(version)) {
    usageError('package.json version must be a plain semver string');
  }
  return version;
}

function listFilesRecursive(absoluteDir, relativePrefix, collected) {
  const entries = fs.readdirSync(absoluteDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const absolute = path.join(absoluteDir, entry.name);
    const relative = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      listFilesRecursive(absolute, relative, collected);
    } else if (entry.isFile()) {
      collected.push({ absolute, relative });
    } else {
      usageError(`unsupported directory entry at ${relative}`);
    }
  }
}

function collectMembers(root) {
  for (const name of ARCHIVE_MEMBERS) {
    const absolute = path.join(root, name);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      usageError(`missing required archive member ${name}`);
    }
  }
  const distDir = path.join(root, 'dist');
  if (!fs.existsSync(distDir) || !fs.statSync(distDir).isDirectory()) {
    usageError('missing dist/: run `npm run build` before building the release archive');
  }
  for (const name of REQUIRED_DIST_ENTRIES) {
    const absolute = path.join(distDir, name);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      usageError(`missing required build output dist/${name}`);
    }
  }

  const members = [];
  for (const name of ARCHIVE_MEMBERS) {
    members.push({ absolute: path.join(root, name), relative: name });
  }
  listFilesRecursive(distDir, 'dist', members);
  members.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));

  for (const member of members) {
    try {
      assertMemberAllowed(member.relative);
    } catch (error) {
      usageError(error instanceof Error ? error.message : String(error));
    }
  }
  return members;
}

function tarChecksum(header) {
  let sum = 0;
  for (let index = 0; index < TAR_BLOCK; index += 1) {
    sum += header[index];
  }
  return sum;
}

function writeStringField(header, offset, length, value, fieldName) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) {
    usageError(`path field ${fieldName} exceeds ${length} bytes: ${value}`);
  }
  bytes.copy(header, offset);
}

function writeOctalField(header, offset, length, value, fieldName) {
  const text = value.toString(8);
  const width = length - 1;
  if (text.length > width) {
    usageError(`numeric field ${fieldName} does not fit in ${width} octal digits`);
  }
  header.write(text.padStart(width, '0'), offset, width, 'ascii');
  header[offset + length - 1] = 0;
}

function buildTarHeader(relativePath, size) {
  const header = Buffer.alloc(TAR_BLOCK, 0);
  if (relativePath.length <= 100) {
    writeStringField(header, 0, 100, relativePath, 'name');
  } else {
    // ustar prefix/name split: up to 155 bytes of directory prefix.
    const split = relativePath.lastIndexOf('/');
    if (split <= 0 || split > 155) {
      usageError(`path is too long for a ustar header: ${relativePath}`);
    }
    const prefix = relativePath.slice(0, split);
    const name = relativePath.slice(split + 1);
    if (prefix.length > 155 || name.length > 100) {
      usageError(`path is too long for a ustar header: ${relativePath}`);
    }
    writeStringField(header, 0, 100, name, 'name');
    writeStringField(header, 345, 155, prefix, 'prefix');
  }
  writeOctalField(header, 100, 8, 0o644, 'mode');
  writeOctalField(header, 108, 8, 0, 'uid');
  writeOctalField(header, 116, 8, 0, 'gid');
  writeOctalField(header, 124, 12, size, 'size');
  writeOctalField(header, 136, 12, 0, 'mtime');
  header.write('        ', 148, 8, 'ascii'); // checksum placeholder
  header[156] = '0'.charCodeAt(0); // regular file
  header.write('ustar', 257, 5, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write('root', 265, 32, 'ascii');
  header.write('root', 297, 32, 'ascii');
  writeOctalField(header, 329, 8, 0, 'devmajor');
  writeOctalField(header, 337, 8, 0, 'devminor');

  const checksum = tarChecksum(header);
  const checksumText = `${checksum.toString(8).padStart(6, '0')}\0 `;
  header.write(checksumText, 148, 8, 'ascii');
  return header;
}

function padToBlock(buffer) {
  const remainder = buffer.length % TAR_BLOCK;
  if (remainder === 0) {
    return Buffer.alloc(0);
  }
  return Buffer.alloc(TAR_BLOCK - remainder, 0);
}

function buildTar(members) {
  const chunks = [];
  for (const member of members) {
    const content = fs.readFileSync(member.absolute);
    chunks.push(buildTarHeader(member.relative, content.length));
    chunks.push(content);
    chunks.push(padToBlock(content));
  }
  chunks.push(Buffer.alloc(TAR_BLOCK * 2, 0));
  return Buffer.concat(chunks);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function gzipDeterministic(buffer) {
  const deflated = zlib.deflateRawSync(buffer, { level: 9 });
  const header = Buffer.alloc(10, 0);
  header[0] = 0x1f;
  header[1] = 0x8b;
  header[2] = 0x08; // deflate
  header[3] = 0x00; // no extra fields
  // bytes 4..7 (MTIME) stay 0 so the container carries no timestamp
  header[8] = 0x00;
  header[9] = 0xff; // unknown OS
  const crc = Buffer.alloc(8, 0);
  crc.writeUInt32LE(crc32(buffer), 0);
  crc.writeUInt32LE(buffer.length >>> 0, 4);
  return Buffer.concat([header, deflated, crc]);
}

function gunzipToBuffer(buffer) {
  return zlib.gunzipSync(buffer);
}

function readTarMembers(tarBuffer) {
  const names = [];
  let offset = 0;
  while (offset + TAR_BLOCK <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + TAR_BLOCK);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const rawPrefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const name = rawPrefix ? `${rawPrefix}/${rawName}` : rawName;
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeText, 8);
    if (!Number.isInteger(size) || size < 0) {
      usageError(`unreadable tar size field for ${name}`);
    }
    names.push(name);
    offset += TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
  return names;
}

function extractRecordJson(recordText) {
  const block = recordText.match(/```json\s*([\s\S]*?)```/);
  if (!block || block[1] === undefined) {
    usageError('release record has no machine-readable ```json block');
  }
  try {
    return JSON.parse(block[1]);
  } catch (error) {
    usageError(`release record json block is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(
      'Usage: node scripts/build-release-archive.mjs [--root DIR] [--out DIR]\n' +
        '       node scripts/build-release-archive.mjs --list --archive FILE\n' +
        '       node scripts/build-release-archive.mjs --check-record FILE\n',
    );
    return 0;
  }

  if (options.list) {
    if (!options.archive) {
      usageError('--list requires --archive FILE');
    }
    const archivePath = path.resolve(options.archive);
    if (!fs.existsSync(archivePath)) {
      usageError(`archive not found: ${archivePath}`);
    }
    const names = readTarMembers(gunzipToBuffer(fs.readFileSync(archivePath)));
    for (const name of names) {
      process.stdout.write(`${name}\n`);
    }
    return 0;
  }

  const root = path.resolve(options.root ?? path.join(__dirname, '..'));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    usageError(`root is not a directory: ${root}`);
  }
  const version = readPackageVersion(root);
  const members = collectMembers(root);
  const tar = buildTar(members);
  const gz = gzipDeterministic(tar);
  const sha256 = crypto.createHash('sha256').update(gz).digest('hex');

  const outDir = path.resolve(options.out ?? path.join(root, 'release-artifacts'));
  const archiveName = `neo-mcp-${version}.tar.gz`;
  const archivePath = path.join(outDir, archiveName);
  const archiveRelative = path.relative(root, archivePath).split(path.sep).join('/');

  if (options.checkRecord) {
    // Verification only: never write, never repair. A corrupt or missing
    // shipped artifact is the failure, not something to overwrite and then
    // report as "matches".
    const recordPath = path.resolve(options.checkRecord);
    if (!fs.existsSync(recordPath)) {
      usageError(`release record not found: ${recordPath}`);
    }
    const record = extractRecordJson(fs.readFileSync(recordPath, 'utf8'));
    const expected = record.archiveSha256;
    if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) {
      usageError('release record archiveSha256 must be 64 lowercase hex characters');
    }
    if (record.version !== version) {
      mismatchError(`record mismatch: version ${record.version} != built ${version}`);
    }
    if (expected !== sha256) {
      mismatchError(`record mismatch: expected ${expected}, built ${sha256}`);
    }
    if (!fs.existsSync(archivePath) || !fs.statSync(archivePath).isFile()) {
      mismatchError(`shipped artifact is missing: ${archivePath}; run node scripts/build-release-archive.mjs`);
    }
    const shipped = fs.readFileSync(archivePath);
    const shippedSha256 = crypto.createHash('sha256').update(shipped).digest('hex');
    if (shippedSha256 !== expected) {
      mismatchError(`shipped artifact mismatch: ${archivePath} hashes to ${shippedSha256}, record names ${expected}`);
    }
    process.stdout.write(
      `${JSON.stringify({ version, archive: archiveRelative, sha256: shippedSha256, bytes: shipped.length })}\n`,
    );
    process.stdout.write('record matches the shipped archive\n');
    return 0;
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(archivePath, gz);

  const result = {
    version,
    archive: archiveRelative,
    sha256,
    bytes: gz.length,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv));
}
