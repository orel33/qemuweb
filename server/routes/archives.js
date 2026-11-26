'use strict';

// Session ZIP archive: size estimate, export, base image check and import. The ZIP travels
// between the browser and the runner as a protocol stream (runner/commands/archives.js);
// nothing is written by the control plane. An import places the session on a runner first, and
// releases it again when it created nothing.
const {pipeline} = require('stream/promises');

// The downloaded file name (the runner's archive.estimate reports the same format name). The
// admin holding the control lock of a session saves it under the owner's name.
const ARCHIVE_NAME = 'qemuweb-session.zip';
const archiveName = (req, owner) => (req.observedControl ? `qemuweb-session-${owner}.zip` : ARCHIVE_NAME);

function register({app, session, runner, handle, placed, lifecycle}) {
  app.get('/api/session-archive/estimate', handle('archive.estimate', req => ({includeDisks: req.query.includeDisks === 'true'}), 400, {noStore: true}));
  app.post('/api/session-archive/check', handle('archive.check', req => ({body: req.body}), 400, {noStore: true}));

  app.post('/api/session-archive/export', async (req, res) => {
    session.archiveBusy = true;
    try {
      const {stream, size} = await runner.request('archive.export', {includeDisks: req.body?.includeDisks});
      const download = runner.incoming(stream);
      res.set('Cache-Control', 'no-store');
      res.attachment(archiveName(req, session.owner));
      res.set('Content-Length', String(size));
      await pipeline(download, res).catch(error => {
        if (!res.headersSent) res.status(500).json({error: error.message});
        else res.destroy();
      });
    } catch (error) {
      res.status(error.status || 400).json({error: error.message});
    } finally { session.archiveBusy = false; }
  });

  app.post('/api/session-archive/import', placed, async (req, res) => {
    let result, failure = null;
    try {
      result = await importArchive({session, runner, source: req, query: req.query,
        contentType: req.headers['content-type'], declaredBytes: req.headers['content-length']});
    } catch (error) { failure = error; }
    await lifecycle.release();
    if (failure) res.status(failure.status || 400).json({error: failure.message});
    else res.json(result);
  });
}

// Sends a ZIP to the runner's archive.import and answers its result. `source` is a Readable: the
// HTTP upload, or a file of the server's examples (server/routes/examples.js); both go through
// the same runner command and its checks. The upload goes to the runner as it arrives. When the
// runner refuses it (its stream is cancelled), the rest of the source is read and discarded so
// that an HTTP connection stays usable for the error response.
async function importArchive({session, runner, source, query, contentType, declaredBytes}) {
  session.archiveBusy = true;
  const {id, stream} = runner.outgoing();
  const discard = () => { source.unpipe(stream); source.resume(); };
  stream.on('error', discard);
  source.on('error', error => stream.destroy(error));
  source.pipe(stream);
  try {
    return await runner.request('archive.import', {stream: id, query, contentType, declaredBytes});
  } catch (error) {
    discard();
    if (!stream.destroyed) stream.destroy();
    throw error;
  } finally {
    session.archiveBusy = false;
  }
}

module.exports = {register, importArchive};
