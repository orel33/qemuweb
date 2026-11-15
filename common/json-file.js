'use strict';

// Atomic JSON file writes shared by the session layer and the runner.
const fs = require('fs');
const crypto = require('crypto');

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {encoding: 'utf8', mode: 0o600, flag: 'wx'});
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.rmSync(temporary, {force: true}); } catch (_) {}
    throw error;
  }
}

module.exports = {writeJsonAtomic};
