'use strict';

// User accounts in users.json (see lib/auth/users-store.js); run through scripts/user.sh.
//   add <login> [--role student|admin]   create an account
//   passwd <login>                       change a password
//   role <login> student|admin           change a role
//   remove <login>                       delete an account (its running session is kept until deleted)
//   list                                 print logins and roles
//   import-csv <file>                    add or update accounts from "login,password[,role]" lines
// Passwords come from QEMUWEB_PASSWORD, else from standard input when it is not a terminal
// (first line), else from a prompt without echo.
const fs = require('fs');
const path = require('path');
const {hashPassword} = require('../lib/auth/passwords');
const {readUsers, writeUsers, usersFilePath, validateLogin, validateRole} = require('../lib/auth/users-store');

const root = path.join(__dirname, '..');
const USAGE = `Usage: scripts/user.sh <command>
  add <login> [--role student|admin]
  passwd <login>
  role <login> student|admin
  remove <login>
  list
  import-csv <file>          lines: login,password[,role]
Password: QEMUWEB_PASSWORD, or the first line of standard input, or a prompt.
Users file: ${path.relative(process.cwd(), usersFilePath(root)) || 'users.json'} (QEMUWEB_USERS_FILE overrides it).`;

function fail(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

function readHiddenLine(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    process.stderr.write(prompt);
    let value = '';
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    const finish = error => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
      process.stderr.write('\n');
      if (error) reject(error); else resolve(value);
    };
    function onData(chunk) {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u0003' || char === '\u0004') return finish(Object.assign(new Error('Cancelled.'), {exitCode: 130}));
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    }
    input.on('data', onData);
  });
}

async function readStdinLine() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.includes('\n') || text.length > 4096) break;
  }
  return text.split(/\r?\n/)[0];
}

async function readPassword(login) {
  if (process.env.QEMUWEB_PASSWORD !== undefined) return process.env.QEMUWEB_PASSWORD;
  if (!process.stdin.isTTY) return readStdinLine();
  const first = await readHiddenLine(`Password for ${login}: `);
  const second = await readHiddenLine('Repeat the password: ');
  if (first !== second) fail('The passwords differ.');
  return first;
}

function checkPassword(password) {
  if (typeof password !== 'string' || !password) fail('The password must not be empty.');
  if (password.length > 1024) fail('The password is too long (maximum 1024 characters).');
  return password;
}

function parseCsv(text) {
  const entries = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(',').map(field => field.trim());
    if (index === 0 && fields[0].toLowerCase() === 'login') continue;
    if (fields.length < 2 || fields.length > 3) fail(`Line ${index + 1}: expected login,password[,role].`);
    const [login, password, role = 'student'] = fields;
    try {
      validateLogin(login);
      validateRole(role);
      checkPassword(password);
    } catch (error) { fail(`Line ${index + 1}: ${error.message}`); }
    entries.push({login, password, role});
  }
  return entries;
}

async function main(args) {
  const file = usersFilePath(root);
  const [command, ...rest] = args;
  const users = () => readUsers(file);
  const find = (list, login) => list.find(user => user.login === login);
  switch (command) {
    case 'add': {
      const [login, ...options] = rest;
      validateLogin(login);
      let role = 'student';
      if (options.length) {
        if (options.length !== 2 || options[0] !== '--role') fail(USAGE, 2);
        role = validateRole(options[1]);
      }
      const list = users();
      if (find(list, login)) fail(`User ${login} already exists; use passwd to change the password.`);
      const hash = await hashPassword(checkPassword(await readPassword(login)));
      writeUsers(file, [...list, {login, hash, role}]);
      console.log(`Added ${login} (${role}) to ${file}.`);
      return;
    }
    case 'passwd': {
      const [login] = rest;
      if (rest.length !== 1) fail(USAGE, 2);
      validateLogin(login);
      const list = users();
      const user = find(list, login);
      if (!user) fail(`Unknown user ${login}.`);
      user.hash = await hashPassword(checkPassword(await readPassword(login)));
      writeUsers(file, list);
      console.log(`Password changed for ${login}.`);
      return;
    }
    case 'role': {
      const [login, role] = rest;
      if (rest.length !== 2) fail(USAGE, 2);
      validateLogin(login);
      validateRole(role);
      const list = users();
      const user = find(list, login);
      if (!user) fail(`Unknown user ${login}.`);
      user.role = role;
      writeUsers(file, list);
      console.log(`${login} is now ${role}.`);
      return;
    }
    case 'remove': {
      const [login] = rest;
      if (rest.length !== 1) fail(USAGE, 2);
      validateLogin(login);
      const list = users();
      if (!find(list, login)) fail(`Unknown user ${login}.`);
      writeUsers(file, list.filter(user => user.login !== login));
      console.log(`Removed ${login}. A session it already opened stays on the server until deleted or restarted.`);
      return;
    }
    case 'list': {
      if (rest.length) fail(USAGE, 2);
      for (const user of users()) console.log(`${user.login}\t${user.role}`);
      return;
    }
    case 'import-csv': {
      const [csv] = rest;
      if (rest.length !== 1) fail(USAGE, 2);
      const entries = parseCsv(fs.readFileSync(csv, 'utf8'));
      const logins = entries.map(entry => entry.login);
      if (new Set(logins).size !== logins.length) fail('The CSV file lists a login twice.');
      const list = users();
      let added = 0, updated = 0;
      for (const entry of entries) {
        const hash = await hashPassword(entry.password);
        const user = find(list, entry.login);
        if (user) { Object.assign(user, {hash, role: entry.role}); updated++; }
        else { list.push({login: entry.login, hash, role: entry.role}); added++; }
      }
      writeUsers(file, list);
      console.log(`Imported ${entries.length} account${entries.length === 1 ? '' : 's'} (${added} added, ${updated} updated) into ${file}.`);
      return;
    }
    case undefined: case '-h': case '--help': case 'help':
      console.log(USAGE);
      return;
    default:
      fail(USAGE, 2);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exit(error.exitCode || 1);
  });
}

module.exports = {main, parseCsv};
