'use strict';

// Hides the guest startup hook's QEMUWEB_START_* marker lines from serial output.

function plainSerialLine(line) {
  return line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
}

function standaloneTerminalControl(text) {
  return /^(?:\r|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[78])+$/.test(text);
}

function possibleGuestHookLine(line) {
  const plain = plainSerialLine(line);
  if (plain.length > 160) return false;
  if (plain.startsWith('\x1b')) return true; // Wait for a split ANSI sequence.
  // OpenRC writes its service label immediately before the hook's first line.
  const openRcPrefix = ' * QemuWeb guest startup ...';
  if (openRcPrefix.startsWith(plain) || plain.startsWith(openRcPrefix)) return true;
  const timestamp = /^\[\s*[\d.]*\]\s*(.*)$/.exec(plain);
  if (timestamp) return 'qemuweb-guest-start'.startsWith(timestamp[1]) || timestamp[1].startsWith('qemuweb-guest-start');
  if (/^\[\s*[\d.]*$/.test(plain)) return true;
  return ['qemuweb-guest-start', 'QEMUWEB_START_'].some(prefix => prefix.startsWith(plain) || plain.startsWith(prefix));
}

function filterGuestHookSerial(node, text) {
  let visible = '';
  for (const char of text) {
    if (node.serialFilterPassThrough) {
      visible += char;
      if (char === '\n') node.serialFilterPassThrough = false;
      continue;
    }
    node.serialFilterPending += char;
    if (char === '\n') {
      if (!/(?:qemuweb-guest-start\[\d+\]:\s*)?QEMUWEB_START_(?:BEGIN|EXIT)\b/.test(plainSerialLine(node.serialFilterPending))) {
        visible += node.serialFilterPending;
      }
      node.serialFilterPending = '';
    } else if (standaloneTerminalControl(node.serialFilterPending)) {
      // Pass CR and complete terminal controls without waiting for a newline.
      visible += node.serialFilterPending;
      node.serialFilterPending = '';
    } else if (!possibleGuestHookLine(node.serialFilterPending)) {
      visible += node.serialFilterPending;
      node.serialFilterPending = '';
      node.serialFilterPassThrough = true;
    }
  }
  return visible;
}

module.exports = {plainSerialLine, standaloneTerminalControl, possibleGuestHookLine, filterGuestHookSerial};
