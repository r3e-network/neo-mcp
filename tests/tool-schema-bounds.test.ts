import { PUBLIC_TOOLS } from '../src/registry/tool-registry';

/**
 * The public input schemas are the only thing standing between a model-authored string and
 * an ABI encoder / calldata blob / RPC envelope. Each bound is asserted to REJECT above the
 * limit and ACCEPT at it, so a removed `max()` is a caught defect rather than a silent hole.
 */
function field(tool: string, name: string) {
  const spec = PUBLIC_TOOLS[tool];
  expect(spec).toBeDefined();
  const schema = spec.inputSchema[name];
  expect(schema).toBeDefined();
  return schema;
}

describe('public tool input bounds', () => {
  test('call_contract bounds operation, argument count, calldata and signature', () => {
    expect(field('call_contract', 'operation').safeParse('o'.repeat(128)).success).toBe(true);
    expect(field('call_contract', 'operation').safeParse('o'.repeat(129)).success).toBe(false);

    expect(field('call_contract', 'args').safeParse(Array.from({ length: 64 }, () => 1)).success).toBe(true);
    expect(field('call_contract', 'args').safeParse(Array.from({ length: 65 }, () => 1)).success).toBe(false);

    expect(field('call_contract', 'data').safeParse('0x' + 'ab'.repeat(131072)).success).toBe(true);
    expect(field('call_contract', 'data').safeParse('0x' + 'ab'.repeat(131073)).success).toBe(false);

    expect(field('call_contract', 'functionSignature').safeParse('f(' + 'a'.repeat(1019) + ')').success).toBe(true);
    expect(field('call_contract', 'functionSignature').safeParse('g'.repeat(1025)).success).toBe(false);
  });

  test('simulate_call bounds its calldata', () => {
    expect(field('simulate_call', 'data').safeParse('0x' + 'cd'.repeat(131072)).success).toBe(true);
    expect(field('simulate_call', 'data').safeParse('0x' + 'cd'.repeat(131073)).success).toBe(false);
  });

  test('build_transfer bounds the wei amount', () => {
    expect(field('build_transfer', 'amountWei').safeParse('1'.repeat(78)).success).toBe(true);
    expect(field('build_transfer', 'amountWei').safeParse('1'.repeat(79)).success).toBe(false);
  });

  test('build_contract_call bounds operation, arguments, calldata, signature and value', () => {
    expect(field('build_contract_call', 'operation').safeParse('o'.repeat(129)).success).toBe(false);
    expect(field('build_contract_call', 'args').safeParse(Array.from({ length: 65 }, () => 1)).success).toBe(false);
    expect(field('build_contract_call', 'data').safeParse('0x' + 'ef'.repeat(131073)).success).toBe(false);
    expect(field('build_contract_call', 'functionSignature').safeParse('h'.repeat(1025)).success).toBe(false);
    expect(field('build_contract_call', 'valueWei').safeParse('9'.repeat(78)).success).toBe(true);
    expect(field('build_contract_call', 'valueWei').safeParse('9'.repeat(79)).success).toBe(false);
  });

  test('every bounded field still accepts an ordinary value', () => {
    expect(field('call_contract', 'operation').safeParse('balanceOf').success).toBe(true);
    expect(field('call_contract', 'args').safeParse(['0x' + '11'.repeat(20)]).success).toBe(true);
    expect(field('call_contract', 'data').safeParse('0xdeadbeef').success).toBe(true);
    expect(field('call_contract', 'functionSignature').safeParse('balanceOf(address)').success).toBe(true);
    expect(field('build_transfer', 'amountWei').safeParse('1000000000000000000').success).toBe(true);
  });
});
