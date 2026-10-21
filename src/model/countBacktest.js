// Rolling-origin back-test of the count markets (corners, yellow cards):
// log-score of the observed team counts under the production NegBin model
// versus a plain Poisson baseline (same data, same weights, no over-dispersion).
// Same weekly origins and strictly-before training as the goals back-test.

import { SIGMA_COUNTS, fitCountMarket, predictCountMeans, countPmfs } from './counts.js';

const FLOOR = 1e-12;

function teamsOf(rows, extra) {
  const set = new Set();
  for (const m of rows) {
    set.add(m.home);
    set.add(m.away);
  }
  for (const m of extra) {
    set.add(m.home);
    set.add(m.away);
  }
  return [...set].sort();
}

const isCount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * @param {object} o
 * @param {object[]} o.matches  rows sorted by t: { t, season, home, away, hc, ac, hy, ay, ... }
 * @param {{home:string, away:string}} o.fields   column names, e.g. { home: 'hc', away: 'ac' }
 * @param {number} o.xi
 * @returns {{ n:number, origins:number, negbin:number, poisson:number, gain:number, gainSe:number,
 *             families:{negbin:number, poisson:number}, meanRatio:number }}
 *   negbin / poisson = mean log-score per team count (higher = better, <= 0); gain = negbin - poisson
 */
export function runCountBacktest({ matches, from, to, fields, xi, sigma = SIGMA_COUNTS, stepDays = 7, horizonDays = 7, seasonsBack = 3, minTrain = 300 }) {
  const diffs = [];
  let sumNb = 0;
  let sumPo = 0;
  let n = 0;
  let origins = 0;
  let sumPred = 0;
  let sumObs = 0;
  const families = { negbin: 0, poisson: 0 };

  for (let day = from; day < to; day += stepDays) {
    const test = matches.filter((m) => m.t >= day && m.t < Math.min(day + horizonDays, to) && isCount(m[fields.home]) && isCount(m[fields.away]));
    if (test.length === 0) continue;
    const seasonNow = test[0].season;
    const train = matches.filter((m) => m.t < day && m.season >= seasonNow - seasonsBack);
    if (train.length < minTrain) continue;
    const teams = teamsOf(train, test);
    const common = { matches: train, teams, homeField: fields.home, awayField: fields.away, tNow: day, xi, sigma };
    const nb = fitCountMarket(common);
    const po = fitCountMarket({ ...common, forcePoisson: true });
    if (!nb || !po) continue;
    origins++;
    families[nb.family]++;
    for (const m of test) {
      const a = predictCountMeans(nb, m.home, m.away);
      const b = predictCountMeans(po, m.home, m.away);
      const pa = countPmfs(nb, a.mHome, a.mAway);
      const pb = countPmfs(po, b.mHome, b.mAway);
      for (const [obs, pmfNb, pmfPo, meanNb] of [
        [m[fields.home], pa.home, pb.home, a.mHome],
        [m[fields.away], pa.away, pb.away, a.mAway],
      ]) {
        const lNb = Math.log(Math.max(FLOOR, pmfNb[Math.min(obs, pmfNb.length - 1)] ?? FLOOR));
        const lPo = Math.log(Math.max(FLOOR, pmfPo[Math.min(obs, pmfPo.length - 1)] ?? FLOOR));
        sumNb += lNb;
        sumPo += lPo;
        diffs.push(lNb - lPo);
        sumPred += meanNb;
        sumObs += obs;
        n++;
      }
    }
  }
  if (n === 0) return null;
  const mean = diffs.reduce((s, v) => s + v, 0) / n;
  let ss = 0;
  for (const d of diffs) ss += (d - mean) ** 2;
  return {
    n,
    origins,
    negbin: sumNb / n,
    poisson: sumPo / n,
    gain: (sumNb - sumPo) / n,
    gainSe: n > 1 ? Math.sqrt(ss / (n - 1) / n) : NaN,
    families,
    meanRatio: sumObs > 0 ? sumPred / sumObs : NaN, // predicted / observed mean (1 = unbiased level)
  };
}
