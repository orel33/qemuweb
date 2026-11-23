'use strict';

// The command line and the startup display shared by the two programs of QemuWeb, the server
// (server/main.js) and the runner (runner/main.js). Core modules only: it is loaded before
// anything else, so that --help and a bad option answer at once.
//
// A program describes itself with a spec (server/options.js, runner/options.js):
//   {program, node, script, summary, options: [...], environment: null | [{names, description}]}
// and each option is {flag, metavar (null: a flag without value), kind (text | port | number |
// path | integer | choice), key, default (the value when absent), fallback (the default as shown by --help
// and, when the value is null, by the startup block), description, value (what a flag without
// value sets), choices (kind choice: the allowed values), min, max, expected, convert, exclusive: [flags], showWhenGiven, required (the
// option must be given), secret (its value is never printed)}.
//
// A spec may also have validate(settings), which throws a UsageError for a combination of options
// that parseArguments cannot see option by option (an option that another one requires).
//
// Both programs then print the same things in the same order: the banner, the Options block, the
// "Checking dependencies…" and "Checking configuration…" blocks (heading, pass, warning,
// failure, skipped), and refuse what is wrong in the same way (usageError, abort).
const path = require('path');
const packageInfo = require('../package.json');

const MAX_PORT = 65535;
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

// A command-line mistake: unknown option, missing or invalid value, options that exclude each other.
class UsageError extends Error {}

function invalid(flag, value, expected) {
  return new UsageError(`Invalid value for ${flag}: ${value} (${expected})`);
}

const KINDS = {
  text: (option, value) => {
    if (value === '') throw invalid(option.flag, value, 'not empty');
    return value;
  },
  path: (option, value) => {
    if (value === '') throw invalid(option.flag, value, 'not empty');
    return path.resolve(value);
  },
  choice: (option, value) => {
    if (!option.choices.includes(value)) throw invalid(option.flag, value, `one of ${option.choices.join(', ')}`);
    return value;
  },
  port: (option, value) => {
    if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > MAX_PORT) throw invalid(option.flag, value, `1 to ${MAX_PORT}`);
    return Number(value);
  },
  // A whole number from option.min (default 0) to option.max, 0 included.
  integer: (option, value) => {
    const min = option.min ?? 0;
    if (!/^\d{1,9}$/.test(value) || Number(value) < min || Number(value) > option.max) throw invalid(option.flag, value, option.expected || `a whole number from ${min} to ${option.max}`);
    return Number(value);
  },
  number: (option, value) => {
    const number = Number(value);
    const bounded = Number.isFinite(option.max);
    if (value === '' || !Number.isFinite(number) || number <= 0 || (bounded && number > option.max)) {
      throw invalid(option.flag, value, option.expected || (bounded ? `a number greater than 0 and at most ${option.max}` : 'a number greater than 0'));
    }
    return number;
  }
};

function defaultSettings(spec) {
  const settings = {given: new Set()};
  for (const option of spec.options) settings[option.key] = option.default ?? null;
  return settings;
}

// Parses argv (without node and the script). Returns {help, settings}: help is true when -h or
// --help is anywhere on the line (nothing else is checked then); settings holds every key with
// its default and `given`, the set of the flags present. Throws a UsageError otherwise.
function parseArguments(spec, argv) {
  const settings = defaultSettings(spec);
  if (argv.some(argument => argument === '--help' || argument === '-h')) return {help: true, settings};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    const option = spec.options.find(item => item.flag === name);
    if (!option) throw new UsageError(`Unknown option: ${name}`);
    if (option.metavar) {
      if (index + 1 >= argv.length) throw new UsageError(`Missing value for ${name} (${name} ${option.metavar})`);
      const value = KINDS[option.kind](option, argv[++index]);
      settings[option.key] = option.convert ? option.convert(value) : value;
    } else {
      settings[option.key] = option.value;
    }
    settings.given.add(name);
  }
  for (const option of spec.options) {
    if (option.required && !settings.given.has(option.flag)) throw new UsageError(`Missing required option ${option.flag} (${option.flag} ${option.metavar})`);
    const other = (option.exclusive || []).find(flag => settings.given.has(option.flag) && settings.given.has(flag));
    if (other) throw new UsageError(`${option.flag} and ${other} exclude each other`);
  }
  if (spec.validate) spec.validate(settings);
  return {help: false, settings};
}

const usageLine = spec => `Usage: ${spec.node} [options]   (--help lists the options)`;

// `<program>: <message>` and the usage line on stderr, exit status 2.
function usageError(spec, message) {
  console.error(`${spec.program}: ${message}\n${usageLine(spec)}`);
  process.exit(2);
}

