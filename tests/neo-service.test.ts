import { jest } from '@jest/globals';
import { NeoService, NeoNetwork } from '../src/services/neo-service';
import { RateLimitError, ValidationError } from '../src/utils/errors';

const mockBlockCount = 12345;
const mockValidators = [
  { publickey: 'key1', votes: '100', active: true },
  { publickey: 'key2', votes: '200', active: true },
];
const mockBlock = {
  hash: '0x1234567890abcdef',
  size: 1000,
  version: 0,
  previousblockhash: '0x0987654321fedcba',
  merkleroot: '0xabcdef1234567890',
  time: 1600000000,
  index: 12344,
  nonce: '0',
  nextconsensus: 'address',
  script: { invocation: '', verification: '' },
  tx: [],
};
const mockTransaction = {
  hash: '0xabcdef1234567890',
  size: 500,
  version: 0,
  nonce: 0,
  sender: 'address1',
  sysfee: '0.1',
  netfee: '0.05',
  validuntilblock: 12400,
  signers: [],
  attributes: [],
  script: '',
  witnesses: [],
};
const mockAccountState = {
  balances: [
    { asset: 'NEO', amount: '100' },
    { asset: 'GAS', amount: '50.5' },
  ],
};
const mockBalance = {
  balance: [
    { asset: 'NEO', amount: '100' },
    { asset: 'GAS', amount: '50.5' },
  ],
};
const mockSenderScriptHash = 'f81a9a9ebf8cc9ae7f9ac3491f5a9f3b282b5e9e';
const mockDummyScriptHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const mockFlamingoScriptHash = 'f970f4ccecd765b63732b821775dc38c25d74b39';
const mockSenderAddress = 'NaMLm1hwCaQitxmLboJGo2XJkG8PSYvuyr';
const mockFlamingoAddress = 'NR8vZB6LijzinRcjbc1y8mZ8gbqrERbGpr';

const mockApplicationLog = {
  txid: '0xabcdef1234567890',
  executions: [{
    vmstate: 'HALT',
    notifications: [{
      contract: '0xd2a4cff31913016155e38e474a2c06d08be276cf',
      eventname: 'Transfer',
      state: {
        type: 'Array',
        value: [
          { type: 'ByteString', value: Buffer.from(mockSenderScriptHash, 'hex').reverse().toString('base64') },
          { type: 'ByteString', value: Buffer.from(mockFlamingoScriptHash, 'hex').reverse().toString('base64') },
          { type: 'Integer', value: '42' }
        ]
      }
    }]
  }],
};
const mockNep17Transfers = {
  address: mockSenderAddress,
  sent: [
    {
      timestamp: 1710000000000,
      assethash: '0xd2a4cff31913016155e38e474a2c06d08be276cf',
      transferaddress: mockFlamingoAddress,
      amount: '42',
      blockindex: 12345,
      transfernotifyindex: 0,
      txhash: '0x1111111111111111111111111111111111111111111111111111111111111111'
    }
  ],
  received: [
    {
      timestamp: 1710000001000,
      assethash: '0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5',
      transferaddress: mockFlamingoAddress,
      amount: '7',
      blockindex: 12346,
      transfernotifyindex: 1,
      txhash: '0x2222222222222222222222222222222222222222222222222222222222222222'
    }
  ]
};
const mockNep11AssetHash = '0x1234567890abcdef1234567890abcdef12345678';
const mockNep11Balances = {
  address: mockSenderAddress,
  balance: [
    {
      assethash: mockNep11AssetHash,
      amount: '2',
      lastupdatedblock: 23456,
      tokens: [
        { tokenid: 'nft-1', amount: '1', lastupdatedblock: 23455 },
        { tokenid: 'nft-2', amount: '1', lastupdatedblock: 23456 }
      ]
    }
  ]
};
const mockNep11Transfers = {
  address: mockSenderAddress,
  sent: [
    {
      timestamp: 1710000002000,
      assethash: mockNep11AssetHash,
      transferaddress: mockFlamingoAddress,
      amount: '1',
      tokenid: 'nft-1',
      blockindex: 12347,
      transfernotifyindex: 0,
      txhash: '0x3333333333333333333333333333333333333333333333333333333333333333'
    }
  ],
  received: [
    {
      timestamp: 1710000003000,
      assethash: mockNep11AssetHash,
      transferaddress: mockFlamingoAddress,
      amount: '1',
      tokenid: 'nft-2',
      blockindex: 12348,
      transfernotifyindex: 1,
      txhash: '0x4444444444444444444444444444444444444444444444444444444444444444'
    }
  ]
};
const mockUnclaimedGas = '123456789';
const mockTransactionHeight = 12346;
const mockTransactionId = `0x${'b'.repeat(64)}`;
var mockNetworkMagic = 860833102;
var mockNep17BalanceOf = jest.fn().mockResolvedValue(10);
var mockNep17Decimals = jest.fn().mockResolvedValue(8);
var mockSmartContractInvoke = jest.fn().mockResolvedValue(mockTransactionId);
var mockClaimGas = jest.fn().mockResolvedValue(mockTransactionId);
var mockSmartCalculateNetworkFee = jest.fn().mockResolvedValue({ toString: () => '123456' });
var mockSetBlockExpiry = jest.fn().mockResolvedValue(undefined);
var mockAddFees = jest.fn().mockResolvedValue(undefined);
var mockScriptBuilderBuild = jest.fn().mockReturnValue('shared-transfer-script');
var mockScriptBuilderEmitAppCall = jest.fn();
var mockScriptBuilderEmit = jest.fn();
var mockContractParamInteger = jest.fn().mockReturnValue('integerParam');
var mockSendRawTransaction = jest.fn().mockResolvedValue(mockTransactionId);
var mockTransactions: Array<Record<string, unknown>> = [];

