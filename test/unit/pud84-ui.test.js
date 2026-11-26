const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');

test('Reset session follows Clone at the end of the bottom-left button group', () => {
  const navigation = html.match(/<nav class="machines"[\s\S]*?<\/nav>/)?.[0] || '';
  const addSwitch = navigation.indexOf('id="new-switch"');
  const clone = navigation.indexOf('id="clone-machine"');
  const reset = navigation.indexOf('id="reset-session"');
  const pageControls = navigation.indexOf('class="page-controls"');

  assert.ok(addSwitch >= 0 && clone > addSwitch, 'Clone follows Add switch');
  assert.ok(reset > clone && pageControls > reset, 'Reset session is last before the right-aligned page controls');
});

test('Resume all comes just before Stop all, then Reset session, the one destructive action (UXS02)', () => {
  const ids = [...html.matchAll(/<button id="(resume-all|stop-all|reset-session|exit-all|delete-session)"/g)].map(match => match[1]);
  assert.deepEqual(ids, ['resume-all', 'stop-all', 'reset-session']);
  const button = html.match(/<button id="resume-all"[^>]*>/)[0];
  for (const part of ['icon-button', 'write-action', 'act-green', 'aria-label="Resume all"', 'disabled']) assert.ok(button.includes(part), part);
});
