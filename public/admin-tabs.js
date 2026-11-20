// Tab bar of /admin: one section (panel) visible at a time, the tab kept in the URL fragment,
// keyboard and ARIA tab pattern, a badge on the tab label, and the refresh rules: only the visible
// tab's panel polls, nothing polls while the browser tab is hidden, the badges of every tab refresh at a low rate.
// admin.js gives the refresh function of each panel and the data of each badge; the rules are in admin-tabs-rules.js.
import {TABS, tabFromHash, tabForKey, badgeFor, tabLabel, panelsToRefresh} from './admin-tabs-rules.js';

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

// refresh[id]({polling}) refreshes the panel of tab id; badgeData[id]() resolves the data its badge is computed from;
// isBusy() is true while a dialog is open (a poll tick is skipped then).
export function createAdminTabs({bar, refresh, badgeData, isBusy = () => false, tabs = TABS, pollMs = 4000, badgeMs = 30000}) {
  let activeId = tabs[0].id;
  let pollTimer = null;
  let badgeTimer = null;
  const buttons = new Map();
  const badges = new Map();
  const panel = tab => document.getElementById(tab.panel);

  for (const tab of tabs) {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `tab-${tab.id}`;
    button.className = 'admin-tab';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', tab.panel);
    const label = document.createElement('span');
    label.textContent = tab.label;
    const badge = document.createElement('span');
    badge.className = 'admin-tab-badge';
    badge.hidden = true;
    badge.setAttribute('aria-hidden', 'true');
    button.append(label, badge);
    button.addEventListener('click', () => activate(tab.id, {updateHash: true}));
    button.addEventListener('keydown', event => {
      const target = tabForKey(tabs, tab.id, event.key);
      if (!target) return;
      event.preventDefault();
      activate(target, {updateHash: true, focus: true});
    });
    buttons.set(tab.id, button);
    badges.set(tab.id, badge);
    bar.append(button);
    const section = panel(tab);
    section.setAttribute('role', 'tabpanel');
    section.setAttribute('aria-labelledby', button.id);
  }

  function activate(id, {updateHash = false, focus = false} = {}) {
    const changed = id !== activeId || !bar.dataset.ready;
    activeId = id;
    bar.dataset.ready = 'true';
    for (const tab of tabs) {
      const selected = tab.id === id;
      const button = buttons.get(tab.id);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      const section = panel(tab);
      section.hidden = !selected;
      // A panel is a tab stop only when it holds nothing focusable.
      if (selected && !section.querySelector(FOCUSABLE)) section.tabIndex = 0; else section.removeAttribute('tabindex');
    }
    const button = buttons.get(id);
    if (focus) button.focus();
    button.scrollIntoView({block: 'nearest', inline: 'nearest'});
    if (updateHash && location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
    if (changed) refreshNow();
  }

  // The visible panel at once (a user action, a newly opened tab), then the badges, without waiting.
  function refreshNow() {
    refresh[activeId]?.({polling: false});
    refreshBadges();
  }

  function tick() {
    for (const id of panelsToRefresh({activeId, pageVisible: document.visibilityState === 'visible'})) {
      if (!isBusy()) refresh[id]?.({polling: true});
    }
  }

  async function refreshBadges() {
    if (document.visibilityState !== 'visible') return;
    await Promise.allSettled(tabs.filter(tab => tab.badge && badgeData[tab.id]).map(async tab => {
      const badge = badgeFor(tab.id, await badgeData[tab.id]());
      const element = badges.get(tab.id);
      element.hidden = !badge;
      element.textContent = badge ? String(badge.count) : '';
      element.dataset.level = badge ? badge.level : '';
      element.title = badge ? badge.text : '';
      buttons.get(tab.id).setAttribute('aria-label', tabLabel(tab.label, badge));
    }));
  }

  function startTimers() {
    stopTimers();
    pollTimer = setInterval(tick, pollMs);
    badgeTimer = setInterval(refreshBadges, badgeMs);
  }

  function stopTimers() {
    clearInterval(pollTimer);
    clearInterval(badgeTimer);
    pollTimer = badgeTimer = null;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { startTimers(); tick(); refreshBadges(); } else stopTimers();
  });
  window.addEventListener('hashchange', () => activate(tabFromHash(location.hash)));

  activate(tabFromHash(location.hash));
  if (document.visibilityState === 'visible') startTimers();
  return {active: () => activeId, refreshNow};
}
