// Corners and cards for European cup matches (Champions League, Europa League).
//
// There is no common European history of corners / cards, so each club is described by its OWN domestic
// two-sided NegBin model (attack / defence terms of its league). For a cup match:
//   c   = mean of the two leagues' intercepts        (the level of the two competitions averaged)
//   eta = mean of the two leagues' home advantages   (0 on neutral ground, i.e. the final)
//   mHome = exp(c + eta + att_home + def_away)       mAway = exp(c + att_away + def_home)
//   r   = harmonic-type mean 1 / mean(1/r_H, 1/r_A)  (dispersion; Poisson when both are Poisson)
//   reds: mean of the two leagues' base red rate times each club's own shrunken multiplier.
// Limits (shown in the UI as "estimate"): the offset between leagues is not estimated, the referee is not used,
// and the result cannot be back-tested on European matches because we have no history of them.

import { countPmfs, redPmf } from './counts.js';
import { cardMarkets, cornerMarkets } from './markets.js';

export const MIN_EFFECTIVE_MATCHES = 8; // weighted domestic matches needed for a club's terms to be trusted

/** models: [{ code, corners, yellow, red }] from the domestic leagues. */
export function createEuroCounts(models) {
  const list = (models || []).filter((m) => m && (m.corners || m.yellow));

  function find(key, kind) {
    for (const m of list) {
      const model = m[kind];
      if (!model) continue;
      const i = model.index.get(key);
      if (i === undefined) continue;
      if (model.effN && !(model.effN[i] >= MIN_EFFECTIVE_MATCHES)) continue;
      return { code: m.code, model, i };
    }
    return null;
  }

  function combined(a, b) {
    const fa = a.model.fit;
    const fb = b.model.fit;
    const invR = (m) => (m.family === 'negbin' && Number.isFinite(m.r) && m.r > 0 ? 1 / m.r : 0);
    const inv = (invR(a.model) + invR(b.model)) / 2;
    return {
      c: (fa.c + fb.c) / 2,
      eta: (fa.eta + fb.eta) / 2,
      family: inv > 0 ? 'negbin' : 'poisson',
      r: inv > 0 ? 1 / inv : Infinity,
    };
  }

  function means(kind, home, away, neutral) {
    const h = find(home, kind);
    const a = find(away, kind);
    if (!h || !a) return null;
    const co = combined(h, a);
    const eta = neutral ? 0 : co.eta;
    return {
      mHome: Math.exp(co.c + eta + h.model.fit.att[h.i] + a.model.fit.def[a.i]),
      mAway: Math.exp(co.c + a.model.fit.att[a.i] + h.model.fit.def[h.i]),
      co,
      leagues: [h.code, a.code],
    };
  }

  function redTerm(key) {
    for (const m of list) {
      const r = m.red;
      if (r && m.yellow && r.index.has(key)) return { code: m.code, red: r };
    }
    return null;
  }

  return {
    corners(home, away, { neutral = false } = {}) {
      const mm = means('corners', home, away, neutral);
      if (!mm) return null;
      const p = countPmfs({ family: mm.co.family, r: mm.co.r }, mm.mHome, mm.mAway);
      return { ...cornerMarkets(p.home, p.away), estimate: true, basis: mm.leagues };
    },
    cards(home, away, { neutral = false } = {}) {
      const mm = means('yellow', home, away, neutral);
      const rh = redTerm(home);
      const ra = redTerm(away);
      if (!mm || !rh || !ra) return null;
      const p = countPmfs({ family: mm.co.family, r: mm.co.r }, mm.mHome, mm.mAway);
      const rbar = (rh.red.rbar + ra.red.rbar) / 2;
      const reds = {
        home: rbar * rh.red.mult[rh.red.index.get(home)],
        away: rbar * ra.red.mult[ra.red.index.get(away)],
      };
      const out = cardMarkets({ yH: p.home, yA: p.away, rH: redPmf(reds.home), rA: redPmf(reds.away) });
      return { ...out, refereeFactor: null, estimate: true, basis: mm.leagues };
    },
  };
}
