// Why a control is disabled by observation, Follow or an administrator's control: the pure rules
// (one sentence per state, '' when the control is usable) and how the reason is shown. A state is
// {observing, login, following, holding, admin}: the page observes the session of `login`, follows
// its view, holds control of it; `admin` is the administrator controlling the session, or null.

// Controls of the view (class view-control): one driver at a time.
export function viewReason({observing, login, following, admin}) {
  if (!observing) return admin ? `${admin} controls your view` : '';
  return following ? `The view follows ${login}; uncheck Follow to change it` : '';
}

// Actions that write, load or export (class write-action): never in an observation tab, control
// gives the keyboard of the consoles only.
export function writeReason({observing, login, holding}) {
  if (!observing) return '';
  return holding ? `You control the consoles of ${login}; this action stays with the user` : `Read-only: you observe the session of ${login}`;
}

// A control of either class, or of both (the action is refused whoever drives the view).
export function controlReason({view, write}, state) {
  return (write && writeReason(state)) || (view && viewReason(state)) || '';
}

// The Take control and Release control button: '' when usable. `taking`: the request is pending.
export function takeControlReason({holding, admin, taking}) {
  if (taking) return 'Taking control…';
  return admin && !holding ? `${admin} already controls this session` : '';
}

// The Follow box.
export function followReason({holding}) {
  return holding ? 'You hold control: the user follows your view' : '';
}

// Shows a reason as the tooltip of an element, or puts its normal tooltip back (reason ''). Like the
// other disabled controls, the reason is the title; a control with an aria-label or a text exposes
// it as its accessible description. The modules that own the control may change its title meanwhile:
// that title becomes the normal one.
const shown = new WeakMap();
let titles = null;
export function showReason(element, reason) {
  let entry = shown.get(element);
  const title = element.getAttribute('title');
  if (!reason) {
    if (!entry) return;
    shown.delete(element);
    if (title !== entry.reason) return;
    if (entry.normal === null) element.removeAttribute('title'); else element.setAttribute('title', entry.normal);
    return;
  }
  if (!entry) {
    entry = {normal: title, reason};
    shown.set(element, entry);
    titles ||= new MutationObserver(records => {
      for (const {target} of records) if (shown.has(target)) showReason(target, shown.get(target).reason);
    });
    titles.observe(element, {attributes: true, attributeFilter: ['title']});
  } else if (title !== entry.reason) entry.normal = title;
  entry.reason = reason;
  if (title !== reason) element.setAttribute('title', reason);
}
