export type NeoxIdentityNetwork = 'neox-mainnet' | 'neox-testnet';

export interface KnownNeoxIdentity {
  label: string;
  role: 'bridge' | 'governance' | 'oracle' | 'validator' | 'token' | 'infra';
  evidence: {
    kind: 'curated_official_registry';
    sources: string[];
  };
}

interface RegistryEntry {
  address: string;
  network: 'both' | 'mainnet' | 'testnet';
  label: string;
  role: KnownNeoxIdentity['role'];
}

const SYSTEM_CONTRACTS_SOURCE = 'https://xdocs.ngd.network/governance/neo-x-system-contracts';
const NETWORKS_SOURCE = 'https://xdocs.ngd.network/development/networks';
const BRIDGE_SOURCE = 'https://github.com/bane-labs/bridge-evm-contracts';
const ORACLE_SOURCE = 'https://xdocs.ngd.network/integrations/oracles/neo-oracle-gateway';

const REGISTRY: RegistryEntry[] = [
  { address: '0x1212000000000000000000000000000000000000', network: 'both', label: 'GovProxyAdmin', role: 'governance' },
  { address: '0x1212000000000000000000000000000000000001', network: 'both', label: 'Governance', role: 'governance' },
  { address: '0x1212000000000000000000000000000000000002', network: 'both', label: 'Policy', role: 'governance' },
  { address: '0x1212000000000000000000000000000000000003', network: 'both', label: 'Governance Reward', role: 'governance' },
  { address: '0x1212000000000000000000000000000000000004', network: 'both', label: 'Neo X Bridge (Token Bridge)', role: 'bridge' },
  { address: '0x1212000000000000000000000000000000000005', network: 'both', label: 'Bridge Management', role: 'bridge' },
  { address: '0x1212000000000000000000000000000000000006', network: 'both', label: 'Treasury', role: 'infra' },
  { address: '0x1212000000000000000000000000000000000007', network: 'both', label: 'Committee MultiSig', role: 'governance' },
  { address: '0x1212000000000000000000000000000000000008', network: 'both', label: 'Key Management (Anti-MEV DKG)', role: 'infra' },
  { address: '0x1212000000000000000000000000000000000009', network: 'both', label: 'Message Bridge', role: 'bridge' },
  { address: '0x85776439bbe26a3b6f91bab0fb8ef3fdc769f385', network: 'both', label: 'Bridge Execution Manager', role: 'bridge' },
  { address: '0xde41591ed1f8ed1484ac2cd8ca0876428de60eff', network: 'mainnet', label: 'Wrapped GAS (WGAS10)', role: 'token' },
  { address: '0x1ce16390fd09040486221e912b87551e4e44ab17', network: 'testnet', label: 'Wrapped GAS (WGAS10)', role: 'token' },
  { address: '0x9a50c8804dc885f118835cd96d3ea4d4a5131a01', network: 'mainnet', label: 'Extended GAS (xGAS)', role: 'token' },
  { address: '0x3ee9da67d85475a250423138cbf56af511277958', network: 'testnet', label: 'Extended GAS (xGAS)', role: 'token' },
  { address: '0xce6138e61e5727a318d0debead99aff24b929131', network: 'both', label: 'Neo Oracle Gateway Proxy', role: 'oracle' },
  { address: '0x8b506d2616671b6742b968c18befda1e665a9025', network: 'mainnet', label: 'Supra Pull Oracle', role: 'oracle' },
  { address: '0xc99c8510d9ff355cd664f9412bdd645c5e25a7f1', network: 'testnet', label: 'Supra Pull Oracle', role: 'oracle' },
  { address: '0x58e158c74df7ad6396c0dcbadc4878fac9e93d57', network: 'mainnet', label: 'Supra Oracle Storage', role: 'oracle' },
  { address: '0x5df499c9db456154f81121282c0cb16b59e74c4b', network: 'testnet', label: 'Supra Oracle Storage', role: 'oracle' },
  { address: '0xbb0f96cede5728d69409340be459a864478e9222', network: 'mainnet', label: 'Supra wBTC/USDT Feed', role: 'oracle' },
  { address: '0xd6869e35e568aa6bf481fda57ac38f7353af596f', network: 'mainnet', label: 'Supra WETH/USDT Feed', role: 'oracle' },
  { address: '0x8fd2622c2ca0d7f8bd0e2ee98b143213dbcf4975', network: 'mainnet', label: 'Supra NEO/USDT Feed', role: 'oracle' },
  { address: '0xe38231c17771f02fee44b5275b3625bf67817120', network: 'mainnet', label: 'Supra GAS/USDT Feed', role: 'oracle' },
  { address: '0x99f4800f8958caf403688b988f683188df36ceaf', network: 'testnet', label: 'Supra wBTC/USDT Feed', role: 'oracle' },
  { address: '0xb29f673c3ba1657b2f0ef160dd60425deb67bd38', network: 'testnet', label: 'Supra WETH/USDT Feed', role: 'oracle' },
  { address: '0xe027fe13ae0a9d302a1338b861de64ebb9c6b1b1', network: 'testnet', label: 'Supra NEO/USDT Feed', role: 'oracle' },
  { address: '0xe7d292a336c15ab80a51e9b6959b5ec9ea870474', network: 'testnet', label: 'Supra GAS/USDT Feed', role: 'oracle' },
  { address: '0xd6010d102015fea9cb3a9abfbb51994c0fd6e672', network: 'mainnet', label: 'Multicall3', role: 'infra' },
  { address: '0x82096f92248df7afddef72e545f06e5be0cf0f99', network: 'testnet', label: 'Multicall3', role: 'infra' },
  { address: '0x4e59b44847b379578588920ca78fbf26c0b4956c', network: 'both', label: 'CREATE2 Deployer', role: 'infra' },
  { address: '0xba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed', network: 'both', label: 'CreateX Factory', role: 'infra' },
  { address: '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789', network: 'both', label: 'ERC-4337 EntryPoint v0.6', role: 'infra' },
  { address: '0x0000000071727de22e5e9d8baf0edac6f37da032', network: 'both', label: 'ERC-4337 EntryPoint v0.7', role: 'infra' },
  { address: '0x4337084d9e255ff0702461cf8895ce9e3b5ff108', network: 'both', label: 'ERC-4337 EntryPoint v0.8', role: 'infra' },
  { address: '0x433709009b8330fda32311df1c2afa402ed8d009', network: 'both', label: 'ERC-4337 EntryPoint v0.9', role: 'infra' },
  { address: '0x34a3b2abb99b4c128acf61dcbbd1fcac0b161652', network: 'mainnet', label: 'Stand-by Validator 1', role: 'validator' },
  { address: '0x641ec1c538fa17e6ad8193c9b580f6850b114280', network: 'mainnet', label: 'Stand-by Validator 2', role: 'validator' },
  { address: '0xe3973f57e8a0aa312c1917ab0e6a05d8b6af6609', network: 'mainnet', label: 'Stand-by Validator 3', role: 'validator' },
  { address: '0xa61ac4a4f006f4fceeb72ee0012a2d3367168d10', network: 'mainnet', label: 'Stand-by Validator 4', role: 'validator' },
  { address: '0xe6d1a9db6a0893926bd81c0ef93aaa543c116f0', network: 'mainnet', label: 'Stand-by Validator 5', role: 'validator' },
  { address: '0x4fe8af0dbb633283d8e9703668142fd130f2818d', network: 'mainnet', label: 'Stand-by Validator 6', role: 'validator' },
  { address: '0x763452f65353fffe73d46539e51a6ddfc0e2c86a', network: 'mainnet', label: 'Stand-by Validator 7', role: 'validator' },
  { address: '0xcbbeca26e89011e32ba25610520b20741b809007', network: 'testnet', label: 'Stand-by Validator 1', role: 'validator' },
  { address: '0x4ea2a4697d40247c8be1f2b9ffa03a0e92dcbacc', network: 'testnet', label: 'Stand-by Validator 2', role: 'validator' },
  { address: '0xd10f47396dc6c76ad53546158751582d3e2683ef', network: 'testnet', label: 'Stand-by Validator 3', role: 'validator' },
  { address: '0xa51fe05b0183d01607bf48c1718d1168a1c11171', network: 'testnet', label: 'Stand-by Validator 4', role: 'validator' },
  { address: '0x01b517b301bb143476da35bb4a1399500d925514', network: 'testnet', label: 'Stand-by Validator 5', role: 'validator' },
  { address: '0x7976ad987d572377d39fb4bab86c80e08b6f8327', network: 'testnet', label: 'Stand-by Validator 6', role: 'validator' },
  { address: '0xd711da2d8c71a801fc351163337656f1321343a0', network: 'testnet', label: 'Stand-by Validator 7', role: 'validator' },
];

