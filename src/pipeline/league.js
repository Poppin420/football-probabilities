// One league, end to end, as a pure function: parsed data in, JSON out.
// No network and no file access here, so the pipeline can be tested with
// synthetic data.

import { MODEL, dayNumber } from '../config.js';
import { predictLambdaMu } from '../model/dc.js';
import { PHASE2_DEFAULTS, fitLeagueModel } from '../model/goalsFit.js';
import { DEFAULT_K, bootstrapForecasts } from '../model/bootstrap.js';
import { calibrationLayer, isIdentity } from '../model/calibrate.js';
import { hashSeed } from '../model/rng.js';
import { scoreMatrix } from '../model/poisson.js';
import { goalMarkets, cornerMarkets, cardMarkets } from '../model/markets.js';
import {
  fitCountMarket,
  predictCountMeans,
  countPmfs,
  fitReds,
  predictReds,
  redPmf,
  refereeStats,
  refereeFactor,
  refereeSummary,
} from '../model/counts.js';
import { estimateHalfShare, halfTimeMarkets, htftBlock } from '../model/htft.js';
import { buildAnalysis } from '../model/template.js';
import { createExtrasMatcher } from './extras.js';
import { SCORERS_ABSENCES_NOTE, SCORERS_NOTE, buildMatchScorers, prepareScorers } from './scorerSetup.js';


/**
 * @param {object} input
 * @param {{code:string,name:string,country:string,div:string,eloCountry?:string}} input.league
 * @param {{code:string,current:boolean}[]} input.seasons    oldest first, last = current
 * @param {Map<string, object[]>} input.csvBySeason          season code -> parsed CSV rows (raw names)
 * @param {object[]} input.fixtures                          normalised football-data.org fixtures
 * @param {{current?:object, previous?:object}|null} input.scorers
 * @param {{clubs:object[], date:string}|null} input.elo
 * @param {object} input.resolver                            names.createResolver()
 * @param {Date} input.now
 * @param {{xi?:number, sigma?:number, om?:number, elo?:boolean}} [input.params]
 *        model parameters; the Phase 2 defaults (xi 0.0019, sigma 0.25, om 0.6, Elo prior on)
 *        are replaced by the values of the weekly tuning job (tune.json)
 * @param {object|null} [input.calibration]  adopted calibration maps (calibrate.js) or null
 * @param {number} [input.bootstrapK]        Bayesian-bootstrap replicates; 0 = point forecast, no ranges
 * @param {object|null} [input.tuneInfo]     where the parameters come from (stored in the JSON)
 * @param {{fixtures:object[], injuries:object[], stale?:boolean}|null} [input.extras]
 *        API-Football referees and injuries of this league (extras.js); null = none
 */
