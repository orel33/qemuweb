'use strict';

// The credential of the local runner (docs/runner-model.md, 2.4), for a server started with --local-runner.
// At start the server reads <server directory>/local-runner.token (common/local-token.js); when the file is
// missing, unreadable or does not hold a token, it CREATES it (32 random bytes in base64url, mode 0600, in a
// directory created with mode 0700, written to a temporary file and renamed, so that a reader never sees half a
// token). A file it can read is never rewritten. The server keeps only the sha256 of the token, in memory, as the
// secret of the record "local" (runners.json holds no hash for it): a restart recomputes it from the file, so the
// runner keeps its token across a server restart. matches() compares in constant time. The token is never
// printed, logged or returned. Losing the file is repaired by restarting the server (a new token), rotating is
// removing the file and restarting.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {tokenFilePath, readTokenFile} = require('../common/local-token');

const digest = token => crypto.createHash('sha256').update(String(token)).digest();

// Writes a new token file atomically (0600); the directory is created with 0700 when it does not exist.
function createTokenFile(file) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const token = crypto.randomBytes(32).toString('base64url');
  const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${token}\n`, {mode: 0o600, flag: 'wx'});
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.rmSync(temporary, {force: true}); } catch (_) { /* Nothing left to remove. */ }
    throw error;
  }
  return token;
}

// {file, created, reason, mode, matches(token)}: `created` is true when a new file was written, and `reason` says why
// (the message of the read error, never the content); `mode` is the permission bits of the file. Throws when the
// file can neither be read nor created.
function ensureLocalRunnerToken(serverDirectory) {
  const file = tokenFilePath(serverDirectory);
  let token = null;
  let reason = null;
  try { token = readTokenFile(file); } catch (error) { reason = error.message; }
  const created = token === null;
  if (created) token = createTokenFile(file);
  const expected = digest(token);
  token = null;
  return {
    file, created, reason,
    mode: fs.statSync(file).mode & 0o777,
    matches: candidate => typeof candidate === 'string' && candidate.length <= 256 && crypto.timingSafeEqual(expected, digest(candidate))
  };
}

module.exports = {ensureLocalRunnerToken};
