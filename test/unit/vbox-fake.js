'use strict';

// Test helper: installs the fake VBoxManage (test/unit/vbox-fake-script.js) in a directory and reads what it recorded.
const fs = require('node:fs');
const path = require('node:path');

const BASE_UUID = '4d9d2447-07ee-443b-9fd6-3f74435be80a';
const NIL = '00000000-0000-0000-0000-000000000000';

// Installs the fake as <dir>/VBoxManage with a plan; returns {bin, calls, state, plan}.
function installFake(dir, plan = {}) {
  const bin = path.join(dir, 'VBoxManage');
  const script = fs.readFileSync(path.join(__dirname, 'vbox-fake-script.js'), 'utf8').replace(/^#!.*\n/, `#!${process.execPath}\n`);
  fs.writeFileSync(bin, script, {mode: 0o755});
  const setPlan = next => fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({failOn: null, message: '', failOnce: false, ...next}));
  setPlan(plan);
  const read = name => (fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), 'utf8') : '');
  return {
    bin, setPlan,
    calls: () => read('calls.jsonl').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    state: () => (read('state.json') ? JSON.parse(read('state.json')) : {registry: {}, vms: {}})
  };
}

function uuidBytes(text) {
  const g = text.split('-').map(part => Buffer.from(part, 'hex'));
  return Buffer.concat([Buffer.from(g[0]).reverse(), Buffer.from(g[1]).reverse(), Buffer.from(g[2]).reverse(), g[3], g[4]]);
}

// A VDI file header: type 1 (base) or 4 (differencing), own UUID, parent UUID.
function vdi({type, uuid, parent = NIL}) {
  const buffer = Buffer.alloc(512);
  buffer.writeUInt32LE(0xbeda107f, 64); buffer.writeUInt32LE(type, 76); buffer.writeBigUInt64LE(4096n, 368);
  uuidBytes(uuid).copy(buffer, 392); uuidBytes(parent).copy(buffer, 424);
  return buffer;
}

module.exports = {installFake, vdi, BASE_UUID, NIL};
