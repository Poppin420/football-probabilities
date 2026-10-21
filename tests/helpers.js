// Test helpers: seeded RNG, Poisson sampler and a league simulator.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normal(rand) {
  let u = 0;
  while (u === 0) u = rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function poissonSample(rand, lam) {
  // Knuth; fine for lam < 10
  const L = Math.exp(-lam);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > L);
  return k - 1;
}

export function corr(x, y) {
  const n = x.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i];
    my += y[i];
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
    sxy += (x[i] - mx) * (y[i] - my);
  }
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * Simulate `seasons` double round-robin seasons of an nTeams league.
 * Team parameters are drawn from N(0, sd^2) and centred.
 * Returns { teams, truth: { c, eta, att, def }, matches }.
 */
export function simulateLeague({ seed = 1, nTeams = 20, seasons = 2, sd = 0.25, eta = 0.25, c = 0.15, day0 = 0 }) {
  const rand = mulberry32(seed);
  const teams = Array.from({ length: nTeams }, (_, i) => `T${String(i + 1).padStart(2, '0')}`);
  const center = (arr) => {
    const m = arr.reduce((s, v) => s + v, 0) / arr.length;
    return arr.map((v) => v - m);
  };
  const att = center(teams.map(() => sd * normal(rand)));
  const def = center(teams.map(() => sd * normal(rand)));
  const matches = [];
  let day = day0;
  for (let s = 0; s < seasons; s++) {
    const fixtures = [];
    for (let h = 0; h < nTeams; h++) for (let a = 0; a < nTeams; a++) if (h !== a) fixtures.push([h, a]);
    // shuffle (Fisher-Yates)
    for (let i = fixtures.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [fixtures[i], fixtures[j]] = [fixtures[j], fixtures[i]];
    }
    fixtures.forEach(([h, a], k) => {
      const lam = Math.exp(c + eta + att[h] + def[a]);
      const mu = Math.exp(c + att[a] + def[h]);
      matches.push({
        t: day + Math.floor((k / fixtures.length) * 280),
        home: teams[h],
        away: teams[a],
        x: poissonSample(rand, lam),
        y: poissonSample(rand, mu),
      });
    });
    day += 365;
  }
  matches.sort((p, q) => p.t - q.t);
  return { teams, truth: { c, eta, att, def }, matches, lastDay: day };
}

/** Gamma(shape, scale 1) sampler (Marsaglia-Tsang), shape >= 1 or boosted. */
export function gammaSample(rand, shape) {
  if (shape < 1) return gammaSample(rand, shape + 1) * Math.pow(rand(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x;
    let v;
    do {
      x = normal(rand);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Negative binomial sample with mean m and size r (gamma-Poisson mixture). */
export function nbSample(rand, m, r) {
  const lam = (m * gammaSample(rand, r)) / r;
  if (lam < 30) return poissonSample(rand, lam);
  // normal approximation for large lam (not needed for football counts)
  return Math.max(0, Math.round(lam + Math.sqrt(lam) * normal(rand)));
}
