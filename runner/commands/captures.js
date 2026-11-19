'use strict';

// Traffic capture commands (runner/capture.js). Each command receives {session, runner, io} and
// the request arguments; `interface` is 'eth0'..'eth3'. The capture file never leaves the runner
// as a path: a download goes out on a protocol stream, like a session archive.
const fs = require('fs');
const {pipeline} = require('stream/promises');
const {LIMITS} = require('../../common/capture');
const {completeLength} = require('../pcap');
const {statusError} = require('./errors');

const nodeOf = (session, nodeId) => {
  const node = session.nodes.get(nodeId);
  if (!node) throw statusError('Unknown host or switch.', 404);
  return node;
};

const commands = {
  // The captures of the session (every node) or of one node, and the limits.
  'captures.list': ({session, runner}, {nodeId}) => {
    if (nodeId !== undefined) nodeOf(session, nodeId);
    return {limits: LIMITS, captures: runner.capture.list(nodeId)};
  },

  'capture.start': ({session, runner}, {nodeId, interface: name}) => runner.capture.start(nodeOf(session, nodeId), name),

  'capture.stop': ({session, runner}, {nodeId, captureId}) => runner.capture.stop(nodeOf(session, nodeId), captureId),

  'capture.delete': ({session, runner}, {nodeId, captureId}) => runner.capture.remove(nodeOf(session, nodeId), captureId),

  // Answers {stream, size, name}, then sends the file on that stream. A capture still recording is
  // cut after its last whole packet, so Wireshark never sees a half packet.
  'capture.download': ({session, runner, io}, {nodeId, captureId}) => {
    const file = runner.capture.fileOf(nodeOf(session, nodeId), captureId);
    const size = file.recording ? completeLength(file.path, file.size) : file.size;
    if (!size) throw statusError('The capture holds no data yet.', 409);
    const {id, stream} = io.outgoing();
    io.afterResponse(() => pipeline(fs.createReadStream(file.path, {start: 0, end: size - 1}), stream).catch(() => {}));
    return {stream: id, size, name: file.name};
  },

  // The live Capture view (runner/capture-live.js): liveId is chosen by the server; the text comes as
  // 'capture-live' events. `filter` is an optional tcpdump expression, validated here.
  'capture.live.start': ({session, runner}, {nodeId, captureId, liveId, filter}) => runner.captureLive.start(nodeOf(session, nodeId), {liveId, captureId, filter}),

  'capture.live.stop': ({runner}, {liveId}) => runner.captureLive.stop(liveId)
};

module.exports = {commands};
