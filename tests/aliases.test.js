// The alias files: the built-in list (shipped, replaced on upgrade) + the user's own aliases.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILTIN_ALIASES_PATH, loadAliases } from '../src/sources/aliases.js';
import { createResolver } from '../src/sources/names.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-aliases-'));
const write = (name, content) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
};

test('the built-in file ships with the code and the shipped aliases.json is an empty own list', () => {
  assert.ok(fs.existsSync(BUILTIN_ALIASES_PATH));
  const builtin = JSON.parse(fs.readFileSync(BUILTIN_ALIASES_PATH, 'utf8'));
  assert.ok(builtin['Man City'] && builtin.Salzburg && builtin['St Gillis'], 'Phase 1 groups and Champions League groups');
  const own = JSON.parse(fs.readFileSync(new URL('../aliases.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(own), ['_help', '_end'], 'a fresh install has no lines of its own yet');
  assert.match(own._help, /aliases\.builtin\.json/);
});

test('the shipped aliases.json stays valid JSON when lines are pasted into the blank line below "_help" (what SETUP.md tells the user to do)', () => {
  const text = fs.readFileSync(new URL('../aliases.json', import.meta.url), 'utf8');
  const lines = text.split('\n');
  const help = lines.findIndex((l) => l.startsWith('  "_help"'));
  assert.ok(help >= 0 && help < lines.length - 2);
  assert.equal(lines[help].trimEnd().slice(-1), ',', 'the "_help" line ends with a comma');
  assert.equal(lines[help + 1].trim(), '', 'a blank line follows it');
  assert.match(lines[help + 2], /^\s+"_end"/, 'the closing sentinel follows the blank line');
  // paste one line, then two more lines at the same spot, each ending with a comma like the build-aliases output
  const pasted = [...lines];
  pasted.splice(help + 1, 0, '  "Wolves": ["Wolverhampton Wanderers FC"],');
  pasted.splice(help + 1, 0, '  "Another Club": ["Another Club FC", "ACFC"],', '  "Test Club": ["Test Club FC"],');
  const file = write('pasted.json', pasted.join('\n'));
  const { aliases, warnings } = loadAliases(file);
  assert.deepEqual(warnings, []);
  assert.deepEqual(aliases['Test Club'], ['Test Club FC']);
  assert.ok(aliases.Wolves.includes('Wolverhampton Wanderers FC') && aliases.Wolves.includes('Wolverhampton'), 'merged with the built-in group');
  assert.ok(!Object.keys(aliases).some((k) => k.startsWith('_')), 'the comment keys never become aliases');
});

test('groups with the same key are merged (union, no duplicates); the user adds clubs the built-in list does not know', () => {
  const user = write('own.json', { 'Man City': ['Manchester City', 'Citizens'], 'My Club': ['My Club FC', 'MCFC'] });
  const { aliases, warnings } = loadAliases(user);
  assert.deepEqual(warnings, []);
  assert.ok(aliases['Man City'].includes('Citizens') && aliases['Man City'].includes('Manchester City FC'));
  assert.equal(aliases['Man City'].filter((x) => x === 'Manchester City').length, 1);
  assert.deepEqual(aliases['My Club'], ['My Club FC', 'MCFC']);
  const resolver = createResolver(aliases);
  assert.equal(resolver.key('MCFC'), resolver.key('My Club'));
  assert.equal(resolver.key('Citizens'), resolver.key('Manchester City FC'));
  assert.deepEqual(resolver.conflicts, []);
});

test('a missing own file is fine; "_" keys are comments; nothing is shared between calls', () => {
  const none = loadAliases(path.join(dir, 'does-not-exist.json'));
  assert.deepEqual(none.warnings, []);
  assert.ok(none.aliases['Man City']);
  assert.ok(!Object.keys(none.aliases).some((k) => k.startsWith('_')));
  const a = loadAliases(write('c1.json', { X: ['Y'] }));
  const b = loadAliases(write('c2.json', { Z: ['W'] }));
  assert.ok(a.aliases.X && !a.aliases.Z && b.aliases.Z && !b.aliases.X);
});

test('a broken own file (missing comma) never stops anything: a Greek warning, the built-in list keeps working', () => {
  const broken = write('broken.json', '{ "Man City": ["Manchester City"] "Wolves": ["Wolverhampton"] }');
  const { aliases, warnings } = loadAliases(broken);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'aliases-invalid');
  assert.match(warnings[0].message, /^Το aliases\.json δεν είναι έγκυρο JSON \(.+\) και αγνοήθηκε\./);
  assert.match(warnings[0].message, /λείπει κόμμα ή εισαγωγικό/);
  assert.ok(aliases['Man City'] && aliases.Salzburg, 'built-in groups are still there');
  // not an object at all
  const arr = loadAliases(write('array.json', '["a", "b"]'));
  assert.equal(arr.warnings[0].code, 'aliases-invalid');
  assert.ok(arr.aliases['Man City']);
});

test('one malformed line is skipped and named, the other lines of the file still count', () => {
  const user = write('partial.json', { Good: ['Good FC'], Bad: 'Bad FC', AlsoBad: ['ok', 5], Fine: [] });
  const { aliases, warnings } = loadAliases(user);
  assert.equal(aliases.Good[0], 'Good FC');
  assert.ok(!aliases.Bad && !aliases.AlsoBad);
  assert.deepEqual(aliases.Fine, []);
  assert.deepEqual(warnings.map((w) => w.code), ['aliases-entry-invalid', 'aliases-entry-invalid']);
  assert.match(warnings[0].message, /"Bad"/);
  assert.match(warnings[1].message, /"AlsoBad"/);
});

test('a missing or broken built-in file is reported, the own list still works (the code can be run without the shipped file)', () => {
  const user = write('only-own.json', { Solo: ['Solo FC'] });
  const none = loadAliases(user, { builtinPath: path.join(dir, 'nope.json') });
  assert.deepEqual(none.warnings.map((w) => w.code), ['aliases-missing']);
  assert.deepEqual(Object.keys(none.aliases), ['Solo']);
  const off = loadAliases(user, { builtinPath: null });
  assert.deepEqual(off.warnings, []);
  assert.deepEqual(Object.keys(off.aliases), ['Solo']);
  const noUser = loadAliases(null, { builtinPath: null });
  assert.deepEqual(noUser.aliases, {});
});
