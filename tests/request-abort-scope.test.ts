import { createRequestAbortScope } from '../src/utils/request-abort-scope';

describe('per-attempt abort resource scope', () => {
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  test('deadline aborts only this attempt, and disposal cancels resources', () => {
    jest.useFakeTimers();
    const parent = new AbortController();
    const remove = jest.spyOn(parent.signal, 'removeEventListener');
    const scope = createRequestAbortScope(100, parent.signal);
    expect(scope.aborted).toBe(false); jest.advanceTimersByTime(100); expect(scope.aborted).toBe(true); expect(parent.signal.aborted).toBe(false);
    scope.dispose(); scope.dispose();
    expect(jest.getTimerCount()).toBe(0);
    // Disposal is idempotent: the parent listener is detached exactly once.
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test('a sibling attempt on the same parent is NOT cancelled by this attempt deadline', () => {
    // Scope of an abort: the attempt that hit its deadline is cancelled; the parent request
    // and every sibling attempt keep running. Only the parent abort (below) cancels them.
    jest.useFakeTimers();
    const parent = new AbortController();
    const first = createRequestAbortScope(100, parent.signal);
    const second = createRequestAbortScope(5000, parent.signal);
    // Each attempt owns its own abort resource; nothing is shared with the parent or a sibling.
    expect(first.signal).not.toBe(second.signal);
    expect(first.signal).not.toBe(parent.signal);
    expect(second.signal).not.toBe(parent.signal);
    jest.advanceTimersByTime(100);
    expect(first.aborted).toBe(true);
    expect(second.aborted).toBe(false);
    expect(parent.signal.aborted).toBe(false);
    expect(second.signal?.aborted).toBe(false);
    first.dispose(); second.dispose();
  });

  test('parent abort is forwarded to every live attempt and the listener is removed', () => {
    jest.useFakeTimers(); const parent = new AbortController(), remove = jest.spyOn(parent.signal, 'removeEventListener');
    const scope = createRequestAbortScope(100, parent.signal); parent.abort(); expect(scope.signal?.aborted).toBe(true);
    scope.dispose(); expect(remove).toHaveBeenCalledWith('abort', expect.any(Function)); expect(jest.getTimerCount()).toBe(0);
  });

  test('already-aborted parent is preserved', () => {
    const parent = new AbortController(); parent.abort(); const scope = createRequestAbortScope(100, parent.signal);
    expect(scope.aborted).toBe(true); scope.dispose();
  });

  test('disposed scope no longer observes later parent abort or timer expiry', () => {
    jest.useFakeTimers(); const parent = new AbortController(), scope = createRequestAbortScope(100, parent.signal);
    scope.dispose(); parent.abort(); jest.advanceTimersByTime(100); expect(scope.aborted).toBe(false);
  });

  test.each([0, -1, NaN, Infinity, 1.5, 2147483648])('invalid timeout %s is rejected', value => {
    expect(() => createRequestAbortScope(value)).toThrow('Invalid RPC timeout');
  });

  test('preserves the existing no-AbortController compatibility path without timers', () => {
    jest.useFakeTimers();
    const original = global.AbortController;
    try { Object.defineProperty(global, 'AbortController', { value: undefined, configurable: true });
      const scope = createRequestAbortScope(100); expect(scope.signal).toBeUndefined(); expect(scope.aborted).toBe(false); scope.dispose();
      expect(jest.getTimerCount()).toBe(0);
    } finally { Object.defineProperty(global, 'AbortController', { value: original, configurable: true }); }
  });
});
