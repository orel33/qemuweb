// "Connections" panel of /admin: the live Socket.IO connections with the transport each one really
// uses (WebSocket, or the slower polling fallback), and the "Test WebSocket" button, which opens a
// test connection forced to WebSocket (then to polling if that fails) on the /ws-test namespace.
// Read-only: login, transport, connection time and kind (main or observer) are all it shows.
// api(path) and cell(content) come from admin.js; `io` is the Socket.IO client (/socket.io/socket.io.js).

const ROUND_TRIPS = 5;
const TIMEOUT_MS = 5000;
const CAUSE = 'The reverse proxy must forward Upgrade and Connection (see docs/deployment.md, "WebSocket check").';

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

export function summaryText({total, websocket, polling}) {
  if (!total) return 'No session page is connected. The Admin page itself uses no WebSocket.';
  return `${plural(total, 'connection')}: ${websocket} WebSocket, ${polling} polling`;
}

// Opens a test connection with the given transports and resolves {ms: [..]} after the echo round
// trips, or {error} (connect_error message or timeout). Never rejects.
export function probe(transports, {connect = io, rounds = ROUND_TRIPS, timeout = TIMEOUT_MS} = {}) {
  return new Promise(resolve => {
    const socket = connect('/ws-test', {transports, reconnection: false, timeout, forceNew: true});
    let finished = false;
    const finish = result => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.close();
      resolve(result);
    };
    const timer = setTimeout(() => finish({error: `no answer within ${timeout / 1000} s`}), timeout + 1000);
    socket.on('connect_error', error => finish({error: error.message || 'connection error'}));
    socket.on('disconnect', reason => finish({error: `disconnected (${reason})`}));
    socket.on('connect', async () => {
      const ms = [];
      try {
        for (let i = 0; i < rounds; i++) {
          const start = performance.now();
          await new Promise((done, fail) => {
            const failure = setTimeout(() => fail(new Error('echo timeout')), timeout);
            socket.emit('echo', i, () => { clearTimeout(failure); done(); });
          });
          ms.push(performance.now() - start);
        }
        finish({ms});
      } catch (error) { finish({error: error.message}); }
    });
  });
}

// The message shown for the outcomes of a WebSocket probe and, when it failed, a polling probe.
export function testMessage(websocket, polling) {
  if (websocket.ms) {
    const min = Math.min(...websocket.ms);
    const average = websocket.ms.reduce((a, b) => a + b, 0) / websocket.ms.length;
    return {ok: true, text: `WebSocket OK, ${Math.round(average)} ms average (min ${Math.round(min)} ms, ${plural(websocket.ms.length, 'round trip')}).`};
  }
  const failure = `WebSocket failed: ${websocket.error}. ${CAUSE}`;
  if (polling?.ms) return {ok: false, text: `${failure} Polling works: the interface runs in fallback mode.`};
  return {ok: false, text: `${failure} Polling failed too: ${polling?.error || 'not tried'}.`};
}

export function createConnectionsPanel({api, cell, elements: {body, summary, warning, status, test, result}}) {
  let refreshing = false;
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const data = await api('/connections');
      summary.textContent = summaryText(data);
      warning.hidden = !data.polling;
      body.replaceChildren(...data.items.map(item => {
        const row = document.createElement('tr');
        const transport = cell(item.transport === 'websocket' ? 'WebSocket' : 'polling');
        transport.dataset.transport = item.transport;
        row.append(cell(item.login), transport, cell(new Date(item.since).toLocaleString()), cell(item.observer ? 'observer' : item.main ? 'main' : 'console'));
        return row;
      }));
      status.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } catch (failure) { status.textContent = `Not updated: ${failure.message}`; }
    finally { refreshing = false; }
  }

  test.addEventListener('click', async () => {
    test.disabled = true;
    result.hidden = false;
    result.dataset.state = 'running';
    result.textContent = 'Testing WebSocket…';
    try {
      const websocket = await probe(['websocket']);
      let polling = null;
      if (!websocket.ms) {
        result.textContent = 'WebSocket failed, trying polling…';
        polling = await probe(['polling']);
      }
      const message = testMessage(websocket, polling);
      result.dataset.state = message.ok ? 'ok' : 'failed';
      result.textContent = message.text;
    } finally { test.disabled = false; }
  });
  return refresh;
}
