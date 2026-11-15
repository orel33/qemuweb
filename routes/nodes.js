'use strict';

// Node listing, switches, start, stop, reboot, reset, monitor, rename and deletion.
const {entityKind} = require('../common/node-id');

function register({app, session, runner, emit}) {
  const {getNode, setNodeHostname, persistSwitchConfiguration, persistHostConfiguration, stateMessage,
    startSwitch, stopSwitch, start, stop, reboot, reset, publishState, destroyNode, exitAllNodes} = runner;

  app.get('/api/nodes', (_req, res) => {
    res.json(runner.listNodes());
  });

  app.get('/api/nodes/:nodeId/options', (req, res) => {
    try { res.json(runner.previewLaunch(req.params.nodeId, req.query)); }
    catch (error) { res.status(400).json({error: error.message}); }
  });

  app.post('/api/nodes/:nodeId/start', async (req, res) => {
    try {
      const configured = getNode(req.params.nodeId);
      if (configured?.kind === 'switch') {
        await startSwitch(configured);
        return res.json({ok: true});
      }
      if (!configured || configured.kind !== 'host' || !configured.selectedImage) throw new Error('Unknown host configuration.');
      if (req.body?.engine !== configured.engine || req.body.imageId !== configured.selectedImage.id) throw new Error('Host system and engine differ from the saved configuration.');
      start(configured.id, configured.engine, configured.selectedImage.id, {
        interfaces: configured.networkInterfaces.map(nic => nic.switchId), settings: configured.launchSettings,
        startupDiskEnabled: configured.guestIsoAttached
      });
      res.json({ok: true, nodeId: configured.id, name: configured.hostname});
    } catch (error) {
      const message = error.stderr ? error.stderr.toString().trim() : error.message;
      console.error(message);
      try {
        const node = getNode(req.params.nodeId);
        if (node && node.kind === 'host') publishState(node, message);
      } catch (_) {}
      res.status(getNode(req.params.nodeId)?.kind === 'switch' ? 400 : 500).json({error: message});
    }
  });

  app.post('/api/switches', async (req, res) => {
    let node;
    try {
      const {id, name, autostart = true} = req.body || {};
      if (typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(name)) throw new Error('Switch name must be 1–32 letters, digits, underscores or hyphens.');
      entityKind(id, 'switch');
      if (session.nodes.has(id) || [...session.nodes.values()].some(s => s.kind === 'switch' && s.hostname === name)) throw new Error('Switch ID or name already exists.');
      node = getNode(id, true, 'switch');
      setNodeHostname(node, name);
      node.lastMessage = 'VDE switch ready to start';
      persistSwitchConfiguration(node);
      session.saveMetadata();
      if (autostart) await startSwitch(node);
      emit('nodes-changed', {nodeId: id, running: !!node.machine, hasLaunched: node.everStarted, message: stateMessage(node)});
      res.json({id, name, running: !!node.machine, message: stateMessage(node)});
    } catch (error) {
      if (node) {
        try { await destroyNode(node); }
        catch (cleanupError) { console.error('Cannot clean up failed switch:', cleanupError); }
      }
      res.status(node ? 500 : 400).json({error: error.message});
    }
  });

  app.post('/api/nodes/:nodeId/stop', async (req, res) => {
    const target = getNode(req.params.nodeId);
    if (target?.kind === 'switch') {
      try { await stopSwitch(target); res.json({ok: true}); }
      catch (error) { res.status(400).json({error: error.message}); }
      return;
    }
    try {
      if (target && target.action) throw new Error('An action is already in progress for this host.');
      await stop(target);
      res.json({ok: true});
    }
    catch (error) {
      console.error(error);
      try { const node = getNode(req.params.nodeId); if (node) publishState(node, error.message); } catch (_) {}
      res.status(500).json({error: error.message});
    }
  });

  app.post('/api/nodes/:nodeId/reboot', async (req, res) => {
    try { await reboot(getNode(req.params.nodeId)); res.json({ok: true}); }
    catch (error) { res.status(500).json({error: error.message}); }
  });

  app.post('/api/nodes/:nodeId/reset', async (req, res) => {
    try { await reset(getNode(req.params.nodeId)); res.json({ok: true}); }
    catch (error) { res.status(500).json({error: error.message}); }
  });


  app.post('/api/nodes/:nodeId/monitor', async (req, res) => {
    try {
      const output = await runner.monitor(req.params.nodeId, req.body && req.body.command);
      res.json({ok: true, output});
    } catch (error) { res.status(400).json({error: error.message}); }
  });

  app.patch('/api/nodes/:nodeId', (req, res) => {
    try {
      const node = getNode(req.params.nodeId);
      const name = req.body && req.body.name;
      if (!node || node.kind !== 'host') throw new Error('Unknown host.');
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 64 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Invalid name (1 to 64 characters).');
      if ([...session.nodes.values()].some(other => other.id !== node.id && other.hostname === name.trim())) throw new Error('Host name already exists.');
      const previous = node.hostname;
      setNodeHostname(node, name.trim());
      try { persistHostConfiguration(node); }
      catch (error) { setNodeHostname(node, previous); throw error; }
      emit('node-renamed', {nodeId: node.id, name: node.hostname});
      res.json({name: node.hostname});
    } catch (error) { res.status(400).json({error: error.message}); }
  });

  app.delete('/api/nodes', async (_req, res) => {
    try { res.json({removed: await exitAllNodes()}); }
    catch (error) { res.status(500).json({error: error.message}); }
  });

  app.delete('/api/nodes/:nodeId', async (req, res) => {
    try {
      const node = getNode(req.params.nodeId);
      await destroyNode(node);
      emit('nodes-removed', {ids: [req.params.nodeId]});
      res.json({ok: true});
    } catch (error) { res.status(500).json({error: error.message}); }
  });
}

module.exports = {register};
