// Rolling-origin back-test of the goals model (pure; the data come from the caller).
//
// Weekly origins: for the origin day o the model is trained STRICTLY on the
// matches before o (the last `seasonsBack` completed seasons plus the current
// one, exactly like the daily pipeline) and predicts the matches of the next
// `horizonDays` days. Elo, when used, is the snapshot valid at the origin.

import { seasonStartYear } from '../config.js';
import { forecastMatch } from './dc.js';
import { coreProbs, outcomeIndex } from './core.js';
import { fitLeagueModel } from './goalsFit.js';
import { bootstrapForecasts } from './bootstrap.js';
import { hashSeed } from './rng.js';
import { estimateHalfShare, halfTimeMarkets, htBaseRates, htOutcomeIndex, htftIndex } from './htft.js';

const DAY_MS = 86400000;
const EARLY_DAYS = 56; // "early season" = the first 8 weeks of a season

export const yearOfDay = (t) => seasonStartYear(new Date(t * DAY_MS));

/** First match day of every season in the sample (season start year -> day). */
export function seasonStarts(matches) {
  const first = new Map();
  for (const m of matches) {
    const s = first.get(m.season);
    if (s === undefined || m.t < s) first.set(m.season, m.t);
  }
  return first;
}

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

/** Teams of the current season that were not in this division in the previous completed season. */
export function promotedTeams(train, test, startYear) {
  const prev = train.filter((m) => m.season === startYear - 1);
  if (prev.length < 100) return new Set();
  const prevKeys = new Set();
  for (const m of prev) {
    prevKeys.add(m.home);
    prevKeys.add(m.away);
  }
  const promoted = new Set();
  const consider = (k) => {
    if (!prevKeys.has(k)) promoted.add(k);
  };
  for (const m of train) {
    if (m.season !== startYear) continue;
    consider(m.home);
    consider(m.away);
  }
  for (const m of test) {
    consider(m.home);
    consider(m.away);
  }
  return promoted;
}

/** Base-rate forecast from a training sample (add-one smoothing). */
export function baseRates(train) {
  let h = 0;
  let d = 0;
  let a = 0;
  let over = 0;
  let btts = 0;
  for (const m of train) {
    const o = outcomeIndex(m.x, m.y);
    if (o === 0) h++;
    else if (o === 1) d++;
    else a++;
    if (m.x + m.y >= 3) over++;
    if (m.x > 0 && m.y > 0) btts++;
  }
  const n = train.length;
  return {
    p: [(h + 1) / (n + 3), (d + 1) / (n + 3), (a + 1) / (n + 3)],
    pOver: (over + 1) / (n + 2),
    pBtts: (btts + 1) / (n + 2),
  };
}

/**
 * @param {object} o
 * @param {object[]} o.matches   all rows of the league, sorted by t: { t, season, home, away, x, y, hs, as, hst, ast, ... }
 * @param {number} o.from        first day of the test window (inclusive)
 * @param {number} o.to          end of the test window (exclusive)
 * @param {{xi:number, sigma:number, om:number, elo:boolean}} o.params
 * @param {(t:number) => Map<string, number>|null} [o.eloAt]  Elo by team key valid at day t
 * @param {object|null} [o.resolver]
 * @param {boolean} [o.baseline]   also store the base-rate forecast of every match
 * @param {number} [o.bootstrapK]  > 0: forecast like production (mean of K Bayesian-bootstrap
 *                                 matrices, with 10-90 % ranges); 0: the plain point forecast
 * @param {string} [o.seedTag]     part of the bootstrap seed (same tag = same replicates)
 * @param {(M: object) => object} [o.calibrate]  calibration layer applied to the forecast matrices
 * @param {number|null} [o.rho]    fix rho (0 = independent Poisson baseline) instead of fitting it
 * @param {boolean} [o.htft]       also forecast the half-time markets (Phase 3): every record gets `hf`
 *                                 with the half-time forecasts, the outcome and the training base rates
 */
