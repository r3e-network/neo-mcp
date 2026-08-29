import { readBoundedJson } from '../utils/bounded-json';
import { config } from '../config';
import { NeoNetwork } from '../services/neo-service';
import { NetworkError, RateLimitError, ValidationError } from '../utils/errors';
import { assertValidRpcUrl } from '../utils/rpc-url';
import { validateAddress, validateNetwork } from '../utils/validation';

type FetchLike = typeof fetch;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 16 * 1024;

export const ACCOUNT_WATCH_TOOLS = new Set(['request_account_watch']);

function normalizeEmail(value: unknown): string {
  const email = String(value || '').trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new ValidationError('A valid email address is required.');
  }
  return email;
}

function watchApiUrl(): string {
  const value = String(config.accountWatch.apiUrl || '').trim();
  try {
    assertValidRpcUrl(value);
  } catch {
    throw new ValidationError('Explorer account watch endpoint is invalid.');
  }
  const parsed = new URL(value);
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parsed.pathname !== '/api/account-watches'
  ) {
    throw new ValidationError('Explorer account watch endpoint is invalid.');
  }
  return parsed.toString();
}

export async function requestAccountWatch(
  input: Record<string, unknown>,
  fetchImpl: FetchLike = fetch,
): Promise<Record<string, unknown>> {
  if (!config.accountWatch.enabled) {
    throw new ValidationError('Explorer account watch requests are disabled on this MCP server.');
  }
  const apiToken = String(config.accountWatch.apiToken || '').trim();
  if (Buffer.byteLength(apiToken, 'utf8') < 32) {
    throw new ValidationError('Explorer account watch integration is not configured.');
  }

  if (input.network !== NeoNetwork.MAINNET && input.network !== NeoNetwork.TESTNET) {
    throw new ValidationError('Network must be explicitly set to mainnet or testnet.');
  }
  const network = validateNetwork(input.network);
  if (network !== NeoNetwork.MAINNET && network !== NeoNetwork.TESTNET) {
    throw new ValidationError('Network must be mainnet or testnet.');
  }
  const address = validateAddress(String(input.address || '').trim());
  const email = normalizeEmail(input.email);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await fetchImpl(watchApiUrl(), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'neo-mcp/account-watch',
      },
      body: JSON.stringify({ network, address, email }),
      redirect: 'error',
      signal: controller.signal,
    });

    if (response.status === 429) {
      await response.body?.cancel?.().catch(() => undefined);
      throw new RateLimitError('Account watch verification is rate limited. Please retry later.');
    }
    if (response.status !== 202) {
      await response.body?.cancel?.().catch(() => undefined);
      throw new NetworkError('Explorer did not accept the account watch verification request.');
    }
    const payload = await readBoundedJson<Record<string, unknown>>(
      response,
      MAX_RESPONSE_BYTES,
      'Explorer account watch',
    );
    if (payload?.success !== true) {
      throw new NetworkError('Explorer returned an invalid account watch response.');
    }

    return {
      status: 'verification_pending',
      network,
      address,
      confirmation_required: true,
      active: false,
      message:
        'The verification request was accepted. The watch becomes active only after the user confirms the email link.',
    };
  } catch (error) {
    if (
      error instanceof ValidationError
      || error instanceof RateLimitError
      || error instanceof NetworkError
    ) {
      throw error;
    }
    if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw new NetworkError('Explorer account watch request timed out.');
    }
    throw new NetworkError('Explorer account watch request failed.');
  } finally {
    clearTimeout(timeout);
  }
}

export async function dispatchAccountWatchTool(
  name: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (name !== 'request_account_watch') {
    throw new ValidationError(`Unknown account watch tool: ${name}`);
  }
  return requestAccountWatch(input);
}
