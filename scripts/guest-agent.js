'use strict';

// Asks the QEMU guest agent of a RUNNING host, from the shell (scripts/guest-agent.sh). Read-only and limited
// to three commands: this file never builds a request, it only picks one of the three names that
// runner/guest-agent.js allows (queryAgent refuses anything else) and prints the reply after the SAME validation
// the runner applies (common/guest-addresses.js), so `interfaces` shows what the browser shows. The guest is
// untrusted: nothing it sends is printed as received (strings are validated or stripped of control characters).
//   scripts/guest-agent.sh [--runtime DIR] [--port PORT] [--json] [HOST] ping|info|interfaces
//     ping         ok, or the error
//     info         the agent version and the commands it reports as enabled
//     interfaces   a table NIC NAME MAC ADDRESS/PREFIX, then what the Graphic view shows per NIC
//     HOST         a node ID (h-...), a host name or a unique prefix of either; optional when exactly one host
//                  has a qga.sock. The runtime directory is the default one of the local runner of the port (default 3002),
//                  /tmp/qw-<login>/l-<port>, or --runtime DIR (the directory of a runner). Exit status: 0 ok, 1 error or no answer, 2 usage or ambiguity.
// Docs: docs/guest-agent.md.
const fs = require('fs');
const path = require('path');
const {queryAgent, ALLOWED_COMMANDS} = require('../runner/guest-agent');
const {parseGuestInterfaces, nicIndexes, matchAddresses} = require('../common/guest-addresses');
const {localRunnerRuntime, runtimeTooLong, SOCKET_LIMIT, NODE_FILES} = require('../common/runtime-dir');

const COMMANDS = {ping: 'guest-ping', info: 'guest-info', interfaces: 'guest-network-get-interfaces'};
const ATTEMPTS = 3;
const RETRY_MS = 1000;
const TIMEOUT_MS = 2000;
// Commands that must not be enabled in a QemuWeb image (scripts/prepare/resources/qemu-ga.conf blocks them).
const RISKY = ['guest-exec', 'guest-exec-status', 'guest-file-open', 'guest-file-read', 'guest-file-write', 'guest-set-user-password', 'guest-shutdown', 'guest-ssh-add-authorized-keys', 'guest-set-time'];
const USAGE = 'Usage: scripts/guest-agent.sh [--runtime DIR] [--port PORT] [--json] [HOST] ping|info|interfaces';

class CliError extends Error {
  constructor(message, status = 1) { super(message); this.status = status; }
}

// Control and bidirectional characters removed, length bounded: safe to print whatever it came from.
const clean = (text, max = 80) => String(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '').slice(0, max);

function parseArguments(argv) {
  const options = {runtime: null, port: 3002, json: false, host: null, command: null, help: false};
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => { if (i + 1 >= argv.length) throw new CliError(`${arg} needs a value.\n${USAGE}`, 2); return argv[++i]; };
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--runtime') options.runtime = path.resolve(value());
    else if (arg === '--port') {
      const text = value();
      if (!/^\d{1,5}$/.test(text) || Number(text) < 1 || Number(text) > 65535) throw new CliError(`Invalid port: ${clean(text)}\n${USAGE}`, 2);
      options.port = Number(text);
    } else if (arg.startsWith('-')) throw new CliError(`Unknown option: ${clean(arg)}\n${USAGE}`, 2);
    else words.push(arg);
  }
  if (options.help) return options;
  if (words.length < 1 || words.length > 2) throw new CliError(USAGE, 2);
  const word = words[words.length - 1];
  if (!Object.hasOwn(COMMANDS, word)) throw new CliError(`Unknown command "${clean(word)}": only ping, info and interfaces exist (the agent is read-only here).\n${USAGE}`, 2);
  options.command = word;
  options.host = words.length === 2 ? words[0] : null;
  return options;
}

const list = directory => { try { return fs.readdirSync(directory).sort(); } catch (_) { return []; } };

