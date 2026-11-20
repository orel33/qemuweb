// The engine badge of the header, after the beta badge: the engine of the session the page shows
// (the observed one while an administrator observes), as `qemu` or `vbox`.

// {text, label} of an engine, or null for an unknown value (the badge is then hidden).
export function engineBadge(engine) {
  if (engine === 'qemu') return {text: 'qemu', label: 'Session engine: QEMU (KVM)'};
  if (engine === 'vbox') return {text: 'vbox', label: 'Session engine: VirtualBox'};
  return null;
}

// Shows the badge for an engine, or hides it when the engine is not known.
export function showEngineBadge(engine) {
  const element = document.getElementById('engine-badge');
  if (!element) return;
  const badge = engineBadge(engine);
  element.hidden = !badge;
  element.textContent = badge ? badge.text : '';
  if (badge) { element.title = badge.label; element.setAttribute('aria-label', badge.label); }
  else { element.removeAttribute('title'); element.removeAttribute('aria-label'); }
}
