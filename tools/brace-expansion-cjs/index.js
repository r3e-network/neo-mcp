'use strict';

// brace-expansion <= 5.0.8 is vulnerable to unbounded expansion advisories
// GHSA-mh99-v99m-4gvg and GHSA-rgw5-rvv9-x895. A pattern such as `{0..}` can take
// the process down with an OOM that cannot be caught. Version 5.0.9 applies the
// complete cap at EXPANSION_MAX results / EXPANSION_MAX_LENGTH characters.
//
// That release cannot be dropped in through `overrides` alone. Its CommonJS build is
// an object with `__esModule: true` and a named `expand`, but no `default` and no
// callable module export, so every existing consumer breaks:
//
//   minimatch@3 does `require('brace-expansion')(pattern)`  -> not a function
//   minimatch@9 does `interop(...).default`                 -> undefined
//
// This wrapper restores the callable CommonJS shape those consumers expect while
// keeping the patched implementation, so the vulnerable copy leaves the tree instead
// of being suppressed in the audit gate. The upstream package is aliased as
// `brace-expansion-upstream`: an aliased edge is not matched by the root
// `brace-expansion` override, which is what stops the override from resolving back
// into this wrapper.
const upstream = require('brace-expansion-upstream');

const upstreamExpand = typeof upstream === 'function' ? upstream : upstream.expand;

if (typeof upstreamExpand !== 'function') {
  throw new TypeError('brace-expansion upstream exposes no callable expand()');
}

function braceExpand(pattern, options) {
  return upstreamExpand(pattern, options);
}

module.exports = braceExpand;
module.exports.expand = braceExpand;
module.exports.default = braceExpand;
module.exports.EXPANSION_MAX = upstream.EXPANSION_MAX;
module.exports.EXPANSION_MAX_LENGTH = upstream.EXPANSION_MAX_LENGTH;
