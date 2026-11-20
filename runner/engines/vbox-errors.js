'use strict';

// Plain-English explanation of the VBoxManage failures whose cause is the machine, not QemuWeb.
// The original VBoxManage text stays in the host's Log under the explanation.
const rules = [
  [/VERR_VMX_IN_VMX_ROOT_MODE|VERR_SVM_IN_USE|used by another hypervisor|VMX root mode/i,
    'VirtualBox cannot start: another program on this machine holds the virtualization hardware (KVM). Stop every QEMU/KVM host, virtual machine of libvirt or other KVM program, then start this host again. VirtualBox and KVM cannot run at the same time.'],
  [/VERR_VM_DRIVER_VERSION_MISMATCH|VERR_VM_DRIVER_NOT_INSTALLED|driver version mismatch|kernel driver not installed|vboxdrv kernel module/i,
    'The VirtualBox kernel module is missing or does not match the installed VirtualBox: run "sudo /sbin/vboxconfig" (reboot if the kernel or VirtualBox was just updated), then start this host again.'],
  [/VERR_ACCESS_DENIED|kernel driver not accessible|not accessible to the current user|Failed to open \/dev\/vboxdrv|Permission denied.*vboxdrv/i,
    'VirtualBox cannot open /dev/vboxdrv: add yourself to the group vboxusers ("sudo usermod -aG vboxusers $USER") and log in again.'],
  [/Failed to connect to the VDE SWITCH|VDE SWITCH/i,
    'A network adapter of this host cannot connect to its VDE switch: make sure the switch is running, then start this host again.']
];

// The sentence for a failure text, or null when the cause is not known.
function explainVirtualBoxFailure(text) {
  const found = rules.find(([pattern]) => pattern.test(String(text)));
  return found ? found[1] : null;
}

// The text VBoxManage wrote (stderr first), from an execFileSync error.
function failureText(error) {
  const text = `${error.stderr || ''}${error.stdout || ''}`.trim();
  return text || String(error.message || error);
}

// The first "error:" line, without its prefix: what an unknown failure shows in the interface.
function firstErrorLine(text) {
  const line = String(text).split('\n').find(item => /error:/i.test(item)) || String(text).split('\n')[0];
  return line.replace(/^.*?error:\s*/i, '').trim();
}

module.exports = {explainVirtualBoxFailure, failureText, firstErrorLine};
