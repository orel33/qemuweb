const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {publicDir, modules, moduleSource, moduleLinks} = require('./web-ui-source');

test('every Web UI module is valid JavaScript and stays below 600 lines', () => {
  for (const name of modules) {
    const source = moduleSource(name);
    assert.ok(source.split('\n').length <= 600, `${name}.js is too long`);
    // vm.Script cannot parse import/export: drop them, the bodies stay checked.
    const body = source.replace(/^import .*$/gm, '').replace(/^export /gm, '');
    assert.doesNotThrow(() => new vm.Script(`(async () => {\n${body}\n})`), `${name}.js`);
  }
});

test('every named import resolves to an export of a Web UI module', () => {
  const links = Object.fromEntries(modules.map(name => [name, moduleLinks(moduleSource(name))]));
  for (const [name, {imports}] of Object.entries(links)) {
    for (const {from, names} of imports) {
      assert.ok(links[from], `${name}.js imports unknown module ./${from}.js`);
      for (const imported of names) assert.ok(links[from].exports.includes(imported), `${name}.js imports ${imported} from ./${from}.js`);
    }
  }
});

test('the module list matches public/ and app.js initializes every feature module', () => {
  // Classic scripts, and login.js, admin.js, admin-runners.js and admin-connections.js, the modules of the separate login and /admin pages.
  const classic = new Set(['monitor-terminal.js', 'session-log.js', 'network-node-icons.js', 'topology-graphic.js', 'view-state.js', 'login.js', 'admin.js', 'admin-runners.js', 'admin-connections.js']);
  const files = fs.readdirSync(publicDir).filter(file => file.endsWith('.js') && !classic.has(file)).sort();
  assert.deepEqual(files, modules.map(name => `${name}.js`).sort());
  const app = moduleSource('app');
  for (const name of modules) {
    const init = moduleLinks(moduleSource(name)).exports.find(exported => /^init[A-Z]/.test(exported));
    if (init) assert.match(app, new RegExp(`^${init}\\(\\);$`, 'm'), `app.js calls ${init}()`);
  }
});

test('the stylesheet is served from public/css/app.css', () => {
  assert.ok(fs.statSync(path.join(publicDir, 'css', 'app.css')).size > 0);
});

test('the Load session dialog is a review with Start and Discard options and OK', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  for (const id of ['session-archive-load-options', 'load-auto-start', 'load-discard-disks', 'load-discard-note', 'confirm-session-archive-load']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /Start hosts and switches after loading/);
  assert.match(html, /<input type="checkbox" id="load-discard-disks"> Discard working disks/);
  assert.doesNotMatch(html, /Load without working disks/);
  const archive = moduleSource('archive');
  assert.match(archive, /discardDisks=\$\{discardDisks\}/);
  assert.doesNotMatch(archive, /discardStaleDisks/);
});
