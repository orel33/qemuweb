// Why a control is disabled by observation, Follow or an administrator's control: the pure rules
// (one sentence per state, '' when the control is usable) and how the reason is shown. A state is
// {observing, login, following, holding, admin}: the page observes the session of `login`, follows
// its view, holds control of it; `admin` is the administrator controlling the session, or null.

// Controls of the view (class view-control): one driver at a time.
export function viewReason({observing, login, following, admin}) {
  if (!observing) return admin ? `${admin} controls your view` : '';
  return following ? `The view follows ${login}; uncheck Follow to change it` : '';
}

// Actions that write, load or export (class write-action): one driver at a time, like the view.
// The admin holding control does what the owner can, except Delete session (class owner-only,
// done from the admin page); an observer without control reads only; the owner's page is
// read-only while an admin controls its session.
export function writeReason({observing, login, holding, admin}, {ownerOnly = false} = {}) {
  if (!observing) return admin ? `${admin} controls your session` : '';
  if (!holding) return `Read-only: you observe the session of ${login}`;
  return ownerOnly ? `Delete the session of ${login} from the admin page` : '';
}

// Whether this page may write to the session it shows: the owner when nobody controls it, the
// admin holding control.
export function canWrite({observing, holding, admin}) {
  return observing ? !!holding : !admin;
}

// A control of either class, or of both (the action is refused whoever drives the view).
export function controlReason({view, write, ownerOnly = false}, state) {
  return (write && writeReason(state, {ownerOnly})) || (view && viewReason(state)) || '';
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

// The banner of the owner's page (one line, its explanation in the tooltip), or null when none
// shows: while an administrator controls the session, that control; else while administrators
// observe it (the logins, from session-observers), the observation.
export function ownerBanner({admin, observers = []}) {
  if (admin) {
    return {kind: 'control', text: `${admin} controls your session: keyboard, actions and view`,
      title: `You see the commands and their output; your keyboard and your actions are blocked, and ${admin} controls your view.`};
  }
  if (!observers.length) return null;
  const who = observers.length === 1 ? `${observers[0]} is` : observers.length === 2 ? `${observers[0]} and ${observers[1]} are` : `${observers.length} administrators are`;
  return {kind: 'observed', text: `${who} observing your session`,
    title: `Read-only observation by ${observers.join(', ')}: they see your consoles and your view, and cannot type or act.`};
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
