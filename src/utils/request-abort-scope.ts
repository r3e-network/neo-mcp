/** Resources owned by exactly one RPC attempt, with no transport/retry policy. */
export interface RequestAbortScope {
  readonly signal: AbortSignal | undefined;
  readonly aborted: boolean;
  dispose(): void;
}

export function createRequestAbortScope(timeoutMs: number, parent?: AbortSignal): RequestAbortScope {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) {
    throw new RangeError('Invalid RPC timeout');
  }
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  const abortFromParent = () => controller?.abort();
  if (parent?.aborted) controller?.abort();
  else parent?.addEventListener('abort', abortFromParent, { once: true });
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  timer?.unref?.();
  let disposed = false;
  return {
    signal: controller?.signal,
    get aborted() { return controller?.signal.aborted === true; },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      parent?.removeEventListener('abort', abortFromParent);
    },
  };
}
