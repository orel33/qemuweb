#!/usr/bin/env node
'use strict';

// Records the current base image SHA-256 and size in demo/*.zip (session.json "baseImages").
// Called by `scripts/prepare.sh --update-demo-hashes`.
//
// Usage: node scripts/update-demo-hashes.js [--demo-dir <dir>] [<system-id> ...]
//   <system-id>   Only update these systems (default: every system an archive records).
//   --demo-dir    Archive directory (default: demo/).
//
// A working disk (qcow2) stores only differences from the base image it was created
// on. Recording a new hash for an archive that contains such disks would make QemuWeb
// accept them on the new image, which can corrupt the guests' filesystems. For those
// archives the script warns and asks for confirmation; without a terminal it skips them.
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const root = path.resolve(__dirname, '..');
const {readArchive, writeArchive} = require(path.join(root, 'lib/session-archive'));
const {fileSha256} = require(path.join(root, 'runner/media/image-hash'));
const {readCatalog} = require(path.join(root, 'common/system-config'));

const args = process.argv.slice(2);
let demoDir = path.join(root, 'demo');
const onlySystems = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--demo-dir') demoDir = path.resolve(args[++i] || '');
  else if (args[i].startsWith('--')) { console.error(`update-demo-hashes: unknown option ${args[i]}`); process.exit(2); }
  else onlySystems.push(args[i]);
}

const catalog = readCatalog(path.join(root, 'config.json'));
const imageFile = (id, format) => {
  const entry = catalog.systems[id]?.[format === 'vdi' ? 'vbox' : 'qemu'];
  return entry ? path.resolve(root, entry.image) : null;
};
const short = value => value.slice(0, 12);

function ask(question) {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = readline.createInterface({input: process.stdin, output: process.stdout});
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(/^y(es)?$/i.test(answer.trim())); }));
}

(async () => {
  const zips = fs.readdirSync(demoDir).filter(name => name.endsWith('.zip')).sort();
  const summary = {updated: 0, current: 0, skipped: 0, failed: 0};
  for (const name of zips) {
    const zip = path.join(demoDir, name);
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'qemuweb-demo-'));
    try {
      const files = await readArchive(zip, stage);
      const sessionPath = path.join(stage, 'session.json');
      const original = fs.readFileSync(sessionPath, 'utf8');
      const data = JSON.parse(original);
      if (JSON.stringify(data, null, 2) + '\n' !== original) throw new Error('unexpected session.json formatting');

      const changes = [];
      for (const [id, entry] of Object.entries(data.baseImages || {})) {
        if (onlySystems.length && !onlySystems.includes(id)) continue;
        const file = imageFile(id, entry.format);
        if (!file || !fs.existsSync(file)) { console.warn(`  ${name}: image for ${id} not found, left unchanged.`); continue; }
        const actual = fileSha256(file);
        if (actual.size !== entry.size || actual.sha256 !== entry.sha256) changes.push({id, entry, actual});
      }
      if (!changes.length) { console.log(`${name}: up to date`); summary.current++; continue; }

      // Working disks of the hosts that use a changed image.
      const stale = [];
      for (const file of files) {
        const match = /^(h-[0-9a-f]{16})\/disk\.qcow2$/.exec(file);
        if (!match) continue;
        const host = JSON.parse(fs.readFileSync(path.join(stage, match[1], 'host.json'), 'utf8'));
        if (changes.some(change => change.id === host.system)) stale.push(`${host.name} (${host.system})`);
      }
      for (const {id, entry, actual} of changes) console.log(`${name}: ${id} ${short(entry.sha256)} -> ${short(actual.sha256)}`);
      if (stale.length) {
        console.warn(`\n  WARNING: ${name} contains working disks (qcow2): ${stale.join(', ')}.`);
        console.warn('  They only store differences from the OLD base image. If the new image is not');
        console.warn('  identical in content, loading this archive with the new hash would apply them to');
        console.warn('  a different base and may corrupt the guests. Safer: keep the old hash (answer n),');
        console.warn('  so QemuWeb warns and discards those disks on load, or recreate the demo.');
        if (!await ask(`  Update the hash of ${name} anyway? [y/N] `)) {
          console.warn(`${name}: skipped${process.stdin.isTTY ? '' : ' (no terminal to confirm)'}`);
          summary.skipped++;
          continue;
        }
      }

      for (const {entry, actual} of changes) { entry.size = actual.size; entry.sha256 = actual.sha256; }
      fs.writeFileSync(sessionPath, JSON.stringify(data, null, 2) + '\n');
      const rewritten = path.join(os.tmpdir(), `qemuweb-demo-${process.pid}-${name}`);
      fs.rmSync(rewritten, {force: true});
      await writeArchive(rewritten, files.map(file => ({name: file, file: path.join(stage, file)})));
      // The new archive must read back with the same entries and bytes before it replaces the old one.
      const check = fs.mkdtempSync(path.join(os.tmpdir(), 'qemuweb-demo-check-'));
      try {
        const names = await readArchive(rewritten, check);
        if (JSON.stringify(names) !== JSON.stringify(files)) throw new Error('entry list differs after rewrite');
        for (const file of files) {
          if (!fs.readFileSync(path.join(check, file)).equals(fs.readFileSync(path.join(stage, file)))) throw new Error(`content differs after rewrite: ${file}`);
        }
      } finally { fs.rmSync(check, {recursive: true, force: true}); }
      fs.copyFileSync(rewritten, zip);
      fs.rmSync(rewritten, {force: true});
      console.log(`${name}: updated (${files.length} entries)`);
      summary.updated++;
    } catch (error) {
      console.error(`${name}: FAILED ${error.message}`);
      summary.failed++;
    } finally { fs.rmSync(stage, {recursive: true, force: true}); }
  }
  console.log(`Demo archives: ${summary.updated} updated, ${summary.current} up to date, ${summary.skipped} skipped, ${summary.failed} failed.`);
  if (summary.updated) console.log('Review with `git diff --stat demo/` and check that the demos still load before committing.');
  if (summary.failed) process.exitCode = 1;
})();