// The one call of a program's entry point: the settings, or --help printed (exit 0) or the
// mistake reported (exit 2).
function commandLine(spec, argv) {
  let result;
  try { result = parseArguments(spec, argv); }
  catch (error) {
    if (!(error instanceof UsageError)) throw error;
    return usageError(spec, error.message);
  }
  if (result.help) {
    process.stdout.write(formatHelp(spec));
    process.exit(0);
  }
  return result.settings;
}

// A failure after a valid start: `<program>: <message>` on stderr, exit status 1.
function abort(program, message) {
  console.error(`${program}: ${message}`);
  process.exit(1);
}

// The text of --help; docs/reference.md repeats the options, defaults and descriptions.
function formatHelp(spec) {
  const entries = spec.options.map(option => [option.metavar ? `${option.flag} ${option.metavar}` : option.flag, option.fallback, option.description]);
  const width = Math.max(...entries.map(([name]) => name.length), '-h, --help'.length);
  const indent = ' '.repeat(width);
  // A program with subcommands (spec.commands: [{name, description}]) lists them right after the usage lines.
  const commands = spec.commands || [];
  const commandWidth = Math.max(0, ...commands.map(({name}) => name.length));
  const lines = [
    `Usage: ${spec.node} [options]`,
    `       ${spec.script} [options]`,
    ...commands.filter(({name}) => name !== '(none)').map(({name}) => `       ${spec.script} ${name} [options]`),
    '',
    ...(commands.length ? [
      'Commands (each one has its own options: --help after the command):',
      ...commands.map(({name, description}) => `  ${name.padEnd(commandWidth)}  ${description}`),
      ''
    ] : []),
    spec.summary,
    '',
    'Options (default in brackets):',
    ...entries.flatMap(([name, fallback, description]) => [`  ${name.padEnd(width)}  [${fallback}]`, `  ${indent}  ${description}`]),
    `  ${'-h, --help'.padEnd(width)}  this text`,
    '',
    'Environment variables:',
    ...(spec.environment
      ? spec.environment.flatMap(({names, description}) => [`  ${names}`, `    ${description}`])
      : ['  none: this program reads no environment variable']),
    '',
    'At startup it prints a banner, these options with their values and where each comes from (default, option or derived),',
    'then its dependency and configuration checks.',
    ''
  ];
  return lines.join('\n');
}

// What an option shows in the Options block: its value, "on" or "off" for a flag.
function shownValue(option, settings) {
  const value = settings[option.key];
  if (!option.metavar) return value === option.value ? 'on' : 'off';
  if (option.secret && settings.given.has(option.flag)) return '********';
  return value === null ? option.fallback : String(value);
}

// The rows [name, value, source] of the Options block: every option, with the value in effect and
// where it comes from (default or option, or settings.sources[flag] for a value read from a file),
// then the derived values [[name, value]].
function startupRows(spec, settings, derived = []) {
  const rows = spec.options
    .filter(option => !option.showWhenGiven || settings.given.has(option.flag))
    .map(option => [option.flag, shownValue(option, settings), settings.given.has(option.flag) ? 'option' : settings.sources?.[option.flag] || 'default']);
  return [...rows, ...derived.map(([name, value]) => [name, value, 'derived'])];
}

// The lines of the Options block: a title, then one aligned line per row.
function formatOptions(rows) {
  const nameWidth = Math.max(...rows.map(([name]) => name.length));
  const valueWidth = Math.max(...rows.map(([, value]) => String(value).length));
  return ['Options', ...rows.map(([name, value, source]) => `  ${name.padEnd(nameWidth)}  ${String(value).padEnd(valueWidth)}  (${source})`)];
}

// `QemuWeb <version> <server|runner>`, then a blank line.
function banner(role) {
  return `QemuWeb ${packageInfo.version} ${role}`;
}

function printBanner(role) {
  console.log(`${banner(role)}\n`);
}

function printOptions(rows) {
  console.log(`${formatOptions(rows).join('\n')}\n`);
}

// A block is a heading, lines, and a blank line (end()). ✓ pass, ⚠ warning, ✗ failure, - skipped.
function heading(text) { console.log(text); }
function pass(text) { console.log(`  ${GREEN}✓${RESET} ${text}`); }
function warning(text) { console.log(`  ${YELLOW}⚠${RESET} ${text}`); }
function failure(text) { console.error(`  ${RED}✗${RESET} ${text}`); }
function skipped(text) { console.log(`  - ${text}`); }
function end() { console.log(''); }

module.exports = {UsageError, parseArguments, defaultSettings, commandLine, usageError, abort, formatHelp, formatOptions, startupRows, banner,
  printBanner, printOptions, heading, pass, warning, failure, skipped, end, invalid};
