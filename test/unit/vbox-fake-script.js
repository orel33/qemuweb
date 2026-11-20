#!/usr/bin/env node
'use strict';
// A FAKE VBoxManage for the unit tests (no VirtualBox is used). tests install it with test/unit/vbox-fake.js.
// It records every call (calls.jsonl, next to the script) and models what the real tool refuses:
//  - the media registry: createmedium --diffparent registers the parent and the child, openmedium registers (unless
//    plan.openmediumRegisters is false), closemedium unregisters and forgets a base nothing uses, `list hdds`;
//    attaching a differencing disk whose parent UUID is not registered fails ("Parent medium with UUID ... is not found");
//  - the machines created with createvm: storage controllers and slots. `storageattach --medium none` on an empty slot
//    fails ("No storage device attached to device slot ..."), --type dvddrive creates the drive (an ISO or emptydrive),
//    startvm needs a boot disk and every medium file, showvminfo needs a registered machine (plan.modelVms);
//  - plan.failOn (a command name or a list) fails that command with plan.message, once with plan.failOnce.
// A machine never created with createvm is not modelled (the older tests drive single commands).
const fs = require('fs');
const path = require('path');
const dir = path.dirname(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(args) + '\n');
const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
const stateFile = path.join(dir, 'state.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {registry: {}, vms: {}};
const {registry, vms} = state;
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
const fail = message => { process.stderr.write(`VBoxManage: error: ${message}\n`); process.exit(1); };
const NIL = '00000000-0000-0000-0000-000000000000';
const uuid = (buffer, at) => {
  const h = x => Buffer.from(x).reverse().toString('hex'), b = buffer.subarray(at, at + 16);
  return `${h(b.subarray(0, 4))}-${h(b.subarray(4, 6))}-${h(b.subarray(6, 8))}-${b.subarray(8, 10).toString('hex')}-${b.subarray(10, 16).toString('hex')}`;
};
const header = file => {
  try { const b = fs.readFileSync(file); return b.length >= 456 && b.readUInt32LE(64) === 0xbeda107f ? {uuid: uuid(b, 392), parent: uuid(b, 424)} : null; }
  catch (_) { return null; }
};
const register = file => { const h = header(file); if (h) registry[file] = h; };
const opt = name => args[args.indexOf(name) + 1];
const [command, name] = args;
const vm = vms[name];

if (command === 'createmedium') {
  const parent = opt('--diffparent'), file = opt('--filename');
  register(parent);
  fs.writeFileSync(file, 'diff');
  if (registry[parent]) registry[file] = {uuid: `probe-${path.basename(file)}`, parent: registry[parent].uuid};
  save();
}
if (command === 'openmedium' && plan.openmediumRegisters !== false) { register(args[2]); save(); }
if (command === 'closemedium') {
  delete registry[args[2]];
  // VirtualBox forgets a base image that nothing uses.
  for (const [file, medium] of Object.entries(registry)) if (medium.parent === NIL && !Object.values(registry).some(other => other.parent === medium.uuid)) delete registry[file];
  save();
}
if (command === 'list' && args[1] === 'hdds' && !plan.listEmpty) {
  process.stdout.write(Object.entries(registry).map(([file, m]) => `UUID:           ${m.uuid}\nParent UUID:    ${m.parent}\nLocation:       ${file}\n`).join('\n'));
}
if (command === 'createvm') { vms[opt('--name')] = {ctl: {}, slots: {}, started: false}; save(); }
if (command === 'showvminfo') {
  if (plan.modelVms && !vm) fail(`Could not find a registered machine named '${name}'`);
  process.stdout.write(`VMState="${vm && vm.started ? 'running' : 'poweroff'}"\n`);
}
if (command === 'unregistervm' && vm) { delete vms[name]; save(); }
if (command === 'storagectl' && vm) { vm.ctl[opt('--name')] = true; save(); }
if (command === 'storageattach') {
  const type = opt('--type'), medium = opt('--medium'), file = medium;
  if (type === 'hdd') {
    const h = header(file);
    if (h && h.parent !== NIL && !Object.values(registry).some(m => m.uuid === h.parent)) {
      fail(`Parent medium with UUID {${h.parent}} of the medium '${file}' is not found in the media registry ('/home/orel/.config/VirtualBox/VirtualBox.xml')`);
    }
    register(file); save();
  }
  if (vm) {
    const controller = opt('--storagectl'), port = opt('--port'), device = opt('--device'), key = `${controller}|${port}|${device}`;
    if (!vm.ctl[controller]) fail(`Could not find a storage controller named '${controller}'`);
    if (medium === 'none') {
      if (!vm.slots[key]) fail(`No storage device attached to device slot ${device} on port ${port} of controller '${controller}'`);
      delete vm.slots[key];
    } else vm.slots[key] = {type, medium: medium === 'emptydrive' ? null : medium};
    save();
  }
}
if (command === 'startvm' && vm) {
  if (!vm.slots['SATA|0|0']) fail('No bootable medium');
  for (const slot of Object.values(vm.slots)) if (slot.medium && !fs.existsSync(slot.medium)) fail(`Could not open the medium '${slot.medium}'`);
  vm.started = true; save();
}
if (command === 'controlvm' && vm) { vm.started = false; save(); }
if ([].concat(plan.failOn).includes(command) && (!plan.failOnce || !fs.existsSync(path.join(dir, 'failed')))) {
  fs.writeFileSync(path.join(dir, 'failed'), '');
  process.stderr.write(`${plan.message}\n`);
  process.exit(1);
}
