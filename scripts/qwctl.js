'use strict';

// Installs and controls the systemd services (system units) of a QemuWeb server and its runners; run through
// scripts/qwctl.sh, as a normal account (sudo is called where it is needed). The unit templates are in deploy/systemd/,
// the rules of the options files and of the units in scripts/lib/service-units.js.
// It never touches the data (runtime directories, users.json, runners.json, logs), nor an options file or a runner file
// that exists.
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {UsageError} = require('../common/cli');
const {localRunnerRuntime, remoteRunnerRuntime, runtimeTooLong} = require('../common/runtime-dir');
const {validateRunnerConfig} = require('../runner/config-file');
const units = require('./lib/service-units');

const COMMANDS = ['install', 'uninstall', 'start', 'stop', 'restart', 'status', 'logs'];
const TARGETS = ['server', 'runner'];
const DEFAULT_LOG_LINES = 20;

// The options of qwctl itself (docs/reference.md repeats them); every other option of install is an option of the program.
const OPTIONS = [
  {flag: '--sysuser', metavar: 'ACCOUNT', commands: ['install'],
    description: 'Linux account that runs the service (User= of the unit; not the --users FILE of the server); default: the account that runs qwctl.sh, $SUDO_USER under sudo; never root'},
  {flag: '--name', metavar: 'NAME', commands: COMMANDS,
    description: 'runner only: the unit qemuweb-runner-NAME instead of qemuweb-runner (lower case letters, digits and -, at most 16 characters, not starting with -)'},
  {flag: '--remote', metavar: null, commands: ['install'],
    description: 'runner only: a remote runner (runner.sh run, with the runner file written by runner.sh register); default: the local runner of the server of this machine'},
  {flag: '--now', metavar: null, commands: ['install'], description: 'also starts the service (a running one is not restarted)'},
  {flag: '--dry-run', metavar: null, commands: ['install', 'uninstall'], description: 'shows what would be done and changes nothing'},
  {flag: '--force', metavar: null, commands: ['install', 'uninstall'],
    description: 'replaces or removes a unit that QemuWeb did not generate, or changes the account of an installed unit'},
  {flag: '-y', metavar: null, commands: ['uninstall', 'stop', 'restart'], description: 'answers yes to the confirmation asked before stopping a runner (its machines are stopped)'}
];

function helpText() {
  const name = option => (option.metavar ? `${option.flag} ${option.metavar}` : option.flag);
  const width = Math.max(...OPTIONS.map(option => name(option).length), '-h, --help'.length);
  return [
    'Usage: ./scripts/qwctl.sh install server [qwctl options] [options of server.sh]',
    '       ./scripts/qwctl.sh install runner [--name NAME] [--remote] [qwctl options] [options of runner.sh, or of runner.sh run]',
    '       ./scripts/qwctl.sh uninstall server|runner [--name NAME]',
    '       ./scripts/qwctl.sh start|stop|restart|status [server|runner [--name NAME]]',
    '       ./scripts/qwctl.sh logs [server|runner [--name NAME]] [LINES]',
    '',
    'Installs and controls the systemd services (system units) of a QemuWeb server and its runners. Without a target,',
    'start, stop, restart, status and logs act on every installed QemuWeb unit. Run it as a normal account: it calls sudo.',
    '',
    'install checks the options of the program, writes them once to /etc/qemuweb/server.args, runner.args or runner-NAME.args',
    '(then edited by hand, never overwritten), creates the missing directories, writes and enables the unit. Installing again',
    'is the update: it shows the difference and replaces the unit. uninstall removes the unit only, never the data.',
    'A remote runner is registered first, with ./scripts/runner.sh register.',
    '',
    'Options:',
    ...OPTIONS.flatMap(option => [`  ${name(option).padEnd(width)}  (${option.commands.length === COMMANDS.length ? 'every command' : option.commands.join(', ')})`, `  ${' '.repeat(width)}  ${option.description}`]),
    `  ${'-h, --help'.padEnd(width)}  this text`,
    ''
  ].join('\n');
}

class Failure extends Error {}
const fail = message => { throw new Failure(message); };

