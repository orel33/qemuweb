// The rules of the Accounts tab of /admin that depend on the authentication mode of the server (authMode of
// /auth/me: 'password', 'proxy' or 'off'). Pure functions, read by admin.js.

const NOTES = {
  password: {title: 'Authentication: password', option: '--auth password',
    text: 'Users sign in with a login and a password of this list. A login that is not listed is refused.'},
  proxy: {title: 'Authentication: proxy', option: '--auth proxy',
    text: 'Users sign in through the front end. A login that is not listed is a student. Add an account only to make someone an administrator or to disable them.'},
  off: {title: 'Authentication: off', option: '--no-auth',
    text: 'There is no sign-in: everyone shares one local session, and these accounts are not used.'}
};

export function authNote(mode) {
  return NOTES[mode] || null;
}

// The Create account dialog. With --auth proxy an account needs no password: the field only appears when the
// administrator asks for one. In the other modes a password is required and there is nothing to ask.
export function createAccountForm(mode, alsoPassword) {
  const proxy = mode === 'proxy';
  return {passwordChoice: proxy, passwordField: !proxy || !!alsoPassword, loginHint: proxy};
}

export function createAccountBody(mode, {login, role, password, alsoPassword}) {
  return createAccountForm(mode, alsoPassword).passwordField ? {login, role, password} : {login, role, noPassword: true};
}
