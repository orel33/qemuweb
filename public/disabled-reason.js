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
// The admin holding control does what the owner can, Reset session included; an observer
// without control reads only; the owner's page is read-only while an admin controls its session.
export function writeReason({observing, login, holding, admin}) {
  if (!observing) return admin ? `${admin} controls your session` : '';
  return holding ? '' : `Read-only: you observe the session of ${login}`;
}

// Whether this page may write to the session it shows: the owner when nobody controls it, the
// admin holding control.
export function canWrite({observing, holding, admin}) {
  return observing ? !!holding : !admin;
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

// The observation and control banners: one sentence "<who> is observing | is controlling <whose
// session>", the same verb forms on both sides, the logins in bold (parts {login}) and nothing
// else, the long explanation in the tooltip (title). A banner is {kind, parts, text, title}:
// parts are strings and {login} objects, text is their plain concatenation.
const banner = (kind, parts, title) => ({kind, parts,
  text: parts.map(part => (typeof part === 'string' ? part : part.login)).join(''), title});

// The banner of the observer's page: while this admin holds control (kind 'controlling'), while
// another admin does ('other'), else the read-only observation ('observing'), whose tooltip says
// whether the view follows the owner.
export function observerBanner({login, holding, admin, following}) {
  if (holding) {
    return banner('controlling', ['You are controlling the session of ', {login}],
      `Your keyboard, actions and view drive the session of ${login}; the page of ${login} is read-only and follows your view. Release control to give it back.`);
  }
  if (admin) {
    return banner('other', [{login: admin}, ' is controlling the session of ', {login}],
      `Read-only: ${admin} holds control of the session of ${login}.`);
  }
  return banner('observing', ['You are observing the session of ', {login}],
    `Read-only: you see the consoles and the view of ${login} and cannot type or act. ${following
      ? `Your view follows the view of ${login}; uncheck Follow to change it.` : 'Follow is unchecked: your view is your own.'}`);
}

// The banner of the owner's page, or null when none shows: while an administrator controls the
// session, that control ('control'); else while administrators observe it (the logins, from
// session-observers), the observation ('observed').
export function ownerBanner({admin, observers = []}) {
  if (admin) {
    return banner('control', [{login: admin}, ' is controlling your session'],
      `You see the commands and their output; your keyboard and your actions are blocked, and ${admin} drives your view.`);
  }
  if (!observers.length) return null;
  const who = observers.length === 1 ? [{login: observers[0]}, ' is']
    : observers.length === 2 ? [{login: observers[0]}, ' and ', {login: observers[1]}, ' are'] : [`${observers.length} administrators are`];
  return banner('observed', [...who, ' observing your session'],
    `Read-only observation by ${observers.join(', ')}: they see your consoles and your view, and cannot type or act.`);
}

// Fills an element with a banner's parts: the logins in <strong>, the rest as text.
export function renderBannerParts(element, parts = []) {
  element.replaceChildren(...parts.map(part => {
    if (typeof part === 'string') return document.createTextNode(part);
    const strong = document.createElement('strong');
    strong.textContent = part.login;
    return strong;
  }));
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
