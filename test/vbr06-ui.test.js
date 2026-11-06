const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const monitorTerminal = require('../public/monitor-terminal');

test('QEMU monitor capability excludes engines without an HMP monitor', () => {
  assert.equal(monitorTerminal.isSupported({kind: 'vm', engine: 'qemu'}), true);
  assert.equal(monitorTerminal.isSupported({kind: 'vm', engine: 'qemu-tcg'}), true);
  assert.equal(monitorTerminal.isSupported({kind: 'vm', engine: 'virtualbox'}), false);
  assert.equal(monitorTerminal.isSupported({kind: 'switch', engine: 'qemu'}), false);
});

test('monitor input handles commands, editing, cancellation, and escape sequences', () => {
  assert.deepEqual(monitorTerminal.consumeInput('', 'info status\r'), {
    input: '', echo: 'info status\r\n', command: 'info status', prompt: false
  });
  assert.deepEqual(monitorTerminal.consumeInput('helx', '\x7fp\r'), {
    input: '', echo: '\b \bp\r\n', command: 'help', prompt: false
  });
  assert.deepEqual(monitorTerminal.consumeInput('info', '\x03'), {
    input: '', echo: '^C\r\n', command: null, prompt: true
  });
  assert.deepEqual(monitorTerminal.consumeInput('help', '\x1b[A'), {
    input: 'help', echo: '', command: null, prompt: false
  });
});

test('each console pane owns an in-place Console/Monitor toggle and one xterm area', () => {
  assert.equal((html.match(/class="console-view-toggle"/g) || []).length, 4);
  assert.equal((html.match(/data-view="console"/g) || []).length, 4);
  assert.equal((html.match(/data-view="monitor"/g) || []).length, 4);
  assert.equal((html.match(/class="terminal" id="terminal-/g) || []).length, 4);
  for (let index = 0; index < 4; index++) {
    const pane = html.match(new RegExp(`<section class="console-pane" id="console-pane-${index}"[\\s\\S]*?</section>`));
    assert.ok(pane, `console pane ${index} exists`);
    assert.match(pane[0], new RegExp(`id="console-view-${index}"[\\s\\S]*id="terminal-${index}"`));
  }
  assert.doesNotMatch(html, /id="monitor-panel"|id="show-monitor"/);
});

test('the inline browser program is valid JavaScript', () => {
  const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .filter(source => source.trim());
  assert.equal(inlineScripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(inlineScripts[0]));
});
