// The dialog shown when a host cannot start (Play, Resume all, Reboot): the cause in a modal
// dialog, in addition to the host's Log and state line. One dialog per user action, even with
// several failures; identical sentences are listed once with the hosts they concern.

// What the dialog shows for failures [{host, message}]: a title and the text.
export function startFailureContent(failures) {
  const groups = new Map();
  for (const {host, message} of failures) {
    const text = String(message ?? '').trim() || 'The host did not start.';
    if (!groups.has(text)) groups.set(text, []);
    if (host && !groups.get(text).includes(host)) groups.get(text).push(host);
  }
  const entries = [...groups];
  if (entries.length === 1 && entries[0][1].length <= 1) {
    return {title: `Cannot start ${entries[0][1][0] || 'host'}`, text: entries[0][0]};
  }
  return {title: 'Cannot start some hosts', text: entries.map(([text, hosts]) => (hosts.length ? `${hosts.join(', ')}: ${text}` : text)).join('\n\n')};
}

// The failures of the "name: message" lines a runner answers to Resume all.
export function parseStartErrors(lines) {
  return lines.map(line => {
    const index = String(line).indexOf(': ');
    return index > 0 ? {host: line.slice(0, index), message: line.slice(index + 2)} : {host: '', message: String(line)};
  });
}

const dialog = document.getElementById('start-failure-dialog');
const title = document.getElementById('start-failure-title');
const message = document.getElementById('start-failure-message');
let shown = [];
let returnFocus = null;

// Opens the dialog, or adds to it when it is already open (no stacking). textContent only.
export function showStartFailure(failures) {
  if (!failures.length) return;
  if (!dialog.open) { shown = []; returnFocus = document.activeElement; }
  shown = [...shown, ...failures];
  const content = startFailureContent(shown);
  title.textContent = content.title;
  message.textContent = content.text;
  if (!dialog.open) dialog.showModal();
}

dialog.addEventListener('close', () => {
  shown = [];
  if (returnFocus && returnFocus.isConnected && !returnFocus.disabled) returnFocus.focus();
  returnFocus = null;
});
