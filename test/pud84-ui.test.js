const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('Clone is the last action in the bottom-left button group', () => {
  const navigation = html.match(/<nav class="machines"[\s\S]*?<\/nav>/)?.[0] || '';
  const addSwitch = navigation.indexOf('id="new-switch"');
  const clone = navigation.indexOf('id="clone-machine"');
  const pageControls = navigation.indexOf('class="page-controls"');

  assert.ok(addSwitch >= 0 && clone > addSwitch, 'Clone follows Add switch');
  assert.ok(pageControls > clone, 'Clone remains left of the right-aligned page controls');
});