// {command, item, options, words, lines, help}: the command line of qwctl. Throws a UsageError.
function parseCommandLine(argv, root) {
  const [command, ...rest] = argv;
  if (command === undefined || command === '-h' || command === '--help') return {help: true};
  if (!COMMANDS.includes(command)) throw new UsageError(`Unknown command: ${command}`);
  if (rest.some(word => word === '-h' || word === '--help')) return {help: true};
  const target = TARGETS.includes(rest[0]) ? rest.shift() : null;
  if (!target && ['install', 'uninstall'].includes(command)) throw new UsageError(`${command} needs a target first: server or runner`);

  const mode = target === 'runner' ? (rest.includes('--remote') ? 'remote' : 'local') : 'server';
  const programOptions = command === 'install' ? units.programSpec(mode, root).options : [];
  const options = {};
  const words = [];
  const others = [];
  for (let index = 0; index < rest.length; index++) {
    const word = rest[index];
    const own = OPTIONS.find(option => option.flag === word);
    if (own) {
      if (!own.commands.includes(command)) throw new UsageError(`${word} is not an option of ${command}`);
      if (own.metavar && index + 1 >= rest.length) throw new UsageError(`Missing value for ${word} (${word} ${own.metavar})`);
      options[word] = own.metavar ? rest[++index] : true;
    } else if (command === 'install') {
      // An option of the program, with its value; what is unknown is refused by the program's own table.
      const option = programOptions.find(item => item.flag === word);
      words.push(word);
      if (option && option.metavar && index + 1 < rest.length) words.push(rest[++index]);
    } else {
      others.push(word);
    }
  }
  let lines = DEFAULT_LOG_LINES;
  if (command === 'logs' && others.length === 1 && /^\d{1,6}$/.test(others[0])) lines = Number(others.pop());
  if (others.length) throw new UsageError(`Unknown argument: ${others[0]} (a target is server or runner)`);
  if (target !== 'runner') {
    for (const flag of ['--name', '--remote']) if (options[flag] !== undefined) throw new UsageError(`${flag} needs the target runner`);
  }
  if (options['--name'] !== undefined && !units.NAME.test(options['--name'])) {
    throw new UsageError(`Invalid value for --name: ${options['--name']} (lower case letters, digits and -, at most 16 characters, not starting with -)`);
  }
  const item = target ? units.service(target, {name: options['--name'] ?? null, remote: Boolean(options['--remote'])}) : null;
  return {help: false, command, item, options, words, lines};
}

