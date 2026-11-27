// Sessions tab of /admin: the presence of a user and the text of the Runner column (ADM03). A session placed on a runner shows
// the runner's name and ID ("salle-12 (r-1a2b3c4d)"), the local runner "local" (its name is its ID);
// a session without any node is placed on no runner (UXS02): "not placed".
export function sessionRunnerLabel({placed, runnerId, runnerName}) {
  if (!placed || !runnerId) return {text: 'not placed', title: 'No node: the session is placed on no runner'};
  const name = runnerName || runnerId;
  return {text: name === runnerId ? runnerId : `${name} (${runnerId})`, title: `Runner ${name}, ID ${runnerId}`};
}

// The mark next to a user: `browsers` counts their connected session pages (main pages, by Socket.IO).
// /admin opens no socket: without such a page, the admin's own row says "this page", never "online".
export function presenceLabel(browsers, own) {
  if (browsers > 0) {
    return {online: true, text: browsers > 1 ? `online ×${browsers}` : 'online', title: `${browsers} session page${browsers === 1 ? '' : 's'} connected`};
  }
  if (own) return {online: false, text: 'this page', title: 'You are on the Admin page; no session page of yours is connected'};
  return {online: false, text: 'offline', title: 'No session page connected; the session keeps running'};
}
