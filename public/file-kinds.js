// The pure parts of the Load and Save dialogs: which kind of file a name and its bytes stand for,
// which existing flow takes it, and what the Save dialog shows. No DOM here (unit tests import it).

// 'session' (.zip) or 'topology' (.topo) from the extension, else null.
export function kindOfFileName(name) {
  const match = /\.(topo|zip)$/i.exec(String(name));
  return match ? (match[1].toLowerCase() === 'zip' ? 'session' : 'topology') : null;
}

// The text of a file whose bytes do not match the kind its name announces, or '' when they do. A
// ZIP starts with PK\x03\x04; a topology is UTF-8 text without control characters (so without NUL bytes). `bytes` is the start of the
// file for a session, the whole file for a topology.
export function contentProblem(kind, bytes) {
  if (kind === 'session') {
    return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4
      ? '' : 'This file is not a ZIP archive: it does not start with a ZIP header.';
  }
  // Text has no control character but tab, line feed and carriage return (NUL and the bytes of a ZIP header are binary).
  if (bytes.some(byte => (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f)) return 'This file is not a topology: it is binary, not text.';
  try { new TextDecoder('utf-8', {fatal: true}).decode(bytes); } catch (_) { return 'This file is not a topology: it is not UTF-8 text.'; }
  return '';
}

// "2 hosts", "1 host", "no host".
export function countPhrase(count, singular, plural = `${singular}s`) {
  return count === 0 ? `no ${singular}` : `${count} ${count === 1 ? singular : plural}`;
}

// The hosts and switches among nodes ({kind: 'host' | 'switch'}).
export function nodeCounts(nodes) {
  const counts = {hosts: 0, switches: 0};
  for (const node of nodes) { if (node.kind === 'host') counts.hosts++; else if (node.kind === 'switch') counts.switches++; }
  return counts;
}

const countsText = (hosts, switches) => `${countPhrase(hosts, 'host')} and ${countPhrase(switches, 'switch', 'switches')}`;

// The one status line of the Save dialog, the same whether the topology checkbox is ticked or not.
export function saveStatusLine(hosts, switches) {
  return hosts + switches === 0 ? 'Your current session is empty.' : `Save your current session: ${countsText(hosts, switches)}.`;
}

// The Save dialog's note on the working disks it includes: {qemu, vbox} is the number of hosts that have a
// disk of each engine (disk.qcow2, disk.vdi). Both kinds go in the ZIP when they exist.
export function workingDisksNote({qemu = 0, vbox = 0} = {}) {
  if (qemu && vbox) return 'QEMU and VirtualBox disks are both included.';
  if (qemu) return 'QEMU disks are included (no VirtualBox disk exists).';
  if (vbox) return 'VirtualBox disks are included (no QEMU disk exists).';
  return 'No working disk exists yet.';
}

// The working disks of an archive for the Load dialog: {qemu, vbox} counts of disk.qcow2 and disk.vdi files.
export function archiveDisksPhrase({qemu = 0, vbox = 0} = {}) {
  if (!qemu && !vbox) return 'no working disk';
  const parts = [qemu ? `${qemu} qcow2` : '', vbox ? `${vbox} vdi` : ''].filter(Boolean).join(', ');
  return `${countPhrase(qemu + vbox, 'working disk')} (${parts})`;
}

// The orange warning of the Load Session and Load Topology dialogs: the previous session is always closed.
// Empty for an empty session (its slot keeps its height).
export function closeWarning(hosts, switches) {
  return hosts + switches === 0 ? '' : `Your current session (${countsText(hosts, switches)}) will be closed and its working disks discarded.`;
}

// What the Close step of a load reports once the nodes are removed.
export function closedText(hosts, switches) {
  return `Closed ${countsText(hosts, switches)}`;
}

// When the previous session is removed: never when a dialog opens, and only once the file was read and checked
// (`reviewed`) and the user pressed Load (`confirmed`); nothing to remove from an empty session, and nothing is
// removed twice (a second try after a failed load finds the session empty).
export function shouldCloseSession({reviewed, confirmed, nodeCount}) {
  return reviewed === true && confirmed === true && nodeCount > 0;
}

// What a chosen file is: {kind: 'session' | 'topology'}, or {error} when the extension is not one of a topology or
// a session, or the content does not match it. `bytes` is the start of the file for a session, the whole file for a
// topology. A file of the user and an example of the server go through this same check.
export function routeFile(name, bytes) {
  const kind = kindOfFileName(name);
  if (!kind) return {error: 'Choose a .topo (topology) or .zip (session) file.'};
  const problem = contentProblem(kind, bytes);
  if (problem) return {error: `${name}: ${problem}`};
  return {kind};
}

export const kindLabel = kind => (kind === 'session' ? 'Session' : 'Topology');

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

// The label of an example in the list of the file selector: "name · Topology|Session · size".
export function exampleOptionLabel(example) {
  return `${example.name} · ${kindLabel(example.kind)} · ${formatSize(example.size)}`;
}

// What the Save dialog does for the checkbox "Save only the topology": the dialog keeps its size and its Download
// button, nothing is hidden. With it, the working disk option is disabled (with its reason), the ZIP estimate line
// is empty, and the .topo text is downloaded; otherwise the session ZIP.
export function saveChoice(topologyOnly) {
  return topologyOnly
    ? {sessionOptions: false, optionNote: 'Not used for a topology file', fileName: 'network.topo'}
    : {sessionOptions: true, optionNote: '', fileName: 'qemuweb-session.zip'};
}

// The sources of the file selector: the examples of the server, or a file of the user's computer.
export const SOURCES = ['server', 'local'];

// The source the Load Session dialog opens on: the remembered one when it can be used, else the examples when the
// server has some, else the user's files. `examples` is the list of the server (empty when none or unreachable).
export function openingSource(remembered, examples) {
  const hasExamples = Array.isArray(examples) && examples.length > 0;
  if (remembered === 'local' || !hasExamples) return 'local';
  return 'server';
}

// The "Server examples" segment of the source switch: disabled, with its hint, when the server has no example.
export function serverSourceState(examples) {
  return Array.isArray(examples) && examples.length > 0
    ? {disabled: false, hint: 'Examples of the server'}
    : {disabled: true, hint: 'No examples on the server'};
}

// The file card: the same lines for a file of the server and for a file of the user. `info` is
// {name, kind, size, description}; the kind line is "Session · 3.4 KB".
export function fileCardLines(info) {
  if (!info) return {name: 'No file chosen', meta: '', description: ''};
  return {name: info.name, meta: info.kind ? `${kindLabel(info.kind)} · ${formatSize(info.size)}` : formatSize(info.size), description: info.description || ''};
}

// The check boxes of the Load Session dialog. The previous session is always closed (shown checked and disabled);
// "Start" is always available; "Discard working disks" matters only for a session ZIP that holds working disks.
// `file` is {kind, hasDisks} or null (nothing chosen); hasDisks is true, false, or null when unknown.
export function loadOptionStates(file) {
  const discard = {disabled: true, note: ''};
  if (file?.kind === 'topology') discard.note = 'A topology has no working disk.';
  else if (file?.kind === 'session' && file.hasDisks === false) discard.note = 'This archive has no working disk.';
  else if (file?.kind === 'session') discard.disabled = false;
  return {
    closePrevious: {checked: true, disabled: true, note: 'Loading always replaces the current session.'},
    autoStart: {disabled: false},
    discard
  };
}

// The steps of a load, in order: [name, label]. A session ZIP is sent to the server and restores working disks.
export function loadStepList(kind) {
  const head = [['read', 'Read the file'], ['check', 'Check the file'], ['close', 'Close the previous session']];
  return kind === 'topology'
    ? [...head, ['create', 'Create switches and hosts'], ['start', 'Start hosts and switches']]
    : [...head, ['upload', 'Upload the file'], ['create', 'Create switches and hosts'], ['restore', 'Restore working disks'], ['start', 'Start hosts and switches']];
}

// The steps of a save, in order: [name, label]. Working disks are copied only once the hosts and switches are stopped.
export function saveStepList({topologyOnly, includeDisks}) {
  if (topologyOnly) return [['create', 'Create the topology'], ['download', 'Download the file']];
  return [...(includeDisks ? [['stop', 'Stop hosts and switches']] : []), ['create', 'Create the archive'], ['download', 'Download the file']];
}

// The refusal of a load whose working disks no longer match a rebuilt base image while "Discard working disks" is off.
// `messages` are the lines of the base image check; nothing was closed or changed.
export function staleDisksRefusal(messages) {
  return `${messages.join('\n')}\nCheck "Discard working disks" and load again. Nothing was changed.`;
}

// What the Restore step reports.
export function restoreText({hasDisks, discard}) {
  if (!hasDisks) return 'No working disk in the file';
  return discard ? 'Working disks discarded: hosts start from the current base images' : 'Working disks restored';
}
