// Team-name alias groups = the built-in list + the user's own aliases.json.
//
//   aliases.builtin.json  shipped with the code, replaced on every upgrade (do not edit)
//   aliases.json          the user's own lines, edited by hand on GitHub, never overwritten by an upgrade
//
// Both files have the same format: { "Name used as the key": ["other spelling", ...], ... }.
// Groups with the same key are merged. A broken user file (a typical typo of a beginner editing JSON on
// GitHub: a missing comma or quote) must never stop a run: it is reported as a warning and ignored, the
// built-in list keeps working.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const BUILTIN_ALIASES_PATH = fileURLToPath(new URL('../../aliases.builtin.json', import.meta.url));

/** Reads one alias file. Returns { groups, warnings }; a missing file is not an error. */
function readGroups(file, label, { required = false } = {}) {
  const warnings = [];
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      if (required) warnings.push({ code: 'aliases-missing', message: `Λείπει το αρχείο ${label}.` });
      return { groups: {}, warnings };
    }
    return { groups: {}, warnings: [{ code: 'aliases-invalid', message: `Δεν διαβάστηκε το ${label}: ${err?.message || err}` }] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      groups: {},
      warnings: [
        {
          code: 'aliases-invalid',
          message: `Το ${label} δεν είναι έγκυρο JSON (${err?.message || err}) και αγνοήθηκε. Συνήθως λείπει κόμμα ή εισαγωγικό· διόρθωσέ το στο GitHub. Στο μεταξύ χρησιμοποιούνται μόνο οι έτοιμες αντιστοιχίσεις.`,
        },
      ],
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { groups: {}, warnings: [{ code: 'aliases-invalid', message: `Το ${label} πρέπει να είναι της μορφής { "Όνομα": ["άλλη γραφή", ...] } και αγνοήθηκε.` }] };
  }
  const groups = {};
  for (const [name, list] of Object.entries(parsed)) {
    if (name.startsWith('_')) continue; // comment keys
    if (!Array.isArray(list) || !list.every((x) => typeof x === 'string')) {
      warnings.push({ code: 'aliases-entry-invalid', message: `${label}: η γραμμή "${name}" πρέπει να έχει λίστα με ονόματα σε εισαγωγικά (π.χ. ["Άλλη γραφή", "Και άλλη"]) και παραλείφθηκε.` });
      continue;
    }
    groups[name] = list;
  }
  return { groups, warnings };
}

/**
 * @param {string|null} userPath   the user's aliases.json (may be missing)
 * @param {{ builtinPath?: string|null }} [opt]   builtinPath = null switches the built-in list off (tests)
 * @returns {{ aliases: Record<string,string[]>, warnings: {code:string,message:string}[] }}
 */
export function loadAliases(userPath, { builtinPath = BUILTIN_ALIASES_PATH } = {}) {
  const warnings = [];
  const aliases = {};
  const sources = [];
  if (builtinPath) sources.push(readGroups(builtinPath, 'aliases.builtin.json', { required: true }));
  if (userPath) sources.push(readGroups(userPath, 'aliases.json'));
  for (const s of sources) {
    warnings.push(...s.warnings);
    for (const [name, list] of Object.entries(s.groups)) aliases[name] = [...new Set([...(aliases[name] || []), ...list])];
  }
  return { aliases, warnings };
}
