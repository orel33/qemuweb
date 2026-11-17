// Console tab of the Host Settings dialog: the serial ports of the host (ttyS0 always on, ttyS1
// optional) and the read-only console and monitor sockets of the launch preview.
import {addSettingRow, addSettingTextRow} from './host-settings.js';

// A checkbox row for one serial port.
function addPortRow(container, port, description, checked, disabled, onChange) {
  const row = document.createElement('div');
  row.className = 'setting-row';
  const title = document.createElement('span');
  title.className = 'setting-label';
  title.textContent = port;
  const content = document.createElement('label');
  content.className = 'create-autostart setting-value';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.disabled = disabled;
  input.addEventListener('change', () => onChange(input.checked));
  content.append(input, description);
  row.append(title, content);
  container.append(row);
}

// editable and readOnly are the tab's two containers; ports is the host's list, limit the list
// its system exposes (store.images[].serialPorts); onChange(ports) saves the new list.
export function renderConsoleSettings(editable, readOnly, {body, ports, limit, locked, onChange}) {
  const [main, second] = ConsoleId.PORTS;
  addPortRow(editable, main, 'main console, always on', true, true, () => {});
  const exposed = limit.includes(second);
  addPortRow(editable, second, exposed ? 'second console' : 'not exposed by this system', exposed && ports.includes(second), locked || !exposed,
    checked => onChange(checked ? [main, second] : [main]));
  if (!exposed) addSettingTextRow(editable, '', `This system exposes only ${limit.join(', ')}.`);
  addSettingRow(readOnly, 'Serial ports', ports.join(', '));
  addSettingRow(readOnly, 'Console socket', body.console?.socket || '');
  if (body.console2) addSettingRow(readOnly, 'Second console socket', body.console2.socket);
  if (body.monitor) addSettingRow(readOnly, 'Monitor socket', body.monitor);
}
