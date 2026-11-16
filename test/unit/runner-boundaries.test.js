// Static dependency rules of the runner (see docs/architecture.md):
// runner/ depends only on common/, Node built-ins and node-pty (the VDE switch
// management terminal), and the control plane reaches the runner only through
// the protocol (lib/runner-client.js): it never requires runner/ (the local
// runner is a separate process, runner/main.js, see lib/local-runner.js).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {builtinModules} = require('node:module');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');

function sources(dir) {
  return fs.readdirSync(path.join(root, dir), {withFileTypes: true}).flatMap(entry => {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(relative);
    return entry.name.endsWith('.js') ? [relative] : [];
  });
}

function requires(file) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  return [...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1]);
}

test('runner/ requires only runner/, common/, Node built-ins and node-pty', () => {
  const builtins = new Set([...builtinModules, 'node-pty']);
  for (const file of sources('runner')) {
    for (const request of requires(file)) {
      if (!request.startsWith('.')) {
        assert.ok(builtins.has(request.replace(/^node:/, '')), `${file} requires package ${request}`);
        continue;
      }
      const target = path.relative(root, path.resolve(root, path.dirname(file), request));
      assert.match(target, /^(runner|common)(\/|$)/, `${file} requires ${request}`);
    }
  }
});

test('the control plane never requires runner/', () => {
  const files = ['server.js', 'sockets.js', ...sources('routes'), ...sources('lib'), ...sources('common')];
  for (const file of files) {
    for (const request of requires(file).filter(item => item.startsWith('.'))) {
      const target = path.relative(root, path.resolve(root, path.dirname(file), request));
      assert.ok(!/^runner(\/|$)/.test(target), `${file} requires ${request}`);
    }
  }
});
