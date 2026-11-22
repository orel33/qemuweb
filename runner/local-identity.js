'use strict';

// What the local runner (`runner.sh [options]`, id "local") knows about itself before it connects: the
// server of this machine, ws://HOST:PORT/runner/connect (HOST: --host, 127.0.0.1 by default), and the token file the server created
// (--local-runner, server/local-runner-token.js). The file is read at EVERY connection attempt (readToken), so a
// rotation needs no restart; a missing file is a normal wait (the server creates it at its next start), never a
// failure. The token is never printed, logged or put on a command line.
const fs = require('fs');
const cli = require('../common/cli');
const {readTokenFile} = require('../common/local-token');
const {serverUrls} = require('./remote-url');
const {urlHost} = require('../common/bind');

const LOCAL_ID = 'local';
const octal = mode => (mode & 0o777).toString(8).padStart(4, '0');

function load(options) {
  // --host is the address of this machine (the server's --bind): it is chosen by the administrator of this machine, so --insecure is not asked for.
  const urls = serverUrls(`http://${urlHost(options.host)}:${options.port}`, {insecure: true});
  const file = options.tokenFile;

  function printChecks() {
    if (urls.plain) cli.warning(`${urls.base} is not loopback: the token and the traffic are clear text; --host is for an address of this machine.`);
    try {
      const mode = fs.statSync(file).mode;
      cli.pass(`${file}  (mode ${octal(mode)})`);
      if (mode & 0o077) cli.warning(`${file} can be read by other users and holds the token of this runner: chmod 600 it.`);
    } catch (_) {
      cli.warning(`${file} does not exist (yet): the runner waits for the server (--local-runner) to create it.`);
    }
    return true;
  }

  return {runnerId: LOCAL_ID, urls, tokenFile: file, readToken: () => readTokenFile(file), printChecks,
    derivedRows: () => [['Runner', LOCAL_ID], ['Server WebSocket', urls.connectUrl]]};
}

module.exports = {load, LOCAL_ID};
