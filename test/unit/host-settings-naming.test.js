const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const {read, moduleSource, functionSource} = require('./web-ui-source');

const html = read('index.html');
const hostSettings = moduleSource('host-settings');

function nextName({scheme, machines = [], random = 0}) {
  const context = {
    machines: new Map(machines.map((hostname, index) => [String(index), {hostname}])),
    store: {namingSchemes: {selected: scheme}},
    generalSettings: {namingScheme: 'selected'},
    Math: {...Math, floor: Math.floor, random: () => random}
  };
  return vm.runInNewContext(`${functionSource(moduleSource('nodes'), 'nextMachineName')}\nnextMachineName('host');`, context);
}

test('list-based naming randomly selects an unused name', () => {
  const scheme = {names: ['Alpha', 'Beta', 'Gamma', 'Delta']};
  assert.equal(nextName({scheme, random: 0.75}), 'delta');
  assert.equal(nextName({scheme, machines: ['delta'], random: 0.75}), 'gamma');
});

test('classic naming remains sequential', () => {
  assert.equal(nextName({scheme: {prefixes: {host: 'h'}}, machines: ['h1']}), 'h2');
});

test('Add a new host and Host Settings share a dialog with Cancel and OK', () => {
  assert.match(functionSource(hostSettings, 'openHostSettingsCreate'), /qemuOptionsPanel\.showModal\(\)/);
  assert.match(functionSource(hostSettings, 'openHostSettings'), /qemuOptionsPanel\.showModal\(\)/);
  assert.match(html, /id="cancel-host-create"[^>]*>Cancel<\/button>[^<]*<button id="confirm-host-create"[^>]*>OK<\/button>/);
  assert.doesNotMatch(html, /id="close-host-settings"|closeHostSettings/);
  assert.doesNotMatch(hostSettings, /close-host-settings|closeHostSettings/);
});
