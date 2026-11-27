// The About dialog (public/about.js) and the license of the project.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('the About button is on the main page and on /admin, and both pages initialize it', () => {
  for (const page of ['public/index.html', 'public/admin.html']) assert.match(read(page), /<button id="show-about" [^>]*title="About QemuWeb"[^>]*aria-label="About QemuWeb"/, page);
  for (const script of ['public/app.js', 'public/admin.js']) {
    assert.match(read(script), /^import \{initAbout\} from '\.\/about\.js';$/m, script);
    assert.match(read(script), /^ *initAbout\(\);$/m, script);
  }
});

test('the dialog shows the version of package.json, the license, the repository and the authors', () => {
  const source = read('public/about.js');
  assert.ok(source.includes(`export const VERSION = '${require('../../package.json').version}';`), 'about.js has the version of package.json');
  for (const text of ['MIT License', 'https://github.com/orel33/qemuweb', 'aurelien.esnard@u-bordeaux.fr', 'Co-authored with Claude and Codex']) assert.ok(source.includes(text), text);
});

test('LICENSE, package.json and the README name the MIT license', () => {
  assert.match(read('LICENSE'), /^MIT License\n\nCopyright \(c\) 2026 Aurelien Esnard\n/);
  assert.equal(require('../../package.json').license, 'MIT');
  assert.match(read('README.md'), /\[MIT\]\(LICENSE\)/);
});
