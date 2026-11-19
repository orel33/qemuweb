'use strict';

// Traffic capture: list, start, stop, delete and download (runner/commands/captures.js). Only
// the owner of the session and an administrator holding its control lock (the gate marks the request
// req.observedControl) may use these routes: any other observer gets 403, even for the list and
// the download (the observation gate lets a GET through; this is checked here). The
// PCAP never touches the server's disk: it goes from the runner to the browser as a protocol
// stream, like a session archive.
const {Transform} = require('stream');
const {pipeline} = require('stream/promises');
const {LIMITS, isCaptureId, interfaceIndex} = require('../../common/capture');

// A burst can overshoot the size limit between two looks of the runner's watcher.
const MAX_DOWNLOAD = LIMITS.maxBytes + 64 * 1024 * 1024;

function ownerOnly(req, res, next) {
  if (req.observed && !req.observedControl) return res.status(403).json({error: 'Read-only observation: captures are not available.'});
  next();
}

function register({app, runner, handle}) {
  const base = '/api/nodes/:nodeId/captures';
  // Malformed IDs never reach the runner.
  const validCapture = (req, res, next) => (isCaptureId(req.params.captureId) ? next() : res.status(404).json({error: 'Unknown capture.'}));
  const target = req => ({nodeId: req.params.nodeId, captureId: req.params.captureId});

  app.get('/api/captures', ownerOnly, handle('captures.list', () => ({}), 500, {noStore: true}));
  app.get(base, ownerOnly, handle('captures.list', req => ({nodeId: req.params.nodeId}), 500, {noStore: true}));
  app.post(base, ownerOnly, (req, res, next) => (interfaceIndex(req.body?.interface) === null && typeof req.body?.interface !== 'number'
    ? res.status(400).json({error: 'Unknown interface; use eth0 to eth3.'}) : next()),
  handle('capture.start', req => ({nodeId: req.params.nodeId, interface: req.body.interface}), 500));
  app.post(`${base}/:captureId/stop`, ownerOnly, validCapture, handle('capture.stop', target, 500));
  app.delete(`${base}/:captureId`, ownerOnly, validCapture, handle('capture.delete', target, 500));

  app.get(`${base}/:captureId/download`, ownerOnly, validCapture, async (req, res) => {
    let download;
    try {
      const {stream, size, name} = await runner.request('capture.download', target(req));
      download = runner.incoming(stream);
      if (!Number.isSafeInteger(size) || size > MAX_DOWNLOAD) {
        download.destroy();
        return res.status(413).json({error: 'The capture is too large to download.'});
      }
      let sent = 0;
      const limit = new Transform({transform(chunk, _encoding, callback) {
        sent += chunk.length;
        callback(sent > size ? new Error('The runner sent more than announced.') : null, chunk);
      }});
      res.attachment(name);
      res.set({'Cache-Control': 'no-store', 'Content-Type': 'application/vnd.tcpdump.pcap', 'Content-Length': String(size)});
      await pipeline(download, limit, res);
    } catch (error) {
      if (!res.headersSent) res.status(error.status || 500).json({error: error.message});
      else res.destroy();
    }
  });
}

module.exports = {register, MAX_DOWNLOAD};