// The hosts of a runtime directory, as {session, id, name, nics, socket}: socket is the qga.sock path when the
// file exists and is a socket, else null (host stopped, or its system has no agent).
function discover(runtime) {
  const found = [];
  for (const session of list(path.join(runtime, 'sessions'))) {
    if (!/^[0-9a-f]{16}$/.test(session)) continue;
    for (const id of list(path.join(runtime, 'sessions', session))) {
      if (!/^h-[0-9a-f]{16}$/.test(id)) continue;
      const directory = path.join(runtime, 'sessions', session, id);
      let socket = path.join(directory, NODE_FILES.qga);
      try { if (!fs.lstatSync(socket).isSocket()) socket = null; } catch (_) { socket = null; }
      let name = '';
      let nics = [];
      try {
        const data = JSON.parse(fs.readFileSync(path.join(directory, 'host.json'), 'utf8'));
        name = typeof data.name === 'string' ? clean(data.name, 40) : '';
        nics = (data.network?.interfaces || []).map(nic => ({mac: typeof nic?.mac === 'string' ? nic.mac : ''}));
      } catch (_) { /* host.json unreadable: no name, no NIC list */ }
      found.push({session, id, name, nics, socket});
    }
  }
  return found;
}

const describeHost = entry => `${entry.id}  ${entry.name || '-'}  (session ${entry.session})`;

// The one host to ask. Exact ID or name first, then a unique prefix of either; several matches are listed and
// refused (status 2), never guessed.
function chooseHost(hosts, wanted) {
  const withSocket = hosts.filter(entry => entry.socket);
  let matches = withSocket;
  if (wanted !== null) {
    matches = withSocket.filter(entry => entry.id === wanted || entry.name === wanted);
    if (!matches.length) matches = withSocket.filter(entry => entry.id.startsWith(wanted) || (entry.name && entry.name.startsWith(wanted)));
    if (!matches.length) {
      const stopped = hosts.some(entry => entry.id.startsWith(wanted) || (entry.name && entry.name.startsWith(wanted)));
      throw new CliError(stopped
        ? `Host "${clean(wanted)}" has no qga.sock: it is not running, or its system has no guest agent.`
        : `No host "${clean(wanted)}" with a guest agent socket in this runtime directory.`);
    }
  } else if (!matches.length) throw new CliError('No running host with a guest agent socket (qga.sock) in this runtime directory.');
  if (matches.length > 1) throw new CliError(`${wanted === null ? 'Several hosts have a guest agent socket' : `"${clean(wanted)}" matches several hosts`}, name one:\n${matches.map(entry => `  ${describeHost(entry)}`).join('\n')}`, 2);
  return matches[0];
}

// The friendly message for a socket path a Unix socket cannot use (more than 107 bytes), or null.
function socketPathProblem(runtime, socket) {
  if (Buffer.byteLength(socket) <= SOCKET_LIMIT) return null;
  return runtimeTooLong(runtime) || `The socket path ${clean(socket, 200)} is longer than ${SOCKET_LIMIT} bytes: a Unix socket cannot use it. Use a shorter runtime directory (--runtime).`;
}

const retriable = error => ['ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error.code) || /connection closed/.test(error.message);

// Another client (the runner polls every 5 s) may hold the channel: refused or closed connections are retried.
async function ask(socket, command, io) {
  for (let attempt = 1; ; attempt++) {
    try { return await io.query(socket, command, {timeoutMs: io.timeoutMs}); }
    catch (error) {
      if (!retriable(error) || attempt >= ATTEMPTS) throw error;
      io.err(`The guest agent connection was refused or closed (the runner polls it every 5 s, one client at a time): retrying in ${RETRY_MS / 1000} s (attempt ${attempt + 1} of ${ATTEMPTS}).\n`);
      await io.sleep(RETRY_MS);
    }
  }
}

function table(rows) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map(row => row[column].length)));
  return rows.map(row => row.map((cell, column) => cell.padEnd(widths[column])).join('  ').trimEnd()).join('\n');
}

