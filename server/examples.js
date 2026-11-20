'use strict';

// The examples of the server: the .topo (topology) and .zip (session) files of the --examples
// directory, offered by the Load dialog. Read only: nothing here writes, deletes or renames. A
// request names a file by its bare name, never by a path; the name is checked, looked up in a
// fresh listing, and the file is opened without following a symbolic link and must be a regular
// file. Only the name, kind, size and description of a file leave the server.
const fs = require('fs');
const path = require('path');
const {StringDecoder} = require('string_decoder');

const MAX_NAME = 128;
const MAX_DESCRIPTION = 120;
// The limits of an upload of the same kind: runner/commands/archives.js (session ZIP) and
// common/topology.js (a topology is text under 256 KB).
const LIMITS = {session: 0xffffffff, topology: 262144};
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const HEAD_BYTES = 4096;
// O_NOFOLLOW refuses a symbolic link; O_NONBLOCK keeps a named pipe from blocking the open.
const OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

class ExampleError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// The kind of file a name stands for, from its extension: 'topology', 'session' or null.
function kindOfName(name) {
  const match = typeof name === 'string' ? /\.(topo|zip)$/i.exec(name) : null;
  return match ? (match[1].toLowerCase() === 'topo' ? 'topology' : 'session') : null;
}

// A bare file name of at most 128 characters: no separator, no "..", no leading dot, no control
// character, and an extension of an example.
function isExampleName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= MAX_NAME && !/[/\\]/.test(name) && !name.includes('..')
    && !name.startsWith('.') && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(name) && kindOfName(name) !== null;
}

// The first comment line of a topology (its description): the text after the #, printable
// characters only, at most 120 characters; empty when there is none.
function topologyDescription(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\s*#+\s*(.*)$/.exec(line);
    if (!match) continue;
    const printable = match[1].replace(/\t/g, ' ').replace(/\p{C}/gu, '').replace(/[\p{Zl}\p{Zp}]/gu, ' ').trim();
    if (printable) return [...printable].slice(0, MAX_DESCRIPTION).join('').trim();
  }
  return '';
}

// Whether the bytes of a file agree with the kind its name announces: a message when they do not.
// A ZIP starts with PK\x03\x04; a topology is UTF-8 text without NUL bytes. `head` is the start of
// the file, the whole of it for a topology.
function contentError(kind, head) {
  if (kind === 'session') return head.subarray(0, 4).equals(ZIP_MAGIC) ? null : 'This file is not a ZIP archive: it does not start with a ZIP header.';
  if (head.includes(0)) return 'This file is not a topology: it is binary, not text.';
  try { new TextDecoder('utf-8', {fatal: true}).decode(head); } catch (_) { return 'This file is not a topology: it is not UTF-8 text.'; }
  return null;
}

// Opens a regular file of the directory, or returns null: a symbolic link, a directory, a device
// or a missing file all give null.
async function openRegular(directory, name) {
  let handle = null;
  try {
    handle = await fs.promises.open(path.join(directory, name), OPEN_FLAGS);
    const stat = await handle.stat();
    if (stat.isFile()) return {handle, size: stat.size};
  } catch (_) { /* Missing, a link, no right: not an example. */ }
  await handle?.close().catch(() => {});
  return null;
}

async function readHead(handle, size) {
  const buffer = Buffer.alloc(Math.min(size, HEAD_BYTES));
  const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
  return buffer.subarray(0, bytesRead);
}

// The description of a topology file: its first comment line, empty for a binary file. A UTF-8
// sequence cut by the end of the head is dropped by the decoder.
function descriptionOf(head) {
  if (head.includes(0)) return '';
  return topologyDescription(new StringDecoder('utf8').write(head));
}

// The examples, sorted by name: [{name, kind, size, description}]. A missing or unreadable
// directory is an empty list. Listed afresh at each call.
async function listExamples(directory) {
  let names;
  try { names = await fs.promises.readdir(directory); } catch (_) { return []; }
  const examples = [];
  for (const name of names.filter(isExampleName).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const file = await openRegular(directory, name);
    if (!file) continue;
    try {
      const kind = kindOfName(name);
      if (file.size > LIMITS[kind]) continue;
      examples.push({name, kind, size: file.size, description: kind === 'topology' ? descriptionOf(await readHead(file.handle, file.size)) : ''});
    } catch (_) { /* Vanished while read. */ } finally { await file.handle.close().catch(() => {}); }
  }
  return examples;
}

// Opens the example called `name`: {name, kind, size, handle}. The caller closes the handle (or
// streams it, which closes it at the end). A malformed name is a 400, a name that is not in the
// fresh listing a 404, a file whose content is not of its kind a 400.
async function openExample(directory, name) {
  if (!isExampleName(name)) throw new ExampleError('Invalid example name.', 400);
  if (!(await listExamples(directory)).some(example => example.name === name)) throw new ExampleError('No such example.', 404);
  const file = await openRegular(directory, name);
  if (!file) throw new ExampleError('No such example.', 404);
  const kind = kindOfName(name);
  try {
    if (file.size > LIMITS[kind]) throw new ExampleError(kind === 'topology' ? 'Topology must be text under 256 KB.' : 'Session archive exceeds ZIP total size limit (4 GiB).', 400);
    const head = kind === 'topology' ? await file.handle.readFile() : await readHead(file.handle, file.size);
    if (head.length > LIMITS[kind] && kind === 'topology') throw new ExampleError('Topology must be text under 256 KB.', 400);
    const problem = contentError(kind, head);
    if (problem) throw new ExampleError(`${name}: ${problem}`, 400);
    return {name, kind, size: file.size, handle: file.handle, text: kind === 'topology' ? head.toString('utf8') : null};
  } catch (error) {
    await file.handle.close().catch(() => {});
    throw error;
  }
}

module.exports = {ExampleError, LIMITS, kindOfName, isExampleName, topologyDescription, contentError, listExamples, openExample};
