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

// The existing flow that takes a kind: the session review dialog, or the topology load dialog.
export function loadFlow(kind) {
  return kind === 'session' ? 'archive' : kind === 'topology' ? 'topology' : null;
}

// Whether loading a file of this kind first needs the user's confirmation to remove what the session holds: a
// session ZIP replaces the session, so it does when the session is not empty; a topology is added to it and never does.
export function needsReplaceConfirmation(kind, nodeCount) {
  return kind === 'session' && nodeCount > 0;
}

// "2 hosts", "1 host", "no host".
export function countPhrase(count, singular, plural = `${singular}s`) {
  return count === 0 ? `no ${singular}` : `${count} ${count === 1 ? singular : plural}`;
}

// The text of the confirmation shown before a session replaces the current one.
export function replaceMessage(hosts, switches) {
  return `Your current session has ${countPhrase(hosts, 'host')} and ${countPhrase(switches, 'switch', 'switches')}. Loading a session replaces it: they will be stopped and removed (working disks included) before the new session is loaded. To keep a copy, cancel and use Save first.`;
}

// The label of an example in the dropdown: "name · Topology|Session · size".
export function exampleOptionLabel(example) {
  return `${example.name} · ${kindLabel(example.kind)} · ${formatSize(example.size)}`;
}

// Whether Load example is enabled: an example of the list is chosen (not the placeholder).
export function canLoadExample(value, examples) {
  return typeof value === 'string' && value !== '' && examples.some(example => example.name === value);
}

export const kindLabel = kind => (kind === 'session' ? 'Session' : 'Topology');

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

// What the Save dialog does for the checkbox "Save only the topology": the dialog keeps its size, so nothing
// is hidden. With it, the working disk option is disabled (with its reason) and the estimate line says there is
// no disk, and the .topo text is downloaded; otherwise the session ZIP.
export function saveChoice(topologyOnly) {
  return topologyOnly
    ? {sessionOptions: false, estimate: 'Topology file: no disks', optionNote: 'Not used for a topology file', confirmLabel: 'Download topology', fileName: 'network.topo'}
    : {sessionOptions: true, estimate: null, optionNote: '', confirmLabel: 'Download ZIP', fileName: 'qemuweb-session.zip'};
}
