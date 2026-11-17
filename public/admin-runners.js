// "Runners" panel of /admin: the runners the server knows (read-only), with their engines,
// resources, configuration warnings and sessions; when none is online, the command that starts
// one. Nothing is registered here: a runner dials the server (docs/deployment.md).
// api(path) and cell(content) come from admin.js.
// Inline Lucide icon TriangleAlert (License: /icons/LICENSE-lucide.txt).
const WARNING_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';

const gigabytes = bytes => (Number.isFinite(bytes) ? `${(bytes / 2 ** 30).toFixed(1)} GB` : '—');

function warningList(warnings) {
  const list = document.createElement('ul');
  list.className = 'runner-warnings';
  for (const warning of warnings) {
    const item = document.createElement('li');
    item.insertAdjacentHTML('afterbegin', WARNING_ICON);
    item.append(Object.assign(document.createElement('span'), {textContent: warning}));
    list.append(item);
  }
  return list;
}

function renderRunners({runners, connectHint}, {body, hint, cell}) {
  body.replaceChildren(...runners.map(runner => {
    const row = document.createElement('tr');
    const state = Object.assign(document.createElement('span'), {className: 'session-state', textContent: runner.state === 'online' ? 'online' : 'starting'});
    state.dataset.state = runner.state === 'online' ? 'active' : 'idle';
    const engines = runner.engines.map(engine => (engine === 'vbox' ? 'VirtualBox' : 'QEMU')).join(', ') || 'none';
    const kvm = runner.engines.includes('qemu') ? (runner.kvm ? ', KVM' : ', no KVM') : '';
    row.append(cell(runner.id), cell(state), cell(`${engines}${kvm}`),
      cell(`${runner.cpus ?? '—'} CPU, ${gigabytes(runner.memoryBytes)}`), cell(runner.systems.join(', ') || '—'),
      cell(String(runner.sessions)), cell(runner.warnings.length ? warningList(runner.warnings) : '—'));
    row.cells[6].className = 'runner-warning-cell';
    return row;
  }));
  hint.hidden = runners.length > 0;
  hint.replaceChildren();
  if (!runners.length) {
    hint.append(connectHint ? 'No runner is connected. Start one on this machine with ' : 'No runner is connected yet.');
    if (connectHint) hint.append(Object.assign(document.createElement('code'), {textContent: connectHint}));
  }
}

// Returns refresh(): fetches and draws the table; errors are shown in `status`.
export function createRunnersPanel({api, cell, body, hint, status}) {
  return async function refreshRunners() {
    try {
      const data = await api('/runners');
      renderRunners(data, {body, hint, cell});
      status.textContent = '';
    } catch (error) { status.textContent = `Not updated: ${error.message}`; }
  };
}
