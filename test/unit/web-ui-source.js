// Source helpers for unit tests that inspect the browser ES modules in public/.
const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.join(__dirname, '..', '..', 'public');

// ES modules of the Web UI, in the order app.js initializes them.
const modules = ['app', 'account', 'state', 'api', 'terminal', 'startup-media', 'general-settings', 'graphic-view', 'graphic-edit', 'graphic-console', 'topology', 'workspace',
  'nodes', 'archive', 'node-dialogs', 'host-settings', 'host-console-settings', 'captures', 'socket', 'observe'];

function read(file) {
  return fs.readFileSync(path.join(publicDir, file), 'utf8');
}

function moduleSource(name) {
  return read(`${name}.js`);
}

// Concatenated source of every Web UI module.
function uiSource() {
  return modules.map(moduleSource).join('\n');
}

// Source of one top-level function, without its `export` keyword.
function functionSource(source, name) {
  const start = source.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`function ${name} not found`);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end + 3).replace(/^export /, '');
}

// Named imports and exports of a module, parsed from its top-level statements.
function moduleLinks(source) {
  const imports = [...source.matchAll(/^import \{([^}]*)\} from '\.\/([\w-]+)\.js';$/gm)]
    .map(([, names, from]) => ({from, names: names.split(',').map(name => name.trim()).filter(Boolean)}));
  const exports = [...source.matchAll(/^export (?:async )?(?:function|const|let) (\w+)/gm)].map(match => match[1]);
  return {imports, exports};
}

module.exports = {publicDir, modules, read, moduleSource, uiSource, functionSource, moduleLinks};
