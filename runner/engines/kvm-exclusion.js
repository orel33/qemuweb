'use strict';

// VirtualBox 7.1 and QEMU/KVM both need the processor's virtualization extensions (VT-x/AMD-V),
// which only one of them can hold at a time. The runner sees every session it runs and refuses,
// before creating anything, a start that would conflict with a running host.
//
// What a user reads (the refusal, the host's Log, the interface) names only hosts of the user's
// OWN session and never tells that another session exists. The detailed text, with every host
// involved, is for the runner's own journal (`diagnostics`), which only the administrator reads.
const BUSY = 'The virtualization hardware (KVM) of this runner is busy: try again later.';

function running(nodes, node, matches) {
  return [...nodes].filter(other => other !== node && other.kind === 'host' && other.machine && matches(other));
}

function names(hosts) {
  return hosts.map(host => host.hostname || host.id).join(', ');
}

// {message, diagnostics} for starting `node` with `engine` ('vbox', or 'qemu' with KVM), or null.
// `ownNodes` are the nodes of the session of `node`, `allNodes` those of every session.
function kvmExclusion(allNodes, ownNodes, node, engine, acceleration) {
  let matches, own, foreign, refusal;
  if (engine === 'vbox') {
    matches = other => other.engine.startsWith('qemu') && other.qemuAcceleration === 'kvm';
    refusal = hosts => `VirtualBox cannot start while your QEMU hosts use KVM: stop ${names(hosts)} first`;
  } else if (engine.startsWith('qemu') && acceleration === 'kvm') {
    matches = other => other.engine === 'vbox';
    refusal = hosts => `A QEMU/KVM host cannot start while your VirtualBox hosts are running: stop ${names(hosts)} first`;
  } else return null;
  const conflicts = running(allNodes, node, matches);
  if (!conflicts.length) return null;
  const mine = new Set(ownNodes);
  own = conflicts.filter(host => mine.has(host));
  foreign = conflicts.filter(host => !mine.has(host));
  const message = !own.length ? BUSY : foreign.length ? `${refusal(own)}, or try again later.` : `${refusal(own)}.`;
  return {message, diagnostics: `start of ${node.hostname || node.id} (${engine}) refused: own hosts [${names(own)}], hosts of other sessions [${names(foreign)}]`};
}

module.exports = {kvmExclusion, BUSY};
