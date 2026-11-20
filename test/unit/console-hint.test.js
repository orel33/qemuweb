'use strict';

// The empty-state hint of the Console (ttyS1) view: the pure rule (public/console-hint.js) and the
// wiring of its markup, stylesheet and updates. No browser and no server is started.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {shouldShow, TEXT} = require('../../public/console-hint');
const {publicDir, moduleSource} = require('./web-ui-source');

test('the hint shows only on an attached ttyS1 view that has received nothing', () => {
  assert.equal(shouldShow({view: 'console2', attached: true, received: false}), true);
  assert.equal(shouldShow({view: 'console2', attached: true, received: true}), false);
  assert.equal(shouldShow({view: 'console2', attached: false, received: false}), false);
  for (const view of ['console', 'monitor', 'log']) assert.equal(shouldShow({view, attached: true, received: false}), false, view);
});

test('the hint text explains the empty console', () => {
  assert.equal(TEXT, 'Nothing received yet. Press Enter. If it stays empty, this image has no login on ttyS1: rebuild it with scripts/prepare.sh (images prepared before 17 November 2026).');
});

test('every pane has a hidden hint that takes no pointer event and no selection', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  assert.equal(html.match(/<p class="terminal-hint" hidden><\/p>/g).length, 4);
  assert.match(html, /<script src="\/console-hint\.js"><\/script>/);
  const css = fs.readFileSync(path.join(publicDir, 'css', 'app.css'), 'utf8');
  const rule = css.match(/^\.terminal-hint \{[^}]*\}/m)[0];
  assert.match(rule, /pointer-events: none/);
  assert.match(rule, /user-select: none/);
  assert.match(css, /\.terminal-hint\[hidden\] \{ display: none; \}/);
});

test('the hint is updated when the view, the console buffer or the pane changes', () => {
  const terminal = moduleSource('terminal');
  assert.match(terminal, /ConsoleHint\.shouldShow\(\{view: pane\.view, attached: .*pane\.selectedConsoleId === paneConsoleId\(pane\).*consoleBuffer\(machine, 1\)\.length > 0\}\)/);
  const count = source => (source.match(/updateConsoleHint\(pane\);/g) || []).length;
  assert.ok(count(terminal) >= 3); // console rendering, view change, node or view controls refresh
  const socket = moduleSource('socket');
  assert.equal(count(socket), 3); // snapshot, serial-reset and serial
  for (const name of ['terminal', 'socket']) assert.ok(moduleSource(name).split('\n').length < 600, name);
});