export function runBacktest({
  matches,
  from,
  to,
  params,
  stepDays = 7,
  horizonDays = 7,
  eloAt = null,
  resolver = null,
  seasonsBack = 3,
  minTrain = 200,
  baseline = false,
  bootstrapK = 0,
  seedTag = '',
  calibrate = null,
  rho: rhoFixed = null,
  htft = false,
}) {
  const starts = seasonStarts(matches);
  const records = [];
  let warm = null;
  let origins = 0;
  const diag = { fits: 0, eloFits: 0, eloCoverage: [], ba: [], bd: [], proxyBias: [], proxyFits: 0 };

  for (let day = from; day < to; day += stepDays) {
    const startYear = yearOfDay(day);
    const train = matches.filter((m) => m.t < day && m.season >= startYear - seasonsBack);
    const test = matches.filter((m) => m.t >= day && m.t < Math.min(day + horizonDays, to));
    if (test.length === 0 || train.length < minTrain) continue;
    origins++;

    const teams = teamsOf(train, test);
    const promoted = promotedTeams(train, test, startYear);
    const active = new Set();
    for (const m of train) {
      if (m.t >= day - 400) {
        active.add(m.home);
        active.add(m.away);
      }
    }
    for (const m of test) {
      active.add(m.home);
      active.add(m.away);
    }
    const eloByKey = eloAt ? eloAt(day) : null;
    const fit = fitLeagueModel({ history: train, teams, tNow: day, params, eloByKey, resolver, active, promoted, warm });
    warm = fit.model;
    diag.fits++;
    if (fit.proxy) {
      diag.proxyFits++;
      diag.proxyBias.push(fit.proxy.bias);
    }
    if (fit.eloInfo) {
      diag.eloCoverage.push(fit.eloInfo.coverage);
      if (fit.eloInfo.ok) {
        diag.eloFits++;
        diag.ba.push(fit.eloInfo.ba);
        diag.bd.push(fit.eloInfo.bd);
      }
    }

    const base = baseline ? baseRates(train) : null;
    const share = htft ? estimateHalfShare(train, day, params.xi ?? 0.0019) : null;
    const htBase = share?.ok ? htBaseRates(train) : null;
    const boot =
      bootstrapK > 0
        ? bootstrapForecasts({ base: fit.model, fixtures: test.map((m) => ({ home: m.home, away: m.away })), K: bootstrapK, seed: hashSeed(`${seedTag}|${day}`), calibrate })
        : null;
    for (const [idx, m] of test.entries()) {
      let lam;
      let mu;
      let matrix;
      if (boot) {
        ({ lam, mu, matrix } = boot.fixtures[idx]);
      } else {
        ({ lam, mu, matrix } = forecastMatch(fit.model, rhoFixed ?? fit.rho, m.home, m.away));
        if (calibrate) matrix = calibrate(matrix);
      }
      const c = coreProbs(matrix);
      const rec = {
        t: m.t,
        season: m.season,
        home: m.home,
        away: m.away,
        x: m.x,
        y: m.y,
        o: outcomeIndex(m.x, m.y),
        p: [c.pH, c.pD, c.pA],
        pOver: c.pOver25,
        over: m.x + m.y >= 3 ? 1 : 0,
        pBtts: c.pBtts,
        btts: m.x > 0 && m.y > 0 ? 1 : 0,
        lam,
        mu,
        early: m.t - (starts.get(m.season) ?? m.t) < EARLY_DAYS,
      };
      if (base) rec.base = base;
      if (htBase && isHalfTimeScore(m)) {
        const mk = halfTimeMarkets(matrix, share.s);
        rec.hf = {
          ht: [mk.ht.home, mk.ht.draw, mk.ht.away],
          joint: mk.htft,
          over05: mk.firstHalf.totals[0].over,
          over15: mk.firstHalf.totals[1].over,
          oHt: htOutcomeIndex(m.hthg, m.htag),
          oJoint: htftIndex(m.hthg, m.htag, m.x, m.y),
          y05: m.hthg + m.htag >= 1 ? 1 : 0,
          y15: m.hthg + m.htag >= 2 ? 1 : 0,
          base: htBase,
        };
      }
      if (boot) rec.ranges = boot.fixtures[idx].ranges;
      records.push(rec);
    }
  }
  return { records, origins, diag };
}

const isHalfTimeScore = (m) =>
  Number.isInteger(m.hthg) && Number.isInteger(m.htag) && m.hthg >= 0 && m.htag >= 0 && m.hthg <= m.x && m.htag <= m.y;

export const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
