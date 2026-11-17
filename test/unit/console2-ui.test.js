// Second console (ttyS1) in the Web layer: room routing of console events by console ID, and the
// pane view, Console settings tab and socket handlers of the browser source. No server is started.
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {attachSockets, nodeRoom, consoleRoom} = require('../../server/sockets');
const {publicDir, moduleSource} = require('./web-ui-source');

const HOST = 'h-0123456789abcdef';

test('serial events go to the console room, other node events to the node room', () => {
  const sent = [];
  const io = {on() {}, to: room => ({emit: (event, payload) => sent.push([room, event, payload])})};
  const session = {id: 'sess'};
  const runner = {events: new EventEmitter()};
  attachSockets(io, {list: () => [{session, runner}], on() {}}, {audit: {record() {}}, currentUser: () => null});
  runner.events.emit('serial', {nodeId: HOST, data: 'a'});
  runner.events.emit('serial', {nodeId: `${HOST}:1`, data: 'b'});
  runner.events.emit('serial-reset', {nodeId: `${HOST}:1`});
  runner.events.emit('log', {nodeId: HOST, line: 'x'});
  runner.events.emit('state', {nodeId: HOST, running: true});
  assert.deepEqual(sent.filter(([, event]) => event !== 'nodes-changed').map(([room, event]) => [room, event]), [
    [consoleRoom(session, HOST), 'serial'],
    [consoleRoom(session, `${HOST}:1`), 'serial'],
    [consoleRoom(session, `${HOST}:1`), 'serial-reset'],
    [nodeRoom(session, HOST), 'log'],
    [nodeRoom(session, HOST), 'state']
  ]);
  assert.equal(consoleRoom(session, HOST), `console:sess:${HOST}`);
});

test('every pane has a Console (ttyS1) view button, hidden until the host has a second console', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  assert.equal(html.match(/data-view="console2"[^>]*hidden/g).length, 4);
  assert.match(html, /<script src="\/console-id\.js"><\/script>/);
  assert.match(html, /id="host-panel-console"/);
  assert.match(html, /id="host-tab-console"[^>]*>Console</);
  const expert = html.slice(html.indexOf('id="host-panel-expert"'), html.indexOf('id="host-create-actions"'));
  assert.doesNotMatch(expert, /settings-console/);
});

test('the browser selects consoles by console ID and keeps one buffer per channel', () => {
  const terminal = moduleSource('terminal');
  assert.match(terminal, /'console2'/);
  assert.match(terminal, /hasSecondConsole/);
  assert.match(terminal, /'clear-console', \{id: paneConsoleId\(pane\)/);
  const socket = moduleSource('socket');
  assert.match(socket, /ConsoleId\.baseNodeId\(event\.nodeId\)/);
  assert.match(socket, /machine\.serial2/);
  assert.match(moduleSource('host-settings'), /renderConsoleSettings/);
  assert.match(terminal, /Console \(\$\{ConsoleId\.portName\(1\)\}\)/);
  assert.match(moduleSource('host-console-settings'), /Console socket \(\${second}\)/);
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  assert.equal(html.match(/aria-label="Console \(ttyS1\)" title="Console \(ttyS1\)"/g).length, 4);
  assert.doesNotMatch(html, /Console 2/);
});

test('the pane "Show only this terminal" button is gone; no expanded state remains', () => {
  const workspace = moduleSource('workspace');
  for (const name of ['workspace', 'terminal']) assert.doesNotMatch(moduleSource(name), /solo|showOnlyPane|Show only this terminal/i, name);
  assert.doesNotMatch(fs.readFileSync(path.join(publicDir, 'css', 'app.css'), 'utf8'), /pane-solo/);
  assert.match(workspace, /toggleConsoleColumns\.title = `Layout: \$\{current\.label\}`/);
  assert.doesNotMatch(workspace, /toggleConsoleColumns\.disabled/);
  for (const name of ['workspace', 'terminal', 'state', 'view-state', 'observe', 'socket']) {
    assert.doesNotMatch(moduleSource(name), /expanded(?!['"])|expandedPaneIndex|expandButton|Restore the layout/, name);
  }
});

test('the pane view menu is a view-control; the pane views are carried by the view state', () => {
  const {functionSource} = require('./web-ui-source');
  const terminal = moduleSource('terminal');
  const workspace = moduleSource('workspace');
  assert.match(terminal, /pane\.viewMenu\.className = 'pane-view-menu view-control'/);
  assert.match(moduleSource('observe'), /pane\.viewMenu\.open = false/, 'a driven page closes the open view menus');
  assert.match(functionSource(workspace, 'captureView'), /views: panes\.slice\(0, store\.layoutSize\)\.map\(pane => \(pane\.machineId \? pane\.view : 'console'\)\)/);
  const apply = functionSource(workspace, 'applyView');
  assert.ok(apply.indexOf('setPaneSessions(') < apply.indexOf('view.views.forEach'), 'views are applied after the panes\' nodes');
  assert.match(apply, /usablePaneView\(pane, observing && wanted === 'monitor' \? 'console' : wanted\)/);
  assert.match(apply, /setPaneView\(pane, shown\)/);
  assert.match(functionSource(terminal, 'setPaneView'), /viewChanged\(\)/);
  assert.match(terminal, /if \(view === 'console2'\) return hasSecondConsole\(machine\) \? view : 'console'/);
  assert.match(moduleSource('view-state'), /views: \('console' \| 'console2' \| 'monitor' \| 'log'\)\[\]/);
});
