'use strict';

// Quotes a value for display in logged shell command lines.

function shellQuote(value) {
  const text = String(value);
  return /^[a-zA-Z0-9_./:=,+-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

module.exports = {shellQuote};
