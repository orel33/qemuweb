'use strict';

// The runner: every session it executes, multiplexed by session ID, behind one command
// dispatcher. Reached by the control plane only through the protocol (runner/endpoint.js).
//   handle(command, sessionId, args, io)  runs one command; io gives the archive streams
//                                         (incoming, outgoing, afterResponse)
//   input(sessionId, nodeId, data)        console input
//   hello()                               capabilities and the sessions with their nodes
//   setConsoleFlow(paused)                pauses console sources while the connection is congested
//   events                                'event' (sessionId, event, payload)
// Session IDs come from the control plane (session.create); the runner never invents one.
const fs = require('fs');
const os = require('os');
const path = require('path');
const {EventEmitter} = require('events');
const {readCatalog} = require('../common/system-config');
const {PROTOCOL_VERSION} = require('../common/runner-protocol');
const {Session, SESSION_ID} = require('./session');
const {createSessionRunner} = require('./session-runner');
const {knownImageIdentity} = require('./media/image-hash');
const {statusError} = require('./commands/errors');

const NODE_ID = /^[hs]-[0-9a-f]{16}$/;
const RUNNER_EVENTS = ['state', 'log', 'logs-reset', 'serial', 'serial-reset', 'nodes-removed'];
const COMMANDS = Object.assign({}, ...['nodes', 'hosts', 'settings', 'topology', 'archives', 'consoles']
  .map(name => require(`./commands/${name}`).commands));
// Commands that answer for an unknown node themselves: the launch preview describes host
// drafts that do not exist yet, and consoles have their own messages.
const OWN_NODE_CHECK = new Set(['node.preview', 'console.attach', 'console.resize', 'console.clear']);

function createRunnerService({commands, root, runtimeRoot, configPath}) {
  const sessions = new Map();
  const events = new EventEmitter();
  const flow = {paused: false};
  const hostNodes = () => [...sessions.values()].flatMap(entry => [...entry.session.nodes.values()]);
  const availableEngines = commands.VBOXMANAGE ? ['qemu', 'vbox'] : ['qemu'];

  function entryOf(sessionId) {
    const entry = typeof sessionId === 'string' && sessions.get(sessionId);
    if (!entry) throw statusError('Unknown session.', 404);
    return entry;
  }

  function createSession({sessionId, owner = null, createdAt}) {
    if (!SESSION_ID.test(sessionId || '')) throw new Error('Invalid session ID.');
    if (sessions.has(sessionId)) throw statusError('Session already exists.', 409);
    const session = new Session({runtimeRoot, id: sessionId, owner: typeof owner === 'string' ? owner : null,
      ...(typeof createdAt === 'string' ? {createdAt} : {})});
    fs.mkdirSync(path.dirname(session.runtimeDir), {recursive: true});
    fs.mkdirSync(session.runtimeDir);
    session.saveMetadata();
    session.saveMeta();
    const runner = createSessionRunner({session, commands, root, runtimeRoot, configPath, hostNodes, flow});
    const emit = (event, payload) => events.emit('event', sessionId, event, payload);
    for (const event of RUNNER_EVENTS) runner.events.on(event, payload => emit(event, payload));
    sessions.set(sessionId, {session, runner, emit});
    runner.startResourceSampling();
    return {sessionId};
  }

  // Stops and removes every node of the session, then its directory.
  async function deleteSession(sessionId) {
    const {session, runner} = entryOf(sessionId);
    await runner.shutdown();
    if (session.nodes.size) {
      runner.startResourceSampling();
      throw statusError('Some nodes could not be deleted; see the server log.', 409);
    }
    sessions.delete(sessionId);
    runner.events.removeAllListeners();
    fs.rmSync(session.runtimeDir, {recursive: true, force: true});
    return {deleted: true};
  }

  // Every session: stops every node and removes the empty session directories (server stop,
  // or the loss of the control connection of a local runner).
  async function shutdown() {
    await Promise.all([...sessions.values()].map(async ({session, runner}) => {
      try { await runner.shutdown(); }
      catch (error) { console.error(`Session ${session.id} shutdown:`, error); }
      session.removeIfEmpty();
      runner.events.removeAllListeners();
    }));
    sessions.clear();
    return {ok: true};
  }

  async function handle(command, sessionId, args = {}, io = null) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid runner command arguments.');
    if (command === 'session.create') return createSession({...args, sessionId});
    if (command === 'session.delete') return deleteSession(sessionId);
    if (command === 'runner.shutdown') return shutdown();
    const handler = Object.hasOwn(COMMANDS, command) && COMMANDS[command];
    if (!handler) throw new Error(`Unknown runner command: ${String(command).slice(0, 64)}.`);
    const {session, runner, emit} = entryOf(sessionId);
    // A well-formed node ID that is not in this session is unknown (404).
    if (typeof args.nodeId === 'string' && NODE_ID.test(args.nodeId) && !session.nodes.has(args.nodeId) && !OWN_NODE_CHECK.has(command)) {
      throw statusError('Unknown host or switch.', 404);
    }
    return handler({session, runner, commands, emit, io}, args);
  }

  // Console input from a browser: the guest serial socket of the console (a console ID), or
  // the VDE terminal of a switch.
  function input(sessionId, consoleId, data) {
    const entry = typeof sessionId === 'string' && sessions.get(sessionId);
    const target = entry && typeof consoleId === 'string' && entry.runner.resolveConsole(consoleId);
    if (!target || typeof data !== 'string' || data.length > 4096) return;
    entry.runner.writeConsoleInput(target.node, data, target.channel);
  }

  function setConsoleFlow(paused) {
    if (flow.paused === paused) return;
    flow.paused = paused;
    for (const {runner} of sessions.values()) runner.setConsoleFlow(paused);
  }

  // What this runner can do, announced in hello: no image is hashed here (only known digests).
  function capabilities() {
    let kvm = true;
    try { fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK); } catch (_) { kvm = false; }
    const images = {};
    try {
      const catalog = readCatalog(configPath);
      for (const [system, profiles] of Object.entries(catalog.systems)) {
        if (system === 'default') continue;
        const entry = {};
        for (const [format, engine] of [['raw', 'qemu'], ['vdi', 'vbox']]) {
          const file = profiles[engine]?.image;
          const identity = typeof file === 'string' && knownImageIdentity(path.resolve(root, file));
          if (identity) entry[format] = identity;
        }
        images[system] = entry;
      }
    } catch (error) { console.error(`Cannot read the system catalog: ${error.message}`); }
    return {engines: availableEngines, kvm, cpus: os.cpus().length, memoryBytes: os.totalmem(), images};
  }

  function hello() {
    return {type: 'hello', protocol: PROTOCOL_VERSION, pid: process.pid, ...capabilities(),
      sessions: [...sessions.values()].map(({session, runner}) => ({sessionId: session.id, engine: session.engine, nodes: runner.listNodes()}))};
  }

  return {events, handle, input, hello, shutdown, setConsoleFlow, availableEngines};
}

module.exports = {createRunnerService};
