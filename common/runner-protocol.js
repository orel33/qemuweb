'use strict';

// Runner protocol framing, shared by the control plane (server/runner-client.js) and the runner
// (runner/endpoint.js). See "Runner interface" in docs/architecture.md.
//
// A frame is a uint32 BE length (of what follows), a type byte, then the payload:
//   'J' (0x4a)  one JSON message (UTF-8)
//   'B' (0x42)  a binary stream chunk: uint32 BE stream ID, then the bytes
// Streams carry archives. Each direction has its own stream IDs, chosen by the sender of
// the data. The sender keeps at most STREAM_WINDOW unacknowledged bytes per stream; the
// receiver grants credit as its consumer reads. Stream control messages:
//   sender -> receiver   {type: 'stream', id, op: 'end'} | {..., op: 'error', message}
//   receiver -> sender   {type: 'stream', id, op: 'credit', bytes} | {..., op: 'cancel', message}
// A cancel ends the sender's stream (its producer sees an error); a late frame for a finished
// stream is ignored. Streams never emit an unhandled 'error': a failure reaches whoever pipes
// or listens to the stream.
const {EventEmitter} = require('events');
const {Readable, Writable} = require('stream');

const PROTOCOL_VERSION = 1;
const MAX_FRAME = 16 * 1024 * 1024;
const MAX_CHUNK = 1024 * 1024;
const STREAM_WINDOW = 4 * 1024 * 1024;
// Incoming streams whose data arrived before anyone claimed them (see Connection.incoming).
const MAX_UNCLAIMED_STREAMS = 16;
// Finished incoming stream IDs remembered, so that late frames for them are ignored.
const FINISHED_MEMORY = 1024;
const JSON_FRAME = 0x4a;
const CHUNK_FRAME = 0x42;

function encodeJson(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length + 1 > MAX_FRAME) throw new Error('Runner message too large.');
  const frame = Buffer.allocUnsafe(5 + body.length);
  frame.writeUInt32BE(body.length + 1, 0);
  frame[4] = JSON_FRAME;
  body.copy(frame, 5);
  return frame;
}

function encodeChunk(streamId, data) {
  if (data.length > MAX_CHUNK) throw new Error('Runner stream chunk too large.');
  const frame = Buffer.allocUnsafe(9 + data.length);
  frame.writeUInt32BE(data.length + 5, 0);
  frame[4] = CHUNK_FRAME;
  frame.writeUInt32BE(streamId, 5);
  data.copy(frame, 9);
  return frame;
}

// Splits a byte stream into frames: push(buffer) returns the complete frames,
// {json: object} or {streamId, data}. Throws on a malformed or oversized frame.
class FrameDecoder {
  constructor() { this.buffer = Buffer.alloc(0); }

  push(data) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
    const frames = [];
    let offset = 0;
    while (this.buffer.length - offset >= 4) {
      const length = this.buffer.readUInt32BE(offset);
      if (length < 1 || length > MAX_FRAME) throw new Error('Invalid runner frame length.');
      if (this.buffer.length - offset - 4 < length) break;
      const type = this.buffer[offset + 4];
      const body = this.buffer.subarray(offset + 5, offset + 4 + length);
      offset += 4 + length;
      if (type === JSON_FRAME) {
        const json = JSON.parse(body.toString('utf8'));
        if (!json || typeof json !== 'object' || Array.isArray(json) || typeof json.type !== 'string') throw new Error('Invalid runner message.');
        frames.push({json});
      } else if (type === CHUNK_FRAME && body.length >= 4 && body.length - 4 <= MAX_CHUNK) {
        frames.push({streamId: body.readUInt32BE(0), data: Buffer.from(body.subarray(4))});
      } else throw new Error('Invalid runner frame type.');
    }
    this.buffer = offset === this.buffer.length ? Buffer.alloc(0) : this.buffer.subarray(offset);
    return frames;
  }
}

