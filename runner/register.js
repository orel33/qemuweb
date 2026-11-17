'use strict';

// `runner.sh register`: sends the one-time registration token to POST /api/runner/register of the
// server and returns the runner's identity {runnerId, authToken, name}. Built-in http/https only;
// a self-signed server certificate is trusted with --ca (the PEM file), nothing else.
const fs = require('fs');
const http = require('http');
const https = require('https');

const TIMEOUT_MS = 15000;

function registerRunner({registerUrl, token, name, ca = null}) {
  const body = JSON.stringify({token, ...(name ? {name} : {})});
  const url = new URL(registerUrl);
  const transport = url.protocol === 'https:' ? https : http;
  const options = {method: 'POST', timeout: TIMEOUT_MS, headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)},
    ...(ca ? {ca: fs.readFileSync(ca)} : {})};
  return new Promise((resolve, reject) => {
    const request = transport.request(url, options, response => {
      const chunks = [];
      response.on('data', chunk => { if (chunks.length < 64) chunks.push(chunk); });
      response.on('end', () => {
        let data = {};
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { /* Not JSON: reported below. */ }
        if (response.statusCode !== 200) return reject(new Error(`${data.error || `the server answered HTTP ${response.statusCode}`}`));
        if (typeof data.runnerId !== 'string' || typeof data.authToken !== 'string') return reject(new Error('the server answered with an invalid registration.'));
        resolve({runnerId: data.runnerId, authToken: data.authToken, name: typeof data.name === 'string' ? data.name : name || data.runnerId});
      });
    });
    request.on('timeout', () => request.destroy(new Error('the server did not answer in time')));
    request.on('error', error => reject(new Error(`cannot reach ${url.origin}: ${error.message}${/certificate|self.signed|issuer/i.test(error.message) ? ' (a private certificate authority: use --ca FILE)' : ''}`)));
    request.end(body);
  });
}

module.exports = {registerRunner};
