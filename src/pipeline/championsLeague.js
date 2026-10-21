// Champions League (Phase 3): the Elo-only goals model.
//
// The clubs of a European cup have no common domestic history, so the expected goals come from the ClubElo
// rating difference alone (src/model/eloOnly.js):
//
//   lam = exp(c + eta + kappa * dE / 800),   mu = exp(c - kappa * dE / 800),   dE = E_home - E_away
//
// kappa, eta (and a first c) come from ONE pooled Poisson regression on the domestic matches of all enabled leagues
// (each with the monthly ClubElo rating of both teams); c is then shrunk towards the average of the cup's own past
// results. The score matrix, the goals markets, the half-time markets and the scorers are the same code as the
// leagues use. Corners and cards are not offered (no common history), there are no bootstrap ranges, and every match
// carries the flag `eloOnly` ("χαμηλότερη βεβαιότητα" in the UI). Pure function: parsed data in, JSON out.

import { MODEL, dayNumber } from '../config.js';
import { timeWeight } from '../model/dc.js';
import { scoreMatrix } from '../model/poisson.js';
import { goalMarkets } from '../model/markets.js';
import { halfTimeMarkets, htftBlock } from '../model/htft.js';
import { ELO_DIV, SHRINK_MATCHES, eloOnlyMeans, fitCupIntercept, fitEloOnly, fitEloOnlyRho, shrinkIntercept } from '../model/eloOnly.js';
import { buildAnalysis } from '../model/template.js';
import { createExtrasMatcher } from './extras.js';
import { SCORERS_ABSENCES_NOTE, buildMatchScorers, prepareScorers } from './scorerSetup.js';

export const CL_SCORERS_NOTE =
  'Δεν υπάρχουν διαθέσιμες συνθέσεις: οι πιθανότητες δεν λαμβάνουν υπόψη τραυματισμούς, ποινές ή αν ο παίκτης θα παίξει. ' +
  'Λίστα: παίκτες με τουλάχιστον ένα γκολ στο Champions League φέτος.';
export const CL_NOTE =
  'Στο Champions League οι ομάδες δεν έχουν κοινό ιστορικό, οπότε το μοντέλο χρησιμοποιεί μόνο τη διαφορά βαθμολογίας Elo (clubelo.com). ' +
  'Δεν δείχνει φόρμα, απουσίες ή στυλ παιχνιδιού, και δεν υπάρχουν κόρνερ και κάρτες. Η βεβαιότητά του είναι χαμηλότερη από των εγχώριων λιγκών.';

export const TOP_LEVELS = 2; // ClubElo division level of the clubs the cup draws from (1 = top flight)
const LAMBAR_PRIOR_MATCHES = 4; // a team's goals per cup match is shrunk to the cup average with the weight of this many matches
const LAMBDA_WARN = 5;

/** The best club entry per resolved key (top division first, then the higher rating). */
export function clubsByKey(clubs, resolver) {
  const out = new Map();
  for (const c of clubs) {
    if (Number.isFinite(c.level) && c.level > TOP_LEVELS) continue;
    const k = resolver.key(c.club);
    const old = out.get(k);
    const level = Number.isFinite(c.level) ? c.level : 9;
    if (!old || level < old.level || (level === old.level && c.elo > old.elo)) out.set(k, { club: c.club, elo: c.elo, level });
  }
  return out;
}

/**
 * @param {object} input
 * @param {{code:string,name:string,country:string}} input.league
 * @param {object[]} input.fixtures     football-data.org fixtures (with `stage`)
 * @param {{season:'current'|'previous', results:object[]}[]} input.results   finished cup matches, parseResults() rows
 * @param {{current?:object, previous?:object}|null} input.scorers
 * @param {{clubs:object[], date:string}} input.elo          today's ClubElo snapshot (all clubs)
 * @param {(day:number) => Map<string,number>|null} input.eloAt   monthly snapshots, all clubs, by resolved key
 * @param {{x:number,y:number,d:number,w:number}[]} input.domesticRows   rows of the pooled regression (eloOnlyData.js)
 * @param {{ok:boolean,s?:number,n:number,reason?:string}} input.halfShare  pooled first-half share of the domestic leagues
 * @param {object} input.resolver
 * @param {Date} input.now
 * @param {object|null} [input.extras]   API-Football entry of this league (extras.js)
 * @returns {{json:object, summary:object, warnings:object[]}}
 */