// The machine as seen by qwctl. `prefix` is put before every path of this machine (tests: a temporary root);
// the real entry point passes none.
function createHost({prefix = '', uid = process.getuid(), username = os.userInfo().username, sudoUser = process.env.SUDO_USER, env = process.env, nodeDirectories = ['/usr/local/bin', '/usr/bin']} = {}) {
  const at = file => prefix + file;
  const spawn = (command, args, options = {}) => {
    const result = spawnSync(command, args, {encoding: 'utf8', env, stdio: ['inherit', 'pipe', 'inherit'], ...options});
    if (result.error) fail(`Cannot run ${command}: ${result.error.message}`);
    return result;
  };
  const privileged = (command, args) => (uid === 0 ? [command, args] : ['sudo', [command, ...args]]);
  // Output of a command that may fail (status is returned).
  const query = (command, args) => spawn(command, args, {stdio: ['ignore', 'pipe', 'ignore']});
  function change(command, args) {
    const [program, words] = privileged(command, args);
    const result = spawn(program, words, {stdio: 'inherit'});
    if (result.status !== 0) fail(`${[program, ...words].join(' ')} failed (status ${result.status ?? result.signal}).`);
  }
  const test = (kind, file) => { const [program, words] = privileged('test', [kind, at(file)]); return spawn(program, words).status === 0; };

  // A file or a directory may be closed to this account (a home directory, /etc/qemuweb 0750): sudo then answers.
  function exists(file) {
    try { fs.lstatSync(at(file)); return true; } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
      if (error.code === 'EACCES') return test('-e', file);
      throw error;
    }
  }
  // The text of a file, or null when it does not exist. `account`: read as that account (its own runner file), not as root.
  function read(file, account = null) {
    try { return fs.readFileSync(at(file), 'utf8'); } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
      if (error.code !== 'EACCES') fail(`Cannot read ${file}: ${error.message}`);
    }
    const as = account ? ['-u', account] : [];
    if (spawn('sudo', [...as, 'test', '-e', at(file)]).status !== 0) return null;
    const result = spawn('sudo', [...as, 'cat', '--', at(file)]);
    if (result.status !== 0) fail(`Cannot read ${file}.`);
    return result.stdout;
  }
  function owner(file) {
    try { return fs.statSync(at(file)).uid; } catch (_) { return null; }
  }
  function list(directory) {
    try { return fs.readdirSync(at(directory)); } catch (_) { return []; }
  }
  // A root file, mode 0644, from a temporary copy.
  function write(file, text) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwctl-'));
    try {
      const temporary = path.join(directory, path.basename(file));
      fs.writeFileSync(temporary, text);
      change('install', ['-m', '0644', '-o', 'root', '-g', 'root', temporary, at(file)]);
    } finally {
      fs.rmSync(directory, {recursive: true, force: true});
    }
  }
  function diff(file, before, after) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qwctl-'));
    try {
      const names = [['old', before], ['new', after]].map(([name, text]) => {
        const temporary = path.join(directory, name);
        fs.writeFileSync(temporary, text);
        return temporary;
      });
      return query('diff', ['-u', '--label', `${file} (installed)`, '--label', `${file} (new)`, ...names]).stdout;
    } finally {
      fs.rmSync(directory, {recursive: true, force: true});
    }
  }
  // {uid, gid, home} of a Linux account, or a Failure.
  function account(name) {
    const result = query('getent', ['passwd', name]);
    const fields = (result.stdout || '').trim().split(':');
    if (result.status !== 0 || fields.length < 7) fail(`The account ${name} does not exist on this machine.`);
    return {uid: Number(fields[2]), gid: Number(fields[3]), home: fields[5]};
  }
  const makeDirectory = (directory, mode, {uid: ownerId, gid}) => change('install', ['-d', '-m', mode, '-o', String(ownerId), '-g', String(gid), at(directory)]);
  const remove = file => change('rm', ['-f', '--', at(file)]);
  const isActive = unit => ['active', 'activating', 'reloading', 'deactivating'].includes(query('systemctl', ['is-active', unit]).stdout.trim());
  const property = (unit, name) => query('systemctl', ['show', unit, '-p', name, '--value']).stdout.trim();
  // The drop-ins of a unit that replace its command.
  const overridingDropIns = unit => property(unit, 'DropInPaths').split(/\s+/).filter(Boolean).filter(file => /^\s*ExecStart\s*=/m.test(read(file) || ''));
  const hasNode = () => nodeDirectories.some(directory => fs.existsSync(path.join(directory, 'node')));
  const hasGroup = name => query('getent', ['group', name]).status === 0;

  return {uid, username, sudoUser, spawn, query, change, exists, read, owner, list, write, diff, account, makeDirectory, remove, isActive, property, overridingDropIns, hasNode, hasGroup, at};
}

// The account of the service (User=).
function resolveSysuser(given, host) {
  let name = given;
  if (name === undefined) {
    if (host.uid !== 0) name = host.username;
    else if (host.sudoUser && host.sudoUser !== 'root') name = host.sudoUser;
    else throw new UsageError('--sysuser ACCOUNT is needed when qwctl.sh is run directly as root');
  }
  if (name === 'root') throw new UsageError('--sysuser root is refused: QemuWeb runs under a normal account');
  if (!units.ACCOUNT.test(name)) throw new UsageError(`Invalid value for --sysuser: ${name} (a Linux account)`);
  const account = host.account(name);
  if (account.uid === 0) throw new UsageError(`--sysuser ${name} is refused: it has the user ID of root`);
  return {name, ...account};
}

// Every installed QemuWeb unit: [{item, text, info}], the server first. The mode of a runner comes from its unit.
function installedUnits(host) {
  return host.list(units.UNIT_DIRECTORY).sort().map(file => {
    const found = units.serviceOfFile(file);
    if (!found) return null;
    const text = host.read(units.unitPath(found));
    if (text === null) return null;
    const info = units.unitInfo(found, text);
    return {item: units.service(found.target, {name: found.name, remote: info.mode === 'remote'}), text, info};
  }).filter(Boolean).sort((a, b) => Number(a.item.target !== 'server') - Number(b.item.target !== 'server'));
}

