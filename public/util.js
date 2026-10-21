// Pure helpers for the browser UI (no DOM access): dates in Athens time,
// percentages, badges, grouping. Unit-tested without a browser.

import { largestRemainder } from './format.js';

export const TZ = 'Europe/Athens';
export const STALE_AFTER_HOURS = 30;
const MINUS = '−';

// ---------------------------------------------------------------- dates ----

const partsFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('el-GR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const headFmt = new Intl.DateTimeFormat('el-GR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
const stampFmt = new Intl.DateTimeFormat('el-GR', {
  timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** Calendar day in Athens as 'YYYY-MM-DD'. */
export function athensDay(date) {
  const p = Object.fromEntries(partsFmt.formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export function addDays(dayKey, n) {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function formatTime(date) {
  return timeFmt.format(date);
}

export function formatStamp(date) {
  return stampFmt.format(date);
}

/** "Σήμερα · Κυριακή 18 Οκτωβρίου", "Αύριο · …" or just the date. */
export function dayHeading(dayKey, todayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const text = headFmt.format(new Date(Date.UTC(y, m - 1, d, 12)));
  if (dayKey === todayKey) return `Σήμερα · ${text}`;
  if (dayKey === addDays(todayKey, 1)) return `Αύριο · ${text}`;
  return text;
}

/** Hours between an ISO timestamp and now; null when the timestamp is unusable. */
export function ageHours(iso, now) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (now.getTime() - t) / 3600000 : null;
}

export function agoText(hours) {
  if (hours === null || hours === undefined) return 'πριν από άγνωστο χρόνο';
  if (hours < 1) return 'πριν από λίγα λεπτά';
  if (hours < 48) {
    const h = Math.round(hours);
    return `πριν από ${h} ${h === 1 ? 'ώρα' : 'ώρες'}`;
  }
  const d = Math.floor(hours / 24);
  return `πριν από ${d} ημέρες`;
}

// ------------------------------------------------------------- numbers ----

/** Single probability as text: "52%", "<1%", ">99%". */
export function fmtPct(p) {
  if (!Number.isFinite(p)) return '–';
  const v = p * 100;
  if (v > 0 && v < 0.5) return '<1%';
  if (v >= 99.5 && v < 100) return '>99%';
  return `${Math.round(v)}%`;
}

/** Probabilities that belong together (1X2, Over/Under, ...): integers that sum to 100. */
export function pctSet(values) {
  const ints = largestRemainder(values, 100);
  return ints.map((n, i) => {
    if (n === 0 && values[i] > 0) return '<1%';
    if (n === 100 && values[i] < 1) return '>99%';
    return `${n}%`;
  });
}

/** Number text with a real minus sign: "-0,028" -> "−0,028". */
export function minus(text) {
  return String(text).replace('-', MINUS);
}

/** 2.5 -> "2,5" */
export function lineText(x) {
  return String(x).replace('.', ',');
}

/** Handicap line with a real minus sign: -1.5 -> "−1,5", 0.5 -> "+0,5". */
export function signed(x) {
  if (x > 0) return `+${lineText(x)}`;
  if (x < 0) return `${MINUS}${lineText(-x)}`;
  return '0';
}

export function rangeText(range) {
  if (!Array.isArray(range) || range.length < 2) return null;
  return `${Math.round(range[0] * 100)}–${Math.round(range[1] * 100)}%`;
}

/** [lo, hi] fractions from match.ranges (Phase 2), or null. Path: 'oneX2.home', 'over25', 'btts'. */
export function rangeOf(match, path) {
  let node = match?.ranges;
  for (const part of path.split('.')) {
    if (node === null || node === undefined || typeof node !== 'object') return null;
    node = node[part];
  }
  return Array.isArray(node) && node.length >= 2 && node.every(Number.isFinite) ? node : null;
}

// -------------------------------------------------------- league status ----

/** Is this league's data old, either flagged by the pipeline or by its timestamp? */
export function staleInfo(league, now) {
  const age = ageHours(league?.updatedAt, now);
  if (league?.stale) {
    return { stale: true, age, reason: league.staleReason || 'Η πηγή δεν απάντησε· κρατήθηκαν τα τελευταία καλά δεδομένα.' };
  }
  if (age === null || age > STALE_AFTER_HOURS) {
    return { stale: true, age, reason: `Τελευταία ενημέρωση ${agoText(age)}.` };
  }
  return { stale: false, age, reason: null };
}

export const BADGE_HELP = {
  eloOnly: 'Στο Champions League οι ομάδες δεν έχουν κοινό ιστορικό. Το μοντέλο χρησιμοποιεί μόνο τη διαφορά βαθμολογίας Elo των δύο ομάδων: δεν ξέρει φόρμα, απουσίες ή στυλ παιχνιδιού, άρα οι πιθανότητες είναι πιο αβέβαιες από των εγχώριων πρωταθλημάτων.',
  promoted: 'Η ομάδα ανέβηκε φέτος κατηγορία ή είναι νέα στα δεδομένα. Οι δυνάμεις της εκτιμώνται με περιορισμένο ιστορικό και μια προσεκτική προ-εκτίμηση (prior).',
  fewData: 'Η ομάδα έχει λίγους πρόσφατους αγώνες στα δεδομένα, άρα η εκτίμηση για αυτήν είναι πιο αβέβαιη.',
  lowConfidence: 'Πολύ λίγα δεδομένα για μία από τις ομάδες: οι πιθανότητες είναι ιδιαίτερα αβέβαιες.',
  stale: 'Τα δεδομένα δεν ανανεώθηκαν πρόσφατα. Οι πιθανότητες μπορεί να μην ισχύουν πια.',
};

/** Badges of one match: [{ id, text, help, tone }]. */
export function matchBadges(match, league, now) {
  const f = match.flags || {};
  const out = [];
  if (f.eloOnly) out.push({ id: 'eloOnly', text: 'χαμηλότερη βεβαιότητα', help: BADGE_HELP.eloOnly, tone: 'warn' });
  const side = (flagHome, flagAway) => [flagHome && match.homeName, flagAway && match.awayName].filter(Boolean).join(' & ');
  if (f.promotedHome || f.promotedAway) {
    out.push({ id: 'promoted', text: `νεοφώτιστη: ${side(f.promotedHome, f.promotedAway)}`, help: BADGE_HELP.promoted, tone: 'info' });
  }
  if (f.fewDataHome || f.fewDataAway) {
    out.push({ id: 'fewData', text: `λίγα δεδομένα: ${side(f.fewDataHome, f.fewDataAway)}`, help: BADGE_HELP.fewData, tone: 'warn' });
  }
  if (f.lowConfidence) out.push({ id: 'lowConfidence', text: 'χαμηλή βεβαιότητα', help: BADGE_HELP.lowConfidence, tone: 'warn' });
  const st = staleInfo(league, now);
  if (st.stale) out.push({ id: 'stale', text: 'παλιά δεδομένα', help: `${BADGE_HELP.stale} ${st.reason}`, tone: 'bad' });
  return out;
}

// ------------------------------------------------------ Phase 3 wording ----

/** Greek names of the Champions League stages (football-data.org codes). Unknown codes give null. */
export const STAGE_LABELS = {
  GROUP_STAGE: 'Φάση ομίλων',
  LEAGUE_STAGE: 'Φάση λίγκας',
  PLAYOFFS: 'Πλέι-οφ',
  LAST_16: 'Φάση των 16',
  QUARTER_FINALS: 'Προημιτελικά',
  SEMI_FINALS: 'Ημιτελικά',
  FINAL: 'Τελικός',
};

export function stageLabel(code) {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(STAGE_LABELS, code) ? STAGE_LABELS[code] : null;
}

/** Why a scorer is missing, in Greek: injury / suspension / anything else. */
export function absenceKindText(kind) {
  if (kind === 'injury') return 'τραυματισμός';
  if (kind === 'suspension') return 'τιμωρία';
  return 'απουσία';
}

/** The nine half-time/full-time combinations in the order of the data (home = 1, draw = Χ, away = 2). */
export const HTFT_LABELS = ['1/1', '1/Χ', '1/2', 'Χ/1', 'Χ/Χ', 'Χ/2', '2/1', '2/Χ', '2/2'];

/** The htft block of a match when it is complete (9 combinations, half-time 1X2), otherwise null (old data files have none). */
export function htftOf(match) {
  const b = match?.htft;
  if (!b || !Array.isArray(b.combos) || b.combos.length !== 9 || !b.combos.every(Number.isFinite)) return null;
  const ht = b.ht;
  if (!ht || ![ht.home, ht.draw, ht.away].every(Number.isFinite)) return null;
  return b;
}

// ---------------------------------------------------------- list helpers ----

/**
 * loaded: [{ league: <league json>, order: <chip order> }]
 * Returns upcoming matches (kick-off in the future) sorted by time.
 */
export function collectEntries(loaded, now) {
  const out = [];
  for (const { league, order } of loaded) {
    for (const m of league.matches || []) {
      const t = Date.parse(m.kickoff);
      if (!Number.isFinite(t) || t <= now.getTime()) continue;
      out.push({ key: `${league.league.code}:${m.id}`, m, league, order, t });
    }
  }
  return out.sort((a, b) => a.t - b.t || a.order - b.order);
}

/** Entries (already sorted) -> [{ day: 'YYYY-MM-DD', entries }] in Athens days. */
export function groupByDay(entries) {
  const groups = [];
  for (const e of entries) {
    const day = athensDay(new Date(e.t));
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.entries.push(e);
    else groups.push({ day, entries: [e] });
  }
  return groups;
}

export function parseHash(hash, codes) {
  let raw = '';
  try {
    raw = decodeURIComponent(String(hash || '').replace(/^#/, ''));
  } catch {
    raw = '';
  }
  const code = raw.toUpperCase();
  return codes.includes(code) ? code : 'ALL';
}

/** Which screen a URL hash asks for: '#reliability' opens the reliability report, anything else the matches. */
export function parseView(hash) {
  let raw = '';
  try {
    raw = decodeURIComponent(String(hash || '').replace(/^#/, ''));
  } catch {
    raw = '';
  }
  return raw.toLowerCase() === 'reliability' ? 'reliability' : 'matches';
}

// ------------------------------------------------------- report numbers ----

const finiteNum = (x) => typeof x === 'number' && Number.isFinite(x);

/** Decimal comma with fixed digits; a dash when the value is missing: 0.2169 -> "0,217". */
export function fmtDec(x, digits = 3) {
  return finiteNum(x) ? x.toFixed(digits).replace('.', ',') : '–';
}

/** A fraction as a percentage with one decimal: 0.126 -> "12,6%". */
export function fmtPct1(x) {
  return finiteNum(x) ? `${(x * 100).toFixed(1).replace('.', ',')}%` : '–';
}

/** Improvement over a reference, with a sign: 0.126 -> "+12,6%", -0.03 -> "−3,0%". */
export function fmtSkill(x) {
  if (!finiteNum(x)) return '–';
  const v = Math.abs(x * 100).toFixed(1).replace('.', ',');
  if (Math.round(Math.abs(x) * 1000) === 0) return `${v}%`;
  return `${x < 0 ? MINUS : '+'}${v}%`;
}

/** Percentage points: 0.1177 -> "11,8 π.μ." (width of a 10-90 % range). */
export function fmtPoints(x) {
  return finiteNum(x) ? `${(x * 100).toFixed(1).replace('.', ',')} π.μ.` : '–';
}

/**
 * Colour class of an improvement over the league base rates:
 * 'good' at or above the limit, 'bad' below it, 'neutral' when unknown.
 */
export function skillTone(skill, minSkill = 0.08) {
  if (!finiteNum(skill)) return 'neutral';
  return skill >= minSkill ? 'good' : 'bad';
}

/** Greek wording of the calibration layer's decision reasons (the job writes them in English). */
export function calibrationReasonText(reason) {
  if (typeof reason !== 'string' || reason === '') return '';
  if (reason === 'no clear out-of-sample gain') return 'καμία σαφής βελτίωση σε δεδομένα εκτός δείγματος';
  if (reason === 'improves nested out-of-sample log-loss') return 'βελτιώνει τις προβλέψεις σε δεδομένα εκτός δείγματος';
  const few = /^only (\d{1,7}) matches$/.exec(reason);
  if (few) return `μόνο ${few[1]} αγώνες: λίγοι για αξιόπιστη εκτίμηση`;
  return reason; // unknown wording: shown as written (textContent, so it cannot inject markup)
}

/** Half-life in days of the time weights exp(-xi * days): ln 2 / xi. */
export function halfLifeDays(xi) {
  return finiteNum(xi) && xi > 0 ? Math.round(Math.LN2 / xi) : null;
}

// ---------------------------------------------------------------- config ----

const SAFE = /^[A-Za-z0-9._-]+$/;
const PLACEHOLDER = /^YOUR[_-]/i;

/** Where the JSON files are read from: { ok, base } or { ok: false, reason }. */
export function dataBase(config) {
  if (!config || typeof config !== 'object') return { ok: false, reason: 'missing' };
  if (typeof config.DATA_URL === 'string' && config.DATA_URL) return { ok: true, base: config.DATA_URL.replace(/\/+$/, '') };
  const good = (s) => typeof s === 'string' && SAFE.test(s) && !PLACEHOLDER.test(s);
  if (!good(config.OWNER) || !good(config.REPO)) return { ok: false, reason: 'unset' };
  const branch = good(config.BRANCH) ? config.BRANCH : 'data';
  return { ok: true, base: `https://raw.githubusercontent.com/${config.OWNER}/${config.REPO}/${branch}` };
}

/** Only plain file names like "PL.json" are fetched. */
export function safeFile(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_-]+\.json$/.test(name) ? name : null;
}