export function buildChampionsLeague({ league, fixtures, results, scorers = null, elo, eloAt, domesticRows, halfShare, resolver, now, extras = null }) {
  const warnings = [];
  const tNow = dayNumber(now);
  const xi = MODEL.xi;

  // 1. Pooled domestic regression: kappa, eta, first c, and rho ----------------------------
  const fit = fitEloOnly(domesticRows);
  if (!fit.ok) throw new Error(`Elo-only: ${fit.reason}`);
  const rhoFit = fitEloOnlyRho(domesticRows, fit);

  // 2. Clubs ------------------------------------------------------------------------------------
  const eloByKey = clubsByKey(elo.clubs, resolver);
  const universe = new Set(eloByKey.keys());
  const display = new Map();
  const teamOf = (t) => resolver.matchAny([t.name, t.shortName], universe);

  // 3. The cup's own past results: intercept, matches played, goals per match ----------------------
  const played = { current: new Map(), previous: new Map() };
  const goalsFor = new Map(); // current season only: key -> { gf, n }
  const cupRows = [];
  let cupSkipped = 0;
  let cupUnmatched = 0;
  for (const part of results) {
    for (const r of part.results) {
      if (!(Date.parse(r.kickoff) < now.getTime())) continue;
      const h = teamOf(r.home);
      const a = teamOf(r.away);
      if (!h.key || !a.key) {
        cupUnmatched++;
        continue;
      }
      for (const k of [h.key, a.key]) played[part.season].set(k, (played[part.season].get(k) || 0) + 1);
      if (r.x === null || r.y === null) {
        cupSkipped++; // extra time / penalties without a 90-minute score
        continue;
      }
      if (part.season === 'current') {
        for (const [k, gf] of [[h.key, r.x], [a.key, r.y]]) {
          const g = goalsFor.get(k) || { gf: 0, n: 0 };
          g.gf += gf;
          g.n += 1;
          goalsFor.set(k, g);
        }
      }
      const t = dayNumber(new Date(r.kickoff));
      const map = eloAt(t);
      const eh = map?.get(h.key);
      const ea = map?.get(a.key);
      if (eh === undefined || ea === undefined) continue;
      cupRows.push({ x: r.x, y: r.y, d: (eh - ea) / ELO_DIV, w: timeWeight(t, tNow, xi), neutral: r.stage === 'FINAL' });
    }
  }
  const cup = fitCupIntercept(cupRows, { eta: fit.eta, kappa: fit.kappa });
  const shrunk = shrinkIntercept({ cCup: cup?.c, wSum: cup?.wSum ?? 0, cBase: fit.c, n0: SHRINK_MATCHES });
  const params = { c: shrunk.c, eta: fit.eta, kappa: fit.kappa };
  if (cupUnmatched > 0) {
    warnings.push({
      league: league.code,
      code: 'cup-results-unmatched',
      message: `Champions League: ${cupUnmatched} παλιά αποτελέσματα δεν αντιστοιχίστηκαν σε ομάδες του ClubElo και δεν μετρούν (έλεγξε το aliases.json).`,
    });
  }

  // 4. Fixtures ---------------------------------------------------------------------------------
  const matched = [];
  const unmatchedNames = new Set();
  for (const f of fixtures) {
    const h = teamOf(f.home);
    const a = teamOf(f.away);
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
          message: `Δεν αντιστοιχίστηκε η ομάδα "${side.name}" (${league.code}) - ο αγώνας παραλείπεται. Πρόσθεσέ την στο aliases.json (όνομα όπως στο clubelo.com).`,
          closest: resolver.closest(side.name, universe).map((c) => c.key),
        });
      }
      continue;
    }
    matched.push({ f, home: h.key, away: a.key });
    display.set(h.key, f.home.shortName || f.home.name);
    display.set(a.key, f.away.shortName || f.away.name);
  }

  // 5. Scorers (the cup's own list; the club's matches this / last season in the cup) ----------------
  const meanGoals = (() => {
    let gf = 0;
    let n = 0;
    for (const g of goalsFor.values()) {
      gf += g.gf;
      n += g.n;
    }
    return n >= 20 ? gf / n : (Math.exp(params.c + params.eta) + Math.exp(params.c)) / 2;
  })();
  const lamBarOf = (k) => {
    const g = goalsFor.get(k) || { gf: 0, n: 0 };
    return (g.gf + LAMBAR_PRIOR_MATCHES * meanGoals) / (g.n + LAMBAR_PRIOR_MATCHES);
  };
  const scorerSetup = prepareScorers({ scorers, teamKeyOf: (t) => teamOf(t).key, N0: played.current, N1: played.previous });

  // 6. Per-match output --------------------------------------------------------------------------
  const extrasMatcher = createExtrasMatcher({ extras, resolver, universe });
  const extrasMissing = [];
  const teamsOut = {};
  const matches = [];
  const lamRange = { min: Infinity, max: -Infinity };
  for (const { f, home, away } of matched) {
    const eh = eloByKey.get(home).elo;
    const ea = eloByKey.get(away).elo;
    const neutral = f.stage === 'FINAL';
    const { lam, mu } = eloOnlyMeans(params, eh - ea, { neutral });
    lamRange.min = Math.min(lamRange.min, lam, mu);
    lamRange.max = Math.max(lamRange.max, lam, mu);
    const matrix = scoreMatrix(lam, mu, rhoFit.rho);
    const { marginals, ...goals } = goalMarkets(matrix);
    const ex = extras ? extrasMatcher({ home, away, kickoff: f.kickoff }) : null;
    if (extras && !extras.stale && !ex && Date.parse(f.kickoff) - now.getTime() <= MODEL.extrasHorizonHours * 3600000) {
      extrasMissing.push(`${display.get(home)} – ${display.get(away)}`);
    }
    const scorersOut = scorerSetup
      ? buildMatchScorers({ setup: scorerSetup, home, away, lam, mu, marginals, lamBarOf, injuries: ex?.injuries ?? null })
      : null;
    const htft = halfShare?.ok ? htftBlock(halfTimeMarkets(matrix, halfShare.s)) : null;

    for (const [k, e] of [[home, eh], [away, ea]]) {
      if (!teamsOut[k]) teamsOut[k] = { name: display.get(k) || k, promoted: false, fewData: false, nEff: null, elo: Math.round(e) };
    }
    const out = {
      id: f.id,
      kickoff: f.kickoff,
      matchday: f.matchday,
      stage: f.stage,
      neutral,
      home,
      away,
      homeName: display.get(home) || home,
      awayName: display.get(away) || away,
      flags: { eloOnly: true },
      model: { lam, mu, rho: rhoFit.rho },
      elo: { home: Math.round(eh), away: Math.round(ea) },
      goals,
      corners: null,
      cards: null,
      scorers: scorersOut,
      htft,
      ranges: null,
    };
    out.analysis = { text: buildAnalysis(out), source: 'template' };
    matches.push(out);
  }
  matches.sort((a, b) => a.kickoff.localeCompare(b.kickoff) || a.id - b.id);
  if (extrasMissing.length > 0) {
    warnings.push({
      league: league.code,
      code: 'apif-no-match',
      message: `API-Football ${league.code}: δεν αντιστοιχίστηκαν οι αγώνες ${extrasMissing.slice(0, 6).join(', ')}${extrasMissing.length > 6 ? ' …' : ''} - χωρίς απουσίες (έλεγξε τα aliases.json).`,
    });
  }
  if (matches.length > 0 && lamRange.max > LAMBDA_WARN) {
    warnings.push({
      league: league.code,
      code: 'lambda-extreme',
      message: `Champions League: αναμενόμενα γκολ έως ${lamRange.max.toFixed(2)} - ασυνήθιστα υψηλό, έλεγξε τα δεδομένα Elo.`,
    });
  }
  if (!halfShare?.ok) {
    warnings.push({ league: league.code, code: 'htft-off', message: `Ημίχρονο/Τελικό ${league.code}: δεν υπολογίζεται (${halfShare?.reason ?? 'χωρίς δεδομένα'}).` });
  }

  const json = {
    schema: 1,
    phase: 3,
    league: { code: league.code, name: league.name, country: league.country, eloOnly: true },
    updatedAt: now.toISOString(),
    stale: false,
    staleReason: null,
    params: {
      xi,
      eloOnly: {
        c: params.c,
        cPooled: fit.c,
        cCup: cup ? cup.c : null,
        cupWeight: shrunk.weight,
        eta: fit.eta,
        kappa: fit.kappa,
        kappaSe: Number.isFinite(fit.se?.kappa) ? fit.se.kappa : null,
        rho: rhoFit.rho,
        rhoInterval: [rhoFit.lo, rhoFit.hi],
        pooledMatches: fit.n,
        pooledWeight: fit.wSum,
        cupMatches: cupRows.length,
        cupSkipped,
        eloDate: elo.date,
        iterations: fit.iterations,
        converged: fit.converged,
      },
      halfShare: halfShare?.ok ? { s: halfShare.s, n: halfShare.n } : null,
      scorerPrior: scorerSetup ? scorerSetup.prior : null,
    },
    teams: teamsOut,
    matches,
    notes: { scorers: CL_SCORERS_NOTE, scorersAbsences: SCORERS_ABSENCES_NOTE, eloOnly: CL_NOTE },
  };

  const summary = {
    code: league.code,
    fixtures: fixtures.length,
    matched: matched.length,
    unmatched: [...unmatchedNames],
    lambdaMin: matches.length ? lamRange.min : null,
    lambdaMax: matches.length ? lamRange.max : null,
    rho: rhoFit.rho,
    eta: fit.eta,
    c: params.c,
    trainMatches: fit.n,
    promoted: [],
    scorers: scorerSetup ? 'ok' : 'unavailable',
    scorerPrior: scorerSetup ? scorerSetup.prior : null,
    halfShare: halfShare?.ok ? halfShare.s : null,
    converged: fit.converged,
    eloOnly: {
      kappa: fit.kappa,
      kappaSe: fit.se?.kappa ?? null,
      cPooled: fit.c,
      cCup: cup ? cup.c : null,
      cupWeight: shrunk.weight,
      cupMatches: cupRows.length,
    },
    extras: extras ? { fixtures: extras.fixtures.length, injuries: (extras.injuries || []).length, stale: Boolean(extras.stale) } : null,
  };
  return { json, summary, warnings };
}
