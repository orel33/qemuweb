'use strict';

// The stylesheets of the web interface must be well formed: a missing or extra brace silently drops every rule after it
// (a broken media query once left the login page unstyled). Braces are counted outside comments and strings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cssDir = path.join(__dirname, '..', '..', 'public', 'css');

function stripped(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');
}

for (const file of fs.readdirSync(cssDir).filter(name => name.endsWith('.css'))) {
  test(`${file}: braces are balanced and never go below zero`, () => {
    const text = stripped(fs.readFileSync(path.join(cssDir, file), 'utf8'));
    let depth = 0;
    let line = 1;
    for (const character of text) {
      if (character === '\n') line += 1;
      else if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        assert.ok(depth >= 0, `${file}: unexpected } on line ${line}`);
      }
    }
    assert.equal(depth, 0, `${file}: ${depth} unclosed { at the end`);
  });

  test(`${file}: nesting stays at most two levels (a rule inside an @media or @supports block)`, () => {
    const lines = stripped(fs.readFileSync(path.join(cssDir, file), 'utf8')).split('\n');
    let depth = 0;
    for (const [index, line] of lines.entries()) {
      depth += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
      assert.ok(depth <= 2, `${file}:${index + 1}: nesting depth ${depth}`);
    }
  });
}
