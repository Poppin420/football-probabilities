#!/usr/bin/env node
// Short, readable result of a refresh run for the bottom of the GitHub Actions
// run page ("job summary"). Reads <OUT_DIR>/index.json.
//   node scripts/job-summary.mjs
// Writes to $GITHUB_STEP_SUMMARY when it is set, otherwise to the console.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const STATUS = {
  ok: '✅ ΟΚ',
  stale: '⚠️ παλιά δεδομένα',
  error: '❌ σφάλμα',
  off: '⏸️ ανενεργό', // e.g. API-Football without a key, or switched off after a plan / quota error
};

/** Make any text safe inside one Markdown table cell. */
function cell(text, max = 140) {
  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[|\\`<>]/g, (c) => `\\${c}`)
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function renderSummary(index) {
  const lines = [];
  const leagues = Array.isArray(index?.leagues) ? index.leagues : [];
  lines.push('## Αποτέλεσμα ανανέωσης δεδομένων');
  lines.push('');
  lines.push(`Ώρα εκτέλεσης: \`${cell(index?.generatedAt || 'άγνωστη')}\` (UTC)`);
  lines.push('');
  lines.push('| Πρωτάθλημα | Κατάσταση | Αγώνες με πιθανότητες | Σημείωση |');
  lines.push('|---|---|---|---|');
  for (const l of leagues) {
    const shown = `${cell(l.name || l.code)} (${cell(l.code)})`;
    const status = STATUS[l.status] || cell(l.status || '?');
    const counts = l.status === 'error' ? '–' : `${Number(l.matches ?? 0)} από ${Number(l.fixtures ?? 0)}`;
    const note = [l.staleReason, l.eloOnly && l.status !== 'error' ? 'μόνο βαθμολογία Elo (χαμηλότερη βεβαιότητα)' : ''].filter(Boolean).join('; ');
    lines.push(`| ${shown} | ${status} | ${counts} | ${cell(note)} |`);
  }
  lines.push('');

  const sources = Object.entries(index?.sources || {});
  if (sources.length > 0) {
    lines.push('**Πηγές:** ' + sources.map(([name, s]) => `${cell(name)} ${STATUS[s?.status] || cell(s?.status || '?')}${s?.detail ? ` (${cell(s.detail, 80)})` : ''}`).join(' · '));
    lines.push('');
  }

  const ai = refreshSummary(index);
  if (ai) lines.push(ai);

  const warnings = Array.isArray(index?.warnings) ? index.warnings : [];
  if (warnings.length > 0) {
    lines.push(`### Ειδοποιήσεις (${warnings.length})`);
    lines.push('');
    for (const w of warnings.slice(0, 30)) lines.push(`- ${cell(w.message || w.code || '?', 300)}`);
    if (warnings.length > 30) lines.push(`- … και ${warnings.length - 30} ακόμα (δες το index.json)`);
    lines.push('');
  }
  return lines.join('\n');
}