// The checked options of the server of this machine: {settings, sysuser}. The options come from server.args only.
function readServer(host, root, problem) {
  const server = installedUnits(host).find(({item}) => item.target === 'server');
  if (!server) problem('The server is not installed on this machine: ./scripts/qwctl.sh install server first (or --remote for a runner of a server on another machine).');
  if (!server.info.generated) problem('The unit qemuweb-server was not generated by QemuWeb: install the server first (./scripts/qwctl.sh install server).');
  const file = units.argsPath(server.item);
  const text = host.read(file);
  if (text === null) problem(`${file} does not exist: ./scripts/qwctl.sh install server first.`);
  const {settings} = units.readArgs('server', root, text, file);
  return {settings, sysuser: server.info.sysuser, file};
}

// The --port, --host and --token-file of the local runner, from server.args.
function localLink(host, root, sysuser) {
  const {settings, sysuser: serverUser, file} = readServer(host, root, fail);
  if (!settings.localRunner) fail(`${file} has no --local-runner: the server accepts no local runner. Add it there and restart the server.`);
  if (serverUser !== sysuser.name) fail(`The local runner must run under the account of the server, which reads its token file: --sysuser ${serverUser} (not ${sysuser.name}).`);
  return units.serverLink(settings, {username: sysuser.name, uid: sysuser.uid});
}

// The content of a runner file, or null when it does not exist; the token is never printed (nor the text around an error).
function readRunnerFile(host, file, account) {
  const text = host.read(file, account);
  if (text === null) return null;
  let data;
  try { data = JSON.parse(text); } catch (_) { fail(`${file} is not valid JSON.`); }
  try { return validateRunnerConfig(data, file); } catch (error) { return fail(error.message); }
}

// What an installed runner unit uses: {runnerFile, runtime} (null: unknown). Best effort: a unit may not be ours.
function runnerUsage(host, {item, info}) {
  const usage = {runnerFile: null, runtime: null};
  let identity = null;
  try { identity = {username: info.sysuser, ...host.account(info.sysuser)}; } catch (_) { /* The account is gone: no default can be computed. */ }
  let words = info.words;
  if (info.usesArgs) {
    try { words = [...words, ...units.parseArgs(host.read(units.argsPath(item)) ?? '', units.argsPath(item))]; } catch (_) { /* Said by status. */ }
  }
  usage.runtime = units.rawOption(words, '--runtime');
  if (item.mode === 'remote') {
    usage.runnerFile = units.rawOption(words, '--runner-config') || (identity && units.defaultRunnerFile(units.service('runner', {remote: true}), identity.home));
    if (!usage.runtime && usage.runnerFile && identity) {
      try {
        const config = readRunnerFile(host, usage.runnerFile, info.sysuser);
        usage.runtime = config && (config.runtime || remoteRunnerRuntime(config.runnerId, {identity}));
      } catch (_) { /* An unreadable file names no directory. */ }
    }
  } else if (!usage.runtime && identity) {
    usage.runtime = localRunnerRuntime(units.rawOption(words, '--port') || 3002, {identity});
  }
  return usage;
}

// The directories to create for the settings of a service: [{directory, mode}], parents first.
function missingDirectories(host, wanted) {
  const result = new Map();
  for (const {directory, mode} of wanted) {
    const missing = [];
    for (let current = path.resolve(directory); !host.exists(current); current = path.dirname(current)) missing.unshift(current);
    missing.forEach((item, index) => {
      const own = index === missing.length - 1 ? mode : '0750';
      if (!result.has(item) || own === '0700') result.set(item, own);
    });
  }
  return [...result].map(([directory, mode]) => ({directory, mode}));
}

function registerCommand({root, file, sysuser, item, host, insecure}) {
  const sudo = sysuser.name === host.username && host.uid !== 0 ? '' : `sudo -u ${sysuser.name} `;
  return `${sudo}${root}/scripts/runner.sh register --url URL --token TOKEN${item.name ? ` --name ${item.name}` : ''}${insecure ? ' --insecure' : ''} --runner-config ${file}`;
}

