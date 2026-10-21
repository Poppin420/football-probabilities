// Deterministic Greek analysis text built from the model numbers only.
// (In Phase 2 an LLM may rewrite it; this text is also the fallback.)

import { largestRemainder, num, pct } from '../../public/format.js';

function line(markets, lineValue) {
  return markets.find((t) => Math.abs(t.line - lineValue) < 1e-9);
}

/**
 * match: { homeName, awayName, flags, goals, corners|null, cards|null, scorers|null }
 * Returns a short Greek paragraph (strings only, integer percentages).
 */
export function buildAnalysis(match) {
  const g = match.goals;
  const home = match.homeName;
  const away = match.awayName;
  const parts = [];

  // 1X2
  const [ph, pd, pa] = largestRemainder([g.oneX2.home, g.oneX2.draw, g.oneX2.away]);
  const diff = g.oneX2.home - g.oneX2.away;
  if (Math.abs(diff) < 0.08) {
    parts.push('Το μοντέλο βλέπει ένα ισορροπημένο παιχνίδι.');
  } else {
    const fav = diff > 0 ? home : away;
    const d = Math.abs(diff);
    const strength = d >= 0.35 ? 'καθαρό φαβορί' : d >= 0.18 ? 'φαβορί' : 'ελαφρύ φαβορί';
    parts.push(`Το μοντέλο θεωρεί ${strength} την ομάδα ${fav}.`);
  }
  parts.push(`Νίκη ${home}: ${ph}% · Ισοπαλία: ${pd}% · Νίκη ${away}: ${pa}%.`);

  // Goals
  const o25 = line(g.totals, 2.5);
  const [over, under] = largestRemainder([o25.over, o25.under]);
  parts.push(
    `Αναμενόμενα γκολ: ${num(g.expected.home, 2)} – ${num(g.expected.away, 2)} (σύνολο ${num(g.expected.total, 2)}). ` +
      `Over 2,5: ${over}% · Under 2,5: ${under}% · BTTS: ${pct(g.btts.yes)}%.`,
  );
  const top = g.correctScores.slice(0, 3).map((c) => `${c.score} (${pct(c.p)}%)`);
  parts.push(`Πιθανότερα σκορ: ${top.join(', ')}.`);

  // Corners and cards
  if (match.corners) {
    const o = line(match.corners.totals, 9.5);
    parts.push(`Κόρνερ: μέσος όρος ${num(match.corners.mean.total, 1)} · Over 9,5: ${pct(o.over)}%.`);
  }
  if (match.cards) {
    const o = line(match.cards.totals, 3.5);
    parts.push(`Κάρτες: μέσος όρος ${num(match.cards.mean.total, 1)} · Over 3,5: ${pct(o.over)}%.`);
  }

  // Scorers
  if (match.scorers) {
    const all = [...(match.scorers.home || []), ...(match.scorers.away || [])]
      .sort((a, b) => b.anytime - a.anytime)
      .slice(0, 2);
    if (all.length > 0) {
      parts.push(
        `Πιθανότεροι σκόρερ (χωρίς γνωστές συνθέσεις): ${all.map((p) => `${p.name} ${pct(p.anytime)}%`).join(', ')}.`,
      );
    }
  }

  // Data-quality remarks
  const f = match.flags || {};
  if (f.eloOnly) {
    parts.push('Στο Champions League το μοντέλο βασίζεται μόνο στη βαθμολογία Elo των ομάδων, χωρίς πρόσφατη φόρμα ή απουσίες: η βεβαιότητα είναι χαμηλότερη.');
  }
  if (f.promotedHome || f.promotedAway) {
    const who = [f.promotedHome ? home : null, f.promotedAway ? away : null].filter(Boolean).join(' και ');
    parts.push(`Νεοφώτιστη ομάδα (${who}): λιγότερα δεδομένα στη λίγκα, άρα μεγαλύτερη αβεβαιότητα.`);
  } else if (f.fewDataHome || f.fewDataAway) {
    const who = [f.fewDataHome ? home : null, f.fewDataAway ? away : null].filter(Boolean).join(' και ');
    parts.push(`Λίγα δεδομένα για: ${who}.`);
  }

  return parts.join(' ');
}
