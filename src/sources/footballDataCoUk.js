// football-data.co.uk season CSVs (no key). Bookmaker odds columns are
// deliberately never read.
//
// Verified against a real response (2025/26 E0): header begins
//   Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,FTR,HTHG,HTAG,HTR,Referee,
//   HS,AS,HST,AST,HF,AF,HC,AC,HY,AY,HR,AR,<odds...>
// dates are dd/mm/yyyy (older files dd/mm/yy), team names like "Man United",
// "Nott'm Forest". Columns are looked up by header name, never by position.

import { BASES, dayNumberFromIso } from '../config.js';
import { httpGet, HttpError } from './http.js';
import { parseCsv, headerIndex, SourceFormatError } from './csv.js';

const REQUIRED = ['date', 'hometeam', 'awayteam', 'fthg', 'ftag'];

function int(v) {
  if (v === undefined) return null;
  const s = String(v).trim();
  return /^-?\d+$/.test(s) ? Number(s) : null;
}

/** dd/mm/yy or dd/mm/yyyy -> ISO date, or null. */
export function parseCsvDate(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(String(s || '').trim());
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  let year = Number(m[3]);
  if (m[3].length === 2) year += year < 70 ? 2000 : 1900;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Parse one season CSV (already decoded to text).
 * Rows without a result are dropped for the goals model; other columns stay
 * null when empty so each market can drop a row only where it needs to.
 */
export function parseSeasonCsv(text, { div = '', season = '' } = {}) {
  const table = parseCsv(text);
  if (table.length === 0) return { rows: [], stats: emptyStats() };
  const col = headerIndex(table[0]);
  const missing = REQUIRED.filter((c) => col(c) < 0);
  if (missing.length > 0) {
    throw new SourceFormatError(
      `football-data.co.uk ${div} ${season}: header lacks ${missing.join(', ')} (header: ${table[0].slice(0, 12).join('|')})`,
    );
  }
  const idx = {
    date: col('date'),
    time: col('time'),
    home: col('hometeam'),
    away: col('awayteam'),
    fthg: col('fthg'),
    ftag: col('ftag'),
    hthg: col('hthg'),
    htag: col('htag'),
    hs: col('hs'),
    as: col('as'),
    hst: col('hst'),
    ast: col('ast'),
    hc: col('hc'),
    ac: col('ac'),
    hy: col('hy'),
    ay: col('ay'),
    hr: col('hr'),
    ar: col('ar'),
    referee: col('referee'),
  };
  const get = (r, i) => (i >= 0 && i < r.length ? r[i] : undefined);

  const stats = emptyStats();
  stats.columns = Object.entries(idx)
    .filter(([, i]) => i >= 0)
    .map(([k]) => k);
  const rows = [];
  for (let k = 1; k < table.length; k++) {
    const r = table[k];
    stats.total++;
    const iso = parseCsvDate(get(r, idx.date));
    const home = (get(r, idx.home) || '').trim();
    const away = (get(r, idx.away) || '').trim();
    if (!iso || !home || !away) {
      stats.skippedRows++;
      continue;
    }
    const fthg = int(get(r, idx.fthg));
    const ftag = int(get(r, idx.ftag));
    if (fthg === null || ftag === null) {
      stats.noResult++;
      continue;
    }
    const referee = (get(r, idx.referee) || '').trim();
    const row = {
      date: iso,
      t: dayNumberFromIso(iso),
      home,
      away,
      x: fthg,
      y: ftag,
      hthg: int(get(r, idx.hthg)),
      htag: int(get(r, idx.htag)),
      hs: int(get(r, idx.hs)),
      as: int(get(r, idx.as)),
      hst: int(get(r, idx.hst)),
      ast: int(get(r, idx.ast)),
      hc: int(get(r, idx.hc)),
      ac: int(get(r, idx.ac)),
      hy: int(get(r, idx.hy)),
      ay: int(get(r, idx.ay)),
      hr: int(get(r, idx.hr)),
      ar: int(get(r, idx.ar)),
      referee: referee || null,
    };
    if (row.hc !== null && row.ac !== null) stats.withCorners++;
    if (row.hy !== null && row.ay !== null) stats.withYellows++;
    if (row.hs !== null && row.hst !== null) stats.withShots++;
    if (row.hthg !== null && row.htag !== null && row.hthg <= row.x && row.htag <= row.y) stats.withHalfTime++;
    if (row.referee) stats.withReferee++;
    stats.valid++;
    rows.push(row);
  }
  return { rows, stats };
}

function emptyStats() {
  return { total: 0, valid: 0, skippedRows: 0, noResult: 0, withCorners: 0, withYellows: 0, withShots: 0, withHalfTime: 0, withReferee: 0, columns: [] };
}

/** Download and parse one season file. A 404 means "file does not exist (yet)". */
export async function fetchSeasonCsv(div, code, opts = {}) {
  const url = `${opts.baseUrl || BASES.csv}/${code}/${div}.csv`;
  try {
    const { body } = await httpGet(url, { as: 'buffer', retries: 2, fetchImpl: opts.fetchImpl, sleepFn: opts.sleepFn });
    const text = new TextDecoder('latin1').decode(body);
    const parsed = parseSeasonCsv(text, { div, season: code });
    return { url, missing: false, ...parsed };
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      return { url, missing: true, rows: [], stats: emptyStats() };
    }
    throw err;
  }
}