function install({item, options, words, host, root, say}) {
  const sysuser = resolveSysuser(options['--sysuser'], host);
  const unitFile = units.unitPath(item);
  const argsFile = units.argsPath(item);
  const command = `./scripts/qwctl.sh install ${item.target}${item.name ? ` --name ${item.name}` : ''}${item.mode === 'remote' ? ' --remote' : ''}`;

  // The unit that is there.
  const before = host.read(unitFile);
  if (before !== null) {
    const info = units.unitInfo(item, before);
    if (info.mode !== item.mode) fail(`${item.unit} is installed as a ${info.mode} runner: uninstall it first (./scripts/qwctl.sh uninstall runner${item.name ? ` --name ${item.name}` : ''}).`);
    if (!info.generated && !options['--force']) fail(`${unitFile} was not generated by QemuWeb: --force replaces it.`);
    if (info.sysuser !== sysuser.name && !options['--force']) fail(`${item.unit} runs under ${info.sysuser}, which owns its files: give --sysuser ${info.sysuser} (--force changes the account to ${sysuser.name}).`);
  }
  const installed = installedUnits(host);
  const others = installed.filter(other => other.item.unit !== item.unit);
  const otherRunners = others.filter(other => other.item.target === 'runner');
  if (item.mode === 'local') {
    const second = otherRunners.find(other => other.item.mode === 'local');
    if (second) fail(`${second.item.unit} is already the local runner of the server of this machine: a second one is refused.`);
  }

  // The options, checked before anything is written.
  const existing = host.read(argsFile);
  if (existing !== null && words.length) fail(`${argsFile} exists and is never overwritten: edit it, then run ${command} without the options (${words[0]}...).`);
  let checked = existing === null ? units.checkWords(item.mode, root, words) : units.readArgs(item.mode, root, existing, argsFile);
  let runnerFile = null;
  let fileRuntime = null;
  if (item.mode === 'remote') {
    // With an options file that has no --runner-config, the runner reads its own default.
    runnerFile = checked.words.get('--runner-config') || units.defaultRunnerFile(existing === null ? item : units.service('runner', {remote: true}), sysuser.home);
    const config = readRunnerFile(host, runnerFile, sysuser.name);
    if (!config) {
      fail(`${runnerFile} does not exist: register this runner first, with a token created in /admin -> Runners:\n  ` +
        `${registerCommand({root, file: runnerFile, sysuser, item, host, insecure: checked.settings.insecure})}`);
    }
    fileRuntime = config.runtime || null;
    const given = checked.words.get('--runtime');
    if (fileRuntime && given && path.resolve(fileRuntime) !== given) fail(`--runtime ${given} contradicts the runtime of ${runnerFile} (${fileRuntime}): use that one, or edit the file.`);
  }
  const argsText = existing ?? units.formatArgs(item, units.withDefaults(item, checked.words, {home: sysuser.home, fileRuntime}));
  if (existing === null) checked = units.readArgs(item.mode, root, argsText, argsFile);
  const value = flag => checked.words.get(flag) ?? null;
  const runtime = value('--runtime') || fileRuntime;

  if (item.target === 'runner') {
    const usage = {runnerFile, runtime: runtime && path.resolve(runtime)};
    if (runtime && runtimeTooLong(runtime)) fail(runtimeTooLong(runtime));
    for (const other of otherRunners) {
      const used = runnerUsage(host, other);
      if (usage.runnerFile && used.runnerFile && path.resolve(used.runnerFile) === usage.runnerFile) fail(`The runner file ${usage.runnerFile} is already used by ${other.item.unit}.`);
      if (usage.runtime && used.runtime && path.resolve(used.runtime) === usage.runtime) fail(`The runtime directory ${usage.runtime} is already used by ${other.item.unit}.`);
    }
    const server = installed.find(other => other.item.target === 'server');
    const serverArgs = server && server.info.usesArgs ? host.read(units.argsPath(server.item)) : null;
    if (serverArgs !== null && usage.runtime) {
      const {settings} = units.readArgs('server', root, serverArgs, units.argsPath(server.item));
      if (settings.given.has('--runtime') && settings.runtime === usage.runtime) fail(`The runtime directory ${usage.runtime} is the one of the server: a runner has its own.`);
    }
  }
  const link = item.mode === 'local' ? localLink(host, root, sysuser) : [];
  const after = units.renderUnit(item, {root, sysuser: sysuser.name, link});

  const wanted = [];
  if (runtime) wanted.push({directory: runtime, mode: '0700'});
  if (item.mode === 'server') {
    for (const flag of ['--users', '--runners']) if (value(flag)) wanted.push({directory: path.dirname(value(flag)), mode: '0750'});
    if (value('--logs')) wanted.push({directory: value('--logs'), mode: '0750'});
  }
  wanted.push({directory: units.CONFIG_DIRECTORY, mode: '0750'});
  const directories = missingDirectories(host, wanted);

  // What is going to be done.
  const dry = Boolean(options['--dry-run']);
  say(`${item.unit} (${item.mode === 'server' ? 'server' : `${item.mode} runner`}), account ${sysuser.name}`);
  for (const {directory, mode} of directories) say(`  directory ${directory} (${mode}, ${sysuser.name})`);
  say(existing === null ? `  options   ${argsFile} (new)\n${argsText.trimEnd().split('\n').map(line => `    ${line}`).join('\n')}` : `  options   ${argsFile} (kept)`);
  if (before === null) say(`  unit      ${unitFile} (new)\n${after.trimEnd().split('\n').map(line => `    ${line}`).join('\n')}`);
  else if (before === after) say(`  unit      ${unitFile} (unchanged)`);
  else say(`  unit      ${unitFile} (replaced)\n${host.diff(unitFile, before, after).trimEnd()}`);
  const warn = message => say(`Warning: ${message}`);
  if (!host.hasNode()) warn('no node in /usr/local/bin or /usr/bin, where a service looks for it: install Node.js there, or add it to the PATH of the unit with a drop-in (systemctl edit).');
  if (item.target === 'runner' && !host.hasGroup('kvm')) warn('this machine has no kvm group: the unit (SupplementaryGroups=kvm) cannot start.');
  const owner = runtime ? host.owner(runtime) : null;
  if (owner !== null && owner !== sysuser.uid) warn(`${runtime} does not belong to ${sysuser.name}: the service cannot use it.`);
  if (item.mode === 'local') warnServerDropIn(host, warn);
  if (item.target === 'runner' && otherRunners.length) {
    warn(`this machine will have ${otherRunners.length + 1} runners and each one announces the whole machine: limit the remote ones with "limits": {"maxSessions": N} in their runner file.`);
  }
  if (dry) { say('Dry run: nothing was changed.'); return; }

  for (const {directory, mode} of directories) host.makeDirectory(directory, mode, sysuser);
  if (existing === null) host.write(argsFile, argsText);
  if (before !== after) host.write(unitFile, after);
  host.change('systemctl', ['daemon-reload']);
  host.change('systemctl', ['enable', item.unit]);
  const active = host.isActive(item.unit);
  const control = verb => `./scripts/qwctl.sh ${verb} ${item.target}${item.name ? ` --name ${item.name}` : ''}`;
  if (active) say(`${item.unit} is running, with what it was started with: ${control('restart')} applies the unit and its options.`);
  else if (options['--now']) host.change('systemctl', ['start', item.unit]);
  else say(`Installed. Start it with ${control('start')}`);
}

