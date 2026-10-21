// The league goals model as the pipeline AND the back-test use it, so both
// follow exactly the same code path:
//
//   1. xG proxy (b1, b2) from the history before tNow           (om < 1)
//   2. stage 1, pass 1: blended responses, Phase 1 prior
//   3. Elo prior: ridge regression of the fitted att / def on Elo, refit
//   4. stage 2: rho
//
// params = { xi, sigma, om, elo }. PHASE1_PARAMS reproduces Phase 1 exactly.

import { fitGoals, fitRho } from './dc.js';
import { fitXgProxy, withBlendedResponses } from './xg.js';
import { eloForTeams, fitEloPrior } from './elo.js';

/** Phase 2 defaults (the spec's om = 0.6; the tuning job may choose other values per league). */
export const PHASE2_DEFAULTS = Object.freeze({ xi: 0.0019, sigma: 0.25, om: 0.6, elo: true });
/** Phase 1 behaviour: actual goals only, no Elo prior. */
export const PHASE1_PARAMS = Object.freeze({ xi: 0.0019, sigma: 0.25, om: 1, elo: false });

/** Starting point for Newton from an earlier fit, matched by team key (new teams start at 0). */
export function warmTheta(prev, teams) {
  if (!prev) return null;
  const n = teams.length;
  const theta = new Float64Array(2 + 2 * n);
  theta[0] = prev.c;
  theta[1] = prev.eta;
  for (let i = 0; i < n; i++) {
    const j = prev.index.get(teams[i]);
    if (j !== undefined) {
      theta[2 + i] = prev.att[j];
      theta[2 + n + i] = prev.def[j];
    }
  }
  return theta;
}

/**
 * @param {object} p
 * @param {object[]} p.history   rows { t, home, away, x, y, hs, as, hst, ast } (team keys), any order
 * @param {string[]} p.teams     team keys of the model
 * @param {number} p.tNow
 * @param {{xi:number, sigma:number, om:number, elo:boolean}} p.params
 * @param {Map<string, number>|null} [p.eloByKey]  Elo of the league country's clubs, by resolver key
 * @param {object|null} [p.resolver]               names.createResolver() (fuzzy Elo-name matching)
 * @param {Set<string>|null} [p.active]            teams currently in the league (Elo regression)
 * @param {Set<string>} [p.promoted]
 * @param {object|null} [p.warm]                   an earlier fit to start from
 */
export function fitLeagueModel({ history, teams, tNow, params, eloByKey = null, resolver = null, active = null, promoted = new Set(), warm = null }) {
  const { xi, sigma, om, elo, xgRescale = false } = { ...PHASE2_DEFAULTS, ...params };
  const proxy = om < 1 ? fitXgProxy(history, tNow, { rescale: xgRescale }) : null;
  const matches = withBlendedResponses(history, proxy, om);
  const base = { matches, teams, tNow, xi, sigma, promoted };

  let model = fitGoals({ ...base, theta0: warmTheta(warm, teams) });
  let eloInfo = null;
  if (elo && eloByKey && eloByKey.size > 0) {
    const { map, fuzzy } = eloForTeams({ teamKeys: teams, eloByKey, resolver });
    eloInfo = fitEloPrior({ model, elo: map, active: active ?? new Set(teams), promoted });
    eloInfo.fuzzy = fuzzy;
    if (eloInfo.ok) model = fitGoals({ ...base, priorMeans: eloInfo.priorMeans, theta0: model.theta });
  }
  const rhoFit = fitRho(model);
  return { model, rho: rhoFit.rho, rhoFit, proxy, eloInfo, params: { xi, sigma, om, elo } };
}