export function buildLeague({
  league,
  seasons,
  csvBySeason,
  fixtures,
  scorers = null,
  elo = null,
  resolver,
  now,
  params = {},
  calibration = null,
  bootstrapK = DEFAULT_K,
  tuneInfo = null,
  extras = null,
}) {
  const P = { ...PHASE2_DEFAULTS, xi: MODEL.xi, sigma: MODEL.sigma, ...params };
  const { xi, sigma } = P;
  const tNow = dayNumber(now);
  const warnings = [];

  // 1. History with resolved team keys -------------------------------------
  const display = new Map(); // key -> raw display name (fallback)
  const bySeason = new Map();
  for (const s of seasons) {
    const rows = (csvBySeason.get(s.code) || []).map((r) => {
      const home = resolver.key(r.home);
      const away = resolver.key(r.away);
      if (!display.has(home)) display.set(home, r.home);
      if (!display.has(away)) display.set(away, r.away);
      return { ...r, home, away };
    });
    bySeason.set(s.code, rows);
  }
  const history = [...bySeason.values()].flat().filter((m) => m.t < tNow).sort((a, b) => a.t - b.t);
  if (history.length < 200) {
    throw new Error(`only ${history.length} historical matches for ${league.code}; refusing to fit`);
  }
  const csvKeys = new Set();
  for (const m of history) {
    csvKeys.add(m.home);
    csvKeys.add(m.away);
  }

  // 2. Universe for matching fixture teams: this league's CSV teams plus
  //    ClubElo clubs of the same country (covers promoted teams that have
  //    no history in this division yet).
  const universe = new Set(csvKeys);
  const eloByKey = new Map();
  if (elo) {
    for (const c of elo.clubs) {
      if (league.eloCountry && c.country !== league.eloCountry) continue;
      const k = resolver.key(c.club);
      eloByKey.set(k, c);
      universe.add(k);
      if (!display.has(k)) display.set(k, c.club);
    }
  }

  // 3. Match fixture teams --------------------------------------------------
  const matched = [];
  const unmatchedNames = new Set();
  for (const f of fixtures) {
    const h = resolver.matchAny([f.home.name, f.home.shortName], universe);
    const a = resolver.matchAny([f.away.name, f.away.shortName], universe);
    if (!h.key || !a.key) {
      for (const [side, m] of [[f.home, h], [f.away, a]]) {
        if (m.key) continue;
        unmatchedNames.add(side.name);
        warnings.push({
          league: league.code,
          code: 'unmatched-team',
          team: side.name,
          matchId: f.id,
          reason: m.how,
          message: `Δεν αντιστοιχίστηκε η ομάδα "${side.name}" (${league.code}) - ο αγώνας παραλείπεται. Πρόσθεσέ την στο aliases.json.`,
          closest: resolver.closest(side.name, universe).map((c) => c.key),
        });
      }
      continue;
    }
    matched.push({ f, home: h.key, away: a.key, how: [h.how, a.how] });
  }
  // Prefer the football-data.org spelling for names shown in the UI.
  for (const m of matched) {
    display.set(m.home, m.f.home.shortName || m.f.home.name);
    display.set(m.away, m.f.away.shortName || m.f.away.name);
  }

  // 4. Promoted teams: in the current season but not in this division in the
  //    previous completed season.
  const prevSeason = seasons.filter((s) => !s.current).at(-1);
  const prevRows = prevSeason ? bySeason.get(prevSeason.code) || [] : [];
  const promoted = new Set();
  if (prevRows.length >= 100) {
    const prevKeys = new Set();
    for (const m of prevRows) {
      prevKeys.add(m.home);
      prevKeys.add(m.away);
    }
    const currentKeys = new Set();
    for (const m of bySeason.get(seasons.at(-1).code) || []) {
      currentKeys.add(m.home);
      currentKeys.add(m.away);
    }
    for (const m of matched) {
      currentKeys.add(m.home);
      currentKeys.add(m.away);
    }
    for (const k of currentKeys) if (!prevKeys.has(k)) promoted.add(k);
  } else {
    warnings.push({
      league: league.code,
      code: 'no-promotion-info',
      message: `Δεν υπάρχουν δεδομένα προηγούμενης σεζόν για ${league.code}: δεν μπορούν να σημανθούν οι νεοφώτιστες.`,
    });
  }

  // 5. Fit the goals model ---------------------------------------------------
  const teamSet = new Set(csvKeys);
  for (const m of matched) {
    teamSet.add(m.home);
    teamSet.add(m.away);
  }
  const teams = [...teamSet].sort();
  const active = new Set(matched.flatMap((m) => [m.home, m.away]));
  for (const m of history) {
    if (m.t >= tNow - 400) {
      active.add(m.home);
      active.add(m.away);
    }
  }
  const eloRatings = new Map([...eloByKey].map(([k, c]) => [k, c.elo]));
  const fit = fitLeagueModel({ history, teams, tNow, params: P, eloByKey: eloRatings, resolver, active, promoted });
  const { model, rho: pointRho, rhoFit, proxy, eloInfo } = fit;
  if (P.elo && elo && eloInfo && !eloInfo.ok) {
    warnings.push({
      league: league.code,
      code: 'elo-prior-off',
      message: `Elo prior ${league.code}: δεν εφαρμόστηκε (${eloInfo.reason}). Έλεγξε το aliases.json για ομάδες που λείπουν από το ClubElo.`,
    });
  }

  // 6. Count models ----------------------------------------------------------
  const cornersModel = fitCountMarket({ matches: history, teams, homeField: 'hc', awayField: 'ac', tNow, xi, sigma: MODEL.sigmaCounts });
  const yellowModel = fitCountMarket({ matches: history, teams, homeField: 'hy', awayField: 'ay', tNow, xi, sigma: MODEL.sigmaCounts });
  const redModel = fitReds({ matches: history, teams, tNow, xi });
  const refStats = refereeStats(history, tNow);
  const cardsAvailable = Boolean(yellowModel && redModel);

  // 7. Scorer inputs -----------------------------------------------------------
  const scorerSetup = prepareScorers({
    scorers,
    teamKeyOf: (t) => resolver.matchAny([t.name, t.shortName], universe).key,
    ...clubMatchCounts({ bySeason, seasons, tNow }),
  });
  if (scorerSetup?.prior.source === 'default' && scorerSetup.prior.reason && /boundary|cut/.test(scorerSetup.prior.reason)) {
    warnings.push({
      league: league.code,
      code: 'scorer-prior-default',
      message: `Σκόρερ ${league.code}: η εκτίμηση του prior δεν ήταν αξιόπιστη (${scorerSetup.prior.reason}) - χρησιμοποιείται το σταθερό a=1, b=12.`,
    });
  }

  // 7b. Half-time share of the goals (HT/FT markets) and the API-Football extras ------------
  const share = estimateHalfShare(history, tNow, xi);
  if (!share.ok) {
    warnings.push({
      league: league.code,
      code: 'htft-off',
      message: `Ημίχρονο/Τελικό ${league.code}: δεν υπολογίζεται (${share.reason}).`,
    });
  }
  const extrasMatcher = createExtrasMatcher({ extras, resolver, universe });
  const extrasMissing = [];

  // 8. Forecasts and per-match output ---------------------------------------------
  // Bayesian bootstrap (posterior predictive mean + 10-90 % ranges) or, with
  // bootstrapK = 0, the plain point forecast. The calibration layer, when adopted
  // by the weekly tuning, is applied to every replicate matrix.
  const calLayer = calibrationLayer(calibration);
  const fixturePairs = matched.map(({ home, away }) => ({ home, away }));
  let forecasts;
  let bootInfo = null;
  if (bootstrapK > 0 && fixturePairs.length > 0) {
    const bs = bootstrapForecasts({ base: model, fixtures: fixturePairs, K: bootstrapK, seed: hashSeed(`${league.code}|${tNow}`), calibrate: calLayer });
    forecasts = bs.fixtures;
    bootInfo = { k: bootstrapK, replicates: bs.replicates, failed: bs.failed };
    if (bs.failed > 0) {
      warnings.push({ league: league.code, code: 'bootstrap-failed', message: `Bootstrap ${league.code}: ${bs.failed} από ${bootstrapK} επαναλήψεις απέτυχαν και παραλείφθηκαν.` });
    }
  } else {
    forecasts = fixturePairs.map(({ home, away }) => {
      const { lam, mu } = predictLambdaMu(model, home, away);
      const matrix = scoreMatrix(lam, mu, pointRho);
      return { matrix: calLayer ? calLayer(matrix) : matrix, lam, mu, rho: pointRho, ranges: null };
    });
  }

  const teamInfo = new Map();
  const infoFor = (key) => {
    if (teamInfo.has(key)) return teamInfo.get(key);
    const i = model.index.get(key);
    const nEff = model.effN[i];
    const e = eloByKey.get(key);
    const info = {
      name: display.get(key) || key,
      promoted: promoted.has(key),
      fewData: nEff < MODEL.fewDataWeighted,
      nEff: nEff,
      elo: e ? Math.round(e.elo) : null,
    };
    teamInfo.set(key, info);
    return info;
  };

  const lamRange = { min: Infinity, max: -Infinity };
  const matches = [];
  for (const [idx, { f, home, away }] of matched.entries()) {
    const hi = infoFor(home);
    const ai = infoFor(away);
    const { lam, mu, rho, matrix, ranges } = forecasts[idx];
    lamRange.min = Math.min(lamRange.min, lam, mu);
    lamRange.max = Math.max(lamRange.max, lam, mu);
    const gm = goalMarkets(matrix);
    const { marginals, ...goals } = gm;

    let corners = null;
    if (cornersModel) {
      const { mHome, mAway } = predictCountMeans(cornersModel, home, away);
      const p = countPmfs(cornersModel, mHome, mAway);
      corners = cornerMarkets(p.home, p.away);
    }

    // API-Football: referee (only when football-data.org has none) and injuries
    const ex = extras ? extrasMatcher({ home, away, kickoff: f.kickoff }) : null;
    if (extras && !extras.stale && !ex && Date.parse(f.kickoff) - now.getTime() <= MODEL.extrasHorizonHours * 3600000) {
      extrasMissing.push(`${hi.name} – ${ai.name}`);
    }
    const refereeName = f.referee || ex?.referee || null;
    const refereeSource = f.referee ? 'football-data.org' : ex?.referee ? 'api-football' : null;

    let cards = null;
    let refFactor = 1;
    if (cardsAvailable) {
      refFactor = refereeFactor(refStats, refereeName);
      const { mHome, mAway } = predictCountMeans(yellowModel, home, away, refFactor);
      const yp = countPmfs(yellowModel, mHome, mAway);
      const reds = predictReds(redModel, home, away);
      cards = cardMarkets({ yH: yp.home, yA: yp.away, rH: redPmf(reds.home), rA: redPmf(reds.away) });
      cards.refereeFactor = refFactor !== 1 ? refFactor : null;
      const ref = refereeSummary(refStats, refereeName);
      if (ref) cards.referee = { ...ref, source: refereeSource };
    }

    const scorersOut = scorerSetup
      ? buildMatchScorers({
          setup: scorerSetup,
          home,
          away,
          lam,
          mu,
          marginals,
          lamBarOf: (k) => model.gfBar[model.index.get(k)],
          injuries: ex?.injuries ?? null,
        })
      : null;

    const htft = share.ok ? htftBlock(halfTimeMarkets(matrix, share.s)) : null;

    const flags = {
      promotedHome: hi.promoted,
      promotedAway: ai.promoted,
      fewDataHome: hi.fewData,
      fewDataAway: ai.fewData,
      lowConfidence: Math.min(hi.nEff, ai.nEff) < MODEL.lowConfidenceWeighted,
    };

    const out = {
      id: f.id,
      kickoff: f.kickoff,
      matchday: f.matchday,
      home,
      away,
      homeName: hi.name,
      awayName: ai.name,
      flags,
      model: { lam, mu, rho },
      goals,
      corners,
      cards,
      scorers: scorersOut,
      htft,
      ranges, // 10th / 90th percentile of 1X2, Over 2.5 and BTTS (null without the bootstrap)
    };
    out.analysis = { text: buildAnalysis(out), source: 'template' };
    matches.push(out);
  }
  matches.sort((a, b) => a.kickoff.localeCompare(b.kickoff) || a.id - b.id);
  if (extrasMissing.length > 0) {
    warnings.push({
      league: league.code,
      code: 'apif-no-match',
      message: `API-Football ${league.code}: δεν αντιστοιχίστηκαν οι αγώνες ${extrasMissing.slice(0, 6).join(', ')}${extrasMissing.length > 6 ? ' …' : ''} - χωρίς διαιτητή / απουσίες (έλεγξε τα aliases.json).`,
    });
  }

  // 9. League JSON and summary -------------------------------------------------
  const teamsOut = {};
  for (const m of matched) {
    for (const k of [m.home, m.away]) {
      if (teamsOut[k]) continue;
      const i = infoFor(k);
      teamsOut[k] = { name: i.name, promoted: i.promoted, fewData: i.fewData, nEff: i.nEff, elo: i.elo };
    }
  }

  const json = {
    schema: 1,
    phase: 3,
    league: { code: league.code, name: league.name, country: league.country },
    updatedAt: now.toISOString(),
    stale: false,
    staleReason: null,
    params: {
      xi,
      sigma,
      om: P.om,
      c: model.c,
      eta: model.eta,
      rho: pointRho,
      rhoInterval: [rhoFit.lo, rhoFit.hi],
      trainMatches: model.nUsed,
      weightSum: model.wSum,
      teams: teams.length,
      iterations: model.iterations,
      converged: model.converged,
      corners: cornersModel ? countSummary(cornersModel) : null,
      yellows: yellowModel ? countSummary(yellowModel) : null,
      redRate: redModel ? redModel.rbar : null,
      refereeMatches: refStats.nMatches,
      xg: proxy ? { b1: proxy.b1, b2: proxy.b2, n: proxy.n, bias: proxy.bias } : null,
      eloPrior: eloSummary(eloInfo, P.elo),
      bootstrap: bootInfo,
      calibration: isIdentity(calibration) ? null : calibration,
      scorerPrior: scorerSetup ? scorerSetup.prior : null,
      halfShare: share.ok ? { s: share.s, n: share.n } : null,
      tuned: tuneInfo,
    },
    teams: teamsOut,
    matches,
    notes: { scorers: SCORERS_NOTE, scorersAbsences: SCORERS_ABSENCES_NOTE },
  };

  const summary = {
    code: league.code,
    fixtures: fixtures.length,
    matched: matched.length,
    unmatched: [...unmatchedNames],
    lambdaMin: matches.length ? lamRange.min : null,
    lambdaMax: matches.length ? lamRange.max : null,
    rho: pointRho,
    om: P.om,
    xg: proxy ? { b1: proxy.b1, b2: proxy.b2, bias: proxy.bias } : null,
    eloPrior: eloSummary(eloInfo, P.elo),
    bootstrap: bootInfo,
    scorerPrior: scorerSetup ? scorerSetup.prior : null,
    halfShare: share.ok ? share.s : null,
    extras: extras ? { fixtures: extras.fixtures.length, injuries: (extras.injuries || []).length, stale: Boolean(extras.stale), unmatched: extrasMissing.length } : null,
    eta: model.eta,
    c: model.c,
    trainMatches: model.nUsed,
    promoted: [...promoted].map((k) => display.get(k) || k),
    cornersR: cornersModel ? cornersModel.r : null,
    cornersCorr: cornersModel ? cornersModel.corrResid : null,
    yellowsR: yellowModel ? yellowModel.r : null,
    scorers: scorerSetup ? 'ok' : 'unavailable',
    converged: model.converged,
  };
  if (cornersModel?.warnCorr) {
    warnings.push({
      league: league.code,
      code: 'corner-correlation',
      message: `Κόρνερ ${league.code}: |συσχέτιση| κατάλοιπων ${cornersModel.corrResid.toFixed(3)} > 0,1 - η υπόθεση ανεξαρτησίας χαλαρώνει.`,
    });
  }
  return { json, summary, warnings };
}

