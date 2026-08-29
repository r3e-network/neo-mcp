import { config } from '../src/config';
import { requestAccountWatch } from '../src/handlers/account-watch-tools';

const ADDRESS = 'NZeAarn3UMCqNsTymTMF2Pn6X7Yw3GhqDv';
const TOKEN = 'account-watch-integration-token-at-least-32-bytes';

describe('account watch MCP tool', () => {
  const original = { ...config.accountWatch };

  beforeEach(() => {
    Object.assign(config.accountWatch, {
      enabled: true,
      apiUrl: 'https://www.neo3scan.com/api/account-watches',
      apiToken: TOKEN,
    });
  });

  afterAll(() => {
    Object.assign(config.accountWatch, original);
  });

  test('requests a double-opt-in verification without echoing the email', async () => {
    const fetchMock = jest.fn(async () => new Response(JSON.stringify({
      success: true,
      message: 'accepted',
    }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    }));

    const result = await requestAccountWatch({
      network: 'testnet',
      address: ADDRESS,
      email: 'Owner@Example.com',
    }, fetchMock as typeof fetch);

    expect(result).toEqual({
      status: 'verification_pending',
      network: 'testnet',
      address: ADDRESS,
      confirmation_required: true,
      active: false,
      message: expect.stringContaining('only after'),
    });
    expect(result).not.toHaveProperty('email');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.neo3scan.com/api/account-watches',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: expect.objectContaining({ Authorization: `Bearer ${TOKEN}` }),
        body: JSON.stringify({
          network: 'testnet',
          address: ADDRESS,
          email: 'owner@example.com',
        }),
      }),
    );
  });

  test.each([
    [{ address: ADDRESS, email: 'owner@example.com' }, /Network must be explicitly set/],
    [{ network: 'mainnet', address: 'invalid', email: 'owner@example.com' }, /Invalid Neo N3 address/],
    [{ network: 'mainnet', address: ADDRESS, email: 'invalid' }, /valid email/],
  ])('rejects invalid input before calling Explorer', async (input, message) => {
    const fetchMock = jest.fn();
    await expect(requestAccountWatch(input, fetchMock as typeof fetch)).rejects.toThrow(message);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('fails closed when the integration is disabled', async () => {
    config.accountWatch.enabled = false;
    await expect(requestAccountWatch({
      network: 'mainnet',
      address: ADDRESS,
      email: 'owner@example.com',
    }, jest.fn() as typeof fetch)).rejects.toThrow(/disabled/);
  });

  test('rejects a plaintext remote Explorer endpoint at call time', async () => {
    config.accountWatch.apiUrl = 'http://example.com/api/account-watches';
    const fetchMock = jest.fn();
    await expect(requestAccountWatch({
      network: 'mainnet',
      address: ADDRESS,
      email: 'owner@example.com',
    }, fetchMock as typeof fetch)).rejects.toThrow(/endpoint is invalid/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('maps provider throttling without reading or exposing its body', async () => {
    const fetchMock = jest.fn(async () => new Response('provider detail', { status: 429 }));
    await expect(requestAccountWatch({
      network: 'mainnet',
      address: ADDRESS,
      email: 'owner@example.com',
    }, fetchMock as typeof fetch)).rejects.toThrow(/rate limited/);
  });
});
