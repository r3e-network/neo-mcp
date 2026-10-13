import { config } from '../config';
import { ValidationError } from './errors';

/** The environment switch that owns the n3index analytical surface. */
export const N3INDEX_ENABLE_FLAG = 'N3INDEX_ENABLED';

/**
 * Whether the n3index analytical surface (`api.n3index.dev`) may be contacted.
 *
 * Read at call time, never cached: the operator switch is the authority and a long-lived
 * process must honour a flip without a restart.
 */
export function isIndexerAvailable(): boolean {
  return config.n3index.enabled === true;
}

/**
 * The refusal raised before any host is resolved while the surface is off.
 *
 * The subject names the capability the caller asked for, so the message is a diagnosis rather
 * than a blank failure. Nothing from the request or the upstream response is echoed.
 */
export function indexerDisabled(subject: string): ValidationError {
  return new ValidationError(`${subject} is disabled; enable ${N3INDEX_ENABLE_FLAG}`);
}

/**
 * Refuse an indexer-backed read while `N3INDEX_ENABLED` is off.
 *
 * Every n3index entry point calls this BEFORE URL construction, fetch, or service activation,
 * so with the flag off no tool reaches the indexer host. Callers get a typed
 * `ValidationError` (`InvalidParams`), which the error surface passes through verbatim.
 *
 * @param subject Capability name to quote in the refusal (a public tool or endpoint key).
 * @throws {ValidationError} when the indexer surface is switched off.
 */
export function assertIndexerAvailable(subject: string): void {
  if (!isIndexerAvailable()) {
    throw indexerDisabled(subject);
  }
}
