const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');

function nextNameSource() {
  const start = html.indexOf('    function nextMachineName(kind) {');
  const end = html.indexOf('    async function openHostSettingsCreate()', start);
  assert.ok(start >= 0 && end > start, 'nextMachineName source is present');
  return html.slice(start, end);
}

function nextName({scheme, machines = [], random = 0}) {
  const context = {
    machines: new Map(machines.map((hostname, index) => [String(index), {hostname}])),
    namingSchemes: {selected: scheme},
    generalSettings: {namingScheme: 'selected'},
    Math: {...Math, floor: Math.floor, random: () => random}
  };
  return vm.runInNewContext(`${nextNameSource()}\nnextMachineName('vm');`, context);
}

test('list-based naming randomly selects an unused name', () => {
  const scheme = {names: ['Alpha', 'Beta', 'Gamma', 'Delta']};
  assert.equal(nextName({scheme, random: 0.75}), 'delta');
  assert.equal(nextName({scheme, machines: ['delta'], random: 0.75}), 'gamma');
});

test('classic naming remains sequential', () => {
  assert.equal(nextName({scheme: {prefixes: {vm: 'h'}}, machines: ['h1']}), 'h2');
});

test('Add a new host and Host Settings share a dialog with Cancel and OK', () => {
  const createStart = html.indexOf('async function openHostSettingsCreate()');
  const createEnd = html.indexOf('function openCreateDialog', createStart);
  const settingsStart = html.indexOf('function openHostSettings()');
  const settingsEnd = html.indexOf('function selectSettingsTab(', settingsStart);

  assert.ok(createStart >= 0 && createEnd > createStart);
  assert.ok(settingsStart >= 0 && settingsEnd > settingsStart);
  assert.match(html.slice(createStart, createEnd), /qemuOptionsPanel\.showModal\(\)/);
  assert.match(html.slice(settingsStart, settingsEnd), /qemuOptionsPanel\.showModal\(\)/);
  assert.match(html, /id="cancel-host-create"[^>]*>Cancel<\/button>[^<]*<button id="confirm-host-create"[^>]*>OK<\/button>/);
  assert.doesNotMatch(html, /id="close-host-settings"|closeHostSettings/);
});
