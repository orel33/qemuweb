'use strict';

// Host creation, configuration and startup CD-ROM.
const fs = require('fs');
const {entityKind} = require('../common/node-id');
const {validateLaunchSettings} = require('../common/launch-settings');
const {writeJsonAtomic} = require('../common/json-file');

function register({app, session, runner, emit}) {
  const {getNode, tempFile, setNodeHostname, removeHostnameAlias, persistHostConfiguration, hostConfiguration,
    hostConfigurationResponse, startupDirectory, imageById, readConfig, launchSettingsFor, requireSessionEngine,
    allocateName, assignNetworkInterfaces, validateNetworkInterfaces, appendLog, stateMessage, pendingRestart,
    guestIsoStatus, buildGuestIso, cleanupGuestIsoFiles} = runner;
  const {defaultStartupScript, validateBootFiles, validateStartupTemplate, normalizeScript, readStartupFiles, writeStartupFiles} = runner.media;

  app.post('/api/hosts', (req, res) => {
    try {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
          Object.keys(req.body).some(key => !['id', 'name', 'imageId', 'engine', 'interfaces', 'settings', 'guestMedia', 'startupDiskEnabled'].includes(key))) {
        throw new Error('Unknown host creation option.');
      }
      const {id, name, imageId, engine = session.engine, interfaces, settings, guestMedia, startupDiskEnabled} = req.body || {};
      entityKind(id, 'host');
      if (session.nodes.has(id)) throw new Error('Host ID already exists.');
      const image = imageById(imageId || Object.keys(readConfig().systems).find(id => id !== 'default'));
      if (!image) throw new Error('Unknown system in config.json.');
      if (!['qemu', 'vbox'].includes(engine)) throw new Error('Unknown engine.');
      requireSessionEngine(engine);
      if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length > 64 || /[\x00-\x1f\x7f]/.test(name))) throw new Error('Invalid host name (1 to 64 characters).');
      const hostname = name === undefined ? allocateName('h') : name.trim();
      if ([...session.nodes.values()].some(other => other.hostname === hostname)) throw new Error('Host name already exists.');
      const networkInterfaces = assignNetworkInterfaces({id}, validateNetworkInterfaces(interfaces, engine, false));
      const launchSettings = launchSettingsFor(image.id, settings || {});
      const validatedMedia = guestMedia === undefined ? {script: defaultStartupScript(networkInterfaces), resources: []} : validateBootFiles(guestMedia);
      if (startupDiskEnabled !== undefined && typeof startupDiskEnabled !== 'boolean') throw new Error('Invalid startup disk option.');
      const buildStartupDisk = startupDiskEnabled ?? image.startupDiskEnabled;
      if (buildStartupDisk) {
        validateStartupTemplate(validatedMedia.script, networkInterfaces, true);
      }
      const node = getNode(id, true, 'host');
      node.selectedImage = image;
      node.engine = engine;
      node.networkInterfaces = networkInterfaces;
      node.launchSettings = launchSettings;
      try {
        writeStartupFiles(startupDirectory(node), validatedMedia);
        node.guestMedia = readStartupFiles(startupDirectory(node));
        setNodeHostname(node, hostname);
        node.guestIsoAttached = buildStartupDisk;
        persistHostConfiguration(node);
        session.saveMetadata();
      } catch (error) {
        cleanupGuestIsoFiles(node);
        removeHostnameAlias(node);
        session.nodes.delete(id);
        fs.rmSync(node.runtimeDir, {recursive: true, force: true});
        throw error;
      }
      node.lastMessage = 'Host ready to start';
      emit('nodes-changed', {nodeId: id, running: false, hasLaunched: false, message: node.lastMessage});
      res.json({...hostConfigurationResponse(node), imageId: image.id});
    } catch (error) { res.status(400).json({error: error.message}); }
  });

  app.get('/api/nodes/:nodeId/config', (req, res) => {
    try {
      const node = getNode(req.params.nodeId);
      if (!node || node.kind !== 'host' || !node.selectedImage) throw new Error('Unknown host.');
      res.set('Cache-Control', 'no-store');
      res.json(hostConfigurationResponse(node));
    } catch (error) { res.status(400).json({error: error.message}); }
  });

  app.put('/api/nodes/:nodeId/config', (req, res) => {
    try {
      const node = getNode(req.params.nodeId);
      if (!node || node.kind !== 'host' || !node.selectedImage) throw new Error('Unknown host.');
      if (node.action) throw new Error('Wait for the current host action to finish.');
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid host configuration.');
      const required = ['name', 'systemId', 'engine', 'settings', 'interfaces', 'guestMedia', 'startupDiskEnabled'];
      if (Object.keys(body).some(key => !required.includes(key)) || required.some(key => !Object.hasOwn(body, key))) throw new Error('Incomplete host configuration.');
      if (body.systemId !== node.selectedImage.id || body.engine !== node.engine) throw new Error('System and engine are read-only for an existing host.');
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 64 || /[\x00-\x1f\x7f]/.test(body.name)) throw new Error('Invalid host name (1 to 64 characters).');
      const name = body.name.trim();
      if ([...session.nodes.values()].some(other => other.id !== node.id && other.hostname === name)) throw new Error('Host name already exists.');
      const settings = validateLaunchSettings(body.settings);
      const media = validateBootFiles(body.guestMedia);
      const script = normalizeScript(media.script);
      if (typeof body.startupDiskEnabled !== 'boolean') throw new Error('Invalid startup CD-ROM option.');
      const switches = validateNetworkInterfaces(body.interfaces, node.engine, false);
      const oldSwitches = node.networkInterfaces.map(nic => nic.switchId);
      const interfaces = JSON.stringify(body.interfaces) === JSON.stringify(oldSwitches)
        ? node.networkInterfaces : assignNetworkInterfaces(node, switches);
      if (body.startupDiskEnabled) validateStartupTemplate(script, interfaces, true);
      const previousName = node.hostname;
      const previousMedia = readStartupFiles(startupDirectory(node));
      const nextMedia = validateBootFiles({script, resources: media.resources});
      const mediaChanged = JSON.stringify(nextMedia) !== JSON.stringify(previousMedia);
      let mediaWritten = false;
      if (name !== previousName) setNodeHostname(node, name);
      try {
        if (mediaChanged) {
          writeStartupFiles(startupDirectory(node), nextMedia);
          mediaWritten = true;
        }
        writeJsonAtomic(tempFile(node, 'host.json'),
          hostConfiguration(node, settings, interfaces, body.startupDiskEnabled, name));
      } catch (error) {
        if (mediaWritten) writeStartupFiles(startupDirectory(node), previousMedia);
        if (name !== previousName) setNodeHostname(node, previousName);
        throw error;
      }
      node.launchSettings = settings;
      node.networkInterfaces = interfaces;
      node.guestMedia = readStartupFiles(startupDirectory(node));
      node.guestIsoAttached = body.startupDiskEnabled;
      if (mediaChanged || name !== previousName) node.guestIsoOutdated = !!node.guestIso;
      if (name !== previousName) emit('node-renamed', {nodeId: node.id, name});
      emit('nodes-changed', {nodeId: node.id, running: !!node.machine, hasLaunched: node.everStarted, pendingRestart: pendingRestart(node), message: stateMessage(node)});
      res.json(hostConfigurationResponse(node));
    } catch (error) { res.status(400).json({error: error.message}); }
  });

  app.get('/api/nodes/:nodeId/guest-media', (req, res) => {
    try {
      const node = getNode(req.params.nodeId);
      if (!node || node.kind !== 'host') throw new Error('Unknown host.');
      res.json({...readStartupFiles(startupDirectory(node)), guestCdrom: guestIsoStatus(node)});
    } catch (error) { res.status(400).json({error: error.message}); }
  });

  app.put('/api/nodes/:nodeId/guest-media', (req, res) => {
    try {
      const node = getNode(req.params.nodeId);
      if (!node || node.kind !== 'host') throw new Error('Unknown host.');
      const media = validateBootFiles(req.body);
      if (node.guestIsoAttached) validateStartupTemplate(media.script, node.networkInterfaces, true);
      writeStartupFiles(startupDirectory(node), media);
      node.guestMedia = readStartupFiles(startupDirectory(node));
      node.guestIsoOutdated = !!node.guestIso;
      appendLog(node, '# Guest startup files saved; create the CD-ROM to include these changes.');
      res.json({ok: true, files: node.guestMedia.resources.length, guestCdrom: guestIsoStatus(node)});
    } catch (error) { res.status(400).json({error: error.message}); }
  });

  app.post('/api/nodes/:nodeId/guest-cdrom', (req, res) => {
    try {
      const node = getNode(req.params.nodeId);
      if (!node || node.kind !== 'host') throw new Error('Unknown host.');
      const media = validateBootFiles(req.body);
      validateStartupTemplate(media.script, node.networkInterfaces, true);
      writeStartupFiles(startupDirectory(node), media);
      node.guestMedia = readStartupFiles(startupDirectory(node));
      const status = buildGuestIso(node);
      res.json({ok: true, guestCdrom: status});
    } catch (error) { res.status(400).json({error: error.message}); }
  });

  app.patch('/api/nodes/:nodeId/guest-cdrom', (req, res) => {
    try {
      const node = getNode(req.params.nodeId);
      if (!node || node.kind !== 'host') throw new Error('Unknown host.');
      if (typeof req.body?.attached !== 'boolean') throw new Error('Invalid CD-ROM attachment option.');
      if (req.body.attached && !guestIsoStatus(node).created) throw new Error('Create the CD-ROM before attaching it.');
      const previous = node.guestIsoAttached;
      node.guestIsoAttached = req.body.attached;
      try { persistHostConfiguration(node); }
      catch (error) { node.guestIsoAttached = previous; throw error; }
      res.json({ok: true, guestCdrom: guestIsoStatus(node)});
    } catch (error) { res.status(400).json({error: error.message}); }
  });
}

module.exports = {register};
