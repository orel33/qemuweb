'use strict';

// The server's examples (server/examples.js): the list, the bytes of one file for the browser's
// review, and the loading of one file from the disk of the server into the session. Loading
// feeds the file into the same runner commands as an upload (topology.load, archive.import), so
// every check of those applies (the session is placed on a runner first, and released again when
// the load created nothing). The routes take a bare file name, never a path; none writes.
const {pipeline} = require('stream/promises');
const {listExamples, openExample, ExampleError} = require('../examples');
const {importArchive} = require('./archives');

const READ_ONLY = 'Read-only observation: this action is not allowed.';

// The options of a load, passed on as the dialogs send them, each a boolean when present.
function booleans(body, names) {
  const options = {};
  for (const name of names) {
    if (body[name] === undefined) continue;
    if (typeof body[name] !== 'boolean') throw new ExampleError(`Invalid ${name} option.`, 400);
    options[name] = body[name];
  }
  return options;
}

function register({app, session, runner, examplesDir, placed, releaseAfter}) {
  const fail = (res, error) => res.status(error.status || 400).json({error: error.message});
  // An observer without the control lock reads only (the admin holding it acts as the owner).
  const refuseObserver = (req, res) => {
    if (!req.observed || req.observedControl) return false;
    res.status(403).json({error: READ_ONLY});
    return true;
  };

  app.get('/api/examples', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await listExamples(examplesDir));
  });

  // The file itself, so that the browser can show the review of a session or a topology before
  // the load, as it does for a file of the user.
  app.post('/api/examples/file', async (req, res) => {
    if (refuseObserver(req, res)) return;
    let example = null;
    try {
      example = await openExample(examplesDir, req.body?.name);
      res.set('Cache-Control', 'no-store');
      res.type('application/octet-stream').set('Content-Length', String(example.size));
      await pipeline(example.handle.createReadStream({start: 0}), res);
    } catch (error) {
      await example?.handle.close().catch(() => {});
      if (!res.headersSent) fail(res, error);
      else res.destroy();
    }
  });

  app.post('/api/examples/load', (req, res, next) => (refuseObserver(req, res) ? null : next()), async (req, res, next) => {
    // A bad name or option answers before the session is placed.
    try {
      const example = await openExample(examplesDir, req.body?.name);
      await example.handle.close();
      next();
    } catch (error) { fail(res, error); }
  }, placed, async (req, res) => {
    let example = null;
    try {
      const body = req.body || {};
      example = await openExample(examplesDir, body.name);
      if (example.kind === 'topology') {
        const options = booleans(body, ['autostart']);
        if (body.engine !== undefined && typeof body.engine !== 'string') throw new ExampleError('Invalid engine.', 400);
        const {text, handle} = example;
        example = null;
        await handle.close();
        const result = await runner.request('topology.load', {body: {text, ...(body.engine !== undefined ? {engine: body.engine} : {}), ...options}});
        await releaseAfter(req);
        res.json(result);
      } else {
        const options = booleans(body, ['autoStart', 'discardDisks']);
        const query = Object.fromEntries(Object.entries(options).map(([key, value]) => [key, String(value)]));
        const {size, handle} = example;
        example = null;
        const source = handle.createReadStream({start: 0});
        const result = await importArchive({session, runner, source, query, contentType: 'application/zip', declaredBytes: String(size)});
        await releaseAfter(req);
        res.json(result);
      }
    } catch (error) {
      await example?.handle.close().catch(() => {});
      await releaseAfter(req);
      fail(res, error);
    }
  });
}

module.exports = {register};
