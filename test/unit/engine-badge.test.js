'use strict';

// The engine badge of the header (public/engine-badge.js): its text and accessible name, and that
// the markup and every update point exist.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {moduleSource, functionSource} = require('./web-ui-source');

const publicDir = path.join(__dirname, '..', '..', 'public');
const {engineBadge} = vm.runInNewContext(`${functionSource(moduleSource('engine-badge'), 'engineBadge')}\n({engineBadge})`);

test('the badge reads qemu or vbox, with an accessible name; an unknown engine has no badge', () => {
  assert.deepEqual({...engineBadge('qemu')}, {text: 'qemu', label: 'Session engine: QEMU (KVM)'});
  assert.deepEqual({...engineBadge('vbox')}, {text: 'vbox', label: 'Session engine: VirtualBox'});
  for (const unknown of [undefined, null, '', 'kvm', 'QEMU', 'virtualbox']) assert.equal(engineBadge(unknown), null, String(unknown));
});

test('the main page has the badge after the beta badge, hidden until the engine is known; /admin has none', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  assert.match(html, /aria-label="Beta version">BETA<\/span><span class="beta-badge engine-badge" id="engine-badge" role="status" hidden><\/span><\/h1>/);
  for (const file of fs.readdirSync(publicDir).filter(name => name.endsWith('.html') && name !== 'index.html')) {
    assert.ok(!fs.readFileSync(path.join(publicDir, file), 'utf8').includes('engine-badge'), file);
  }
  const css = fs.readFileSync(path.join(publicDir, 'css', 'app.css'), 'utf8');
  assert.match(css, /\.engine-badge \{/);
  assert.match(css, /@media \(max-width: 520px\) \{ \.engine-badge \{ display: none; \} \}/, 'hidden at phone width');
});

test('the badge is set at page start and updated by the engine change, the socket event and the system list refresh', () => {
  assert.match(moduleSource('nodes'), /generalSettings\.engine = sessionSettings\.engine;\s*showEngineBadge\(sessionSettings\.engine\);/);
  assert.match(moduleSource('general-settings'), /generalSettings\.engine = body\.engine;\s*showEngineBadge\(generalSettings\.engine\);/);
  assert.match(moduleSource('socket'), /defaultEngineSelect\.value = event\.engine;\s*showEngineBadge\(event\.engine\);/);
  assert.match(moduleSource('systems'), /showEngineBadge\(generalSettings\.engine\);/);
  const source = moduleSource('engine-badge');
  assert.match(source, /element\.textContent = badge \? badge\.text : '';/);
  assert.match(source, /element\.hidden = !badge;/);
});
