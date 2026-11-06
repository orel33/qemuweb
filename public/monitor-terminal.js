(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MonitorTerminal = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  function isSupported(machine) {
    return !!(machine && machine.kind === 'vm' && typeof machine.engine === 'string' && machine.engine.startsWith('qemu'));
  }

  function terminalText(value) {
    return String(value || '').replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n');
  }

  function consumeInput(current, data, maxLength = 256) {
    let input = current;
    let echo = '';
    let command = null;
    let prompt = false;
    if (data.startsWith('\x1b')) return {input, echo, command, prompt};
    for (const character of data) {
      if (character === '\r' || character === '\n') {
        echo += '\r\n';
        command = input.trim() || null;
        input = '';
        prompt = command === null;
        break;
      }
      if (character === '\x03') {
        echo += '^C\r\n';
        input = '';
        prompt = true;
        break;
      }
      if (character === '\x7f' || character === '\b') {
        if (input) {
          input = input.slice(0, -1);
          echo += '\b \b';
        }
        continue;
      }
      if (character >= ' ' && character !== '\x7f' && input.length + character.length <= maxLength) {
        input += character;
        echo += character;
      }
    }
    return {input, echo, command, prompt};
  }

  return {consumeInput, isSupported, terminalText};
});
