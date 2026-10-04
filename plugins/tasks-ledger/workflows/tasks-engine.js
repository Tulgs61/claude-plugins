// BEGIN glob-overlap
// Conservative overlap test for `files` globs. Each pattern is reduced to its literal prefix (the
// segments before the first one holding a glob character); two patterns are disjoint only when
// those prefixes disagree at a position where both have a segment. A false "overlap" is
// acceptable, a false "disjoint" is not.
function globLiteralPrefix(pattern) {
  const segments = String(pattern == null ? '' : pattern)
    .toLowerCase()
    .replace(/\\/g, '/')
    .split('/')
    .filter(s => s !== '' && s !== '.');
  if (segments.includes('..')) return null;
  const prefix = [];
  for (const s of segments) {
    if (/[*?[\]{}()]/.test(s) || s.startsWith('!')) break;
    prefix.push(s);
  }
  return prefix;
}

function globsOverlap(a, b) {
  const pa = globLiteralPrefix(a);
  const pb = globLiteralPrefix(b);
  if (pa === null || pb === null) return true;
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) if (pa[i] !== pb[i]) return false;
  return true;
}

function globListsOverlap(as, bs) {
  if (!Array.isArray(as) || !Array.isArray(bs)) return false;
  return as.some(a => bs.some(b => globsOverlap(a, b)));
}
// END glob-overlap
