// The live area of the Capture dialog: the packets of the capture being recorded, as text while
// they arrive, like tcpdump would print them. A read-only text area keeps the last lines; it is
// not a terminal. The text comes from the runner through the page's session socket
// (server/capture-live.js); nothing is stored, and the view ends when the capture stops, the
// dialog closes or the socket closes.
import {emitOnSession} from './socket.js';

const MAX_LINES = 2000;
const area = document.getElementById('capture-live');
let view = {lines: [], partial: ''};
// The view last asked for: {nodeId, captureId, filter}. It stays set after the view ended by
// itself, so that the dialog does not ask again for the same view.
let requested = null;
let painting = false;

// The text kept after `text` arrived: whole lines (at most `max`, the oldest dropped) and the
// unfinished last line, which waits for its end.
export function appendLiveText(state, text, max = MAX_LINES) {
  const parts = (state.partial + text.replace(/\r/g, '')).split('\n');
  const partial = parts.pop();
  const lines = state.lines.concat(parts);
  return {lines: lines.length > max ? lines.slice(lines.length - max) : lines, partial};
}

// Draws at most once per frame; the area follows the end of the text unless the person scrolled up.
function paint() {
  if (painting) return;
  painting = true;
  requestAnimationFrame(() => {
    painting = false;
    const follow = area.scrollTop + area.clientHeight >= area.scrollHeight - 8;
    area.textContent = view.lines.concat(view.partial).join('\n');
    if (follow) area.scrollTop = area.scrollHeight;
  });
}

const write = text => { view = appendLiveText(view, text); paint(); };
// A line of the dialog itself, in brackets, apart from the packets.
export const addLiveNote = text => write(`[${text}]\n`);

export function clearLive() {
  view = {lines: [], partial: ''};
  paint();
}

// Shows the packets of capture `captureId` of host `nodeId`; the same view asked again does nothing.
export function startLive(nodeId, captureId, filter) {
  if (requested && requested.nodeId === nodeId && requested.captureId === captureId && requested.filter === filter) return;
  stopLive();
  const mine = {nodeId, captureId, filter};
  requested = mine;
  clearLive();
  addLiveNote(`Live view of ${captureId}${filter ? ` · filter: ${filter}` : ''}`);
  emitOnSession('capture-live', mine, result => { if (requested === mine && result?.error) addLiveNote(result.error); });
}

// Ends the view; the runner kills its tcpdump. The text stays on screen.
export function stopLive() {
  if (!requested) return;
  requested = null;
  emitOnSession('capture-live-stop');
}

// Socket events (public/socket.js).
export function receiveLiveData({data}) { if (requested && typeof data === 'string') write(data); }
export function receiveLiveEnd({message}) { if (requested) addLiveNote(message); }
export function liveConnectionLost() {
  if (!requested) return;
  requested = null;
  addLiveNote('Connection lost: live view ended.');
}
