// "Runners" panel of /admin: every registered runner (the local one included, no row is special) with its state, engines,
// resources, configuration warnings and sessions; pause (drain), revoke and remove; registration
// tokens for new remote runners (the command is shown once). A runner dials the server
// (docs/deployment.md). Text that comes from a runner (its name, address, warnings) is always
// set with textContent. api(path, options), cell(content) and confirm(...) come from admin.js.
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

const when = iso => (iso ? new Date(iso).toLocaleString() : '—');

function button(label, onClick, title = label) {
  const element = Object.assign(document.createElement('button'), {type: 'button', className: 'admin-tool', title});
  element.append(Object.assign(document.createElement('span'), {textContent: label}));
  element.addEventListener('click', onClick);
  return element;
}

function stateLabel(runner) {
  const label = Object.assign(document.createElement('span'), {className: 'session-state'});
  const text = {online: 'online', starting: 'starting', offline: 'offline', revoked: 'revoked'}[runner.state] || 'offline';
  label.textContent = runner.paused ? `${text}, paused` : text;
  label.dataset.state = runner.state === 'online' && !runner.paused ? 'active' : 'idle';
  return label;
}

function renderRunners(data, {body, hint, cell, act}) {
  const {runners, connectHint} = data;
  body.replaceChildren(...runners.map(runner => {
    const row = document.createElement('tr');
    const engines = runner.engines.map(engine => (engine === 'vbox' ? 'VirtualBox' : 'QEMU')).join(', ') || 'none';
    const kvm = runner.engines.includes('qemu') ? (runner.kvm ? ', KVM' : ', no KVM') : '';
    const where = document.createElement('div');
    where.textContent = runner.state === 'online' || runner.state === 'starting' ? (runner.address || 'this machine') : `last seen ${when(runner.lastSeen)}${runner.graceLeft === null ? '' : `, its sessions are dropped in ${runner.graceLeft} s`}`;
    // What the runner announced (display only): its directory and process ID.
    const announced = [runner.directory, runner.pid ? `pid ${runner.pid}` : ''].filter(Boolean).join(' · ');
    if (announced) {
      const small = Object.assign(document.createElement('small'), {textContent: announced});
      small.style.display = 'block';
      where.append(small);
    }
    const actions = document.createElement('div');
    actions.className = 'admin-actions';
    const id = encodeURIComponent(runner.id);
    actions.append(runner.paused
      ? button('Resume', () => act(() => `/runners/${id}/resume`, 'POST'), 'Resume: new sessions can be placed on this runner again')
      : button('Pause', () => act(() => `/runners/${id}/pause`, 'POST'), 'Pause: no new session is placed here; the running ones continue'));
    if (runner.state === 'offline' || runner.state === 'revoked') {
      actions.append(button('Drop sessions', () => act(() => `/runners/${id}/drop-sessions`, 'POST', {title: 'Drop sessions',
        message: `Drop the ${runner.sessions} session${runner.sessions === 1 ? '' : 's'} of ${runner.name} now, without waiting for the grace period? Their users get empty sessions; if the runner returns, it is told to delete them.`, accept: 'Drop'}),
      'The runner is not coming back: drop its sessions at once'));
    }
    if (runner.state !== 'revoked') {
      actions.append(button('Revoke', () => act(() => `/runners/${id}/revoke`, 'POST', {title: 'Revoke runner',
        message: `Revoke ${runner.name}? It is disconnected and cannot connect again; its sessions are dropped at once.`, accept: 'Revoke'}), 'Revoke the token of this runner'));
    }
    if (runner.state === 'revoked') {
      actions.append(button('Remove', () => act(() => `/runners/${id}`, 'DELETE'), 'Forget this revoked runner'));
    }
    row.append(cell(runner.name), cell(runner.id), cell(stateLabel(runner)), cell(where), cell(`${engines}${kvm}`),
      cell(`${runner.cpus ?? '—'} CPU, ${gigabytes(runner.memoryBytes)}`), cell(runner.systems.join(', ') || '—'),
      cell(runner.maxSessions ? `${runner.sessions} / ${runner.maxSessions}` : String(runner.sessions)),
      cell(runner.warnings.length ? warningList(runner.warnings) : '—'), cell(actions));
    row.cells[8].className = 'runner-warning-cell';
    return row;
  }));
  hint.hidden = runners.length > 0;
  hint.replaceChildren();
  if (!runners.length) {
    hint.append(connectHint ? 'No runner is connected. Start one on this machine with ' : 'No runner is connected yet.');
    if (connectHint) hint.append(Object.assign(document.createElement('code'), {textContent: connectHint}));
  }
}

function renderPending(data, {pending, act}) {
  pending.hidden = !data.registrationTokens.length;
  pending.replaceChildren(...data.registrationTokens.map(token => {
    const item = document.createElement('li');
    item.append(`Registration token ${token.id} (by ${token.by}) expires ${when(token.expiresAt)} `);
    item.append(button('Cancel', () => act(() => `/runners/registration-tokens/${token.id}`, 'DELETE')));
    return item;
  }));
}

// Returns refresh(): fetches and draws the table; errors are shown in `status`. `elements` are the
// panel's nodes: body, hint, status, pending (list of unused tokens), lifetime (select), create
// (button), tokenBox (where the new command is shown once) and error. updateStatus(runners) refreshes the
// "Runner status" section (admin-runner-status.js) with the same list, at each refresh of the panel.
export function createRunnersPanel({api, cell, confirm, elements, updateStatus = async () => {}}) {
  const {body, hint, status, pending, lifetime, create, tokenBox, error} = elements;
  async function refresh() {
    try {
      const data = await api('/runners');
      if (!lifetime.options.length) {
        for (const minutes of data.lifetimes) lifetime.append(new Option(minutes >= 60 ? `${minutes / 60} h` : `${minutes} min`, String(minutes)));
        lifetime.value = '60';
      }
      renderRunners(data, {body, hint, cell, act});
      renderPending(data, {pending, act});
      status.textContent = `Sessions of a runner that lost its connection (or of a server that restarted) are kept ${data.runnerGraceSeconds} s.`;
      await updateStatus(data.runners);
    } catch (problem) { status.textContent = `Not updated: ${problem.message}`; }
  }
  // confirmation: {title, message, accept} asked first; the path is built lazily, the result shown by refresh.
  async function act(path, method, confirmation = null) {
    error.hidden = true;
    try {
      if (confirmation && !await confirm(confirmation.title, confirmation.message, [], confirmation.accept)) return;
      await api(path(), {method});
    } catch (problem) { error.textContent = problem.message; error.hidden = false; }
    await refresh();
  }
  create.addEventListener('click', async () => {
    error.hidden = true;
    try {
      const created = await api('/runners/registration-tokens', {method: 'POST', body: {minutes: Number(lifetime.value)}});
      tokenBox.replaceChildren(`Run this on the runner machine within ${lifetime.selectedOptions[0].textContent}; the token is shown only now: `,
        Object.assign(document.createElement('code'), {textContent: created.command}));
      tokenBox.hidden = false;
    } catch (problem) { error.textContent = problem.message; error.hidden = false; }
    await refresh();
  });
  return refresh;
}
