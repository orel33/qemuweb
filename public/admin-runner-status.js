// "Runner status" section of the Runners tab of /admin (ADM04): for one runner chosen in a select, what
// scripts/status.sh shows for a runner of this machine (the runner process, each session with its nodes,
// the totals), from GET /api/admin/runners/:id/status, which the runner itself measures (runner.status),
// so a remote runner works too. It refreshes with the Runners panel (admin-runners.js), that is only
// while the tab is visible (admin-tabs.js), and asks only the selected runner.
// The pure parts (no DOM, no import) come first: the unit tests load them in a vm context.
// Text that comes from a runner (names, logins) is always set with textContent.

const pad = value => String(value).padStart(2, '0');

// 3725 -> "01:02:05", with days in front: "2d 01:02:05"; unknown -> "—".
export function duration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const total = Math.max(0, Math.round(seconds));
  const days = Math.floor(total / 86400);
  const clock = `${pad(Math.floor(total % 86400 / 3600))}:${pad(Math.floor(total % 3600 / 60))}:${pad(total % 60)}`;
  return days ? `${days}d ${clock}` : clock;
}

export const megabytes = bytes => (Number.isFinite(bytes) ? `${Math.round(bytes / 2 ** 20)} MB` : '—');
export const percent = cpu => (Number.isFinite(cpu) ? `${cpu < 10 ? cpu.toFixed(1) : Math.round(cpu)}% CPU` : '— CPU');
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

// The options of the runner select: every runner (name and ID), only the online ones selectable.
export function runnerOptions(runners) {
  return (Array.isArray(runners) ? runners : []).map(runner => ({value: runner.id, disabled: runner.state !== 'online',
    label: `${runner.name} (${runner.id})${runner.state === 'online' ? '' : ` · ${runner.state}`}`}));
}

// The runner to show: the selected one while it is listed, else the first online runner, else the first one, else ''.
export function chooseRunner(runners, selectedId) {
  const list = Array.isArray(runners) ? runners : [];
  if (selectedId && list.some(runner => runner.id === selectedId)) return selectedId;
  return (list.find(runner => runner.state === 'online') || list[0])?.id || '';
}

// "Runner offline", "No session", "No runner" or null when there is something to show.
export function emptyState(runner, status) {
  if (!runner) return 'No runner';
  if (runner.state !== 'online') return 'Runner offline';
  if (status && !status.sessions.length) return 'No session';
  return null;
}

// Memory in use over memory configured: "300 MB / 512 MB", "300 MB" without a configured value.
export const memoryText = (rssBytes, memoryMb) => (Number.isFinite(memoryMb) && memoryMb > 0 ? `${megabytes(rssBytes)} / ${memoryMb} MB` : megabytes(rssBytes));

// "2 / 3 hosts, 1 / 1 switch": running over existing.
export const machineText = totals => `${totals.runningHosts} / ${plural(totals.hosts, 'host')}, ${totals.runningSwitches} / ${plural(totals.switches, 'switch', 'switches')}`;

export function runnerText(runner) {
  return [`pid ${runner.pid ?? '—'}`, `up ${duration(runner.uptimeSeconds)}`, megabytes(runner.rssBytes), percent(runner.cpuPercent)].join(' · ');
}

export function sessionText(session) {
  return [`Session ${session.sessionId}`, session.owner || '?', `up ${duration(session.ageSeconds)}`, machineText(session.totals),
    memoryText(session.totals.rssBytes, session.totals.memoryMb), percent(session.totals.cpuPercent)].join(' · ');
}

export function totalsText(totals) {
  return ['Total', machineText(totals), memoryText(totals.rssBytes, totals.memoryMb), percent(totals.cpuPercent)].join(' · ');
}

const ENGINES = {qemu: 'QEMU', vbox: 'VirtualBox', vde: 'VDE'};
// The cells of a node row: name, kind, system, engine, pid, memory, CPU.
export function nodeCells(node) {
  return [node.name || node.id, node.kind, node.system || '—', ENGINES[node.engine] || node.engine || '—',
    node.running ? String(node.pid ?? '—') : 'stopped', node.running ? memoryText(node.rssBytes, node.memoryMb) : (node.memoryMb ? `— / ${node.memoryMb} MB` : '—'),
    node.running ? percent(node.cpuPercent).replace(' CPU', '') : '—'];
}

// The section itself. elements: select, summary (the runner process line), message (the empty state
// or an error), body (tbody of the node table), totals. api(path) comes from admin.js.
export function createRunnerStatusPanel({api, elements}) {
  const {select, summary, message, body, totals} = elements;
  let runners = [];
  let selectedId = '';
  let sequence = 0;

  const show = (text, {keepTable = false} = {}) => {
    message.textContent = text || '';
    message.hidden = !text;
    if (!keepTable) { body.replaceChildren(); totals.textContent = ''; }
  };

  function fillSelect() {
    const options = runnerOptions(runners);
    const same = select.options.length === options.length && options.every((option, index) =>
      select.options[index].value === option.value && select.options[index].textContent === option.label && select.options[index].disabled === option.disabled);
    if (!same) {
      select.replaceChildren(...options.map(option => {
        const element = new Option(option.label, option.value);
        element.disabled = option.disabled;
        return element;
      }));
    }
    select.value = selectedId;
    select.disabled = !options.length;
  }

  function render(status) {
    summary.textContent = `Runner process: ${runnerText(status.runner)}`;
    body.replaceChildren(...status.sessions.flatMap(session => {
      const head = document.createElement('tr');
      head.className = 'runner-status-session';
      const cell = Object.assign(document.createElement('th'), {colSpan: 7, scope: 'rowgroup', textContent: sessionText(session)});
      head.append(cell);
      return [head, ...session.nodes.map(node => {
        const row = document.createElement('tr');
        for (const value of nodeCells(node)) row.append(Object.assign(document.createElement('td'), {textContent: value}));
        return row;
      })];
    }));
    totals.textContent = `${totalsText(status.totals)}${status.truncated ? ' (list truncated)' : ''}`;
  }

  // Refreshes the section with the runner list of the panel (one GET /runners/:id/status for the selected runner).
  async function update(list = runners) {
    runners = Array.isArray(list) ? list : [];
    selectedId = chooseRunner(runners, selectedId);
    fillSelect();
    const runner = runners.find(item => item.id === selectedId);
    const empty = emptyState(runner, null);
    const request = ++sequence;
    if (empty) { summary.textContent = ''; show(empty); return; }
    try {
      const status = await api(`/runners/${encodeURIComponent(runner.id)}/status`);
      if (request !== sequence) return;
      render(status);
      show(emptyState(runner, status), {keepTable: true});
    } catch (problem) {
      if (request !== sequence) return;
      // A runner that went offline meanwhile: the empty state, not an error.
      show(/offline/i.test(problem.message) ? 'Runner offline' : `Not updated: ${problem.message}`, {keepTable: !/offline/i.test(problem.message)});
      if (/offline/i.test(problem.message)) summary.textContent = '';
    }
  }

  select.addEventListener('change', () => {
    selectedId = select.value;
    summary.textContent = '';
    body.replaceChildren();
    totals.textContent = '';
    update();
  });
  return update;
}
