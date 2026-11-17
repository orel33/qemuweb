'use strict';

// The running server process, as seen by scripts and by other servers sharing runtime/:
//   runtime/server-<port>.pid      the server PID (read by scripts/stop.sh)
//   runtime/server-<port>.session  its kind ("regular", or "test" for --ephemeral),
//                                  then one live session ID per line
// Another server started on the same runtime/ never prunes a session listed in a live record.
const fs = require('fs');
const path = require('path');

const SESSION_ID = /^[0-9a-f]{16}$/;

class ServerInstance {
  constructor({runtimeRoot, port, ephemeral = false}) {
    this.runtimeRoot = runtimeRoot;
    this.sessionsDir = path.join(runtimeRoot, 'sessions');
    this.ephemeral = ephemeral;
    this.pidFile = path.join(runtimeRoot, `server-${port}.pid`);
    this.sessionFile = path.join(runtimeRoot, `server-${port}.session`);
  }

  // Writes the PID record and the list of live sessions; called at startup and whenever a
  // session is created or deleted.
  writeRecords(sessionIds) {
    fs.writeFileSync(this.pidFile, `${process.pid}\n`, {mode: 0o600});
    this.updateSessions(sessionIds);
  }

  updateSessions(sessionIds) {
    const lines = [this.ephemeral ? 'test' : 'regular', ...sessionIds];
    const temporary = `${this.sessionFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${lines.join('\n')}\n`, {mode: 0o600});
    fs.renameSync(temporary, this.sessionFile);
  }

  // Removes this process's records, leaving those of a newer server on the same port alone.
  removeRecords() {
    try {
      if (fs.readFileSync(this.pidFile, 'utf8').trim() !== String(process.pid)) return;
      fs.rmSync(this.pidFile, {force: true});
      fs.rmSync(this.sessionFile, {force: true});
    } catch (_) {}
  }

  // Map session ID -> {pid, ephemeral} for every live server sharing this runtime/.
  liveServerSessions() {
    const live = new Map();
    for (const name of fs.readdirSync(this.runtimeRoot)) {
      const match = /^server-(\d+)\.session$/.exec(name);
      if (!match) continue;
      try {
        const [kind, ...ids] = fs.readFileSync(path.join(this.runtimeRoot, name), 'utf8').trimEnd().split('\n');
        if (!['regular', 'test'].includes(kind)) continue;
        const pid = Number(fs.readFileSync(path.join(this.runtimeRoot, `server-${match[1]}.pid`), 'utf8').trim());
        if (!Number.isSafeInteger(pid) || pid <= 0) continue;
        process.kill(pid, 0);
        for (const id of ids.filter(line => SESSION_ID.test(line))) live.set(id, {pid, ephemeral: kind === 'test'});
      } catch (_) { /* Ignore stale or incomplete server records. */ }
    }
    return live;
  }

  // Removes the empty runtime sessions left by servers that are no longer running: directories with
  // nothing in them, or only an empty session.json (and meta.json). Anything else is kept.
  // `keep` lists session IDs to spare (those a runner has just reported).
  pruneEmptyRuntimeSessions({keep = []} = {}) {
    const liveSessions = this.liveServerSessions();
    for (const id of keep) if (typeof id === 'string') liveSessions.set(id, null);
    let removed = 0;
    for (const name of fs.readdirSync(this.sessionsDir)) {
      if (!SESSION_ID.test(name)) continue;
      const directory = path.join(this.sessionsDir, name);
      try {
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || Date.now() - stat.mtimeMs < 30000) continue;
        const files = fs.readdirSync(directory);
        if (liveSessions.has(name)) continue;
        if (!files.length) { fs.rmdirSync(directory); removed++; continue; }
        if (!files.includes('session.json') || files.some(file => !['session.json', 'meta.json'].includes(file))) continue;
        const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'session.json'), 'utf8'));
        if (metadata.schemaVersion !== 4) continue;
        if (!Array.isArray(metadata.hosts) || metadata.hosts.length || !Array.isArray(metadata.switches) || metadata.switches.length) continue;
        fs.rmSync(path.join(directory, 'meta.json'), {force: true});
        fs.unlinkSync(path.join(directory, 'session.json'));
        fs.rmdirSync(directory);
        removed++;
      } catch (_) { /* Preserve unexpected runtime contents. */ }
    }
    if (removed) console.log(`Removed ${removed} empty runtime session${removed === 1 ? '' : 's'}.`);
  }
}

module.exports = {ServerInstance};
