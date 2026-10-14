#!/usr/bin/env node
/**
 * Generate `src/config/generated/network-identities.v1.json` from pinned inputs.
 *
 * The generated artifact is the reviewed Neo N3 network identity source the
 * server reads through `src/registry/network-identity-registry.ts`. It is
 * committed and must never be hand-edited: this script is the only writer.
 *
 * Generation is deterministic. The inputs below are reviewed constants taken
 * from the neo-go protocol configs named in each `provenance` string (the
 * magic values) and from the genesis block those configs produce (the genesis
 * hashes). They cannot be recomputed from the magic alone, which is why they
 * are pinned here rather than derived. The method is recorded in
 * `docs/NETWORK-IDENTITIES.md`.
 *
 * Usage:
 *   node scripts/generate-network-identities.mjs           rewrite the artifact
 *   node scripts/generate-network-identities.mjs --check   verify no drift
 *   node scripts/generate-network-identities.mjs --help    show this text
 *
 * Exit codes: 0 success, 1 drift under --check, 2 usage or write failure.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SCHEMA_VERSION = 1;
export const ARTIFACT_RELATIVE_PATH = path.join('src', 'config', 'generated', 'network-identities.v1.json');

/**
 * Pinned identity inputs. `provenance` names the reviewed neo-go commit and the
 * exact config file each magic was taken from, plus the function that derives
 * the genesis hash.
 */
export const PINNED_NETWORKS = [
  {
    network: 'mainnet',
    magic: 860833102,
    genesisHash: '0x1f4d1defa46faa5e7b9b8d3f79a06bec777d7c26c4aa5f6f5899a291daa87c15',
    provenance:
      'neo-go/6d7bd0c7d612c1e9eeaf08efbb8788efef5a449b/config/protocol.mainnet.yml#CreateGenesisBlock',
  },
  {
    network: 'testnet',
    magic: 894710606,
    genesisHash: '0x9d3276785e7306daf59a3f3b9e31912c095598bbfb8a4476b821b0e59be4c57a',
    provenance:
      'neo-go/6d7bd0c7d612c1e9eeaf08efbb8788efef5a449b/config/protocol.testnet.yml#CreateGenesisBlock',
  },
];

const NETWORK_KEY_PATTERN = /^(mainnet|testnet)$/;
const GENESIS_HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const PROVENANCE_PATTERN = /^neo-go\/[0-9a-f]{40}\//;

function fail(message) {
  process.stderr.write(`generate-network-identities: ${message}\n`);
  process.exit(2);
}

function assertPinnedInputs() {
  const seen = new Set();
  for (const entry of PINNED_NETWORKS) {
    if (!NETWORK_KEY_PATTERN.test(entry.network)) {
      fail(`pinned network name is not supported: ${entry.network}`);
    }
    if (seen.has(entry.network)) {
      fail(`pinned network listed twice: ${entry.network}`);
    }
    seen.add(entry.network);
    if (!Number.isSafeInteger(entry.magic) || entry.magic <= 0) {
      fail(`pinned magic for ${entry.network} is not a positive safe integer`);
    }
    if (!GENESIS_HASH_PATTERN.test(entry.genesisHash)) {
      fail(`pinned genesisHash for ${entry.network} is not 0x-prefixed lowercase hex`);
    }
    if (!PROVENANCE_PATTERN.test(entry.provenance)) {
      fail(`pinned provenance for ${entry.network} is missing a neo-go commit`);
    }
  }
  if (seen.size !== 2) {
    fail('pinned inputs must cover exactly mainnet and testnet');
  }
}

export function buildArtifactObject() {
  const networks = {};
  for (const entry of [...PINNED_NETWORKS].sort((a, b) => (a.network < b.network ? -1 : 1))) {
    networks[entry.network] = {
      network: entry.network,
      magic: entry.magic,
      genesisHash: entry.genesisHash,
      provenance: entry.provenance,
    };
  }
  return { schemaVersion: SCHEMA_VERSION, networks };
}

export function serialize(artifact) {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

function main(argv) {
  const args = argv.slice(2);
  let checkOnly = false;
  for (const arg of args) {
    if (arg === '--check') {
      checkOnly = true;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node scripts/generate-network-identities.mjs [--check]\n' +
          '  (no flags)  rewrite src/config/generated/network-identities.v1.json\n' +
          '  --check     exit 1 if the committed artifact differs from the generator output\n',
      );
      return 0;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }

  assertPinnedInputs();
  const output = serialize(buildArtifactObject());
  const repoRoot = path.resolve(__dirname, '..');
  const artifactPath = path.join(repoRoot, ARTIFACT_RELATIVE_PATH);

  if (checkOnly) {
    if (!fs.existsSync(artifactPath)) {
      process.stderr.write(`generate-network-identities: ${ARTIFACT_RELATIVE_PATH} is missing\n`);
      return 1;
    }
    const current = fs.readFileSync(artifactPath, 'utf8');
    if (current !== output) {
      process.stderr.write(
        `generate-network-identities: ${ARTIFACT_RELATIVE_PATH} does not match the generator output; ` +
          'run node scripts/generate-network-identities.mjs\n',
      );
      return 1;
    }
    process.stdout.write(`generate-network-identities: ${ARTIFACT_RELATIVE_PATH} is current\n`);
    return 0;
  }

  try {
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, output, 'utf8');
  } catch (error) {
    fail(`cannot write ${ARTIFACT_RELATIVE_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.stdout.write(`generate-network-identities: wrote ${ARTIFACT_RELATIVE_PATH}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv));
}