const pct1 = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1).replace('.', ',')}%` : '–');
const fix = (x, d = 4) => (Number.isFinite(x) ? Number(x).toFixed(d).replace('.', ',') : '–');

/** Summary of the weekly tuning (report.json). */
export function renderTuneSummary(report) {
  const lines = [];
  lines.push('## Αποτέλεσμα εβδομαδιαίου ελέγχου αξιοπιστίας');
  lines.push('');
  lines.push(`Ώρα εκτέλεσης: \`${cell(report?.generatedAt || 'άγνωστη')}\` (UTC) · σεζόν αξιολόγησης: ${cell((report?.window?.seasons || []).join(', ') || '–')}`);
  lines.push('');
  lines.push('| Πρωτάθλημα | Αγώνες | RPS μοντέλου | RPS βασικών συχνοτήτων | Βελτίωση | Παράμετροι (xi · sigma · ω · Elo) | Σημείωση |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const [code, r] of Object.entries(report?.leagues || {})) {
    if (!r?.metrics) {
      lines.push(`| ${cell(r?.name || code)} (${cell(code)}) | – | – | – | – | – | ${cell(r?.error || r?.skipped || 'δεν αξιολογήθηκε')} |`);
      continue;
    }
    const p = r.params || {};
    const note = [r.stale ? 'παλιά αποτελέσματα' : '', ...(r.flags || []).map((f) => (f.code === 'skill-below-8pct' ? '⚠️ κάτω από το όριο 8%' : f.message))].filter(Boolean).join('; ');
    lines.push(
      `| ${cell(r.name || code)} (${cell(code)}) | ${Number(r.matches)} | ${fix(r.metrics.model?.x12?.rps)} | ${fix(r.metrics.base?.x12?.rps)} | ${pct1(r.skill?.vsBase?.rps)} | ${cell(`${p.xi} · ${p.sigma} · ${p.om} · ${p.elo ? 'ναι' : 'όχι'}`)} | ${cell(note, 160)} |`,
    );
  }
  lines.push('');
  const half = Object.entries(report?.leagues || {}).filter(([, r]) => r?.htft && Number.isFinite(r.htft.skill?.htRps));
  if (half.length > 0) {
    lines.push(`**Ημίχρονο (βελτίωση RPS ημιχρόνου έναντι βασικών συχνοτήτων):** ${half.map(([code, r]) => `${cell(code)} ${pct1(r.htft.skill.htRps)} (${Number(r.htft.n)} αγώνες)`).join(' · ')}.`);
  }
  if (report?.pooled?.skill) lines.push(`**Συνολικά:** ${Number(report.pooled.matches)} αγώνες · βελτίωση στο RPS ${pct1(report.pooled.skill.vsBase?.rps)} (όριο ${pct1(report.criteria?.minSkill)}).`);
  const cup = report?.eloOnly;
  if (cup?.metrics && Number.isFinite(cup.skill?.vsBase?.rps)) {
    const vsLeague = cup.leagueModel && Number.isFinite(cup.skill?.vsLeagueModel?.rps) ? ` · ${pct1(cup.skill.vsLeagueModel.rps)} έναντι του πλήρους μοντέλου λίγκας` : '';
    lines.push(`**Champions League (μόνο Elo, δοκιμή σε εγχώριους αγώνες):** ${Number(cup.n)} αγώνες · βελτίωση RPS ${pct1(cup.skill.vsBase.rps)} έναντι βασικών συχνοτήτων${vsLeague}${cup.stale ? ' (παλιά αποτελέσματα)' : ''}.`);
  }
  const cl = report?.calibrationLayer;
  if (cl?.markets) {
    const parts = Object.entries(cl.markets).map(([k, v]) => `${cell(k)}: ${v.adopt ? 'εφαρμόζεται' : 'δεν εφαρμόζεται'}`);
    lines.push(`**Βαθμονόμηση πιθανοτήτων:** ${parts.join(' · ')}.`);
  }
  lines.push('');
  const warnings = Array.isArray(report?.warnings) ? report.warnings : [];
  if (warnings.length > 0) {
    lines.push(`### Ειδοποιήσεις (${warnings.length})`);
    lines.push('');
    for (const w of warnings.slice(0, 30)) lines.push(`- ${cell(w.message || w.code || '?', 300)}`);
    lines.push('');
  }
  return lines.join('\n');
}

function refreshSummary(index) {
  const aiLine = index?.ai
    ? [
        '',
        index.ai.enabled
          ? `**Σχόλια AI (Groq):** ${Number(index.ai.written ?? 0)} νέα · ${Number(index.ai.cached ?? 0)} από cache · ${Number(index.ai.rejected ?? 0)} απορρίφθηκαν από τον έλεγχο · ${Number(index.ai.calls ?? 0)} κλήσεις${index.ai.stopped ? ` · σταμάτησε: ${cell(index.ai.stopped, 80)}` : ''}${Array.isArray(index.ai.unavailable) && index.ai.unavailable.length ? ` · μοντέλο που δεν υπάρχει πια: ${cell(index.ai.unavailable.join(', '), 80)}` : ''}`
          : `**Σχόλια AI (Groq):** ανενεργά (${cell(index.ai.reason || '?', 100)})`,
        '',
      ].join('\n')
    : '';
  return aiLine;
}

function main() {
  const outDir = path.resolve(process.env.OUT_DIR || 'data-out');
  if (process.argv[2] === 'tune') {
    let report;
    try {
      report = JSON.parse(fs.readFileSync(path.join(outDir, 'report.json'), 'utf8'));
    } catch {
      console.error('job-summary: no readable report.json, nothing to summarise.');
      return;
    }
    const text = renderTuneSummary(report);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
    else console.log(text);
    return;
  }
  let index;
  try {
    index = JSON.parse(fs.readFileSync(path.join(outDir, 'index.json'), 'utf8'));
  } catch {
    console.error('job-summary: no readable index.json, nothing to summarise.');
    return;
  }
  const text = renderSummary(index);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  else console.log(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
