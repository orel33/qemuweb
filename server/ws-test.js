'use strict';

// Namespace /ws-test, for the "Test WebSocket" button of /admin: the administrator's browser opens a
// connection here (WebSocket only, then polling only) and measures echo round trips. Administrators
// only, authenticated like every other namespace (auth.socketMiddleware, then the account is
// re-read with currentUser). It creates no session, no main socket and no state.
const WS_TEST_NAMESPACE = '/ws-test';
const MAX_ECHO = 1024;

function attachWsTest(io, {socketMiddleware, currentUser}) {
  const namespace = io.of(WS_TEST_NAMESPACE);
  namespace.use(socketMiddleware);
  namespace.use((socket, next) => {
    const {login, via} = socket.data.user;
    if (socket.data.user.role === 'admin' && currentUser(login, via)?.role === 'admin') return next();
    next(new Error('Administrator role required.'));
  });
  namespace.on('connection', socket => {
    // Echoes the payload through the acknowledgement (a small string or number, nothing else).
    socket.on('echo', (payload, acknowledge) => {
      if (typeof acknowledge !== 'function') return;
      acknowledge(typeof payload === 'string' && payload.length <= MAX_ECHO || typeof payload === 'number' ? payload : null);
    });
  });
  return namespace;
}

module.exports = {attachWsTest, WS_TEST_NAMESPACE};
