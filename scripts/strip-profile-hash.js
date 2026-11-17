#!/usr/bin/env node
'use strict';

// ONE-TIME MIGRATION, delete this script once the demo archives are rewritten.
// Removes the retired `profileHash` key from every host.json of the given session archives
// (default: the demo/*.zip files), rewriting each archive in place with the export writer:
// same file names and order, same content otherwise.
// Usage: node scripts/strip-profile-hash.js [archive.zip ...]
const fs = require('fs');
const os = require('os');
const path = require('path');
const {readArchive, writeArchive} = require('../runner/archive-zip');
const {writeJsonAtomic} = require('../common/json-file');

async function strip(archive) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'strip-profile-hash-'));
  try {
    fs.mkdirSync(path.join(stage, 'in'));
    const names = await readArchive(archive, path.join(stage, 'in'));
    let removed = 0;
    for (const name of names.filter(item => item.endsWith('/host.json'))) {
      const file = path.join(stage, 'in', name);
      const host = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Object.hasOwn(host, 'profileHash')) { delete host.profileHash; removed++; writeJsonAtomic(file, host); }
    }
    const output = path.join(stage, 'out.zip');
    await writeArchive(output, names.map(name => ({name, file: path.join(stage, 'in', name)})));
    fs.copyFileSync(output, archive);
    console.log(`${archive}: ${removed} host.json rewritten, ${names.length} files`);
  } finally { fs.rmSync(stage, {recursive: true, force: true}); }
}

(async () => {
  const demo = path.join(__dirname, '..', 'demo');
  const archives = process.argv.length > 2 ? process.argv.slice(2)
    : fs.readdirSync(demo).filter(name => name.endsWith('.zip')).sort().map(name => path.join(demo, name));
  for (const archive of archives) await strip(archive);
})().catch(error => { console.error(error.message); process.exit(1); });
