'use strict';

// The client of the sessions that are not placed on any runner yet (UXS02). Every user has one
// session from the login, implicit; it is placed on a runner (SessionManager.place) only when its
// first node is created or a topology, example or session archive is loaded, and released again
// once it is empty. Until then its handle lives on this client, one per manager, which answers
// the session's reads as an empty session would, without any runner:
//   - the session's own data (nodes, layout, captures, metrics, counts, exports) is empty;
//   - its general settings are those the server keeps for it (the engine chosen, see Session.engine);
//   - the catalog reads (catalog.systems, topology.preview, archive.check) go, without a session,
//     to the runner the session would be placed on (registry.pickRunner, nothing is placed),
//     with the session's engine: `forward(sessionId, command, args)`, given by the manager.
// Every other command (a node command, a stream) is refused: the session has no node. Console
// input is dropped and streams are refused, like on an offline runner (server/offline-runner.js).
// When the session is placed, the runner's client takes the handle over (RunnerClient.adopt), and
// this client takes it back when the session is released: routers and sockets keep the same handle.
const {RunnerClient} = require('./runner-client');
const {OfflineConnection} = require('./offline-runner');
const {LIMITS} = require('../common/capture');
const {formatTopology} = require('../common/topology');

// What an empty session answers (the runner's own answers for a session without nodes).
const EMPTY = {
  'nodes.list': () => [],
  'nodes.ids': () => [],
  'nodes.metrics': () => ({}),
  'layout.get': () => ({positions: {}}),
  'captures.list': () => ({limits: LIMITS, captures: []}),
  'session.summary': () => ({nodes: 0, hosts: 0, switches: 0, runningHosts: 0, runningSwitches: 0, reservedRamMb: 0, cpuPercent: null, active: false}),
  'topology.export': () => ({text: formatTopology({hosts: [], switches: []})}),
  'archive.estimate': (_sessionId, {includeDisks}) => ({bytes: 0, logicalBytes: 0, allocatedBytes: 0, hosts: 0, switches: 0, includeDisks, runningHosts: 0,
    hasWorkingDisks: false, format: 'qemuweb-session.zip', workingDisks: {qemu: 0, vbox: 0}}),
  'archive.export': () => { throw Object.assign(new Error('The session is empty: there is nothing to save.'), {status: 409}); },
  'nodes.stopAll': () => ({stopped: []}),
  'nodes.startAll': () => ({started: [], startErrors: []}),
  'session.delete': () => ({deleted: true})
};
const FORWARDED = new Set(['catalog.systems', 'topology.preview', 'archive.check']);
const unknownNode = () => Object.assign(new Error('Unknown host or switch.'), {status: 404});

class UnboundClient extends RunnerClient {
  // settings(sessionId): the general settings of the session (session.settings); setEngine(sessionId, body)
  // changes its engine; forward(sessionId, command, args): a catalog read on the runner the session would go to.
  constructor({settings, setEngine, forward}) {
    super(new OfflineConnection());
    this.answers = {...EMPTY, 'session.settings': (sessionId) => settings(sessionId), 'session.setEngine': (sessionId, args) => setEngine(sessionId, args.body)};
    this.forward = forward;
  }

  request(command, args = {}, sessionId = null) {
    return Promise.resolve().then(() => {
      if (FORWARDED.has(command)) return this.forward(sessionId, command, args);
      if (Object.hasOwn(this.answers, command)) return this.answers[command](sessionId, args);
      throw unknownNode();
    });
  }
}

module.exports = {UnboundClient};