jest.mock('@cityofzion/neon-js', () => {
  return {
    rpc: {
      Query: jest.fn().mockImplementation((q) => q),
      RPCClient: jest.fn().mockImplementation(() => ({
        getBlockCount: jest.fn().mockReturnValue(Promise.resolve(mockBlockCount)),
        getValidators: jest.fn().mockReturnValue(Promise.resolve(mockValidators)),
        getBlock: jest.fn().mockReturnValue(Promise.resolve(mockBlock)),
        getTransaction: jest.fn().mockReturnValue(Promise.resolve(mockTransaction)),
        getRawTransaction: jest.fn().mockReturnValue(Promise.resolve(mockTransaction)),
        getApplicationLog: jest.fn().mockReturnValue(Promise.resolve(mockApplicationLog)),
        getUnclaimedGas: jest.fn().mockReturnValue(Promise.resolve(mockUnclaimedGas)),
        getTransactionHeight: jest.fn().mockReturnValue(Promise.resolve(mockTransactionHeight)),
        getBalance: jest.fn().mockReturnValue(Promise.resolve(mockBalance)),
        getAccountState: jest.fn().mockReturnValue(Promise.resolve(mockAccountState)),
        invokeScript: jest.fn().mockReturnValue(Promise.resolve({ state: 'HALT', gasconsumed: '1000000', stack: [{ value: '100' }] })),
        invokeFunction: jest.fn().mockImplementation(async (_scriptHash, operation) => ({
          state: 'HALT',
          gasconsumed: '1000000',
          stack: [{ value: operation === 'decimals' ? String(await mockNep17Decimals()) : '100000000000' }],
          validuntilblock: 12500,
        })),
        calculateNetworkFee: (...args: unknown[]) => mockSmartCalculateNetworkFee(...args),
        sendRawTransaction: mockSendRawTransaction,
        execute: jest.fn().mockImplementation((queryOrMethod, paramsArray) => {
          let method = queryOrMethod;
          if (typeof queryOrMethod === 'object' && queryOrMethod !== null) {
            method = queryOrMethod.req ? queryOrMethod.req.method : queryOrMethod.method;
          }
          if (method === 'getblockcount') return Promise.resolve(mockBlockCount);
          if (method === 'getvalidators') return Promise.resolve(mockValidators);
          if (method === 'getblock') return Promise.resolve(mockBlock);
          if (method === 'getrawtransaction') return Promise.resolve(mockTransaction);
          if (method === 'getaccountstate') return Promise.resolve(mockAccountState);
          if (method === 'getversion') return Promise.resolve({ protocol: { network: mockNetworkMagic } });
          if (method === 'getnep17balances') {
            return Promise.resolve({
              address: 'NaMLm1hwCaQitxmLboJGo2XJkG8PSYvuyr',
              balance: [
                { assethash: '0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5', amount: '100', lastupdatedblock: 12345 },
                { assethash: '0xd2a4cff31913016155e38e474a2c06d08be276cf', amount: '50.5', lastupdatedblock: 12345 },
              ],
            });
          }
          if (method === 'getnep17transfers') {
            return Promise.resolve(mockNep17Transfers);
          }
          if (method === 'getnep11balances') {
            return Promise.resolve(mockNep11Balances);
          }
          if (method === 'getnep11transfers') {
            return Promise.resolve(mockNep11Transfers);
          }
          if (method === 'invokescript') return Promise.resolve({ state: 'HALT', stack: [{ value: '100' }] });
          if (method === 'invokefunction') {
            return Promise.resolve({
              state: 'HALT',
              gasconsumed: '1000000',
              stack: [{ value: '100' }],
              validuntilblock: 12500,
            });
          }
          if (method === 'sendrawtransaction') return Promise.resolve(mockTransactionId);
          return Promise.resolve(null);
        }),
      })),
    },
    wallet: {
      Account: jest.fn().mockImplementation(() => ({
        address: 'NaMLm1hwCaQitxmLboJGo2XJkG8PSYvuyr',
        publicKey: 'publicKey',
        WIF: 'WIF',
        scriptHash: mockDummyScriptHash,
        contract: { script: 'EQ==' },
        encrypt: jest.fn().mockReturnValue('encryptedKey'),
        decrypt: jest.fn(),
      })),
      getScriptHashFromAddress: jest.fn().mockImplementation((address) => {
        if (address === mockSenderAddress) return mockSenderScriptHash;
        if (address === mockFlamingoAddress) return mockFlamingoScriptHash;
        return mockSenderScriptHash;
      }),
      getAddressFromScriptHash: jest.fn().mockImplementation((scriptHash) => {
        const normalized = String(scriptHash).replace(/^0x/, '').toLowerCase();
        if (normalized === mockSenderScriptHash) return mockSenderAddress;
        if (normalized === mockFlamingoScriptHash) return mockFlamingoAddress;
        return `addr-${normalized}`;
      }),
      isAddress: jest.fn().mockImplementation((address) => (
        address === mockSenderAddress || address === mockFlamingoAddress
      )),
      isWIF: jest.fn().mockReturnValue(true),
      isPrivateKey: jest.fn().mockReturnValue(false),
      isNEP2: jest.fn().mockReturnValue(true),
      encrypt: jest.fn().mockResolvedValue('encryptedKey'),
      decrypt: jest.fn().mockResolvedValue('privateKey'),
    },
    sc: {
      createScript: jest.fn().mockReturnValue('script'),
      ScriptBuilder: jest.fn().mockImplementation(() => ({
        emitAppCall: mockScriptBuilderEmitAppCall,
        emit: mockScriptBuilderEmit,
        build: mockScriptBuilderBuild,
      })),
      OpCode: {
        ASSERT: 'ASSERT',
      },
      ContractParam: {
        hash160: jest.fn().mockReturnValue('hash160Param'),
        integer: (...args: unknown[]) => mockContractParamInteger(...args),
        any: jest.fn().mockReturnValue('anyParam'),
      },
    },
    u: {
      BigInteger: {
        fromDecimal: jest.fn().mockImplementation((value) => ({ toString: () => String(value) })),
      },
      HexString: {
        fromHex: jest.fn().mockReturnValue('hexString'),
        fromBase64: jest.fn().mockReturnValue({ toString: () => 'verificationScript' }),
      },
    },
    tx: {
      Signer: jest.fn().mockImplementation((value) => value),
      Transaction: jest.fn().mockImplementation(() => {
        const transaction: Record<string, any> = {
          signers: [],
          witnesses: [],
          sign: jest.fn().mockReturnValue(true),
          hash: jest.fn().mockReturnValue('b'.repeat(64)),
          serialize: jest.fn().mockReturnValue('aa55'),
          script: undefined,
        };
        transaction.addSigner = jest.fn((signer) => {
          transaction.signers.push(signer);
          return transaction;
        });
        transaction.addWitness = jest.fn((witness) => {
          transaction.witnesses.push(witness);
          return transaction;
        });
        mockTransactions.push(transaction);
        return transaction;
      }),
      Witness: jest.fn().mockImplementation((input) => input),
      WitnessScope: {
        CalledByEntry: 'CalledByEntry',
        Global: 'Global',
        None: 'None',
      },
    },
    experimental: {
      SmartContract: jest.fn().mockImplementation(() => ({
        invoke: mockSmartContractInvoke,
      })),
      txHelpers: {
        getSystemFee: jest.fn().mockResolvedValue({ toString: () => '1000000' }),
        setBlockExpiry: (...args: unknown[]) => mockSetBlockExpiry(...args),
        addFees: (...args: unknown[]) => mockAddFees(...args),
      },
      nep17: {
        Nep17Contract: jest.fn().mockImplementation(() => ({
          balanceOf: mockNep17BalanceOf,
          decimals: mockNep17Decimals,
        })),
        NEOContract: jest.fn().mockImplementation(() => ({
          claimGas: mockClaimGas,
        })),
      },
    },
    api: {
      smartCalculateNetworkFee: (...args: unknown[]) => mockSmartCalculateNetworkFee(...args),
    },
    CONST: {
      DEFAULT_ADDRESS_VERSION: 53,
    },
  };
});

