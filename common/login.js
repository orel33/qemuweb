'use strict';

// The login names of the accounts: a short, safe character set. It is also the name of the runtime/users/<login> alias a
// runner keeps (runner/runtime-tidy.js), and the owner a session.create command carries.
const LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

module.exports = {LOGIN_PATTERN};
