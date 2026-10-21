// A synthetic world for the tests of the Elo-only proxy back-test (shared by the model, the weekly job and the page).
import { mulberry32, normal, poissonSample } from './helpers.js';
import { createResolver } from '../src/sources/names.js';
import { makeEloAt } from '../src/pipeline/eloSnapshots.js';

export const DAY = 86400000;
export const dayOf = (iso) => Date.parse(iso) / DAY;

/**
 * Three small "leagues" over three seasons whose goals follow the Elo-only model exactly:
 *   x ~ Poisson(exp(c + eta + kappa dE / 800)), y ~ Poisson(exp(c - kappa dE / 800)),
 * with a monthly ClubElo snapshot (a random walk around each team's level), the rating of the month start being
 * the one the match is generated from. So the regression has to find kappa, eta and c again.
 */
export function buildEloOnlyWorld({ seed = 5, kappa = 0.8, eta = 0.25, c = 0.15, ratingSd = 180, nTeams = 20 } = {}) {
  const rand = mulberry32(seed);
  const resolver = createResolver({});
  const labels = ['AAA', 'BBB', 'CCC'];
  const months = [];
  for (let y = 2023, m = 5; ; ) {
    const iso = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    months.push(iso);
    if (iso >= '2026-06-01') break;
    m++;
    if (m > 11) {
      m = 0;
      y++;
    }
  }
  const teams = [];
  for (const label of labels) {
    for (let i = 0; i < nTeams; i++) {
      const base = 1650 + ratingSd * normal(rand);
      const walk = [];
      let w = 0;
      for (let k = 0; k < months.length; k++) {
        w += 12 * normal(rand);
        walk.push(base + w);
      }
      teams.push({ label, name: `${label} Team ${String(i + 1).padStart(2, '0')}`, walk });
    }
  }
  const snaps = new Map(months.map((iso, k) => [iso, teams.map((t) => ({ club: t.name, country: t.label, level: 1, elo: t.walk[k] }))]));
  const monthIndex = (day) => months.findIndex((iso, k) => iso <= new Date(day * DAY).toISOString().slice(0, 10) && (k === months.length - 1 || months[k + 1] > new Date(day * DAY).toISOString().slice(0, 10)));

  const domestic = labels.map((label) => {
    const own = teams.filter((t) => t.label === label);
    const history = [];
    for (const season of [2023, 2024, 2025]) {
      const pairs = [];
      for (let h = 0; h < nTeams; h++) for (let a = 0; a < nTeams; a++) if (h !== a) pairs.push([h, a]);
      for (let i = pairs.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
      }
      const day0 = dayOf(`${season}-08-10`);
      pairs.forEach(([h, a], k) => {
        const t = day0 + Math.floor((k / pairs.length) * 270);
        const mi = monthIndex(t);
        const dE = own[h].walk[mi] - own[a].walk[mi];
        history.push({
          t,
          season,
          home: resolver.key(own[h].name),
          away: resolver.key(own[a].name),
          x: poissonSample(rand, Math.exp(c + eta + (kappa * dE) / 800)),
          y: poissonSample(rand, Math.exp(c - (kappa * dE) / 800)),
        });
      });
    }
    history.sort((p, q) => p.t - q.t);
    return { code: label, history, eloAt: makeEloAt({ snaps, country: label, resolver }) };
  });
  return { domestic, snaps, resolver, from: dayOf('2024-08-01'), to: dayOf('2026-06-30'), truth: { kappa, eta, c } };
}

/** The forecasts of a proxy back-test in the shape of the records of a league back-test (a stand-in "league model"). */
export function asLeagueRecords(records, tweak = (r) => r) {
  return records.map((r) => {
    const [t, home, away] = r.key.split('|');
    return tweak({ t: Number(t), home, away, o: r.o, p: r.p, pOver: r.pOver, over: r.over, pBtts: r.pBtts, btts: r.btts, base: r.base });
  });
}
