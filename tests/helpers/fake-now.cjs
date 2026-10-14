'use strict';

/**
 * Preload hook (`node --require`) that freezes every wall-clock surface a
 * build can read a timestamp from, so two builds can run under two different
 * clocks without sleeping across a Unix-second boundary.
 *
 * Surfaces frozen when `FAKE_NOW` is set to a finite number of milliseconds:
 *   - `Date.now()`
 *   - `new Date()` / `new Date(undefined)` (the "now" constructor)
 *   - `Date()` (the function form, which returns a string)
 *   - `atime` / `mtime` / `ctime` / `birthtime` and their `*Ms` fields on
 *     every `fs.stat` / `lstat` / `fstat` result (sync, callback and promise)
 *
 * Explicitly constructed dates (`new Date(123)`, `new Date('...')`) are left
 * alone: only the wall clock is frozen. `Date.parse` and `Date.UTC` are the
 * originals.
 */
const raw = process.env.FAKE_NOW;
if (raw !== undefined && raw !== '') {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`FAKE_NOW must be a finite number, got ${JSON.stringify(raw)}`);
  }

  const RealDate = Date;

  function FakeDate(...args) {
    // `Date()` as a function returns a string of the current time.
    if (new.target === undefined) {
      return new RealDate(value).toString();
    }
    // `new Date()` / `new Date(undefined)` read the wall clock.
    if (args.length === 0 || (args.length === 1 && args[0] === undefined)) {
      return new RealDate(value);
    }
    return new RealDate(...args);
  }
  FakeDate.now = () => value;
  FakeDate.parse = RealDate.parse.bind(RealDate);
  FakeDate.UTC = RealDate.UTC.bind(RealDate);
  FakeDate.prototype = RealDate.prototype;
  Object.defineProperty(FakeDate, 'name', { value: 'Date' });

  globalThis.Date = FakeDate;

  const fs = require('fs');

  function freezeStats(stats) {
    return new Proxy(stats, {
      get(target, prop, receiver) {
        if (prop === 'atimeMs' || prop === 'mtimeMs' || prop === 'ctimeMs' || prop === 'birthtimeMs') {
          return value;
        }
        if (prop === 'atime' || prop === 'mtime' || prop === 'ctime' || prop === 'birthtime') {
          return new RealDate(value);
        }
        const got = Reflect.get(target, prop, receiver);
        return typeof got === 'function' ? got.bind(target) : got;
      },
    });
  }

  for (const name of ['statSync', 'lstatSync', 'fstatSync']) {
    const original = fs[name];
    fs[name] = (...args) => freezeStats(original(...args));
  }
  for (const name of ['stat', 'lstat', 'fstat']) {
    const original = fs[name];
    fs[name] = (...args) => {
      const callback = args[args.length - 1];
      if (typeof callback === 'function') {
        args[args.length - 1] = (error, stats) => callback(error, stats === undefined ? stats : freezeStats(stats));
      }
      return original(...args);
    };
  }
  if (fs.promises && typeof fs.promises.stat === 'function') {
    for (const name of ['stat', 'lstat']) {
      const original = fs.promises[name];
      fs.promises[name] = async (...args) => freezeStats(await original(...args));
    }
  }
}
