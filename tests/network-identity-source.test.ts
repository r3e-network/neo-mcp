import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import identities from '../src/config/generated/network-identities.v1.json';
import {
  NETWORK_IDENTITIES,
  networkIdentity,
  neoNetworkMagic,
  parseNetworkIdentities,
} from '../src/registry/network-identity-registry';
import { NEO_NETWORK_MAGIC, NeoNetwork } from '../src/services/neo-service';
import { ValidationError } from '../src/utils/errors';

const repoRoot = path.resolve(__dirname, '..');
const artifactPath = path.join(repoRoot, 'src/config/generated/network-identities.v1.json');
const generatorPath = path.join(repoRoot, 'scripts/generate-network-identities.mjs');
const neoServicePath = path.join(repoRoot, 'src/services/neo-service.ts');
const contractServicePath = path.join(repoRoot, 'src/contracts/contract-service.ts');

const expectedMagics = {
  mainnet: 860833102,
  testnet: 894710606,
} as const;

describe('generated Neo N3 identity source', () => {
  test('artifact carries one reviewed identity per supported network', () => {
    expect(identities.schemaVersion).toBe(1);
    expect(Object.keys(identities.networks).sort()).toEqual(['mainnet', 'testnet']);

    for (const [network, identity] of Object.entries(identities.networks)) {
      expect(identity.network).toBe(network);
      expect(Number.isSafeInteger(identity.magic)).toBe(true);
      expect(identity.magic).toBeGreaterThan(0);
      expect(identity.genesisHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(identity.provenance).toMatch(/^neo-go\/[0-9a-f]{40}\//);
    }

    expect(identities.networks.mainnet.magic).toBe(expectedMagics.mainnet);
    expect(identities.networks.testnet.magic).toBe(expectedMagics.testnet);
  });

  test('committed artifact is exactly what the checked-in generator emits', () => {
    expect(fs.existsSync(generatorPath)).toBe(true);
    expect(fs.existsSync(artifactPath)).toBe(true);

    // --check is fail-closed: a hand-edit of the artifact must not survive it.
    execFileSync(process.execPath, [generatorPath, '--check'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    const before = fs.readFileSync(artifactPath);
    execFileSync(process.execPath, [generatorPath], { cwd: repoRoot, encoding: 'utf8' });
    const after = fs.readFileSync(artifactPath);
    expect(after.equals(before)).toBe(true);
  });

  test('--check fails closed when the artifact is missing', () => {
    const backup = fs.readFileSync(artifactPath);
    try {
      fs.rmSync(artifactPath);
      let status = 0;
      let stderr = '';
      try {
        execFileSync(process.execPath, [generatorPath, '--check'], {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: 'pipe',
        });
      } catch (error) {
        const failure = error as { status?: number; stderr?: string | Buffer };
        status = failure.status ?? -1;
        stderr = String(failure.stderr ?? '');
      }
      expect(status).not.toBe(0);
      // the message must name the expected path, not just say "missing"
      expect(stderr).toContain(artifactPath);
      expect(stderr).toMatch(/missing/i);
    } finally {
      fs.writeFileSync(artifactPath, backup);
    }
    // and the restored artifact is current again
    execFileSync(process.execPath, [generatorPath, '--check'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  });
});

describe('network identity registry', () => {
  test('serves the generated identities and freezes them', () => {
    expect(NETWORK_IDENTITIES).toEqual(identities.networks);
    expect(Object.isFrozen(NETWORK_IDENTITIES)).toBe(true);
    expect(Object.isFrozen(NETWORK_IDENTITIES.mainnet)).toBe(true);
    expect(networkIdentity('mainnet').magic).toBe(expectedMagics.mainnet);
    expect(networkIdentity('testnet').magic).toBe(expectedMagics.testnet);
    expect(neoNetworkMagic('mainnet')).toBe(expectedMagics.mainnet);
    expect(neoNetworkMagic('testnet')).toBe(expectedMagics.testnet);
    expect(networkIdentity('mainnet').genesisHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(networkIdentity('mainnet').provenance).toMatch(/^neo-go\/[0-9a-f]{40}\//);
  });

  test('refuses an unknown network name instead of guessing', () => {
    for (const bad of ['', 'Mainnet', 'mainnet ', ' mainnet', 'neox-mainnet', 'MAINNET', 'goerli', null, undefined, 1]) {
      expect(() => networkIdentity(bad as never)).toThrow(ValidationError);
      expect(() => neoNetworkMagic(bad as never)).toThrow(ValidationError);
    }
  });

  test('parseNetworkIdentities is fail-closed on every malformed shape', () => {
    const valid = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

    const mutations: Array<{ label: string; value: unknown }> = [
      { label: 'null root', value: null },
      { label: 'non-object root', value: 'mainnet' },
      { label: 'missing schemaVersion', value: { ...valid, schemaVersion: undefined } },
      { label: 'wrong schemaVersion', value: { ...valid, schemaVersion: 2 } },
      { label: 'missing networks', value: { schemaVersion: 1 } },
      { label: 'empty networks', value: { schemaVersion: 1, networks: {} } },
      { label: 'missing testnet', value: { schemaVersion: 1, networks: { mainnet: valid.networks.mainnet } } },
      { label: 'extra network key', value: { ...valid, networks: { ...valid.networks, goerli: valid.networks.mainnet } } },
      { label: 'network key mismatch', value: { ...valid, networks: { ...valid.networks, mainnet: { ...valid.networks.mainnet, network: 'testnet' } } } },
      { label: 'magic zero', value: { ...valid, networks: { ...valid.networks, mainnet: { ...valid.networks.mainnet, magic: 0 } } } },
      { label: 'magic negative', value: { ...valid, networks: { ...valid.networks, mainnet: { ...valid.networks.mainnet, magic: -1 } } } },
      { label: 'magic non-integer', value: { ...valid, networks: { ...valid.networks, mainnet: { ...valid.networks.mainnet, magic: 1.5 } } } },
      { label: 'magic string', value: { ...valid, networks: { ...valid.networks, mainnet: { ...valid.networks.mainnet, magic: '860833102' } } } },
      { label: 'genesisHash uppercase', value: { ...valid, networks: { ...valid.networks, mainnet: { ...valid.networks.mainnet, genesisHash: '0x' + 'A'.repeat(64) } } } },
      { label: 'genesisHash short', value: { ...valid, networks: { ...valid.networks, mainnet: { ...valid.networks.mainnet, genesisHash: '0x1f4d' } } } },
      { label: 'genesisHash no prefix', value: { ...valid, networks: { ...valid.networks, mainnet: { ...valid.networks.mainnet, genesisHash: '1f4d1defa46faa5e7b9b8d3f79a06bec777d7c26c4aa5f6f5899a291daa87c15' } } } },
      { label: 'provenance missing commit', value: { ...valid, networks: { ...valid.networks, mainnet: { ...valid.networks.mainnet, provenance: 'neo-go/main/config/protocol.mainnet.yml#CreateGenesisBlock' } } } },
      { label: 'provenance wrong project', value: { ...valid, networks: { ...valid.networks, mainnet: { ...valid.networks.mainnet, provenance: 'other/6d7bd0c7d612c1e9eeaf08efbb8788efef5a449b/config/protocol.mainnet.yml#CreateGenesisBlock' } } } },
      { label: 'missing provenance', value: { ...valid, networks: { ...valid.networks, mainnet: { ...valid.networks.mainnet, provenance: undefined } } } },
      { label: 'extra top-level key', value: { ...valid, unexpected: 1 } },
      { label: 'extra top-level key with nested value', value: { ...valid, defaults: { magic: 1 } } },
      {
        label: 'extra identity field',
        value: {
          ...valid,
          networks: {
            ...valid.networks,
            mainnet: { ...valid.networks.mainnet, privateKey: 's3cret' },
          },
        },
      },
      {
        label: 'extra identity field on testnet',
        value: {
          ...valid,
          networks: {
            ...valid.networks,
            testnet: { ...valid.networks.testnet, comment: 'hand edit' },
          },
        },
      },
    ];

    for (const { label, value } of mutations) {
      expect(() => parseNetworkIdentities(value)).toThrow();
    }

    // the exact committed artifact must still parse
    expect(parseNetworkIdentities(valid)).toEqual(valid.networks);
  });

  test('returned identities are deeply frozen so callers cannot retarget a magic', () => {
    const map = parseNetworkIdentities(JSON.parse(fs.readFileSync(artifactPath, 'utf8')));
    expect(Object.isFrozen(map)).toBe(true);
    expect(Object.isFrozen(map.mainnet)).toBe(true);
    expect(Reflect.set(map.mainnet, 'magic', -1)).toBe(false);
    expect(map.mainnet.magic).toBe(expectedMagics.mainnet);
  });
});

describe('Neo N3 magic re-sourcing', () => {
  test('public frozen magic export consumes the registry identities', () => {
    expect(NEO_NETWORK_MAGIC).toEqual({
      [NeoNetwork.MAINNET]: identities.networks.mainnet.magic,
      [NeoNetwork.TESTNET]: identities.networks.testnet.magic,
    });
    expect(Object.isFrozen(NEO_NETWORK_MAGIC)).toBe(true);
    expect(Reflect.set(NEO_NETWORK_MAGIC, NeoNetwork.MAINNET, -1)).toBe(false);
    expect(NEO_NETWORK_MAGIC[NeoNetwork.MAINNET]).toBe(identities.networks.mainnet.magic);
    expect(NEO_NETWORK_MAGIC[NeoNetwork.TESTNET]).toBe(identities.networks.testnet.magic);
  });

  test('is no longer a local magic authority and reads the registry', () => {
    const source = fs.readFileSync(neoServicePath, 'utf8');
    expect(source).not.toMatch(/(?:860833102|894710606)/);
    expect(source).toMatch(/network-identity-registry/);
    expect(source).toMatch(/NEO_NETWORK_MAGIC/);

    const registrySource = fs.readFileSync(
      path.join(repoRoot, 'src/registry/network-identity-registry.ts'),
      'utf8',
    );
    expect(registrySource).toContain('config/generated/network-identities.v1.json');

    expect(fs.readFileSync(contractServicePath, 'utf8')).toContain(
      "import { NEO_NETWORK_MAGIC, NeoNetwork, PreparedNeoTransaction } from '../services/neo-service'",
    );
  });
});
