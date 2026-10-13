/**
 * Bounded model check of the real app-intent dispatcher, not a copy of its
 * routing algorithm. Domain: all subsets of the four recognized networks,
 * all three chain declarations, all nonempty capability subsets or omission,
 * four explicit choices, one default choice and no-choice fallback.
 * Canonical network ordering only; no claim about arbitrary JSON, transports,
 * manifest authenticity, cache concurrency or actual transaction execution.
 */
import { clearAppIntentCatalogCache, dispatchAppIntentTool } from '../src/handlers/app-intent-tools';

const networks = ['neo-n3-mainnet', 'neo-n3-testnet', 'neo-x-mainnet', 'neo-x-testnet'];
// Independent declarative relation rather than the implementation's prefix tests.
const chainDomain: Record<string, ReadonlySet<string>> = {
  n3: new Set(networks.slice(0, 2)),
  neox: new Set(networks.slice(2)),
  both: new Set(networks),
};
const subsets = Array.from({ length: 16 }, (_, mask) => networks.filter((_, bit) => mask & (1 << bit)));
const restrictions: (string[] | undefined)[] = [undefined, ...subsets.slice(1)];
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; clearAppIntentCatalogCache(); });

test('bounded routing model: every accepted draft stays in the declaration intersection', async () => {
  let checked = 0;
  let accepted = 0;
  let rejected = 0;
  for (const appNetworks of subsets) for (const [chain, domain] of Object.entries(chainDomain)) {
    for (const restriction of restrictions) {
      const eligible = appNetworks.filter(n => domain.has(n) && (restriction === undefined || restriction.includes(n)));
      // Case 4 checks a default even if it is outside the capability intersection;
      // case 5 checks fallback. An explicit request must override an invalid default.
      for (let choice = 0; choice < 6; choice++) {
        clearAppIntentCatalogCache();
        const defaultNetwork = choice === 5 ? undefined : 'neo-x-mainnet';
        const requested = choice < 4 ? networks[choice] : undefined;
        const expected = requested ?? defaultNetwork ?? eligible[0];
        const shouldAccept = expected !== undefined && eligible.includes(expected);
        const label = JSON.stringify({ appNetworks, chain, restriction, choice });
        global.fetch = jest.fn(async (url) => {
          const kind = String(url).includes('minigames.json') ? 'minigames' : 'miniapps';
          const apps = kind === 'minigames' ? [] : [{
            app_id: 'network-model', supported_networks: appNetworks, default_network: defaultNetwork,
            intent_capabilities: [{ id: 'query_state', mode: 'read', chain, networks: restriction,
              input_schema: { type: 'object', additionalProperties: false } }],
          }];
          return new Response(JSON.stringify({ kind, count: apps.length, apps }), { status: 200 });
        }) as typeof fetch;
        let output: Record<string, unknown> | undefined;
        let failure: unknown;
        try {
          output = await dispatchAppIntentTool('draft_app_intent', {
            appId: 'network-model', action: 'query_state', network: requested, params: {},
          });
        } catch (error) { failure = error; }
        if (shouldAccept) {
          if (failure) throw new Error(`unexpected rejection ${label}: ${String(failure)}`);
          expect({ label, network: output?.network }).toEqual({ label, network: expected });
          expect(output).toMatchObject({ canSign: false, canBroadcast: false, transaction: null,
            requiresUserReview: true, validation: { valid: true } });
          accepted++;
        } else {
          if (!failure) throw new Error(`out-of-domain draft accepted: ${label}`);
          expect(String(failure)).toContain('network_not_supported');
          rejected++;
        }
        checked++;
      }
    }
  }
  expect(checked).toBe(4608);
  expect(accepted).toBeGreaterThan(0);
  expect(rejected).toBeGreaterThan(0);
  console.info(JSON.stringify({ model: 'app-intent-network-intersection/v1', checked, accepted, rejected }));
}, 60000);
