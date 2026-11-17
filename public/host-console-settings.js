// Console tab of the Host Settings dialog: the read-only console and monitor sockets of the launch
// preview (one per serial port of the host, ttyS0 and optionally ttyS1).
import {addSettingRow} from './host-settings.js';

export function renderConsoleSettings(container, {body}) {
  const [main, second] = ConsoleId.PORTS;
  addSettingRow(container, `Console socket (${main})`, body.console?.socket || '');
  if (body.console2) addSettingRow(container, `Console socket (${second})`, body.console2.socket);
  if (body.monitor) addSettingRow(container, 'Monitor socket', body.monitor);
}