function eloSummary(info, wanted) {
  if (!wanted) return null;
  if (!info) return { on: false, reason: 'no Elo data' };
  if (!info.ok) return { on: false, reason: info.reason, coverage: info.coverage };
  return { on: true, ba: info.ba, bd: info.bd, ebar: info.ebar, teams: info.n, coverage: info.coverage };
}

function countSummary(m) {
  return {
    family: m.family,
    r: Number.isFinite(m.r) ? m.r : null,
    n: m.nUsed,
    corrRaw: m.corrRaw,
    corrResid: m.corrResid,
  };
}

// ---------------------------------------------------------------------------
// Scorers

/** Club matches this / last season from the CSVs (matches before today), for the scorer rates. */
function clubMatchCounts({ bySeason, seasons, tNow }) {
  const matchesPlayed = (rows) => {
    const n = new Map();
    for (const m of rows) {
      if (m.t >= tNow) continue;
      n.set(m.home, (n.get(m.home) || 0) + 1);
      n.set(m.away, (n.get(m.away) || 0) + 1);
    }
    return n;
  };
  const curSeason = seasons.at(-1);
  const prevSeason = seasons.filter((x) => !x.current).at(-1);
  return {
    N0: matchesPlayed(bySeason.get(curSeason.code) || []),
    N1: prevSeason ? matchesPlayed(bySeason.get(prevSeason.code) || []) : new Map(),
  };
}