describe('NeoService', () => {
  let neoService: NeoService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockNetworkMagic = 860833102;
    mockTransactions.length = 0;
    mockNep17BalanceOf.mockResolvedValue(10);
    mockNep17Decimals.mockResolvedValue(8);
    mockScriptBuilderBuild.mockReturnValue('shared-transfer-script');
    neoService = new NeoService('http://localhost:10332', NeoNetwork.MAINNET, {
      minTransactionPollIntervalMs: 1,
    } as any);
  });

  describe('constructor', () => {
    test.each([
      'ftp://rpc.example',
      'ws://rpc.example',
      'file:///tmp/neo-rpc.sock',
      'http://',
      'https://',
    ])('rejects an RPC endpoint without a supported HTTP(S) host: %s', (rpcUrl) => {
      expect(() => new NeoService(rpcUrl, NeoNetwork.MAINNET)).toThrow(/invalid rpc url/i);
    });

    test('rejects embedded RPC credentials without echoing them in the error', () => {
      const rpcUrl = 'https://rpc-user:rpc-password@rpc.example/private?token=secret';
      let thrown: unknown;

      try {
        new NeoService(rpcUrl, NeoNetwork.MAINNET);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/invalid rpc url/i);
      expect((thrown as Error).message).not.toContain(rpcUrl);
      expect((thrown as Error).message).not.toContain('rpc-user');
      expect((thrown as Error).message).not.toContain('rpc-password');
    });

    test('accepts provider RPC endpoints with a path and query string', () => {
      expect(() => new NeoService(
        'https://rpc.example/provider/v2?project=public-id',
        NeoNetwork.MAINNET,
      )).not.toThrow();
    });

    test('rejects remote plaintext RPC unless explicitly enabled', () => {
      expect(() => new NeoService('http://rpc.example:20332', NeoNetwork.MAINNET))
        .toThrow(/HTTPS|secure RPC/i);
      expect(() => new NeoService('http://rpc.example:20332', NeoNetwork.MAINNET, {
        allowInsecureRpc: true,
      } as any)).not.toThrow();
    });
  });

  test('getBlockchainInfo distinguishes block count from the latest block height', async () => {
    const info = await neoService.getBlockchainInfo();
    expect(info).toHaveProperty('blockCount', mockBlockCount);
    expect(info).toHaveProperty('height', mockBlockCount - 1);
    expect(info).toHaveProperty('validators');
    expect(info.validators).toHaveLength(2);
    expect(info).toHaveProperty('network', NeoNetwork.MAINNET);
  });

  test('getBlockchainInfo throws on unrecoverable rpc failure', async () => {
    const mockRpcClient = (neoService as any).rpcClient;
    mockRpcClient.getBlockCount = jest.fn().mockRejectedValue(new Error('RPC Error'));

    await expect(neoService.getBlockchainInfo()).rejects.toThrow('Failed to get blockchain info');
  });

  test('normal RPC calls reject at the configured deadline without retaining process shutdown', async () => {
    const deadlineMs = 25;
    const service = new NeoService(
      'http://localhost:10332',
      NeoNetwork.MAINNET,
      { rpcTimeoutMs: deadlineMs },
    );
    const mockRpcClient = (service as any).rpcClient;
    mockRpcClient.getBlockCount = jest.fn().mockReturnValue(new Promise(() => undefined));

    const unref = jest.fn();
    let fireDeadline: (() => void) | undefined;
    const timeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((callback: () => void, delay?: number) => {
      if (delay === deadlineMs) {
        fireDeadline = callback;
      }
      return { unref } as NodeJS.Timeout;
    }) as typeof setTimeout);

    try {
      const result = service.getBlockCount();

      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), deadlineMs);
      expect(unref).toHaveBeenCalledTimes(1);
      expect(fireDeadline).toBeDefined();
      fireDeadline?.();
      await expect(result).rejects.toThrow(/timed out.*25ms/i);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  test('read-only contract RPC calls use the configured deadline', async () => {
    const service = new NeoService(
      'http://localhost:10332',
      NeoNetwork.MAINNET,
      { rpcTimeoutMs: 10 },
    );
    const mockRpcClient = (service as any).rpcClient;
    mockRpcClient.invokeScript = jest.fn().mockReturnValue(new Promise(() => undefined));

    const outcome = await Promise.race([
      service.invokeReadContract(
        '0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5',
        'balanceOf',
      ).then(
        () => 'resolved',
        (error) => error,
      ),
      new Promise((resolve) => setTimeout(() => resolve('still-pending'), 100)),
    ]);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/invoke read contract.*timed out.*10ms/i);
  });

  test('getBlock returns block details', async () => {
    const block = await neoService.getBlock(12344);
    expect(block).toHaveProperty('hash', mockBlock.hash);
    expect(block).toHaveProperty('index', mockBlock.index);
  });

  test('getStateRootValidation returns exact root evidence and validator boundary', async () => {
    const mockRpcClient = (neoService as any).rpcClient;
    const stateRoot = {
      version: 0,
      index: 12344,
      roothash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      witnesses: [],
    };
    mockRpcClient.execute = jest.fn().mockImplementation((query) => {
      if (query.method === 'getstateroot') return Promise.resolve(stateRoot);
      if (query.method === 'getstateheight') {
        return Promise.resolve({ localrootindex: 12346, validatedrootindex: 12345 });
      }
      return Promise.resolve(null);
    });

    await expect(neoService.getStateRootValidation(12344)).resolves.toEqual({
      blockHeight: 12344,
      root: stateRoot,
      localRootIndex: 12346,
      validatedRootIndex: 12345,
      validated: true,
      network: NeoNetwork.MAINNET,
    });
    expect(mockRpcClient.execute).toHaveBeenCalledWith({
      method: 'getstateroot',
      params: [12344],
    });
    expect(mockRpcClient.execute).toHaveBeenCalledWith({
      method: 'getstateheight',
      params: [],
    });
  });

  test('getStateRootValidation does not mark a root ahead of StateValidator as validated', async () => {
    const mockRpcClient = (neoService as any).rpcClient;
    mockRpcClient.execute = jest.fn().mockImplementation((query) => {
      if (query.method === 'getstateroot') {
        return Promise.resolve({
          index: 12346,
          roothash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        });
      }
      if (query.method === 'getstateheight') {
        return Promise.resolve({ localrootindex: 12346, validatedrootindex: 12345 });
      }
      return Promise.resolve(null);
    });

    await expect(neoService.getStateRootValidation(12346)).resolves.toMatchObject({
      blockHeight: 12346,
      validatedRootIndex: 12345,
      validated: false,
    });
  });

  test.each([
    [
      'a null validation boundary',
      {
        root: {
          index: 12344,
          roothash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        height: { localrootindex: 12346, validatedrootindex: null },
      },
    ],
    [
      'a root for a different block',
      {
        root: {
          index: 12343,
          roothash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        height: { localrootindex: 12346, validatedrootindex: 12345 },
      },
    ],
    [
      'a malformed root hash',
      {
        root: { index: 12344, roothash: 'not-a-state-root' },
        height: { localrootindex: 12346, validatedrootindex: 12345 },
      },
    ],
  ])('getStateRootValidation rejects %s', async (_case, evidence) => {
    const mockRpcClient = (neoService as any).rpcClient;
    mockRpcClient.execute = jest.fn().mockImplementation((query) => (
      Promise.resolve(query.method === 'getstateroot' ? evidence.root : evidence.height)
    ));

    await expect(neoService.getStateRootValidation(12344))
      .rejects.toThrow(/failed to validate state root/i);
  });

  test.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'getStateRootValidation rejects invalid block height %p before RPC',
    async (height) => {
      const mockRpcClient = (neoService as any).rpcClient;
      await expect(neoService.getStateRootValidation(height)).rejects.toThrow(/block height/i);
      expect(mockRpcClient.execute).not.toHaveBeenCalled();
    },
  );

  test('getTransaction returns transaction details', async () => {
    const tx = await neoService.getTransaction('0xabcdef1234567890');
    expect(tx).toHaveProperty('hash', mockTransaction.hash);
    expect(tx).toHaveProperty('sysfee', mockTransaction.sysfee);
  });

  test('getTransaction does not retry through a fallback on transport failures', async () => {
    const mockRpcClient = (neoService as any).rpcClient;
    mockRpcClient.getRawTransaction = jest.fn().mockRejectedValue(new Error('ECONNREFUSED node unavailable'));
    mockRpcClient.execute = jest.fn();

    await expect(neoService.getTransaction('0xabcdef1234567890'))
      .rejects.toThrow('ECONNREFUSED');
    expect(mockRpcClient.execute).not.toHaveBeenCalled();
  });

  test('getTransaction uses its compatibility fallback when the direct method is unsupported', async () => {
    const mockRpcClient = (neoService as any).rpcClient;
    const unsupported = Object.assign(new Error('Method not found'), { code: -32601 });
    mockRpcClient.getRawTransaction = jest.fn().mockRejectedValue(unsupported);
    mockRpcClient.execute = jest.fn().mockResolvedValue(mockTransaction);

    await expect(neoService.getTransaction('0xabcdef1234567890'))
      .resolves.toMatchObject({ hash: mockTransaction.hash });
    expect(mockRpcClient.execute).toHaveBeenCalledTimes(1);
  });

  test('getBalance returns balance for address', async () => {
    const balance = await neoService.getBalance('NaMLm1hwCaQitxmLboJGo2XJkG8PSYvuyr');
    expect(balance).toHaveProperty('balance');
    expect(balance.balance).toHaveLength(2);
    expect(balance.balance[0]).toHaveProperty('asset_name', 'NEO');
    expect(balance.balance[0]).toHaveProperty('amount');
  });

  test.each(['BREAK', 'FAULT', undefined])('getBalance rejects non-HALT VM state %p', async (state) => {
    const mockRpcClient = (neoService as any).rpcClient;
    mockRpcClient.execute = jest.fn().mockRejectedValue(Object.assign(new Error('Method not found'), { code: -32601 }));
    mockRpcClient.invokeScript = jest.fn().mockResolvedValue({
      state,
      stack: [{ value: '100' }],
    });

    await expect(neoService.getBalance('NaMLm1hwCaQitxmLboJGo2XJkG8PSYvuyr'))
      .rejects.toThrow(/invalid NEO balance response/i);
  });



test('getApplicationLog decodes little-endian transfer participants', async () => {
  const applicationLog = await neoService.getApplicationLog('0xabcdef1234567890');
  const notification = applicationLog.executions[0].notifications[0];

  expect(notification.parsed).toMatchObject({
    type: 'nep17_transfer',
    amount: '42',
    asset: expect.objectContaining({
      symbol: 'GAS',
      scriptHash: '0xd2a4cff31913016155e38e474a2c06d08be276cf',
    }),
    to: expect.objectContaining({
      address: mockFlamingoAddress,
      scriptHash: `0x${mockFlamingoScriptHash}`,
      displayName: mockFlamingoAddress,
    }),
  });

  expect(notification.parsed.to).not.toHaveProperty('knownAccount');
  expect(notification.parsed.to).not.toHaveProperty('name');
  expect(notification.parsed.to).not.toHaveProperty('logo');
});

test('getApplicationLog classifies four-field transfers as NEP-11 and retains the token ID', async () => {
  const mockRpcClient = (neoService as any).rpcClient;
  const tokenId = Buffer.from('token-42', 'utf8');
  mockRpcClient.getApplicationLog = jest.fn().mockResolvedValue({
    txid: '0xnft',
    executions: [{
      vmstate: 'HALT',
      notifications: [{
        contract: mockNep11AssetHash,
        eventname: 'Transfer',
        state: {
          type: 'Array',
          value: [
            { type: 'ByteString', value: Buffer.from(mockSenderScriptHash, 'hex').reverse().toString('base64') },
            { type: 'ByteString', value: Buffer.from(mockFlamingoScriptHash, 'hex').reverse().toString('base64') },
            { type: 'Integer', value: '1' },
            { type: 'ByteString', value: tokenId.toString('base64') },
          ],
        },
      }],
    }],
  });

  const result = await neoService.getApplicationLog('0xnft');
  expect(result.executions[0].notifications[0].parsed).toMatchObject({
    type: 'nep11_transfer',
    from: { scriptHash: `0x${mockSenderScriptHash}` },
    to: { scriptHash: `0x${mockFlamingoScriptHash}` },
    amount: '1',
    tokenId: tokenId.toString('hex'),
  });
});

test('getUnclaimedGas returns the address and amount', async () => {
  const result = await neoService.getUnclaimedGas('NaMLm1hwCaQitxmLboJGo2XJkG8PSYvuyr');
  expect(result).toEqual({
    address: 'NaMLm1hwCaQitxmLboJGo2XJkG8PSYvuyr',
    unclaimedGas: mockUnclaimedGas,
  });
});

test('getNep17Transfers enriches native assets without labeling unverified counterparties', async () => {
  const result = await (neoService as any).getNep17Transfers(mockSenderAddress, {
    fromTimestampMs: 0,
    toTimestampMs: 1710000001000,
  });

  expect(result).toMatchObject({
    address: mockSenderAddress,
    sent: [
      expect.objectContaining({
        assethash: '0xd2a4cff31913016155e38e474a2c06d08be276cf',
        transferaddress: mockFlamingoAddress,
        direction: 'sent',
        timestampIso: new Date(1710000000000).toISOString(),
        asset: expect.objectContaining({
          symbol: 'GAS',
          name: 'GasToken',
        }),
        to: expect.objectContaining({
          address: mockFlamingoAddress,
          displayName: mockFlamingoAddress,
        }),
        counterparty: expect.objectContaining({
          address: mockFlamingoAddress,
          displayName: mockFlamingoAddress,
        }),
      }),
    ],
    received: [
      expect.objectContaining({
        assethash: '0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5',
        transferaddress: mockFlamingoAddress,
        direction: 'received',
        timestampIso: new Date(1710000001000).toISOString(),
        asset: expect.objectContaining({
          symbol: 'NEO',
          name: 'NeoToken',
        }),
        from: expect.objectContaining({
          address: mockFlamingoAddress,
          displayName: mockFlamingoAddress,
        }),
        to: expect.objectContaining({
          address: mockSenderAddress,
          displayName: mockSenderAddress,
        }),
      }),
    ],
  });

  expect(result.sent[0].counterparty).not.toHaveProperty('knownAccount');
  expect(result.received[0].counterparty).not.toHaveProperty('knownAccount');
});

test('getNep11Balances enriches balance entries with additive asset metadata', async () => {
  const result = await (neoService as any).getNep11Balances(mockSenderAddress);

  expect(result).toMatchObject({
    address: mockSenderAddress,
    balance: [
      expect.objectContaining({
        assethash: mockNep11AssetHash,
        amount: '2',
        tokens: [
          expect.objectContaining({ tokenid: 'nft-1' }),
          expect.objectContaining({ tokenid: 'nft-2' }),
        ],
        asset: expect.objectContaining({
          scriptHash: mockNep11AssetHash,
          name: mockNep11AssetHash,
        }),
      }),
    ],
  });
});

test('getNep11Transfers retains metadata without labeling unverified counterparties', async () => {
  const result = await (neoService as any).getNep11Transfers(mockSenderAddress, {
    fromTimestampMs: 0,
    toTimestampMs: 1710000003000,
  });

  expect(result).toMatchObject({
    address: mockSenderAddress,
    sent: [
      expect.objectContaining({
        assethash: mockNep11AssetHash,
        tokenid: 'nft-1',
        direction: 'sent',
        timestampIso: new Date(1710000002000).toISOString(),
        to: expect.objectContaining({
          address: mockFlamingoAddress,
          displayName: mockFlamingoAddress,
        }),
      }),
    ],
    received: [
      expect.objectContaining({
        assethash: mockNep11AssetHash,
        tokenid: 'nft-2',
        direction: 'received',
        timestampIso: new Date(1710000003000).toISOString(),
        from: expect.objectContaining({
          address: mockFlamingoAddress,
          displayName: mockFlamingoAddress,
        }),
        to: expect.objectContaining({
          address: mockSenderAddress,
          displayName: mockSenderAddress,
        }),
      }),
    ],
  });

  expect(result.sent[0].counterparty).not.toHaveProperty('knownAccount');
  expect(result.received[0].counterparty).not.toHaveProperty('knownAccount');
});

test('waitForTransaction returns confirmed transaction details and application log', async () => {
  const result = await neoService.waitForTransaction('0xabcdef1234567890', {
    timeoutMs: 1_000,
    pollIntervalMs: 1,
    includeApplicationLog: true,
  });

  expect(result).toMatchObject({
    txid: '0xabcdef1234567890',
    confirmed: true,
    blockHeight: mockTransactionHeight,
    transaction: mockTransaction,
    applicationLog: expect.objectContaining({
      txid: '0xabcdef1234567890',
      executions: expect.arrayContaining([
        expect.objectContaining({
          notifications: expect.arrayContaining([
            expect.objectContaining({
              parsed: expect.objectContaining({
                to: expect.objectContaining({
                  address: mockFlamingoAddress,
                  displayName: mockFlamingoAddress,
                }),
              }),
            }),
          ]),
        }),
      ]),
    }),
  });

  expect(result.applicationLog?.executions[0].notifications[0].parsed.to).not.toHaveProperty('knownAccount');
});

test('waitForTransaction preserves confirmation when the optional application log fails', async () => {
  const mockRpcClient = (neoService as any).rpcClient;
  mockRpcClient.getApplicationLog = jest.fn().mockRejectedValue(new Error('Application log unavailable'));

  await expect(neoService.waitForTransaction('0xabcdef1234567890', {
    timeoutMs: 1_000,
    pollIntervalMs: 1,
    includeApplicationLog: true,
  })).resolves.toMatchObject({
    txid: '0xabcdef1234567890',
    confirmed: true,
    blockHeight: mockTransactionHeight,
    transaction: mockTransaction,
    applicationLogError: 'Application log unavailable',
  });
});

test('waitForTransaction never sleeps past its deadline', async () => {
  const mockRpcClient = (neoService as any).rpcClient;
  (neoService as any).networkMagic = 860833102;
  mockRpcClient.getTransactionHeight = jest.fn().mockRejectedValue(new Error('Unknown transaction'));
  const nowSpy = jest.spyOn(Date, 'now')
    .mockReturnValueOnce(1000)
    .mockReturnValueOnce(1040)
    .mockReturnValueOnce(1040)
    .mockReturnValue(1060);
  const timeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((callback: () => void) => {
    callback();
    return {} as NodeJS.Timeout;
  }) as typeof setTimeout);

  try {
    await expect(neoService.waitForTransaction('0xabcdef1234567890', {
      timeoutMs: 50,
      pollIntervalMs: 1000,
    })).resolves.toMatchObject({ confirmed: false, timeoutMs: 50 });
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 10);
  } finally {
    timeoutSpy.mockRestore();
    nowSpy.mockRestore();
  }
});

