// Anytime-scorer inputs and per-match scorer lists, shared by the domestic leagues and the Champions League.
// Pure functions: parsed data in, plain objects out.

import { MODEL } from '../config.js';
import { teamScorerProbs, fitScorerPrior } from '../model/scorers.js';
import { matchPlayer } from '../sources/playerNames.js';

export const SCORERS_LIST_LIMIT = 200; // the scorers request asks for the top 200

export const SCORERS_NOTE =
  'Δεν υπάρχουν διαθέσιμες συνθέσεις: οι πιθανότητες δεν λαμβάνουν υπόψη τραυματισμούς, ποινές ή αν ο παίκτης θα παίξει. ' +
  'Λίστα: παίκτες με τουλάχιστον ένα γκολ φέτος.';
export const SCORERS_ABSENCES_NOTE =
  'Δεν υπάρχουν διαθέσιμες συνθέσεις. Οι απουσίες (τραυματισμοί, ποινές) προέρχονται από το API-Football, ' +
  'μπορεί να είναι ελλιπείς ή να έχουν αλλάξει, και οι αμφίβολοι παίκτες δεν αφαιρούνται. ' +
  'Λίστα: παίκτες με τουλάχιστον ένα γκολ φέτος.';

/**
 * @param {object} o
 * @param {{current?:object, previous?:object}|null} o.scorers   football-data.org lists (see refresh.js loadScorers)
 * @param {(team:{name:string,shortName?:string}) => string|null} o.teamKeyOf   club -> team key of the league (null = unknown club)
 * @param {Map<string,number>} o.N0     matches of each club in this competition this season
 * @param {Map<string,number>} o.N1     ... and last season
 * @returns {null | {byTeam:Map, N0:Map, N1:Map, a:number, b:number, prior:object}}
 */
export function prepareScorers({ scorers, teamKeyOf, N0, N1 }) {
  const cur = scorers?.current;
  if (!cur || cur.restricted || !Array.isArray(cur.scorers) || cur.scorers.length === 0) return null;
  const prev = scorers?.previous && !scorers.previous.restricted ? scorers.previous.scorers : [];

  const prevByPlayer = new Map(); // playerId or name -> { goals, teamKey }
  for (const s of prev) {
    prevByPlayer.set(s.playerId ?? s.name, { goals: s.goals, teamKey: teamKeyOf(s.team) });
  }
  const byTeam = new Map();
  for (const s of cur.scorers) {
    const teamKey = teamKeyOf(s.team);
    if (!teamKey) continue;
    const p = prevByPlayer.get(s.playerId ?? s.name);
    const entry = {
      name: s.name,
      G0: s.goals,
      G1: p ? p.goals : 0,
      sameClub: Boolean(p && p.teamKey === teamKey),
    };
    if (!byTeam.has(teamKey)) byTeam.set(teamKey, []);
    byTeam.get(teamKey).push(entry);
  }

  // Empirical-Bayes Gamma prior of this competition (fixed a = 1, b = 12 when it cannot be estimated).
  const pairs = [];
  for (const [teamKey, players] of byTeam) {
    for (const p of players) pairs.push({ g: p.G0, n: N0.get(teamKey) || 0 });
  }
  const eb = fitScorerPrior(pairs, { listLength: cur.scorers.length, limit: SCORERS_LIST_LIMIT });
  const prior = { a: eb.a, b: eb.b, source: eb.source, n: eb.n, reason: eb.reason };
  return { byTeam, N0, N1, a: prior.a, b: prior.b, prior };
}

/**
 * Scorer lists of both teams of one match.
 *
 * @param {object} o
 * @param {object} o.setup
 * @param {(teamKey:string) => number} o.lamBarOf   the team's goals per match in the same competition and window
 * @param {{home?:object[], away?:object[]}|null} [o.injuries]  API-Football records of THIS fixture split by side
 *        ({ playerName, state: 'out'|'doubtful', kind }) or null when the API has nothing for it
 * @returns {null | {home:object[], away:object[], absences?:{source:string, home:object[], away:object[]}}}
 */
export function buildMatchScorers({ setup, home, away, lam, mu, marginals, lamBarOf, injuries = null }) {
  const absences = injuries ? { source: 'api-football', home: [], away: [] } : null;
  const side = (teamKey, lamT, pmfN, records, bucket) => {
    const roster = setup.byTeam.get(teamKey);
    const lamBarT = lamBarOf(teamKey);
    if (!roster || roster.length === 0 || !Number.isFinite(lamBarT)) return [];
    const players = flagPlayers(roster, records);
    const res = teamScorerProbs({
      players,
      N0: setup.N0.get(teamKey) || 0,
      N1: setup.N1.get(teamKey) || 0,
      lamT,
      lamBarT,
      pmfN,
      lam,
      mu,
      a: setup.a,
      b: setup.b,
    });
    if (bucket) {
      // absentees who would have been among the displayed scorers, most likely scorer first
      for (const p of res.players.filter((x) => x.absent && x.preRank < MODEL.scorersPerTeam).sort((x, y) => x.preRank - y.preRank)) {
        bucket.push({ name: p.name, goals: p.goals, kind: p.kind });
      }
    }
    return res.players
      .filter((p) => !p.absent)
      .slice(0, MODEL.scorersPerTeam)
      .map((p) => ({
        name: p.name,
        goals: p.goals,
        anytime: p.anytime,
        twoPlus: p.twoPlus,
        first: p.first,
        ...(p.doubtful ? { doubtful: true, kind: p.kind } : {}),
      }));
  };
  const h = side(home, lam, marginals.home, injuries?.home, absences?.home);
  const a = side(away, mu, marginals.away, injuries?.away, absences?.away);
  if (h.length === 0 && a.length === 0) return null;
  return absences ? { home: h, away: a, absences } : { home: h, away: a };
}

/** Copy of the roster with `absent` / `doubtful` / `kind` set for the players named in the injury records (unique matches only). */
export function flagPlayers(roster, records) {
  if (!records || records.length === 0) return roster;
  const flags = new Map(); // roster index -> { state, kind }
  for (const r of records) {
    const player = matchPlayer(r.playerName, roster);
    if (!player) continue;
    const i = roster.indexOf(player);
    const old = flags.get(i);
    if (old?.state === 'out') continue; // "out" wins over "doubtful"
    flags.set(i, { state: r.state, kind: r.kind });
  }
  if (flags.size === 0) return roster;
  return roster.map((p, i) => {
    const f = flags.get(i);
    if (!f) return p;
    return f.state === 'out' ? { ...p, absent: true, kind: f.kind } : { ...p, doubtful: true, kind: f.kind };
  });
}
