'use strict';

// The runner: every session it executes, multiplexed by session ID, behind one command
// dispatcher. Reached by the control plane only through the protocol (runner/endpoint.js).
//   handle(command, sessionId, args, io)  runs one command; io gives the archive streams
//                                         (incoming, outgoing, afterResponse)
//   input(sessionId, nodeId, data)        console input
//   hello()                               capabilities, runtimeRoot, limits and the sessions (ID, owner,
//                                         creation date, nodes)
//   capabilities()                        engines, kvm, cpus, memory, images and config warnings
// Commands outside any session: runner.shutdown (stops every session) and runner.status (read-only
// process view of the runner and its sessions for /admin, runner/runner-status.js).
//   setConsoleFlow(paused)                pauses console sources while the connection is congested
//   stopCaptureLives()                    ends every live capture view (the control connection closed)
//   events                                'event' (sessionId, event, payload)
// Session IDs come from the control plane (session.create); the runner never invents one.
// A few commands also run without a session (DRAFT_COMMANDS): the control plane asks them for a
// session that is not placed on any runner yet (server/unbound-runner.js), with the session's
// engine as argument; they read the system catalog only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const {EventEmitter} = require('events');
const {readCatalog} = require('../common/system-config');
const {PROTOCOL_VERSION} = require('../common/runner-protocol');
const {Session, SESSION_ID} = require('./session');
const {createSessionRunner, createDraftPreview} = require('./session-runner');
const {knownImageIdentity, fileSha256Async} = require('./media/image-hash');
const {createCatalog} = require('./catalog');
const {configWarnings} = require('./config-warnings');
const {availableEngines} = require('./preflight');
const {statusError} = require('./commands/errors');
const {LOGIN_PATTERN} = require('../common/login');
const {linkUserAlias, unlinkUserAlias} = require('./runtime-tidy');
const {createRunnerStatus} = require('./runner-status');

const NODE_ID = /^[hs]-[0-9a-f]{8}$/;
const RUNNER_EVENTS = ['state', 'log', 'logs-reset', 'serial', 'serial-reset', 'nodes-removed', 'captures', 'capture-live', 'guest-info'];
const COMMANDS = Object.assign({}, ...['nodes', 'hosts', 'settings', 'topology', 'archives', 'consoles', 'captures', 'layout']
  .map(name => require(`./commands/${name}`).commands));
// Commands that answer for an unknown node themselves: the launch preview describes host
// drafts that do not exist yet, and consoles have their own messages.
const OWN_NODE_CHECK = new Set(['node.preview', 'console.attach', 'console.resize', 'console.clear']);
// Commands that answer without a session, on the catalog of this runner (see draftContext).
const DRAFT_COMMANDS = new Set(['catalog.systems', 'topology.preview', 'archive.check', 'node.preview']);