test('waitForTransaction bounds a never-resolving RPC call by its timeout', async () => {
  jest.useFakeTimers();
  const mockRpcClient = (neoService as any).rpcClient;
  mockRpcClient.getTransactionHeight = jest.fn().mockReturnValue(new Promise(() => undefined));

  try {
    const waitResult = neoService.waitForTransaction('0xabcdef1234567890', {
      timeoutMs: 20,
      pollIntervalMs: 1,
    });
    await jest.advanceTimersByTimeAsync(25);

    await expect(waitResult).resolves.toMatchObject({
      txid: '0xabcdef1234567890',
      confirmed: false,
      timeoutMs: 20,
    });
  } finally {
    jest.useRealTimers();
  }
});

test('waitForTransaction applies the configured RPC deadline to each polling attempt', async () => {
  jest.useFakeTimers();
  const service = new NeoService(
    'http://localhost:10332',
    NeoNetwork.MAINNET,
    { rpcTimeoutMs: 10, minTransactionPollIntervalMs: 1 },
  );
  const mockRpcClient = (service as any).rpcClient;
  mockRpcClient.getTransactionHeight = jest.fn().mockReturnValue(new Promise(() => undefined));

  try {
    const waitResult = service.waitForTransaction('0xabcdef1234567890', {
      timeoutMs: 50,
      pollIntervalMs: 1,
    });

    await jest.advanceTimersByTimeAsync(60);

    await expect(waitResult).resolves.toMatchObject({
      txid: '0xabcdef1234567890',
      confirmed: false,
      timeoutMs: 50,
    });
    expect(mockRpcClient.getTransactionHeight.mock.calls.length).toBeGreaterThan(1);
  } finally {
    jest.useRealTimers();
  }
});