function showInterfaces(value, host, json) {
  const faces = parseGuestInterfaces(value);
  const indexes = nicIndexes(faces, host.nics);
  const shown = matchAddresses(faces, host.nics);
  if (json) {
    return JSON.stringify({interfaces: faces.map((face, i) => ({nic: indexes[i] >= 0 ? indexes[i] : null, ...face})), shown}, null, 2);
  }
  const rows = [['NIC', 'NAME', 'MAC', 'ADDRESS/PREFIX']];
  faces.forEach((face, i) => {
    (face.addresses.length ? face.addresses : ['-']).forEach((address, k) => {
      rows.push(k === 0 ? [indexes[i] >= 0 ? String(indexes[i]) : '-', face.name || '-', face.mac || '-', address] : ['', '', '', address]);
    });
  });
  const lines = [table(rows), '', 'The Graphic view shows:'];
  const nics = Object.keys(shown);
  if (!nics.length) lines.push('  nothing (no address on an interface of this host)');
  for (const nic of nics) lines.push(`  NIC ${nic}: ${shown[nic].join(', ')}`);
  return lines.join('\n');
}

function showInfo(value, json) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('The guest agent did not return a valid description.');
  const version = typeof value.version === 'string' && /^[A-Za-z0-9.+~:_-]{1,40}$/.test(value.version) ? value.version : null;
  const reported = Array.isArray(value.supported_commands) ? value.supported_commands.slice(0, 256) : [];
  const enabled = reported.filter(entry => entry && entry.enabled === true && typeof entry.name === 'string' && /^[a-z0-9-]{1,64}$/.test(entry.name)).map(entry => entry.name);
  const risky = enabled.filter(name => RISKY.includes(name));
  if (json) return JSON.stringify({version, enabled, risky}, null, 2);
  const lines = [`guest agent version: ${version || 'unknown'}`, `enabled commands (${enabled.length}): ${enabled.join(', ') || 'none'}`];
  if (risky.length) lines.push(`WARNING: this agent is NOT restricted, it allows ${risky.join(', ')} (rebuild the image: bash scripts/prepare.sh --system <id> --force).`);
  return lines.join('\n');
}

// io: {out, err, query, sleep, timeoutMs}; resolves the exit status.
async function run(argv, io) {
  try {
    const options = parseArguments(argv);
    if (options.help) { io.out(`${USAGE}\n`); return 0; }
    const runtime = options.runtime || localRunnerRuntime(options.port);
    const host = chooseHost(discover(runtime), options.host);
    const problem = socketPathProblem(runtime, host.socket);
    if (problem) throw new CliError(problem);
    const command = COMMANDS[options.command];
    if (!ALLOWED_COMMANDS.has(command)) throw new CliError(`Command not allowed: ${command}`, 2);
    let value;
    try { value = await ask(host.socket, command, io); }
    catch (error) {
      const reason = error.code === 'ENOENT' ? 'the socket is gone (the host stopped)'
        : error.code === 'ECONNREFUSED' ? 'nothing listens on the socket (the host is stopping, or QEMU is gone)'
          : clean(error.message);
      throw new CliError(`${describeHost(host)}: ${reason}`);
    }
    if (options.command === 'ping') io.out(options.json ? '{"ok": true}\n' : 'ok\n');
    else io.out(`${options.command === 'info' ? showInfo(value, options.json) : showInterfaces(value, host, options.json)}\n`);
    return 0;
  } catch (error) {
    io.err(`${error instanceof CliError ? error.message : clean(error.message, 300)}\n`);
    return error instanceof CliError ? error.status : 1;
  }
}

module.exports = {COMMANDS, parseArguments, discover, chooseHost, socketPathProblem, run, clean};

if (require.main === module) {
  run(process.argv.slice(2), {
    out: text => process.stdout.write(text), err: text => process.stderr.write(text), query: queryAgent,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs: TIMEOUT_MS
  }).then(status => { process.exitCode = status; });
}
