// Player-name matching between API-Football ("E. Haaland", "M. Salah", "Vinícius Júnior")
// and football-data.org ("Erling Haaland", "Mohamed Salah", "Vinícius Júnior").
//
// The match is only ever made INSIDE one team's list of scorers, and only when exactly
// one candidate fits: a wrong match would remove the wrong player from the scorer list,
// a missing match just leaves the player in (the page then does not know about the absence).
//
// Tiers, the first tier with a hit decides (two hits in a tier = ambiguous = no match):
//   1. identical words after folding (case, accents, dots, hyphens, apostrophes);
//   2. the words of the API name (without a one-letter initial) are the LAST words of the
//      candidate's name, and a given initial agrees with the first letter of its first name;
//   3. at least two words each, same first word and same last word ("Bruno Miguel Fernandes").

const SPECIAL = { ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', ł: 'l', đ: 'd', ð: 'd', þ: 'th', ı: 'i' };

/** Lower-case ASCII words of a person's name. */
export function playerTokens(name) {
  if (typeof name !== 'string') return [];
  let s = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = s.replace(/[øæœßłđðþı]/g, (c) => SPECIAL[c]);
  s = s.replace(/['’`]/g, ''); // N'Golo -> ngolo, O'Neill -> oneill
  return s.replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

const sameWords = (a, b) => a.length === b.length && a.every((t, i) => t === b[i]);

/** Does the API spelling `apiTokens` fit the candidate spelling `candTokens`? Returns the tier (1-3) or 0. */
function tierOf(apiTokens, candTokens) {
  if (sameWords(apiTokens, candTokens)) return 1;
  const initial = apiTokens[0].length === 1 ? apiTokens[0] : null;
  const words = apiTokens.filter((t) => t.length > 1);
  if (words.length === 0) return 0;
  const candWords = candTokens.filter((t) => t.length > 1);
  if (words.length <= candWords.length) {
    const tail = candWords.slice(candWords.length - words.length);
    const first = candTokens[0];
    if (sameWords(words, tail) && (initial === null || (first && first[0] === initial))) return 2;
  }
  if (words.length >= 2 && candWords.length >= 2 && words[0] === candWords[0] && words[words.length - 1] === candWords[candWords.length - 1]) return 3;
  return 0;
}

/**
 * The candidate that `apiName` denotes, or null (no candidate, or more than one).
 * @param {string} apiName
 * @param {object[]} candidates
 * @param {(c: object) => string} [nameOf]
 */
export function matchPlayer(apiName, candidates, nameOf = (c) => c.name) {
  const api = playerTokens(apiName);
  if (api.length === 0) return null;
  const hits = [[], [], []];
  for (const c of candidates) {
    const cand = playerTokens(nameOf(c));
    if (cand.length === 0) continue;
    const tier = tierOf(api, cand);
    if (tier > 0) hits[tier - 1].push(c);
  }
  for (const list of hits) {
    if (list.length === 1) return list[0];
    if (list.length > 1) return null;
  }
  return null;
}