const sourcesForRole = (role: KnownNeoxIdentity['role']): string[] => {
  if (role === 'bridge') return [SYSTEM_CONTRACTS_SOURCE, BRIDGE_SOURCE];
  if (role === 'oracle') return [ORACLE_SOURCE, NETWORKS_SOURCE];
  if (role === 'token' || role === 'infra') return [NETWORKS_SOURCE];
  return [SYSTEM_CONTRACTS_SOURCE];
};

const NETWORK_MAPS: Record<NeoxIdentityNetwork, Map<string, KnownNeoxIdentity>> = {
  'neox-mainnet': new Map(),
  'neox-testnet': new Map(),
};

for (const entry of REGISTRY) {
  const identity: KnownNeoxIdentity = {
    label: entry.label,
    role: entry.role,
    evidence: {
      kind: 'curated_official_registry',
      sources: sourcesForRole(entry.role),
    },
  };
  if (entry.network === 'both' || entry.network === 'mainnet') {
    NETWORK_MAPS['neox-mainnet'].set(entry.address, identity);
  }
  if (entry.network === 'both' || entry.network === 'testnet') {
    NETWORK_MAPS['neox-testnet'].set(entry.address, identity);
  }
}

export function resolveKnownNeoxIdentity(
  address: string,
  network: NeoxIdentityNetwork,
): KnownNeoxIdentity | null {
  return NETWORK_MAPS[network].get(address.toLowerCase()) ?? null;
}
