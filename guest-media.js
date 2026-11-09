'use strict';

const fs = require('fs');
const path = require('path');
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
  if (['start.sh', '.qemuweb-media'].some(reserved => value === reserved || value.startsWith(`${reserved}/`))) {
    throw new Error(`${value} uses a reserved path.`);
  }
  return value;
}

function validateBootFiles(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid startup files.');
  if (typeof value.script !== 'string' || Buffer.byteLength(value.script, 'utf8') > MAX_SCRIPT_BYTES) {
    throw new Error('start.sh must be UTF-8 text of at most 64 KiB.');
  }
  if (value.script.includes('\0')) throw new Error('start.sh cannot contain NUL bytes.');
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

function createGuestIso({files, destination, genisoimage, onCommand}) {
  const source = validateBootFiles(files);
  const stage = fs.mkdtempSync(path.join(path.dirname(destination), '.qemuweb-iso-'));
  const nextIso = `${destination}.tmp`;
  try {
    fs.rmSync(nextIso, {force: true});
    fs.writeFileSync(path.join(stage, '.qemuweb-media'), 'QemuWeb guest startup media\n');
    if (source.script) fs.writeFileSync(path.join(stage, 'start.sh'), source.script, {mode: 0o755});
    for (const entry of source.resources) {
      const target = path.join(stage, entry.path);
      fs.mkdirSync(path.dirname(target), {recursive: true});
      fs.writeFileSync(target, Buffer.from(entry.contentBase64, 'base64'));
    }
    const args = ['-quiet', '-R', '-J', '-V', LABEL, '-o', nextIso, stage];
    if (onCommand) onCommand(genisoimage, args);
    execFileSync(genisoimage, args, {stdio: 'pipe'});
    fs.chmodSync(nextIso, 0o444);
    fs.renameSync(nextIso, destination);
  } finally {
    fs.rmSync(stage, {recursive: true, force: true});
    fs.rmSync(nextIso, {force: true});
  }
  return destination;
}

module.exports = {LABEL, validateBootFiles, createGuestIso};
