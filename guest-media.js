'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {TextDecoder} = require('util');
const {execFileSync} = require('child_process');

const LABEL = 'QWEBSTART';
const MAX_SCRIPT_BYTES = 65536;
const MAX_FILE_BYTES = 1048576;
const MAX_TOTAL_BYTES = 4194304;
const MAX_FILES = 32;

function validateResourcePath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 ||
      !/^[A-Za-z0-9._/-]+$/.test(value) || value.startsWith('/') ||
      value.endsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Resource paths must be relative ASCII paths without empty, dot or parent segments.');
  }
  if (value === 'start.sh' || value.startsWith('start.sh/')) {
    throw new Error(`${value} uses a reserved path.`);
  }
  return value;
}

function validateScript(script) {
  if (typeof script !== 'string' || Buffer.byteLength(script, 'utf8') > MAX_SCRIPT_BYTES ||
      Buffer.from(script, 'utf8').toString('utf8') !== script) {
    throw new Error('start.sh must be UTF-8 text of at most 64 KiB.');
  }
  if (script.includes('\0')) throw new Error('start.sh cannot contain NUL bytes.');
  return script;
}

function validateBootFiles(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid startup files.');
  validateScript(value.script);
  if (!Array.isArray(value.resources) || value.resources.length > MAX_FILES) {
    throw new Error(`At most ${MAX_FILES} companion files are allowed.`);
  }
  let total = Buffer.byteLength(value.script, 'utf8');
  const seen = new Set();
  const resources = value.resources.map(entry => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid companion file.');
    const filename = validateResourcePath(entry.path);
    if (seen.has(filename)) throw new Error(`Duplicate companion file: ${filename}.`);
    if ([...seen].some(other => other.startsWith(`${filename}/`) || filename.startsWith(`${other}/`))) {
      throw new Error(`Companion file conflicts with another path: ${filename}.`);
    }
    seen.add(filename);
    if (typeof entry.contentBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.contentBase64)) {
      throw new Error(`Invalid base64 content for ${filename}.`);
    }
    const content = Buffer.from(entry.contentBase64, 'base64');
    if (content.length > MAX_FILE_BYTES) throw new Error(`${filename} exceeds 1 MiB.`);
    total += content.length;
    return {path: filename, contentBase64: entry.contentBase64};
  });
  if (total > MAX_TOTAL_BYTES) throw new Error('Startup files exceed 4 MiB in total.');
  return {script: value.script, resources};
}

function checkStartupDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Startup source must be a directory, not a symlink.');
}

function readStartupFiles(directory) {
  checkStartupDirectory(directory);
  const resources = [];
  let script = '';
  let total = 0;
  let files = 0;
  function walk(folder, prefix = '') {
    for (const name of fs.readdirSync(folder).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (relative !== 'start.sh') validateResourcePath(relative);
      const absolute = path.join(folder, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Symlinks are not allowed in startup/: ${relative}.`);
      if (stat.isDirectory()) {
        if (relative === 'start.sh') throw new Error('start.sh must be a regular file.');
        walk(absolute, relative);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Only regular files are allowed in startup/: ${relative}.`);
      files += 1;
      if (files > MAX_FILES + 1) throw new Error(`At most ${MAX_FILES} companion files are allowed.`);
      if (relative === 'start.sh' && stat.size > MAX_SCRIPT_BYTES) throw new Error('start.sh must be UTF-8 text of at most 64 KiB.');
      if (relative !== 'start.sh' && stat.size > MAX_FILE_BYTES) throw new Error(`${relative} exceeds 1 MiB.`);
      total += stat.size;
      if (total > MAX_TOTAL_BYTES) throw new Error('Startup files exceed 4 MiB in total.');
      const content = fs.readFileSync(absolute);
      if (relative === 'start.sh') {
        try { script = new TextDecoder('utf-8', {fatal: true}).decode(content); }
        catch (_) { throw new Error('start.sh must be UTF-8 text of at most 64 KiB.'); }
        validateScript(script);
      } else resources.push({path: relative, contentBase64: content.toString('base64')});
    }
  }
  walk(directory);
  return validateBootFiles({script, resources});
}

function writeStartupScript(directory, script, {keepEmpty = false} = {}) {
  validateScript(script);
  checkStartupDirectory(directory);
  // Inspect the existing tree before changing the one file the Web editor owns.
  readStartupFiles(directory);
  const target = path.join(directory, 'start.sh');
  if (!script && !keepEmpty) {
    fs.rmSync(target, {force: true});
    return;
  }
  const temporary = path.join(directory, `.start-${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporary, script, {encoding: 'utf8', mode: 0o755, flag: 'wx'});
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, {force: true});
    throw error;
  }
}

function writeStartupFiles(directory, files) {
  const source = validateBootFiles(files);
  const parent = path.dirname(directory);
  const stage = fs.mkdtempSync(path.join(parent, '.startup-stage-'));
  const backup = path.join(parent, `.startup-backup-${crypto.randomBytes(8).toString('hex')}`);
  let moved = false;
  try {
    if (source.script) fs.writeFileSync(path.join(stage, 'start.sh'), source.script, {mode: 0o755});
    for (const entry of source.resources) {
      const target = path.join(stage, entry.path);
      fs.mkdirSync(path.dirname(target), {recursive: true});
      fs.writeFileSync(target, Buffer.from(entry.contentBase64, 'base64'));
    }
    readStartupFiles(stage);
    let existing = false;
    try { fs.lstatSync(directory); existing = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) {
      readStartupFiles(directory);
      fs.renameSync(directory, backup);
      moved = true;
    }
    try { fs.renameSync(stage, directory); }
    catch (error) {
      if (moved) fs.renameSync(backup, directory);
      throw error;
    }
    if (moved) fs.rmSync(backup, {recursive: true, force: true});
  } finally {
    fs.rmSync(stage, {recursive: true, force: true});
  }
}

function createGuestIso({directory, destination, genisoimage, onCommand}) {
  readStartupFiles(directory);
  const relative = path.relative(directory, destination);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Generated ISO must be outside startup/.');
  }
  fs.rmSync(destination, {force: true});
  try {
    const args = ['-quiet', '-R', '-J', '-V', LABEL, '-o', destination, directory];
    if (onCommand) onCommand(genisoimage, args);
    execFileSync(genisoimage, args, {stdio: 'pipe'});
    fs.chmodSync(destination, 0o444);
  } catch (error) {
    fs.rmSync(destination, {force: true});
    throw error;
  }
  return destination;
}

module.exports = {LABEL, validateBootFiles, readStartupFiles, writeStartupScript, writeStartupFiles, createGuestIso};
