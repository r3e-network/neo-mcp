'use strict';

/**
 * Preload hook (`node --require`) that freezes `Date.now` for a child process.
 * Used by the release-archive determinism test so two builds can run under two
 * different wall clocks without sleeping across a Unix-second boundary.
 */
const raw = process.env.FAKE_NOW;
if (raw !== undefined && raw !== '') {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`FAKE_NOW must be a finite number, got ${JSON.stringify(raw)}`);
  }
  Date.now = () => value;
}
