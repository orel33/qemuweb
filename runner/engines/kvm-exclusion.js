'use strict';

// VirtualBox 7.1 and QEMU/KVM both need the processor's virtualization extensions (VT-x/AMD-V),
// which only one of them can hold at a time. The runner sees every node of every session it
// runs and refuses, before creating anything, a start that would conflict with a running host.
function runningHosts(nodes, node, matches) {
  return nodes.filter(other => other !== node && other.kind === 'host' && other.machine && matches(other));
}

function names(hosts) {
  return hosts.map(host => host.hostname || host.id).join(', ');
}

// The refusal message for starting `node` with `engine` ('vbox', or 'qemu' with KVM), or null.
function kvmExclusionError(nodes, node, engine, acceleration) {
  if (engine === 'vbox') {
    const kvm = runningHosts(nodes, node, other => other.engine.startsWith('qemu') && other.qemuAcceleration === 'kvm');
    return kvm.length ? `A VirtualBox host cannot start while QEMU hosts use KVM on this runner: stop ${names(kvm)} first.` : null;
  }
  if (engine.startsWith('qemu') && acceleration === 'kvm') {
    const vbox = runningHosts(nodes, node, other => other.engine === 'vbox');
    return vbox.length ? `A QEMU/KVM host cannot start while VirtualBox hosts run on this runner: stop ${names(vbox)} first.` : null;
  }
  return null;
}

module.exports = {kvmExclusionError};
