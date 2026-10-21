// Team-name matching across football-data.org, football-data.co.uk and ClubElo.
//
// canonical key = lower case, no diacritics, "&" -> "and", punctuation removed,
//                 generic tokens such as fc / cf / afc / ssc / sv dropped.
// aliases.json overrides the key (it is edited by hand on GitHub).
// Fuzzy fallback: token-Jaccard or Jaro-Winkler >= 0.9, accepted only when
// exactly one candidate qualifies.

const SPECIAL = { ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', ł: 'l', đ: 'd', ð: 'd', þ: 'th', ı: 'i' };

// Generic club-form tokens carry no identity. The first five are required by
// the spec; the rest are the usual prefixes / suffixes in these data sets.
export const DROP_TOKENS = new Set([
  'fc', 'cf', 'afc', 'ssc', 'sv',
  'ac', 'as', 'ss', 'sc', 'us', 'ud', 'cd', 'rc', 'rcd', 'fk', 'sk', 'sd', 'ca', 'ssd',
  'bsc', 'tsg', 'vfb', 'vfl', 'fsv', 'calcio', 'club', 'futbol', 'football', '1',
]);

export function canonicalKey(name) {
  if (typeof name !== 'string') return '';
  let s = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = s.replace(/[øæœßłđðþı]/g, (c) => SPECIAL[c]);
  s = s.replace(/&/g, ' and ');
  s = s.replace(/['’`]/g, ''); // Nott'm -> nottm, M'gladbach -> mgladbach
  s = s.replace(/[^a-z0-9]+/g, ' ').trim();
  const tokens = s.split(' ').filter(Boolean);
  const kept = tokens.filter((t) => !DROP_TOKENS.has(t));
  return (kept.length > 0 ? kept : tokens).join(' ');
}

export function jaroWinkler(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatch = new Array(a.length).fill(false);
  const bMatch = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(b.length - 1, i + window);
    for (let j = lo; j <= hi; j++) {
      if (!bMatch[j] && a[i] === b[j]) {
        aMatch[i] = true;
        bMatch[j] = true;
        matches++;
        break;
      }
    }
  }
  if (matches === 0) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  return jaro > 0.7 ? jaro + prefix * 0.1 * (1 - jaro) : jaro;
}

export function tokenJaccard(a, b) {
  const A = new Set(a.split(' ').filter(Boolean));
  const B = new Set(b.split(' ').filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export function similarity(a, b) {
  return Math.max(jaroWinkler(a, b), tokenJaccard(a, b));
}

export const FUZZY_THRESHOLD = 0.9;

/**
 * aliases: { "Display name": ["alias", ...], ... } (the aliases.json format).
 */
export function createResolver(aliases = {}) {
  const map = new Map(); // canonical key of any alias -> canonical key of its group
  const conflicts = [];
  for (const [display, list] of Object.entries(aliases)) {
    if (display.startsWith('_')) continue; // comment keys
    const group = canonicalKey(display);
    const all = [display, ...(Array.isArray(list) ? list : [])];
    for (const n of all) {
      const k = canonicalKey(n);
      if (!k) continue;
      if (map.has(k) && map.get(k) !== group) conflicts.push({ alias: n, groups: [map.get(k), group] });
      map.set(k, group);
    }
  }

  /** Resolved key of a name (alias applied, no universe needed). */
  function key(name) {
    const k = canonicalKey(name);
    return map.get(k) ?? k;
  }

  /**
   * Match a name against a universe (Set of resolved keys).
   * Returns { key, how } with how = exact | alias | fuzzy, or
   * { key: null, how: none | ambiguous, candidates }.
   */
  function match(name, universe) {
    const raw = canonicalKey(name);
    if (!raw) return { key: null, how: 'none', candidates: [] };
    const resolved = map.get(raw);
    const k = resolved ?? raw;
    if (universe.has(k)) return { key: k, how: resolved && resolved !== raw ? 'alias' : 'exact' };
    const scored = [];
    for (const u of universe) {
      const s = similarity(k, u);
      if (s >= FUZZY_THRESHOLD) scored.push({ key: u, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    if (scored.length === 1) return { key: scored[0].key, how: 'fuzzy', score: scored[0].score };
    if (scored.length > 1) return { key: null, how: 'ambiguous', candidates: scored.slice(0, 3) };
    return { key: null, how: 'none', candidates: [] };
  }

  /** Try several spellings (e.g. name, shortName) and return the first match. */
  function matchAny(names, universe) {
    let last = { key: null, how: 'none', candidates: [] };
    for (const n of names) {
      if (!n) continue;
      const m = match(n, universe);
      if (m.key) return m;
      if (m.how === 'ambiguous') last = m;
    }
    return last;
  }

  /** Closest keys (any score) for diagnostics / alias suggestions. */
  function closest(name, universe, n = 3) {
    const k = key(name);
    return [...universe]
      .map((u) => ({ key: u, score: similarity(k, u) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, n);
  }

  return { key, match, matchAny, closest, conflicts, size: map.size };
}
