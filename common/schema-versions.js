'use strict';

// Version of each JSON file format. Readers accept only this value and reject any other.
// Since 0.9.0, every change of a format increments its number and comes with an explicit
// decision on compatibility (see docs/json-files.md).
module.exports = {
  SESSION_SCHEMA_VERSION: 1,
  HOST_SCHEMA_VERSION: 2,
  SWITCH_SCHEMA_VERSION: 1,
  CONFIG_SCHEMA_VERSION: 2
};
