'use strict';

// Session ZIP archive: size estimate, export, base image check and import. The ZIP travels
// between the browser and the runner as a protocol stream (runner/commands/archives.js);
// nothing is written by the control plane.
const {pipeline} = require('stream/promises');

// The downloaded file name (the runner's archive.estimate reports the same format name).
const ARCHIVE_NAME = 'qemuweb-session-v4.zip';

function register({app, session, runner, handle}) {
  app.get('/api/session-archive/estimate', handle('archive.estimate', req => ({includeDisks: req.query.includeDisks === 'true'}), 400, {noStore: true}));
  app.post('/api/session-archive/check', handle('archive.check', req => ({body: req.body}), 400, {noStore: true}));

  app.post('/api/session-archive/export', async (req, res) => {
    session.archiveBusy = true;
    try {
      const {stream, size} = await runner.request('archive.export', {includeDisks: req.body?.includeDisks});
      const download = runner.incoming(stream);
      res.set('Cache-Control', 'no-store');
      res.attachment(ARCHIVE_NAME);
      res.set('Content-Length', String(size));
      await pipeline(download, res).catch(error => {
        if (!res.headersSent) res.status(500).json({error: error.message});
        else res.destroy();
      });
    } catch (error) {
      res.status(error.status || 400).json({error: error.message});
    } finally { session.archiveBusy = false; }
  });

  app.post('/api/session-archive/import', async (req, res) => {
    session.archiveBusy = true;
    const {id, stream} = runner.outgoing();
    // The upload goes to the runner as it arrives. When the runner refuses it (its stream is
    // cancelled), the rest of the request body is read and discarded so that the HTTP
    // connection stays usable for the error response.
    const discard = () => { req.unpipe(stream); req.resume(); };
    stream.on('error', discard);
    req.on('error', error => stream.destroy(error));
    req.pipe(stream);
    try {
      res.json(await runner.request('archive.import', {stream: id, query: req.query,
        contentType: req.headers['content-type'], declaredBytes: req.headers['content-length']}));
    } catch (error) {
      res.status(error.status || 400).json({error: error.message});
      discard();
      if (!stream.destroyed) stream.destroy();
    } finally {
      session.archiveBusy = false;
    }
  });
}

module.exports = {register};
