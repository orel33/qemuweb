// Pure rules of the tabs of /admin (no DOM, no import: the unit tests load this file as is).
// The tab list is data: add an entry here (and a section with that panel id in admin.html) for a new tab.
// `badge` names the data source of the tab's badge, if it has one (admin.js maps it to an API route).
export const TABS = [
  {id: 'sessions', label: 'Sessions', panel: 'panel-sessions', badge: true},
  {id: 'accounts', label: 'Accounts', panel: 'panel-accounts', badge: true},
  {id: 'runners', label: 'Runners', panel: 'panel-runners', badge: true},
  {id: 'websocket', label: 'WebSocket', panel: 'panel-websocket', badge: true},
  {id: 'logs', label: 'Logs', panel: 'panel-logs', badge: false}
];

// "#runners" -> "runners"; an unknown or empty fragment gives the first tab.
export function tabFromHash(hash, tabs = TABS) {
  const id = String(hash || '').replace(/^#/, '');
  return tabs.some(tab => tab.id === id) ? id : tabs[0].id;
}

// The tab a navigation key goes to, from the current one, or null for any other key.
// Left and Right wrap around; Home and End jump to the first and the last tab.
export function tabForKey(tabs, currentId, key) {
  const index = Math.max(0, tabs.findIndex(tab => tab.id === currentId));
  const target = {
    ArrowRight: (index + 1) % tabs.length,
    ArrowLeft: (index - 1 + tabs.length) % tabs.length,
    Home: 0,
    End: tabs.length - 1
  }[key];
  return target === undefined ? null : tabs[target].id;
}

// The badge of a tab from the data its API route returned: {count, level, text}, or null when
// there is nothing to show. level is "warning" for a problem and "neutral" for a plain count.
export function badgeFor(tabId, data) {
  if (tabId === 'sessions') {
    const count = (Array.isArray(data) ? data : []).filter(session => session.active).length;
    return count ? {count, level: 'neutral', text: `${count} active`} : null;
  }
  if (tabId === 'accounts') {
    const count = (Array.isArray(data) ? data : []).filter(user => user.disabled).length;
    return count ? {count, level: 'neutral', text: `${count} disabled`} : null;
  }
  if (tabId === 'runners') {
    const runners = Array.isArray(data?.runners) ? data.runners : [];
    const offline = runners.filter(runner => runner.state === 'offline' || runner.state === 'lost').length;
    const paused = runners.filter(runner => runner.paused && runner.state !== 'offline' && runner.state !== 'lost').length;
    const count = offline + paused;
    if (!count) return null;
    const parts = [offline ? `${offline} offline` : '', paused ? `${paused} paused` : ''].filter(Boolean);
    return {count, level: offline ? 'warning' : 'neutral', text: parts.join(', ')};
  }
  if (tabId === 'websocket') {
    const count = Number(data?.polling) || 0;
    return count ? {count, level: 'warning', text: `${count} on polling`} : null;
  }
  return null;
}

// Accessible name of a tab: "Runners, 2 offline" with a badge, "Runners" without.
export function tabLabel(label, badge) {
  return badge ? `${label}, ${badge.text}` : label;
}

// Which panels refresh on a poll tick: only the visible tab's panel, none while the page is hidden.
export function panelsToRefresh({activeId, pageVisible}) {
  return pageVisible && activeId ? [activeId] : [];
}
