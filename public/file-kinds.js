// The pure parts of the Load and Save dialogs: which kind of file a name and its bytes stand for,
// which existing flow takes it, and what the Save dialog shows. No DOM here (unit tests import it).

// 'session' (.zip) or 'topology' (.topo) from the extension, else null.
export function kindOfFileName(name) {
  const match = /\.(topo|zip)$/i.exec(String(name));
  return match ? (match[1].toLowerCase() === 'zip' ? 'session' : 'topology') : null;
}

// The text of a file whose bytes do not match the kind its name announces, or '' when they do. A
// ZIP starts with PK\x03\x04; a topology is UTF-8 text without NUL bytes. `bytes` is the start of the
// file for a session, the whole file for a topology.
export function contentProblem(kind, bytes) {
  if (kind === 'session') {
    return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4
      ? '' : 'This file is not a ZIP archive: it does not start with a ZIP header.';
  }
  if (bytes.includes(0)) return 'This file is not a topology: it is binary, not text.';
  try { new TextDecoder('utf-8', {fatal: true}).decode(bytes); } catch (_) { return 'This file is not a topology: it is not UTF-8 text.'; }
  return '';
}

// The existing flow that takes a kind: the session review dialog, or the topology load dialog.
export function loadFlow(kind) {
  return kind === 'session' ? 'archive' : kind === 'topology' ? 'topology' : null;
}

// Whether a load of this kind needs an empty session (a session ZIP does, a topology does not).
export function needsEmptySession(kind) {
  return kind === 'session';
}

export const kindLabel = kind => (kind === 'session' ? 'Session' : 'Topology');

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

// What the Save dialog shows: with "Save only the topology" the working disk options, the size
// estimate and the progress are hidden and the .topo text is downloaded; otherwise the session ZIP.
export function saveChoice(topologyOnly) {
  return topologyOnly
    ? {sessionOptions: false, confirmLabel: 'Download .topo', fileName: 'network.topo'}
    : {sessionOptions: true, confirmLabel: 'Download ZIP', fileName: 'qemuweb-session.zip'};
}
