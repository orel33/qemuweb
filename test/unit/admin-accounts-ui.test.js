// The Accounts tab of /admin follows the authentication mode: the note that names the mode and the Create
// account dialog (public/admin-accounts-rules.js, pure rules, and the markup of admin.html).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '..', '..', 'public');
const read = name => fs.readFileSync(path.join(publicDir, name), 'utf8');
const rules = () => import('../../public/admin-accounts-rules.js');

test('each authentication mode is named with its server option; an unknown mode shows nothing', async () => {
  const {authNote} = await rules();
  assert.equal(authNote('password').option, '--auth password');
  assert.equal(authNote('proxy').option, '--auth proxy');
  assert.equal(authNote('off').option, '--no-auth');
  assert.match(authNote('proxy').text, /not listed is a student/);
  assert.match(authNote('password').text, /not listed is refused/);
  assert.equal(authNote(undefined), null);
});

test('proxy: no password by default, one on request; the other modes require one', async () => {
  const {createAccountForm, createAccountBody} = await rules();
  assert.deepEqual(createAccountForm('proxy', false), {passwordChoice: true, passwordField: false, loginHint: true});
  assert.deepEqual(createAccountForm('proxy', true), {passwordChoice: true, passwordField: true, loginHint: true});
  for (const mode of ['password', 'off', undefined]) assert.deepEqual(createAccountForm(mode, false), {passwordChoice: false, passwordField: true, loginHint: false}, String(mode));
  const input = {login: 'alice', role: 'admin', password: 'secret', alsoPassword: false};
  assert.deepEqual(createAccountBody('proxy', input), {login: 'alice', role: 'admin', noPassword: true});
  assert.deepEqual(createAccountBody('proxy', {...input, alsoPassword: true}), {login: 'alice', role: 'admin', password: 'secret'});
  assert.deepEqual(createAccountBody('password', input), {login: 'alice', role: 'admin', password: 'secret'});
});

test('the page has the note and the dialog elements, and no longer the old checkbox', () => {
  const html = read('admin.html'), script = read('admin.js');
  for (const id of ['accounts-auth', 'accounts-auth-title', 'accounts-auth-option', 'accounts-auth-text', 'new-login-hint', 'new-password-choice', 'new-also-password', 'new-password-field']) {
    assert.ok(html.includes(`id="${id}"`), id);
    assert.ok(script.includes(`$('${id}')`), `${id} is used`);
  }
  assert.doesNotMatch(html + script, /new-no-password/);
  assert.match(html, /Also set a password \(only used if the server is restarted with <code>--auth password<\/code>\)/);
});
