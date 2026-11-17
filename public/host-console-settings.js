// Console tab of the Host Settings dialog: the number of serial consoles (ttyS0, ttyS1) and the
// read-only console and monitor sockets of the launch preview.
import {addSettingRow, addSettingSelectRow, addSettingTextRow} from './host-settings.js';

// editable and readOnly are the tab's two containers; limit is how many consoles the system
// exposes (store.images[].serialConsoles); onChange(count) saves the new value.
export function renderConsoleSettings(editable, readOnly, {body, count, limit, locked, onChange}) {
  addSettingSelectRow(editable, 'Serial consoles', [[1, '1 · ttyS0'], [2, '2 · ttyS0 and ttyS1']].slice(0, Math.max(1, limit)),
    Math.min(count, limit), locked || limit < 2, value => onChange(Number(value)));
  if (limit < 2) addSettingTextRow(editable, '', 'This system exposes only ttyS0.');
  addSettingRow(readOnly, 'VM serial port', body.console?.guest || 'ttyS0 · 115200 baud');
  addSettingRow(readOnly, 'Console socket', body.console?.socket || '');
  if (body.console2) {
    addSettingRow(readOnly, 'Second serial port', body.console2.guest);
    addSettingRow(readOnly, 'Second console socket', body.console2.socket);
  }
  if (body.monitor) addSettingRow(readOnly, 'Monitor socket', body.monitor);
}