const validStreamId = id => Number.isInteger(id) && id > 0 && id <= 0xffffffff;

// One protocol connection over a duplex byte stream (a Unix socket, or an in-memory pair in
// tests). Emits 'message' (a JSON message other than stream control), 'drain' when the
// write buffer empties, and 'close' (error or null) once. Streams:
//   outgoing()        a new Writable whose data goes to the peer; returns {id, stream}
//   incoming(id)      the Readable of the peer's stream `id` (it may already hold data)
class Connection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.decoder = new FrameDecoder();
    this.closed = false;
    this.nextStreamId = 1;
    this.outgoingStreams = new Map();
    this.incomingStreams = new Map();
    this.finished = new Set();
    socket.on('data', data => {
      if (this.closed) return;
      let frames;
      try { frames = this.decoder.push(data); }
      catch (error) { this.close(error); return; }
      for (const frame of frames) {
        if (this.closed) return;
        try { this.receive(frame); }
        catch (error) { this.close(error); return; }
      }
    });
    socket.on('drain', () => this.emit('drain'));
    socket.on('error', error => this.close(error));
    socket.on('close', () => this.close(null));
    socket.on('end', () => this.close(null));
  }

  // Bytes waiting in the write buffer: the runner pauses console sources above a limit.
  get pendingBytes() { return this.socket.writableLength || 0; }

  send(message) {
    if (this.closed) return false;
    return this.socket.write(encodeJson(message));
  }

  close(error = null) {
    if (this.closed) return;
    this.closed = true;
    const lost = error || new Error('Runner connection lost.');
    for (const entry of this.outgoingStreams.values()) entry.stream.destroy(lost);
    for (const entry of this.incomingStreams.values()) entry.stream.destroy(lost);
    this.outgoingStreams.clear();
    this.incomingStreams.clear();
    try { this.socket.destroy(); } catch (_) {}
    this.emit('close', error);
  }

  receive(frame) {
    if (frame.json) {
      if (frame.json.type === 'stream') this.streamControl(frame.json);
      else this.emit('message', frame.json);
      return;
    }
    if (this.finished.has(frame.streamId)) return;
    const entry = this.incomingEntry(frame.streamId);
    if (entry.ended || entry.stream.destroyed) return;
    entry.received += frame.data.length;
    if (entry.received - entry.credited > STREAM_WINDOW) throw new Error('Runner stream exceeded its window.');
    entry.stream.push(frame.data);
  }

  // Stream control from the peer. A message for a stream that is already finished (a late
  // credit, end or error after a cancel) is ignored.
  streamControl({id, op, bytes, message}) {
    if (!validStreamId(id)) throw new Error('Invalid runner stream ID.');
    if (op === 'credit' || op === 'cancel') {
      const entry = this.outgoingStreams.get(id);
      if (!entry) return;
      if (op === 'cancel') {
        entry.cancelled = true;
        entry.stream.destroy(new Error(String(message || 'Stream cancelled.')));
        return;
      }
      if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('Invalid runner stream credit.');
      entry.inFlight = Math.max(0, entry.inFlight - bytes);
      const waiting = entry.waiting;
      entry.waiting = null;
      if (waiting) waiting();
    } else if (op === 'end' || op === 'error') {
      if (this.finished.has(id)) return;
      const entry = this.incomingEntry(id);
      if (entry.ended || entry.stream.destroyed) return;
      entry.ended = true;
      if (op === 'end') entry.stream.push(null);
      else entry.stream.destroy(new Error(String(message || 'Stream failed.')));
      if (entry.claimed) this.finish(id);
    } else throw new Error('Invalid runner stream operation.');
  }

  // Forgets an incoming stream: later frames for it are ignored.
  finish(id) {
    this.incomingStreams.delete(id);
    this.finished.add(id);
    if (this.finished.size > FINISHED_MEMORY) this.finished.delete(this.finished.values().next().value);
  }

  // The entry of an incoming stream, created on its first frame or when claimed, whichever
  // comes first. An entry stays until it is claimed and over, so that a stream sent in full
  // before the consumer claims it is not lost.
  incomingEntry(id) {
    if (!validStreamId(id)) throw new Error('Invalid runner stream ID.');
    let entry = this.incomingStreams.get(id);
    if (entry) return entry;
    if ([...this.incomingStreams.values()].filter(item => !item.claimed).length >= MAX_UNCLAIMED_STREAMS) throw new Error('Too many unclaimed runner streams.');
    entry = {received: 0, credited: 0, claimed: false, ended: false, stream: null};
    entry.stream = new Readable({
      highWaterMark: MAX_CHUNK,
      read: () => {
        const bytes = entry.received - entry.credited;
        if (bytes > 0 && !this.closed && !entry.ended) {
          entry.credited = entry.received;
          this.send({type: 'stream', id, op: 'credit', bytes});
        }
      },
      destroy: (error, callback) => {
        // The consumer gave up before the end: the sender is told to stop.
        if (!entry.ended && !this.closed) this.send({type: 'stream', id, op: 'cancel', message: error ? error.message : 'Stream cancelled.'});
        entry.ended = true;
        if (this.incomingStreams.get(id) === entry) this.finish(id);
        callback(error);
      }
    });
    // Errors reach the consumer through its pipeline or its own listener; an unconsumed
    // stream must not crash the process.
    entry.stream.on('error', () => {});
    this.incomingStreams.set(id, entry);
    return entry;
  }

  // The Readable of the peer's stream `id` (it may already hold data, or be over).
  incoming(id) {
    if (this.finished.has(id)) {
      const gone = new Readable({read() {}});
      gone.on('error', () => {});
      gone.destroy(new Error('Runner stream already closed.'));
      return gone;
    }
    const entry = this.incomingEntry(id);
    entry.claimed = true;
    if (entry.ended) this.finish(id);
    return entry.stream;
  }

  outgoing() {
    const id = this.nextStreamId++;
    const entry = {inFlight: 0, waiting: null, cancelled: false, stream: null};
    const sendPiece = (piece, callback) => {
      if (this.closed) return callback(new Error('Runner connection lost.'));
      if (entry.inFlight + piece.length > STREAM_WINDOW) {
        entry.waiting = () => sendPiece(piece, callback);
        return;
      }
      entry.inFlight += piece.length;
      this.socket.write(encodeChunk(id, piece));
      callback();
    };
    entry.stream = new Writable({
      highWaterMark: MAX_CHUNK,
      write: (chunk, _encoding, callback) => {
        const pieces = [];
        for (let offset = 0; offset < chunk.length; offset += MAX_CHUNK) pieces.push(chunk.subarray(offset, offset + MAX_CHUNK));
        const next = error => (error || !pieces.length ? callback(error) : sendPiece(pieces.shift(), next));
        next();
      },
      final: callback => {
        this.outgoingStreams.delete(id);
        this.send({type: 'stream', id, op: 'end'});
        callback();
      },
      destroy: (error, callback) => {
        if (this.outgoingStreams.get(id) === entry) {
          this.outgoingStreams.delete(id);
          // A stream the receiver cancelled needs no answer; any other failure is reported.
          if (!entry.cancelled && !this.closed) this.send({type: 'stream', id, op: 'error', message: error ? error.message : 'Stream aborted.'});
        }
        callback(error);
      }
    });
    // Same as incoming streams: errors are the producer's business, never an uncaught event.
    entry.stream.on('error', () => {});
    this.outgoingStreams.set(id, entry);
    return {id, stream: entry.stream};
  }
}

module.exports = {PROTOCOL_VERSION, MAX_FRAME, MAX_CHUNK, STREAM_WINDOW, encodeJson, encodeChunk, FrameDecoder, Connection};
