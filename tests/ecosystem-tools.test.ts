import * as neonJs from '@cityofzion/neon-js';
import {
  NNS_SCRIPT_HASHES,
  dispatchEcosystemMetaTool,
  dispatchEcosystemN3Tool,
} from '../src/handlers/ecosystem-tools';
import type { NeoService } from '../src/services/neo-service';

function resultOf(response: Record<string, unknown>): Record<string, any> {
  return response.result as Record<string, any>;
}

function byteString(value: string) {
  return { type: 'ByteString', value: Buffer.from(value, 'utf8').toString('base64') };
}

describe('Neo ecosystem tools', () => {
  test('returns network-correct NNS integration metadata', async () => {
    const mainnet = resultOf(await dispatchEcosystemMetaTool('get_neo_service_info', {
      service: 'nns',
      network: 'mainnet',
    }));
    const testnet = resultOf(await dispatchEcosystemMetaTool('get_neo_service_info', {
      service: 'nns',
      network: 'testnet',
    }));
    expect(mainnet.contractHash).toBe(NNS_SCRIPT_HASHES.mainnet);
    expect(testnet.contractHash).toBe(NNS_SCRIPT_HASHES.testnet);
    expect(testnet.contractHash).not.toBe(mainnet.contractHash);
  });

  test('keeps bridge writes on the official multi-stage bridge surface', async () => {
    const result = resultOf(await dispatchEcosystemMetaTool('get_neo_service_info', {
      service: 'bridge',
      network: 'testnet',
    }));
    expect(result.officialUrl).toBe('https://testnet.bridge.banelabs.org/');
    expect(result.writeBoundary).toMatch(/multi-stage/i);
    expect(result.neoXMessageBridge).toBe('0x1212000000000000000000000000000000000009');
    expect(result.assetBoundary).toMatch(/live bridge UI/i);
  });

  test('generates canonical NeoFS object links without external I/O', async () => {
    const containerId = '3'.repeat(44);
    const objectId = '4'.repeat(44);
    const result = resultOf(await dispatchEcosystemMetaTool('query_neofs', {
      network: 'testnet',
      operation: 'object_link',
      containerId,
      objectId,
    }));
    expect(result.n3Network).toBe('testnet');
    expect(result.networkBoundary).toMatch(/context only/i);
    expect(result.uri).toBe(`neofs://${containerId}/${objectId}`);
    expect(result.httpGatewayUrl).toContain(`${containerId}/${objectId}`);
  });

  test('queries registered NNS properties, owner and records', async () => {
    const owner = 'NiUs458jFbTH1DA3b9QyeDhMaD282h3iJg';
    const ownerHash = neonJs.wallet.getScriptHashFromAddress(owner);
    const ownerBytes = Buffer.from(ownerHash, 'hex').reverse().toString('base64');
    const testInvoke = jest.fn(async (_hash: string, operation: string) => {
      if (operation === 'isAvailable') {
        return { state: 'HALT', exception: null, stack: [{ type: 'Boolean', value: false }] };
      }
      if (operation === 'getPrice') {
        return { state: 'HALT', exception: null, stack: [{ type: 'Integer', value: '200000000' }] };
      }
      if (operation === 'properties') {
        return {
          state: 'HALT',
          exception: null,
          stack: [{
            type: 'Map',
            value: [
              { key: byteString('name'), value: byteString('example.neo') },
              {
                key: byteString('expiration'),
                value: { type: 'Integer', value: '1900000000000' },
              },
            ],
          }],
        };
      }
      if (operation === 'ownerOf') {
        return {
          state: 'HALT',
          exception: null,
          stack: [{ type: 'ByteString', value: ownerBytes }],
        };
      }
      if (operation === 'resolve') {
        return {
          state: 'HALT',
          exception: null,
          stack: [byteString(owner)],
        };
      }
      throw new Error(`unexpected operation ${operation}`);
    });
    const service = {
      getNetwork: () => 'testnet',
      testInvoke,
    } as unknown as NeoService;

    const result = resultOf(await dispatchEcosystemN3Tool('query_nns', {
      domain: 'Example.NEO',
      recordType: 'TXT',
    }, service));
    expect(result).toMatchObject({
      network: 'testnet',
      contractHash: NNS_SCRIPT_HASHES.testnet,
      domain: 'example.neo',
      available: false,
      owner,
      resolved: owner,
      registrationPriceDatos: '200000000',
      registrationPriceGas: '2',
    });
    expect(result.properties).toMatchObject({
      name: 'example.neo',
      expiration: '1900000000000',
    });
    expect(result.properties.expirationIso).toBe(new Date(1900000000000).toISOString());
  });

  test('reads the native Oracle response price', async () => {
    const service = {
      getNetwork: () => 'mainnet',
      testInvoke: jest.fn().mockResolvedValue({
        state: 'HALT',
        exception: null,
        stack: [{ type: 'Integer', value: '50000000' }],
      }),
    } as unknown as NeoService;
    const result = resultOf(await dispatchEcosystemN3Tool('get_oracle_info', {}, service));
    expect(result).toMatchObject({
      network: 'mainnet',
      responseFeeDatos: '50000000',
      responseFeeGas: '0.5',
    });
  });
});
