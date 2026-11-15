'use strict';

// Waiting for a child process to exit.


function waitForChildExit(child, timeoutMs = 30000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('The host did not respond to the graceful shutdown request.')), timeoutMs);
    function finish(error) {
      clearTimeout(timeout);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      if (error) reject(error);
      else resolve();
    }
    function onExit() { finish(); }
    function onError(error) { finish(error); }
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

module.exports = {waitForChildExit};
