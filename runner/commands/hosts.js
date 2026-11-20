'use strict';

// Host commands: creation, configuration and startup CD-ROM. Each command receives
// {session, runner, emit} (runner/service.js) and the request arguments; its result is the
// JSON body of the matching HTTP route.
const fs = require('fs');
const {entityKind} = require('../../common/node-id');
const {validateLaunchSettings} = require('../../common/launch-settings');
const {writeJsonAtomic} = require('../../common/json-file');

function hostNode(runner, nodeId) {
  const node = runner.getNode(nodeId);
  if (!node || node.kind !== 'host') throw new Error('Unknown host.');
  return node;
}

const commands = {
  'host.create': ({session, runner, emit}, {body}) => {
    const {getNode, setNodeHostname, removeHostnameAlias, persistHostConfiguration, hostConfigurationResponse,
      startupDirectory, imageById, readConfig, launchSettingsFor, requireSessionEngine, allocateName,
      assignNetworkInterfaces, validateNetworkInterfaces, cleanupGuestIsoFiles} = runner;
    const {defaultStartupScript, validateBootFiles, validateStartupTemplate, readStartupFiles, writeStartupFiles} = runner.media;
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(key => !['id', 'name', 'imageId', 'engine', 'interfaces', 'settings', 'guestMedia', 'startupDiskEnabled'].includes(key))) {
      throw new Error('Unknown host creation option.');
    }
    const {id, name, imageId, engine = session.engine, interfaces, settings, guestMedia, startupDiskEnabled} = body;
    entityKind(id, 'host');
    if (session.nodes.has(id)) throw new Error('Host ID already exists.');
    const image = imageById(imageId || Object.keys(readConfig().systems).find(system => system !== 'default'));
    if (!image) throw new Error('Unknown system in config.json.');
    runner.requireInstalledImage(image);
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
    if (buildStartupDisk) validateStartupTemplate(validatedMedia.script, networkInterfaces, true);
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
    return {...hostConfigurationResponse(node), imageId: image.id};
  },

  'host.config': ({runner}, {nodeId}) => {
    const node = runner.getNode(nodeId);
    if (!node || node.kind !== 'host' || !node.selectedImage) throw new Error('Unknown host.');
    return runner.hostConfigurationResponse(node);
  },

  'host.configure': ({session, runner, emit}, {nodeId, body}) => {
    const {getNode, tempFile, setNodeHostname, hostConfiguration, hostConfigurationResponse, startupDirectory,
      assignNetworkInterfaces, validateNetworkInterfaces, stateMessage, pendingRestart, serialPortsOf} = runner;
    const {validateBootFiles, validateStartupTemplate, normalizeScript, readStartupFiles, writeStartupFiles} = runner.media;
    const node = getNode(nodeId);
    if (!node || node.kind !== 'host' || !node.selectedImage) throw new Error('Unknown host.');
    if (node.action) throw new Error('Wait for the current host action to finish.');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid host configuration.');
    const required = ['name', 'systemId', 'engine', 'settings', 'interfaces', 'guestMedia', 'startupDiskEnabled'];
    if (Object.keys(body).some(key => !required.includes(key)) || required.some(key => !Object.hasOwn(body, key))) throw new Error('Incomplete host configuration.');
    if (body.systemId !== node.selectedImage.id || body.engine !== node.engine) throw new Error('System and engine are read-only for an existing host.');
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 64 || /[\x00-\x1f\x7f]/.test(body.name)) throw new Error('Invalid host name (1 to 64 characters).');
    const name = body.name.trim();
    if ([...session.nodes.values()].some(other => other.id !== node.id && other.hostname === name)) throw new Error('Host name already exists.');
    const settings = runner.limitSerialPorts(validateLaunchSettings(body.settings), node.selectedImage.id);
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
    let mediaWritten = false, written;
    if (name !== previousName) setNodeHostname(node, name);
    try {
      if (mediaChanged) {
        writeStartupFiles(startupDirectory(node), nextMedia);
        mediaWritten = true;
      }
      written = hostConfiguration(node, settings, interfaces, body.startupDiskEnabled, name);
      writeJsonAtomic(tempFile(node, 'host.json'), written);
    } catch (error) {
      if (mediaWritten) writeStartupFiles(startupDirectory(node), previousMedia);
      if (name !== previousName) setNodeHostname(node, previousName);
      throw error;
    }
    node.hostConfig = written.config;
    node.launchSettings = settings;
    node.networkInterfaces = interfaces;
    node.guestMedia = readStartupFiles(startupDirectory(node));
    node.guestIsoAttached = body.startupDiskEnabled;
    if (mediaChanged || name !== previousName) node.guestIsoOutdated = !!node.guestIso;
    if (name !== previousName) emit('node-renamed', {nodeId: node.id, name});
    emit('nodes-changed', {nodeId: node.id, running: !!node.machine, hasLaunched: node.everStarted, pendingRestart: pendingRestart(node), serialPorts: serialPortsOf(node), message: stateMessage(node)});
    return hostConfigurationResponse(node);
  },

  'host.guestMedia': ({runner}, {nodeId}) => {
    const node = hostNode(runner, nodeId);
    return {...runner.media.readStartupFiles(runner.startupDirectory(node)), guestCdrom: runner.guestIsoStatus(node)};
  },

  'host.setGuestMedia': ({runner}, {nodeId, body}) => {
    const {validateBootFiles, validateStartupTemplate, readStartupFiles, writeStartupFiles} = runner.media;
    const node = hostNode(runner, nodeId);
    const media = validateBootFiles(body);
    if (node.guestIsoAttached) validateStartupTemplate(media.script, node.networkInterfaces, true);
    writeStartupFiles(runner.startupDirectory(node), media);
    node.guestMedia = readStartupFiles(runner.startupDirectory(node));
    node.guestIsoOutdated = !!node.guestIso;
    runner.appendLog(node, '# Guest startup files saved; create the CD-ROM to include these changes.');
    return {ok: true, files: node.guestMedia.resources.length, guestCdrom: runner.guestIsoStatus(node)};
  },

  'host.buildGuestCdrom': ({runner}, {nodeId, body}) => {
    const {validateBootFiles, validateStartupTemplate, readStartupFiles, writeStartupFiles} = runner.media;
    const node = hostNode(runner, nodeId);
    const media = validateBootFiles(body);
    validateStartupTemplate(media.script, node.networkInterfaces, true);
    writeStartupFiles(runner.startupDirectory(node), media);
    node.guestMedia = readStartupFiles(runner.startupDirectory(node));
    return {ok: true, guestCdrom: runner.buildGuestIso(node)};
  },

  'host.attachGuestCdrom': ({runner}, {nodeId, attached}) => {
    const node = hostNode(runner, nodeId);
    if (typeof attached !== 'boolean') throw new Error('Invalid CD-ROM attachment option.');
    if (attached && !runner.guestIsoStatus(node).created) throw new Error('Create the CD-ROM before attaching it.');
    const previous = node.guestIsoAttached;
    node.guestIsoAttached = attached;
    try { runner.persistHostConfiguration(node); }
    catch (error) { node.guestIsoAttached = previous; throw error; }
    return {ok: true, guestCdrom: runner.guestIsoStatus(node)};
  }
};

module.exports = {commands};
