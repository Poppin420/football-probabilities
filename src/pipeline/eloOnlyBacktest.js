// Proxy back-test of the Elo-only model (Phase 3, weekly job).
//
// The Champions League itself cannot be back-tested honestly: its clubs have no common history and a season has
// fewer than 200 matches. The FORMULA of the cup model (src/model/eloOnly.js) can be tested on the domestic
// matches of the leagues, which have the same ingredients (a ClubElo rating for both teams, the goals). Rolling
// origins, weekly, like the league back-test:
//   - the pooled regression (eloOnlyData.js: all leagues together, the last three seasons, monthly Elo ratings,
//     time weights) and rho are fitted on the matches BEFORE the origin only;
//   - the matches of the next 7 days are forecast from the Elo ratings valid at the origin (the monthly snapshot,
//     up to a month older than the daily rating the cup forecasts use);
//   - the forecasts are scored against the pooled base rates of the same training sample.
// What this does NOT test: the cup's own intercept (blended with the cup average), the neutral final, and the
// cup's wider rating gaps (see BIG_GAP in the report). Pure function: parsed data in, records out.

import { MODEL } from '../config.js';
import { baseRates } from '../model/backtest.js';
import { coreProbs, outcomeIndex } from '../model/core.js';
import { MIN_ROWS, eloOnlyMeans, fitEloOnly, fitEloOnlyRho } from '../model/eloOnly.js';
import { scoreMatrix } from '../model/poisson.js';
import { pooledFromDay, pooledRows } from './eloOnlyData.js';

const DAY_MS = 86400000;

/** Rating gap (Elo points) of the "large gap" subset: typical for a cup group match, rare in a division. */
export const BIG_GAP = 200;

/** Key shared with the league back-test records: one match = day + the two resolved team keys. */
export const matchKey = (t, home, away) => `${t}|${home}|${away}`;

/** The reason of a failed fit without the numbers that change from week to week (to group the origins). */
const reasonKey = (reason) => String(reason).replace(/\d+(\.\d+)?/g, '#').replace(/= -#/, '= #');

/** Greek explanation of a grouped reason, for the warnings of the weekly report. */
export function skipReasonText(key) {
  if (/matches with an Elo rating/.test(key)) return 'πολύ λίγοι αγώνες με βαθμολογία Elo και για τις δύο ομάδες (έλεγξε τα ονόματα στο aliases.json)';
  if (/implausible Elo slope/.test(key)) return 'η κλίση Elo βγήκε εκτός λογικών ορίων (πιθανό πρόβλημα στα ονόματα ομάδων ή στα δεδομένα Elo)';
  if (/did not converge/.test(key)) return 'η προσαρμογή δεν συνέκλινε';
  if (/no goals/.test(key)) return 'δεν υπάρχουν γκολ στο δείγμα';
  return key;
}

const stats = (values) => {
  if (values.length === 0) return null;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    sum += v;
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  return { mean: sum / values.length, min, max };
};

/** Mean / min / max of the fitted parameters over the origins. */
export function summarizeFits(fits) {
  return {
    origins: fits.length,
    kappa: stats(fits.map((f) => f.kappa)),
    eta: stats(fits.map((f) => f.eta)),
    c: stats(fits.map((f) => f.c)),
    rho: stats(fits.map((f) => f.rho)),
    rows: stats(fits.map((f) => f.n)),
  };
}

/**
 * @param {object} o
 * @param {{code:string, history:object[], eloAt:(day:number)=>Map<string,number>|null}[]} o.domestic
 *        history rows: { t, home, away, x, y } with resolved team keys (as pooledRows() wants them)
 * @param {number} o.from   first origin (day number)
 * @param {number} o.to     end of the test window (exclusive)
 * @param {number} [o.xi]   time-weight decay of the pooled regression (production value by default)
 * @param {number} [o.minRows]  smallest pooled sample the regression is fitted on (production value by default)
 * @returns {{records:object[], origins:number, skipped:{origins:number, reasons:Object<string,number>}, unrated:number, fits:object[]}}
 */
export function runEloOnlyBacktest({ domestic, from, to, xi = MODEL.xi, stepDays = 7, horizonDays = 7, minRows = MIN_ROWS }) {
  const records = [];
  const fits = [];
  const skipped = { origins: 0, reasons: {} };
  let origins = 0;
  let unrated = 0;

  for (let day = from; day < to; day += stepDays) {
    const end = Math.min(day + horizonDays, to);
    const test = [];
    for (const lg of domestic) {
      for (const m of lg.history) {
        if (m.t >= day && m.t < end && Number.isInteger(m.x) && Number.isInteger(m.y)) test.push({ lg, m });
      }
    }
    if (test.length === 0) continue;
    origins++;

    // Training: strictly before the origin, same window as production (1 July two seasons back).
    const pooled = pooledRows({ domestic, tNow: day, xi, fromDay: pooledFromDay(new Date(day * DAY_MS)) });
    const fit = fitEloOnly(pooled.rows, { minRows });
    if (!fit.ok) {
      skipped.origins++;
      const why = reasonKey(fit.reason);
      skipped.reasons[why] = (skipped.reasons[why] || 0) + 1;
      continue;
    }
    const rho = fitEloOnlyRho(pooled.rows, fit).rho;
    const base = baseRates(pooled.rows);
    fits.push({ day, kappa: fit.kappa, eta: fit.eta, c: fit.c, rho, n: fit.n });

    for (const { lg, m } of test) {
      const ratings = lg.eloAt(day);
      const eh = ratings?.get(m.home);
      const ea = ratings?.get(m.away);
      if (eh === undefined || ea === undefined) {
        unrated++;
        continue;
      }
      const dE = eh - ea;
      const { lam, mu } = eloOnlyMeans(fit, dE);
      const c = coreProbs(scoreMatrix(lam, mu, rho));
      records.push({
        code: lg.code,
        key: matchKey(m.t, m.home, m.away),
        t: m.t,
        dE,
        lam,
        mu,
        o: outcomeIndex(m.x, m.y),
        p: [c.pH, c.pD, c.pA],
        pOver: c.pOver25,
        over: m.x + m.y >= 3 ? 1 : 0,
        pBtts: c.pBtts,
        btts: m.x > 0 && m.y > 0 ? 1 : 0,
        base,
      });
    }
  }
  return { records, origins, skipped, unrated, fits };
}
