// The live Capture view of a console pane: the packets of one capture of the pane's host as text,
// while they arrive, like tcpdump would print them. A bar above the terminal chooses the capture,
// takes an optional tcpdump filter expression and starts or stops the view. The text comes from
// the runner through the pane's socket (server/capture-live.js); nothing is stored here, and the
// view ends when the pane leaves it, changes node, or the socket closes.
import {machines} from './state.js';
import {canCapture, capturesOf, formatBytes, isRecording, onCapturesChanged} from './captures.js';
import {fitTerminal, panes, syncConsoleScroll} from './terminal.js';

// The same limit as common/capture.js FILTER_MAX; the server and the runner check it again.
const FILTER_MAX = 200;
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const say = (pane, text, style = DIM) => pane.terminal.write(`${style}${text}${RESET}\r\n`, () => { pane.terminal.scrollToBottom(); syncConsoleScroll(pane); });

function buildBar(pane) {
  const bar = document.createElement('div');
  bar.className = 'capture-live-bar';
  bar.hidden = true;
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Capture to show');
  const filter = document.createElement('input');
  filter.type = 'text';
  filter.maxLength = FILTER_MAX;
  filter.spellcheck = false;
  filter.autocomplete = 'off';
  filter.placeholder = 'Filter, e.g. icmp or host 10.0.0.2 (optional)';
  filter.setAttribute('aria-label', 'Filter: a tcpdump expression');
  const button = document.createElement('button');
  button.type = 'button';
  bar.append(select, filter, button);
  pane.element.querySelector('.terminal-frame').before(bar);
  // Typing in the filter must not move the pane focus logic of the terminal.
  bar.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Enter' && event.target === filter) toggle(pane); });
  button.addEventListener('click', () => toggle(pane));
  pane.live = {bar, select, filter, button, running: false};
  pane.socket.on('capture-live-data', ({data}) => { if (pane.live.running && typeof data === 'string') pane.terminal.write(data, () => syncConsoleScroll(pane)); });
  pane.socket.on('capture-live-end', ({message}) => { if (pane.live.running) { finished(pane); say(pane, `[${message}]`); } });
  pane.socket.on('disconnect', () => { if (pane.live.running) { finished(pane); say(pane, '[Connection lost: live view ended.]'); } });
  return pane.live;
}

function finished(pane) {
  pane.live.running = false;
  refreshBar(pane);
}

function refreshBar(pane) {
  const live = pane.live;
  if (!live) return;
  const nodeId = pane.machineId;
  const captures = nodeId ? capturesOf(nodeId) : [];
  const chosen = live.select.value;
  live.select.replaceChildren(...captures.map(capture => {
    const option = document.createElement('option');
    option.value = capture.id;
    option.textContent = `${capture.interface} · ${capture.file} · ${capture.message} · ${formatBytes(capture.bytes)}`;
    return option;
  }));
  const recording = captures.filter(isRecording);
  live.select.value = captures.some(capture => capture.id === chosen) ? chosen : (recording.at(-1) || captures.at(-1))?.id ?? '';
  live.select.disabled = live.running || !captures.length;
  live.filter.disabled = live.running;
  live.button.textContent = live.running ? 'Stop' : 'Start';
  live.button.disabled = !live.running && (!live.select.value || !canCapture());
  live.button.title = live.running ? 'Stop the live view (the capture goes on)' : captures.length ? 'Show the packets of this capture' : 'No capture yet';
}

function toggle(pane) {
  const live = pane.live;
  if (live.running) { stopLive(pane); say(pane, '[Live view stopped.]'); return; }
  const captureId = live.select.value;
  const filter = live.filter.value.trim();
  if (!captureId || !pane.machineId) return;
  pane.terminal.reset();
  say(pane, `Capture ${captureId}${filter ? ` · filter: ${filter}` : ''}`);
  live.running = true;
  refreshBar(pane);
  pane.socket.emit('capture-live', {nodeId: pane.machineId, captureId, filter}, result => {
    if (result?.error) { finished(pane); say(pane, result.error, RED); }
  });
}

function stopLive(pane) {
  if (!pane.live?.running) return;
  pane.socket.emit('capture-live-stop');
  finished(pane);
}

// The pane shows the Capture view (terminals.js setPaneView).
export function showCaptureView(pane) {
  const live = pane.live || buildBar(pane);
  live.bar.hidden = false;
  pane.replayGeneration++;
  pane.replayPending = '';
  pane.replaying = false;
  pane.terminal.reset();
  const machine = pane.machineId && machines.get(pane.machineId);
  say(pane, `Live capture of ${machine?.hostname || 'this host'}: choose a capture, add an optional filter, then Start.`);
  say(pane, 'Both directions of the interface are shown; the packet times are QEMU\'s clock. A stopped capture is shown from its start.');
  refreshBar(pane);
  requestAnimationFrame(() => fitTerminal(pane));
}

// The pane leaves the Capture view or changes node: the live view ends, its tcpdump with it.
export function leaveCaptureView(pane) {
  if (!pane.live) return;
  stopLive(pane);
  pane.live.bar.hidden = true;
  requestAnimationFrame(() => fitTerminal(pane));
}

onCapturesChanged(() => { for (const pane of panes) if (pane.view === 'capture') refreshBar(pane); });