function warnServerDropIn(host, warn) {
  for (const file of host.overridingDropIns('qemuweb-server')) {
    warn(`${file} overrides ExecStart of qemuweb-server: the options of the local runner (port, token file) come from server.args only.`);
  }
}

// The units a command acts on: the target, or every installed one.
function selectUnits(host, item) {
  const installed = installedUnits(host);
  if (!item) return installed.length ? installed : fail('No QemuWeb unit is installed on this machine (./scripts/qwctl.sh install server).');
  return [installed.find(other => other.item.unit === item.unit) || fail(`${item.unit} is not installed.`)];
}

const namesOf = selected => selected.map(({item}) => item.unit);

// Stopping a runner stops its machines: ask before doing it.
function confirmRunners(selected, {host, options, ask, say}) {
  const runners = selected.filter(({item}) => item.target === 'runner' && host.isActive(item.unit));
  if (!runners.length || options['-y']) return;
  say(`This stops every machine of ${namesOf(runners).join(', ')}.`);
  if (!ask('Continue? [y/N] ')) fail('Cancelled.');
}

// The unit the repository would generate in place of an installed one (its own account), or a Failure.
function expectedUnit(host, root, {item, info}) {
  const sysuser = {name: info.sysuser, ...host.account(info.sysuser)};
  return units.renderUnit(item, {root, sysuser: sysuser.name, link: item.mode === 'local' ? localLink(host, root, sysuser) : []});
}

