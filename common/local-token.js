'use strict';

// The token file of the local runner (docs/runner-model.md, 2.4): <server directory>/local-runner.token.
// The server creates it (server/local-runner-token.js) and keeps only its sha256 in memory; the local
// runner reads it at every connection attempt (runner/local-identity.js). This file is the ONE place that
// knows its name and what a usable content is. The token is a credential: it is never printed or logged.
//   node common/local-token.js path DIR     the token file of the server directory DIR (used by scripts/lib/runtime.sh)
const fs = require('fs');
const path = require('path');

const TOKEN_FILE = 'local-runner.token';
// 32 random bytes in base64url are 43 characters; a token chosen by hand is accepted from 32 to 256 printable characters, no space
// (the WebSocket gateway reads at most 256 characters of a Bearer token).
const TOKEN_PATTERN = /^[\x21-\x7e]{32,256}$/;

const tokenFilePath = serverDirectory => path.join(serverDirectory, TOKEN_FILE);

// The token of the file, or an Error whose `code` is MISSING (no such file), UNREADABLE (any other read error)
// or INVALID (the content is not a token). The message never contains the content.
function readTokenFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    throw Object.assign(new Error(error.code === 'ENOENT' ? `${file} does not exist` : `${file} cannot be read (${error.code || error.message})`),
      {code: error.code === 'ENOENT' ? 'MISSING' : 'UNREADABLE'});
  }
  const token = text.trim();
  if (!TOKEN_PATTERN.test(token)) throw Object.assign(new Error(`${file} does not hold a token (expected 32 to 256 printable characters)`), {code: 'INVALID'});
  return token;
}

module.exports = {TOKEN_FILE, TOKEN_PATTERN, tokenFilePath, readTokenFile};

if (require.main === module) {
  const [command, directory] = process.argv.slice(2);
  if (command !== 'path' || !directory) {
    console.error('Usage: node common/local-token.js path DIR');
    process.exit(2);
  }
  console.log(tokenFilePath(directory));
}