// `requireImages`: remote runner, see runner/context.js.
// `limits`: {maxSessions, memoryBytes, cpus} from the runner file of a remote runner, or null. They
// only lower what hello announces: the control plane places no more sessions than maxSessions.
function createRunnerService({commands, root, runtimeRoot, configPath, limits = null, requireImages = false}) {
  const sessions = new Map();
  const events = new EventEmitter();
  const flow = {paused: false};
  const hostNodes = () => [...sessions.values()].flatMap(entry => [...entry.session.nodes.values()]);
  const engines = availableEngines(commands);
  const runnerStatus = createRunnerStatus();

  function entryOf(sessionId) {
    const entry = typeof sessionId === 'string' && sessions.get(sessionId);
    if (!entry) throw statusError('Unknown session.', 404);
    return entry;
  }

  // The engine a session is created with, or a draft command runs with: the one asked when this
  // runner has it, else the first engine this runner has (QEMU when it has it).
  function engineOf(engine) {
    if (engine === undefined || engine === null) return engines[0];
    if (!['qemu', 'vbox'].includes(engine)) throw new Error('Invalid session engine.');
    if (!engines.includes(engine)) throw new Error(`${engine === 'vbox' ? 'VirtualBox' : 'QEMU'} is unavailable on this runner.`);
    return engine;
  }

  function createSession({sessionId, owner = null, createdAt, engine}) {
    if (!SESSION_ID.test(sessionId || '')) throw new Error('Invalid session ID.');
    if (sessions.has(sessionId)) throw statusError('Session already exists.', 409);
    if (owner !== null && (typeof owner !== 'string' || !LOGIN_PATTERN.test(owner))) throw new Error('Invalid session owner.');
    const session = new Session({runtimeRoot, id: sessionId, engine: engineOf(engine), owner,
      ...(typeof createdAt === 'string' ? {createdAt} : {})});
    // 32-bit IDs: a directory left with this ID (not loaded) is refused too; the control plane then drops its session.
    if (fs.existsSync(session.runtimeDir)) throw statusError('Session already exists.', 409);
    fs.mkdirSync(path.dirname(session.runtimeDir), {recursive: true});
    fs.mkdirSync(session.runtimeDir);
    session.saveMetadata();
    session.saveMeta();
    if (owner) linkUserAlias(runtimeRoot, owner, sessionId);
    const runner = createSessionRunner({session, commands, root, runtimeRoot, configPath, hostNodes, flow, requireImages});
    const emit = (event, payload) => events.emit('event', sessionId, event, payload);
    for (const event of RUNNER_EVENTS) runner.events.on(event, payload => emit(event, payload));
    sessions.set(sessionId, {session, runner, emit});
    runner.startResourceSampling();
    return {sessionId};
  }

  // Stops and removes every node of the session, then its directory. With ifEmpty, only a session
  // without any node is deleted ({deleted: false} otherwise): the control plane releases an empty
  // session this way without racing a node being created meanwhile.
  async function deleteSession(sessionId, {ifEmpty = false} = {}) {
    const {session, runner} = entryOf(sessionId);
    if (ifEmpty === true && session.nodes.size) return {deleted: false};
    await runner.shutdown();
    if (session.nodes.size) {
      runner.startResourceSampling();
      throw statusError('Some nodes could not be deleted; see the server log.', 409);
    }
    sessions.delete(sessionId);
    runner.events.removeAllListeners();
    fs.rmSync(session.runtimeDir, {recursive: true, force: true});
    if (session.owner) unlinkUserAlias(runtimeRoot, session.owner, sessionId);
    return {deleted: true};
  }

  // Every session: stops every node and removes the empty session directories (SIGTERM, or the
  // loss of the control connection of a runner started with --exit-on-disconnect).
  async function shutdown() {
    await Promise.all([...sessions.values()].map(async ({session, runner}) => {
      try { await runner.shutdown(); }
      catch (error) { console.error(`Session ${session.id} shutdown:`, error); }
      session.removeIfEmpty();
      if (session.owner && !fs.existsSync(session.runtimeDir)) unlinkUserAlias(runtimeRoot, session.owner, session.id);
      runner.events.removeAllListeners();
    }));
    sessions.clear();
    return {ok: true};
  }

  // The context of a draft command: an empty session with the given engine, and the catalog of
  // this runner. Nothing is created on disk. draftSessionId (node.preview only) is the ID of the unplaced
  // session, so that the preview shows the paths its first host will have.
  function draftContext(engine, draftSessionId) {
    const session = draftSessionId === undefined ? {id: null, engine: engineOf(engine), nodes: new Map()}
      : new Session({runtimeRoot, id: draftSessionId, engine: engineOf(engine)});
    const catalog = createCatalog({session, root, configPath, requireImages, availableEngines: engines});
    const preview = draftSessionId === undefined ? {}
      : {previewLaunch: createDraftPreview({session, commands, root, runtimeRoot, configPath, requireImages})};
    return {session, runner: {...catalog, ...preview, availableEngines: engines, fileSha256Async,
      systemOffered: id => !requireImages || catalog.imageInstalled(id)}};
  }

  async function handle(command, sessionId, args = {}, io = null) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid runner command arguments.');
    if (command === 'session.create') return createSession({...args, sessionId});
    if (command === 'session.delete') return deleteSession(sessionId, args);
    if (command === 'runner.shutdown') return shutdown();
    if (command === 'runner.status') return runnerStatus.status([...sessions.values()].map(entry => entry.session));
    const handler = Object.hasOwn(COMMANDS, command) && COMMANDS[command];
    if (!handler) throw new Error(`Unknown runner command: ${String(command).slice(0, 64)}.`);
    if ((sessionId === null || sessionId === undefined) && DRAFT_COMMANDS.has(command)) {
      const {engine, draftSessionId, ...rest} = args;
      if (command === 'node.preview' && draftSessionId === undefined) throw statusError('Unknown session.', 404);
      return handler({...draftContext(engine, draftSessionId), commands, emit: () => {}, io}, rest);
    }
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

  // The control connection is gone: no live capture view has a reader any more.
  function stopCaptureLives() {
    for (const {runner} of sessions.values()) runner.captureLive.stopNode();
  }

  let lastCatalog = {images: {}, warnings: []};
  let loggedCatalogError = null;

  // What this runner can do, announced in hello: no image is hashed here (only known digests).
  function capabilities() {
    let kvm = true;
    try { fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK); } catch (_) { kvm = false; }
    let images = {};
    let warnings = [];
    let catalogError = null;
    try {
      const catalog = readCatalog(configPath);
      warnings = configWarnings({catalog, root, engines, kvm, cpus: os.cpus().length, memoryBytes: os.totalmem()});
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
      lastCatalog = {images, warnings};
      loggedCatalogError = null;
    } catch (error) {
      // The caller sees the error (startup refuses it); a running runner keeps the last good catalog and logs each new error once.
      catalogError = error.message;
      ({images, warnings} = lastCatalog);
      if (loggedCatalogError !== catalogError) console.error(`Cannot read the system catalog: ${catalogError}`);
      loggedCatalogError = catalogError;
    }
    return {engines, kvm, cpus: os.cpus().length, memoryBytes: os.totalmem(), images, warnings, catalogError};
  }

  function hello() {
    const {catalogError, ...announced} = capabilities();
    if (limits?.cpus) announced.cpus = Math.min(announced.cpus, limits.cpus);
    if (limits?.memoryBytes) announced.memoryBytes = Math.min(announced.memoryBytes, limits.memoryBytes);
    return {type: 'hello', protocol: PROTOCOL_VERSION, pid: process.pid, runtimeRoot, ...announced, ...(limits?.maxSessions ? {limits: {maxSessions: limits.maxSessions}} : {}),
      sessions: [...sessions.values()].map(({session, runner}) => ({sessionId: session.id, engine: session.engine,
        owner: session.owner, createdAt: session.createdAt, nodes: runner.listNodes()}))};
  }

  return {events, handle, input, hello, capabilities, shutdown, setConsoleFlow, stopCaptureLives, availableEngines: engines};
}

module.exports = {createRunnerService};
