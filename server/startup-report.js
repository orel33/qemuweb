'use strict';

// What the server prints at startup after its version: its settings (the options of
// server/options.js), each with its value and where it comes from ("default" or "option"), also
// when it is the default. The server runs no external program (QEMU, VDE and the others belong to
// the runner, which prints its own dependency check), so this is its whole report.
const path = require('path');
const {optionTable} = require('./options');

// [name as in --help, default as shown, description] for every option.
function optionRows({root}) {
  return optionTable(root).map(option => [option.metavar ? `${option.flag} ${option.metavar}` : option.flag, option.fallback, option.description]);
}

function shown(option, settings) {
  const value = settings[option.key];
  if (option.key === 'authMode') return value === 'off' ? 'on' : 'off';
  if (option.key === 'ephemeral') return value ? 'on' : 'off';
  return value === null ? 'unset' : String(value);
}

// The lines to print: a title, then one aligned line per option and the derived runner socket.
function startupReport({root, settings}) {
  const rows = optionTable(root).map(option => [option.flag, shown(option, settings), settings.given.has(option.flag) ? 'option' : 'default']);
  rows.push(['Runner socket', path.join(settings.runtime, `runner-${settings.port}.sock`), 'derived']);
  const nameWidth = Math.max(...rows.map(([name]) => name.length));
  const valueWidth = Math.max(...rows.map(([, value]) => String(value).length));
  return ['Settings', ...rows.map(([name, value, source]) => `  ${name.padEnd(nameWidth)}  ${String(value).padEnd(valueWidth)}  (${source})`)];
}

// The text of `--help`: usage, then every option with its default.
function helpText({root}) {
  const rows = optionRows({root});
  const width = Math.max(...rows.map(([name]) => name.length), '-h, --help'.length);
  return `Usage: node server/main.js [options]     (or ./scripts/server.sh [options])

The QemuWeb server (web interface, accounts, sessions). A runner (./scripts/runner.sh --port PORT)
dials it on <runtime>/runner-<PORT>.sock. It reads no environment variable. Any unknown option, or
a value that is missing or invalid, is refused (exit status 2).

Options (default in brackets):
${rows.map(([name, fallback, description]) => `  ${name.padEnd(width)}  [${fallback}]\n  ${' '.repeat(width)}  ${description}`).join('\n')}
  ${'-h, --help'.padEnd(width)}  this text

At startup it prints these options with their values and where each comes from.
`;
}

module.exports = {startupReport, helpText, optionRows};
