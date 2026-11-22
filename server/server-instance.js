'use strict';

// The running server process, as seen by scripts/stop.sh: <runtime>/server-<port>.pid holds the server PID. It is the
// only file the server keeps in its runtime directory (the runner's files belong to the runner, docs/runner-model.md R1).
const fs = require('fs');
const path = require('path');

class ServerInstance {
  constructor({runtimeRoot, port}) {
    this.pidFile = path.join(runtimeRoot, `server-${port}.pid`);
  }

  writeRecords() {
    fs.writeFileSync(this.pidFile, `${process.pid}\n`, {mode: 0o600});
  }

  // Removes this process's record, leaving that of a newer server on the same port alone.
  removeRecords() {
    try {
      if (fs.readFileSync(this.pidFile, 'utf8').trim() === String(process.pid)) fs.rmSync(this.pidFile, {force: true});
    } catch (_) {}
  }
}

module.exports = {ServerInstance};
