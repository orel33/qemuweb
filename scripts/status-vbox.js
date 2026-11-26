'use strict';

// VirtualBox hosts for scripts/status.js. A VirtualBox VM is not a child of the runner:
// `VBoxManage startvm` hands it to the VirtualBox daemon, which starts a detached
//   VBoxHeadless --comment <vm name> --startvm <uuid> ...
// The VM name is built by the runner (runner/session-runtime.js): qemuweb-<runner pid>-<session id>-<node id>.
// That name ties a process to its runner, its session and its node; a VM with another name
// (one of the user's own) is never shown. Pure functions, no I/O except readVirtualBoxMemory.
const path = require('path');
const {serverRuntime, localRunnerRuntime} = require('../common/runtime-dir');

const VM_NAME = /^qemuweb-(\d+)-([0-9a-f]{8})-(h-[0-9a-f]{8})$/;

// {name, uuid, runnerPid, sessionId, nodeId} for the command line of a QemuWeb VBoxHeadless, else null.
function parseVBoxHeadless(args) {
  const words = String(args).split(' ');
  if (path.basename(words[0]) !== 'VBoxHeadless') return null;
  const name = words[words.indexOf('--comment') + 1] || '';
  const uuid = words[words.indexOf('--startvm') + 1] || '';
  const match = words.includes('--comment') && VM_NAME.exec(name);
  if (!match) return null;
  return {name, uuid, runnerPid: Number(match[1]), sessionId: match[2], nodeId: match[3]};
}

// The VirtualBox host processes of one runner, among every process of the machine.
function vboxProcessesOf(entries, runnerPid) {
  return [...entries].filter(entry => entry.vbox && entry.vbox.runnerPid === runnerPid);
}

// The runtime directory a server or a runner works in, from its command line: --runtime, else the default of its kind
// (common/runtime-dir.js): /tmp/qw-<login>/<port> for a server (--listen, 3002), /tmp/qw-<login>/l-<port> for a local runner (--port, 3002).
// A remote runner (`runner/main.js run`) without --runtime takes the name from its runner file: not known here, null.
function runtimeOfProcess(args) {
  const runtime = / --runtime (\S+)/.exec(args)?.[1];
  if (runtime) return runtime;
  if (/(^| )(\S*\/)?runner\/main\.js( |$)/.test(args)) {
    if (/runner\/main\.js (run|register)( |$)/.test(args)) return null;
    return localRunnerRuntime(/ --port (\d+)( |$)/.exec(args)?.[1] || '3002');
  }
  return serverRuntime(/ --listen (\d+)( |$)/.exec(args)?.[1] || '3002');
}

// The sessions directory of a runner, or null when its directory is unknown.
const runnerSessionsDir = args => {
  const runtime = runtimeOfProcess(args);
  return runtime ? path.join(runtime, 'sessions') : null;
};

// "memory=512" of `VBoxManage showvminfo --machinereadable`, in MB, or null.
function memoryFromShowVmInfo(text) {
  const match = /^memory=(\d+)$/m.exec(String(text));
  return match ? Number(match[1]) : null;
}

// The memory given to a host, in MB: QEMU's -m, or the VirtualBox VM's configured memory.
function hostMemoryMb(entry) {
  if (entry.vbox) return entry.vbox.memoryMb ?? null;
  const match = /(?:^| )-m (\d+)(?: |$)/.exec(entry.args);
  return match ? Number(match[1]) : null;
}

// The engine tag of a host line: "host (qemu)" or "host (vbox)".
const hostTag = entry => (entry.vbox ? 'host (vbox)' : 'host (qemu)');

// Reads (once per VM) the configured memory of a VM, read-only. `run(uuid)` returns the text of
// showvminfo and throws when VBoxManage is unavailable.
const memoryCache = new Map();
function readVirtualBoxMemory(uuid, run) {
  if (!memoryCache.has(uuid)) {
    let memory = null;
    try { memory = memoryFromShowVmInfo(run(uuid)); } catch (_) { /* VBoxManage unavailable */ }
    memoryCache.set(uuid, memory);
  }
  return memoryCache.get(uuid);
}

module.exports = {parseVBoxHeadless, vboxProcessesOf, runtimeOfProcess, runnerSessionsDir, memoryFromShowVmInfo, hostMemoryMb, hostTag, readVirtualBoxMemory};