function status(selected, {host, root, say}) {
  for (const entry of selected) {
    const {item, info} = entry;
    say(`${item.unit.padEnd(24)} ${(item.mode === 'server' ? 'server' : `${item.mode} runner`).padEnd(14)} ${host.query('systemctl', ['is-active', item.unit]).stdout.trim().padEnd(10)} ` +
      `${host.query('systemctl', ['is-enabled', item.unit]).stdout.trim()}, since ${host.property(item.unit, 'ActiveEnterTimestamp') || 'never'}`);
    const again = `./scripts/qwctl.sh install ${item.target}${item.name ? ` --name ${item.name}` : ''}${item.mode === 'remote' ? ' --remote' : ''}`;
    if (!info.generated) say(`  Warning: the unit was not generated by QemuWeb (${again} --force replaces it)`);
    else {
      try {
        if (expectedUnit(host, root, entry) !== entry.text) say(`  Warning: the unit differs from what this repository would generate: ${again} --sysuser ${info.sysuser} (--dry-run shows the difference)`);
        const argsFile = units.argsPath(item);
        units.readArgs(item.mode, root, host.read(argsFile) ?? fail(`${argsFile} does not exist.`), argsFile);
      } catch (error) {
        if (!(error instanceof Failure) && error.constructor !== Error) throw error;
        say(`  Warning: ${error.message}`);
      }
    }
    for (const file of host.overridingDropIns(item.unit)) say(`  Warning: the drop-in ${file} overrides ExecStart`);
    if (item.mode === 'local') warnServerDropIn(host, message => say(`  Warning: ${message}`));
  }
  const count = name => host.query('pgrep', ['-c', name]).stdout.trim() || '0';
  say(`machines: ${count('qemu-system')} qemu, ${count('vde_switch')} vde_switch`);
}

function uninstall({item, options, host, say, ask}) {
  const selected = selectUnits(host, item);
  const [{info}] = selected;
  if (!info.generated && !options['--force']) fail(`${units.unitPath(item)} was not generated by QemuWeb: --force removes it.`);
  say(`${item.unit}: stop, disable and remove ${units.unitPath(item)}`);
  say(`Kept: ${units.argsPath(item)}, the runner file, the drop-ins and all the data.`);
  if (options['--dry-run']) { say('Dry run: nothing was changed.'); return; }
  confirmRunners(selected, {host, options, ask, say});
  host.change('systemctl', ['disable', '--now', item.unit]);
  host.remove(units.unitPath(item));
  host.change('systemctl', ['daemon-reload']);
}

// Runs a command line. Returns the exit status; `out` and `err` receive the lines, `ask(question)` answers a confirmation.
function run(argv, {root = path.join(__dirname, '..'), host = createHost(), out = console.log, err = console.error, ask = askTerminal} = {}) {
  try {
    const parsed = parseCommandLine(argv, root);
    if (parsed.help) { out(helpText()); return 0; }
    const {command, item, options, words, lines} = parsed;
    const context = {item, options, words, host, root, say: out, ask};
    if (command === 'install') { install(context); return 0; }
    if (command === 'uninstall') { uninstall(context); return 0; }
    const selected = selectUnits(host, item);
    if (command === 'logs') {
      for (const unit of namesOf(selected)) {
        out(`== ${unit}`);
        host.change('journalctl', ['-u', unit, '-n', String(lines), '--no-pager', '-o', 'cat']);
      }
      return 0;
    }
    if (command !== 'status') {
      if (command !== 'start') confirmRunners(selected, context);
      host.change('systemctl', [command, ...namesOf(selected)]);
    }
    status(selected, context);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) { err(`qwctl: ${error.message}\nUsage: ./scripts/qwctl.sh COMMAND [server|runner] [options]   (--help lists them)`); return 2; }
    // A plain Error is a message of a check (an options file, a runner file); anything else is a bug.
    if (!(error instanceof Failure) && (error.constructor !== Error || error.code)) throw error;
    err(`qwctl: ${error.message}`);
    return 1;
  }
}

function askTerminal(question) {
  const result = spawnSync('bash', ['-c', 'read -r -p "$1" answer; printf %s "$answer"', 'bash', question], {stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8'});
  return /^y$/i.test((result.stdout || '').trim());
}

module.exports = {run, createHost, helpText, OPTIONS, COMMANDS};

if (require.main === module) process.exit(run(process.argv.slice(2)));