test('waitForTransaction rejects out-of-bounds polling options before making RPC calls', async () => {
  const service = new NeoService('http://localhost:10332', NeoNetwork.MAINNET);
  const mockRpcClient = (service as any).rpcClient;

  await expect(service.waitForTransaction('0xabcdef1234567890', {
    timeoutMs: 120_001,
  })).rejects.toThrow(/timeoutMs.*must not exceed/i);
  await expect(service.waitForTransaction('0xabcdef1234567890', {
    timeoutMs: 1_000,
    pollIntervalMs: 249,
  })).rejects.toThrow(/pollIntervalMs.*at least/i);
  expect(mockRpcClient.getTransactionHeight).not.toHaveBeenCalled();
});

test('waitForTransaction releases a polling slot as soon as its request is aborted', async () => {
  const service = new NeoService('http://localhost:10332', NeoNetwork.MAINNET, {
    minTransactionPollIntervalMs: 1,
    maxConcurrentTransactionWaits: 1,
  } as any);
  const mockRpcClient = (service as any).rpcClient;
  mockRpcClient.getTransactionHeight = jest.fn().mockReturnValue(new Promise(() => undefined));
  const controller = new AbortController();
  const firstWait = service.waitForTransaction('0xabcdef1234567890', {
    timeoutMs: 1_000,
    pollIntervalMs: 1,
    signal: controller.signal,
  } as any);

  await expect(service.waitForTransaction('0xabcdef1234567891', {
    timeoutMs: 1_000,
    pollIntervalMs: 1,
  })).rejects.toBeInstanceOf(RateLimitError);

  controller.abort();
  await expect(firstWait).rejects.toMatchObject({ name: 'OperationAbortedError' });

  mockRpcClient.getTransactionHeight = jest.fn().mockResolvedValue(42);
  await expect(service.waitForTransaction('0xabcdef1234567892', {
    timeoutMs: 1_000,
    pollIntervalMs: 1,
  })).resolves.toMatchObject({ confirmed: true, blockHeight: 42 });
});

  test('transferAssets uses fixed native NEO decimals without trusting RPC metadata', async () => {
    const account = { address: 'NaMLm1hwCaQitxmLboJGo2XJkG8PSYvuyr', contract: { script: 'EQ==' } };
    const result = await neoService.transferAssets(
      account,
      'NaMLm1hwCaQitxmLboJGo2XJkG8PSYvuyr',
      'NEO',
      '1'
    );

    expect(result).toHaveProperty('txid', mockTransactionId);

    const neonJs = require('@cityofzion/neon-js');
    expect(neonJs.experimental.nep17.Nep17Contract).not.toHaveBeenCalled();
    expect((neoService as any).rpcClient.invokeFunction).not.toHaveBeenCalledWith(
      expect.anything(), 'decimals', []
    );
    expect(mockContractParamInteger).toHaveBeenCalledWith('1');
  });

  test('rejects a checksum-invalid transfer recipient before building or submitting', async () => {
    await expect(neoService.transferAssets(
      { address: mockSenderAddress, scriptHash: mockSenderScriptHash, contract: { script: 'EQ==' } },
      'NbMLm1hwCaQitxmLboJGo2XJkG8PSYvuyr',
      'NEO',
      '1'
    )).rejects.toThrow(/invalid recipient address/i);

    expect(mockScriptBuilderEmitAppCall).not.toHaveBeenCalled();
    expect(mockSendRawTransaction).not.toHaveBeenCalled();
  });

  test.each([
    ['transferAssets', () => neoService.transferAssets(
      { address: mockSenderAddress, scriptHash: mockSenderScriptHash, contract: { script: 'EQ==' } },
      mockFlamingoAddress,
      mockFlamingoScriptHash,
      '1',
    )],
    ['calculateTransferFee', () => neoService.calculateTransferFee(
      mockSenderAddress,
      mockFlamingoAddress,
      mockFlamingoScriptHash,
      '1',
    )],
  ])('%s accepts an unprefixed 40-hex asset script hash', async (_method, transfer) => {
    await expect(transfer()).resolves.toBeDefined();

    expect((neoService as any).rpcClient.invokeFunction).toHaveBeenCalledWith(
      `0x${mockFlamingoScriptHash}`,
      'decimals',
      [],
    );
  });

  test('refuses to sign when the RPC endpoint reports a different network magic', async () => {
    (neoService as any).fetchRpcVersion = jest.fn().mockResolvedValue({
      protocol: { network: 894710606 },
    });

    await expect(neoService.transferAssets(
      { address: mockSenderAddress },
      mockFlamingoAddress,
      'GAS',
      '1',
    )).rejects.toThrow(/RPC network mismatch.*mainnet.*860833102.*894710606/i);
    expect(mockSendRawTransaction).not.toHaveBeenCalled();
  });

  test('refuses read operations when the RPC endpoint reports a different network magic', async () => {
    const rpcClient = (neoService as any).rpcClient;
    (neoService as any).fetchRpcVersion = jest.fn().mockResolvedValue({
      protocol: { network: 894710606 },
    });

    await expect(neoService.getBlockCount())
      .rejects.toThrow(/RPC network mismatch.*mainnet.*860833102.*894710606/i);
    expect(rpcClient.getBlockCount).not.toHaveBeenCalled();
  });

  test('preserves fee-policy validation errors from transfers', async () => {
    const policyError = new ValidationError('Transaction fees exceed the configured maximum');
    jest.spyOn(neoService as any, 'buildNep17TransferScript').mockRejectedValue(policyError);

    await expect(neoService.transferAssets(
      { address: mockSenderAddress },
      mockFlamingoAddress,
      'GAS',
      '1',
    )).rejects.toBe(policyError);
  });

  test('preserves fee-policy validation errors from GAS claims', async () => {
    const policyError = new ValidationError('Insufficient GAS for transaction fees');
    jest.spyOn(neoService as any, 'buildNep17TransferScript').mockRejectedValue(policyError);

    await expect(neoService.claimGas({ address: mockSenderAddress }))
      .rejects.toBe(policyError);
  });

  test('calculateTransferFee and transferAssets build the same scaled ASSERT transfer script', async () => {
    const account = { address: mockSenderAddress, scriptHash: mockSenderScriptHash, contract: { script: 'EQ==' } };

    await neoService.calculateTransferFee(mockSenderAddress, mockFlamingoAddress, 'GAS', '1.25');
    await neoService.transferAssets(account, mockFlamingoAddress, 'GAS', '1.25');

    expect(mockScriptBuilderEmitAppCall).toHaveBeenCalledTimes(2);
    expect(mockScriptBuilderEmitAppCall.mock.calls[0]).toEqual(mockScriptBuilderEmitAppCall.mock.calls[1]);
    expect(mockScriptBuilderEmitAppCall).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'transfer',
      [expect.anything(), expect.anything(), 'integerParam', 'anyParam'],
    );
    expect(mockScriptBuilderEmit).toHaveBeenNthCalledWith(1, 'ASSERT');
    expect(mockScriptBuilderEmit).toHaveBeenNthCalledWith(2, 'ASSERT');
    expect(mockTransactions[0]).toMatchObject({ script: 'hexString' });
    expect(mockTransactions[1]).toMatchObject({ script: 'hexString' });
    expect(mockSetBlockExpiry).not.toHaveBeenCalled();
    expect(mockAddFees).not.toHaveBeenCalled();
    expect(mockSendRawTransaction).toHaveBeenCalledWith('hexString');
  });

  test.each([
    ['transfer', () => neoService.calculateTransferFee(
      mockSenderAddress,
      mockFlamingoAddress,
      'GAS',
      '1',
    )],
    ['invoke', () => neoService.calculateInvokeFee(
      mockSenderAddress,
      '0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5',
      'transfer',
      [],
    )],
  ])('calculate%sFee uses a matching disposable signer and witness', async (_name, calculate) => {
    await calculate();

    const feeTransaction = mockSmartCalculateNetworkFee.mock.calls.at(-1)?.[0] as any;
    expect(feeTransaction.signers).toEqual([
      expect.objectContaining({ account: mockDummyScriptHash }),
    ]);
    expect(feeTransaction.witnesses).toEqual([
      expect.objectContaining({ verificationScript: 'verificationScript' }),
    ]);
  });

  test('scales large decimal transfer amounts without JavaScript precision loss', async () => {
    await neoService.calculateTransferFee(
      mockSenderAddress,
      mockFlamingoAddress,
      'GAS',
      '90071992.54740991',
    );

    expect(mockContractParamInteger).toHaveBeenCalledWith('9007199254740991');
  });

  test.each([101, 255])('supports valid NEP-17 tokens with %i decimals', async (decimals) => {
    mockNep17Decimals.mockResolvedValueOnce(decimals);
    const smallestUnit = `0.${'0'.repeat(decimals - 1)}1`;

    await neoService.calculateTransferFee(
      mockSenderAddress,
      mockFlamingoAddress,
      mockFlamingoScriptHash,
      smallestUnit,
    );

    expect(mockContractParamInteger).toHaveBeenCalledWith('1');
  });

  test('rejects numeric fractional token amounts so precision cannot be lost before scaling', async () => {
    await expect(neoService.calculateTransferFee(
      mockSenderAddress,
      mockFlamingoAddress,
      'GAS',
      0.1 as any,
    )).rejects.toThrow(/decimal string/i);
  });

  test('rejects transfer amounts with more precision than the token supports', async () => {
    await expect(neoService.calculateTransferFee(
      mockSenderAddress,
      mockFlamingoAddress,
      'GAS',
      '0.000000001',
    )).rejects.toThrow(/more than 8 decimal places/i);
  });

  test('invokeReadContract rejects VM FAULT and preserves VM details', async () => {
    const mockRpcClient = (neoService as any).rpcClient;
    mockRpcClient.invokeScript = jest.fn().mockResolvedValue({
      state: 'FAULT',
      exception: 'division by zero',
      gasconsumed: '42',
      stack: [{ type: 'Integer', value: '7' }],
    });

    await expect(neoService.invokeReadContract(
      '0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5',
      'brokenOperation',
    )).rejects.toThrow(/FAULT.*division by zero.*gasconsumed.*42.*stack.*7/i);
  });

  test('invokeReadContract encodes Neo address arguments as Hash160 values', async () => {
    await neoService.invokeReadContract(
      '0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5',
      'balanceOf',
      [mockSenderAddress],
    );

    const neonJs = jest.requireMock('@cityofzion/neon-js') as any;
    expect(neonJs.sc.createScript).toHaveBeenCalledWith(expect.objectContaining({
      args: [{ type: 'Hash160', value: mockSenderScriptHash }],
    }));
  });

  test.each([
    ['invokeReadContract', () => neoService.invokeReadContract(
      '0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5',
      'balanceOf',
      [1.5],
    )],
    ['invokeContract', () => neoService.invokeContract(
      { address: mockSenderAddress, scriptHash: mockSenderScriptHash, contract: { script: 'EQ==' } },
      '0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5',
      'balanceOf',
      [1.5],
    )],
    ['calculateInvokeFee', () => neoService.calculateInvokeFee(
      mockSenderAddress,
      '0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5',
      'balanceOf',
      [1.5],
    )],
  ])('%s preserves validation errors raised by malformed contract parameters', async (_method, invoke) => {
    await expect(invoke()).rejects.toBeInstanceOf(ValidationError);
  });

  test.each([
    ['transferAssets', () => neoService.transferAssets(
      { address: mockSenderAddress },
      mockFlamingoAddress,
      'GAS',
      '1',
      [{ type: 'HighPriority' }],
    )],
    ['invokeContract', () => neoService.invokeContract(
      { address: mockSenderAddress },
      '0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5',
      'transfer',
      [],
      [{ type: 'HighPriority' }],
    )],
  ])('%s rejects unsupported additional transaction attributes', async (_method, invoke) => {
    await expect(invoke()).rejects.toThrow(/additional transaction attributes are not supported/i);
    expect(mockSendRawTransaction).not.toHaveBeenCalled();
    expect(mockSmartContractInvoke).not.toHaveBeenCalled();
  });

  test('invokeContract builds locally and submits through the configured RPC client', async () => {
    const account = { address: 'NaMLm1hwCaQitxmLboJGo2XJkG8PSYvuyr', contract: { script: 'EQ==' } };
    const result = await neoService.invokeContract(
      account,
      '0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5',
      'transfer',
      []
    );

    expect(result).toHaveProperty('txid', mockTransactionId);
    const neonJs = require('@cityofzion/neon-js');
    expect(neonJs.experimental.SmartContract).not.toHaveBeenCalled();
    expect(mockSetBlockExpiry).not.toHaveBeenCalled();
    expect(mockAddFees).not.toHaveBeenCalled();
    expect(mockSendRawTransaction).toHaveBeenCalledWith('hexString');
  });

  test('rejects a checksum-invalid signing address before building or submitting', async () => {
    await expect(neoService.invokeContract(
      { address: 'NbMLm1hwCaQitxmLboJGo2XJkG8PSYvuyr', contract: { script: 'EQ==' } },
      '0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5',
      'transfer',
      []
    )).rejects.toThrow(/invalid sender address/i);

    expect(mockSendRawTransaction).not.toHaveBeenCalled();
  });

  test('returns fee estimates as exact datos strings', async () => {
    const rpcClient = (neoService as any).rpcClient;
    rpcClient.invokeScript = jest.fn().mockResolvedValue({
      state: 'HALT',
      gasconsumed: '9007199254740995',
    });
    mockSmartCalculateNetworkFee.mockResolvedValueOnce({
      toString: () => '9007199254740993',
    });

    await expect(neoService.calculateInvokeFee(
      mockSenderAddress,
      '0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5',
      'balanceOf',
      [],
    )).resolves.toMatchObject({
      networkFeeDatos: '9007199254740993',
      systemFeeDatos: '9007199254740995',
    });
  });

  test('rejects an inconsistent RPC transaction ID and reports the locally derived ID', async () => {
    mockSendRawTransaction.mockResolvedValueOnce(`0x${'d'.repeat(64)}`);

    await expect(neoService.invokeContract(
      { address: mockSenderAddress, contract: { script: 'EQ==' } },
      '0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5',
      'transfer',
      []
    )).rejects.toThrow(new RegExp(`outcome is unknown.*0x${'b'.repeat(64)}.*do not retry`, 'i'));
  });

  test('claimGas builds locally and submits through the configured RPC client', async () => {
    const account = { address: 'NaMLm1hwCaQitxmLboJGo2XJkG8PSYvuyr', contract: { script: 'EQ==' } };
    mockNep17Decimals.mockResolvedValueOnce(0);
    const result = await neoService.claimGas(account);

    expect(result).toHaveProperty('txid', mockTransactionId);
    expect(mockClaimGas).not.toHaveBeenCalled();
    expect(mockSendRawTransaction).toHaveBeenCalledWith('hexString');
  });

  test('reports an unknown submission outcome with the expected transaction ID on timeout', async () => {
    const service = new NeoService('http://localhost:10332', NeoNetwork.MAINNET, {
      rpcTimeoutMs: 10,
    });
    (service as any).rpcClient.sendRawTransaction = jest.fn().mockReturnValue(new Promise(() => undefined));

    const outcome = await service.invokeContract(
      { address: mockSenderAddress, contract: { script: 'EQ==' } },
      '0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5',
      'transfer',
      []
    ).then(() => 'resolved', (error) => error);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/outcome is unknown.*0x[b]{64}.*do not retry/i);
  });

  test('reports an unknown submission outcome with the expected transaction ID on transport failure', async () => {
    mockSendRawTransaction.mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(neoService.invokeContract(
      { address: mockSenderAddress, contract: { script: 'EQ==' } },
      '0xef4073a0f2b305a38ec4050e4d3d28bc40ea63f5',
      'transfer',
      []
    )).rejects.toThrow(/outcome is unknown.*0x[b]{64}.*do not retry/i);
  });

  test('createWallet returns wallet information without raw WIF leakage', async () => {
    const wallet = await neoService.createWallet('password');
    expect(wallet).toHaveProperty('address', 'NaMLm1hwCaQitxmLboJGo2XJkG8PSYvuyr');
    expect(wallet).toHaveProperty('publicKey', 'publicKey');
    expect(wallet).toHaveProperty('encryptedPrivateKey', 'encryptedKey');
    expect(wallet).not.toHaveProperty('WIF');
  });

  test('importWallet returns wallet information', async () => {
    const wallet = await neoService.importWallet('WIF');
    expect(wallet).toHaveProperty('address', 'NaMLm1hwCaQitxmLboJGo2XJkG8PSYvuyr');
    expect(wallet).toHaveProperty('publicKey', 'publicKey');
  });

  test('getNetwork returns the current network', () => {
    expect(neoService.getNetwork()).toBe(NeoNetwork.MAINNET);

    const testnetService = new NeoService('http://localhost:10332', NeoNetwork.TESTNET);
    expect(testnetService.getNetwork()).toBe(NeoNetwork.TESTNET);
  });
});
