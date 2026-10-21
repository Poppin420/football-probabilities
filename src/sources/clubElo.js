// ClubElo (no key): http://api.clubelo.com/YYYY-MM-DD returns a CSV with every
// club's rating on that day. Header: Rank,Club,Country,Level,Elo,From,To
// (columns are looked up by name). Be gentle: one request per run, cached.

import { BASES } from '../config.js';
import { httpGet } from './http.js';
import { parseCsv, headerIndex, SourceFormatError } from './csv.js';

export function parseEloCsv(text) {
  const table = parseCsv(text);
  if (table.length === 0) throw new SourceFormatError('ClubElo: empty response');
  const col = headerIndex(table[0]);
  const iClub = col('club') >= 0 ? col('club') : col('team');
  const iElo = col('elo');
  if (iClub < 0 || iElo < 0) {
    throw new SourceFormatError(`ClubElo: header lacks Club/Elo (header: ${table[0].join('|')})`);
  }
  const iCountry = col('country');
  const iLevel = col('level');
  const iRank = col('rank');
  const clubs = [];
  for (let k = 1; k < table.length; k++) {
    const r = table[k];
    const elo = Number(r[iElo]);
    const club = (r[iClub] || '').trim();
    if (!club || !Number.isFinite(elo)) continue;
    const rank = iRank >= 0 ? Number(r[iRank]) : NaN;
    clubs.push({
      club,
      country: iCountry >= 0 ? (r[iCountry] || '').trim() : null,
      level: iLevel >= 0 && Number.isFinite(Number(r[iLevel])) ? Number(r[iLevel]) : null,
      elo,
      rank: Number.isFinite(rank) ? rank : null,
    });
  }
  if (clubs.length === 0) throw new SourceFormatError('ClubElo: no usable rows');
  return clubs;
}

export async function fetchEloSnapshot(dateIso, opts = {}) {
  const url = `${opts.baseUrl || BASES.elo}/${dateIso}`;
  const { body } = await httpGet(url, { retries: 2, fetchImpl: opts.fetchImpl, sleepFn: opts.sleepFn });
  return { url, date: dateIso, clubs: parseEloCsv(body) };
}
