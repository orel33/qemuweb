(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SessionLog = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  function append(machine, line, limit = 1000) {
    if (!Array.isArray(machine.logs)) machine.logs = [];
    machine.logs.push(String(line));
    if (machine.logs.length > limit) {
      machine.logs.splice(0, machine.logs.length - limit);
      return true;
    }
    return false;
  }

  function reset(machine) {
    machine.logs = [];
  }

  function terminalText(machine) {
    if (!machine || !Array.isArray(machine.logs) || machine.logs.length === 0) return 'No session log entries yet.\r\n';
    return `${machine.logs.join('\n').replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n')}\r\n`;
  }

  function terminalEntry(line) {
    return `${String(line)}\n`.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n');
  }

  return {append, reset, terminalEntry, terminalText};
});
