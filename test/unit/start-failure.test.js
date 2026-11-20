'use strict';

// The start failure dialog: its pure content (public/start-failure.js) and where it is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {moduleSource, functionSource} = require('./web-ui-source');

const source = moduleSource('start-failure');
const {startFailureContent, parseStartErrors} = vm.runInNewContext(`${functionSource(source, 'startFailureContent')}\n${functionSource(source, 'parseStartErrors')}\n({startFailureContent, parseStartErrors})`);
const plain = value => JSON.parse(JSON.stringify(value));

test('one failure: the title names the host and the text is the sentence', () => {
  assert.deepEqual(plain(startFailureContent([{host: 'h1', message: 'VirtualBox cannot start while your QEMU hosts use KVM: stop h2 first.'}])),
    {title: 'Cannot start h1', text: 'VirtualBox cannot start while your QEMU hosts use KVM: stop h2 first.'});
  assert.equal(startFailureContent([{host: '', message: 'boom'}]).title, 'Cannot start host');
  assert.equal(startFailureContent([{host: 'h1', message: '  '}]).text, 'The host did not start.');
});

test('several failures: one text, identical sentences listed once with their hosts', () => {
  const busy = 'The virtualization hardware (KVM) of this runner is busy: try again later.';
  const content = plain(startFailureContent([{host: 'h1', message: busy}, {host: 'h2', message: busy}, {host: 'h3', message: 'Start failed twice'}, {host: 'h1', message: busy}]));
  assert.equal(content.title, 'Cannot start some hosts');
  assert.equal(content.text, `h1, h2: ${busy}\n\nh3: Start failed twice`);
  assert.equal(startFailureContent([{host: 'h1', message: busy}, {host: 'h2', message: busy}]).title, 'Cannot start some hosts', 'one sentence for two hosts is still a list');
});

test('the "name: message" lines of Resume all become failures', () => {
  assert.deepEqual(plain(parseStartErrors(['h1: VirtualBox: boom: with colon', 'no separator'])),
    [{host: 'h1', message: 'VirtualBox: boom: with colon'}, {host: '', message: 'no separator'}]);
});

test('Play, Reboot and Resume all use the one helper, and the dialog is filled with textContent only', () => {
  const nodes = moduleSource('nodes');
  assert.equal((nodes.match(/showStartFailure\(/g) || []).length, 3);
  assert.match(nodes, /showStartFailure\(parseStartErrors\(startErrors\)\)/);
  assert.match(source, /title\.textContent = content\.title;\s*message\.textContent = content\.text;/);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML/);
  assert.match(source, /if \(!dialog\.open\) dialog\.showModal\(\);/, 'an open dialog is updated, never stacked');
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /<dialog class="confirm-dialog" id="start-failure-dialog" aria-labelledby="start-failure-title" aria-describedby="start-failure-message">/);
  assert.match(html, /<form method="dialog" class="confirm-actions"><button value="ok" autofocus>OK<\/button><\/form>/);
});
