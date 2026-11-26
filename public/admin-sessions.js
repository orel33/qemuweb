// Sessions tab of /admin: the text of the Runner column (ADM03). A session placed on a runner shows
// the runner's name and ID ("salle-12 (r-1a2b3c4d)"), the local runner "local" (its name is its ID);
// a session without any node is placed on no runner (UXS02): "not placed".
export function sessionRunnerLabel({placed, runnerId, runnerName}) {
  if (!placed || !runnerId) return {text: 'not placed', title: 'No node: the session is placed on no runner'};
  const name = runnerName || runnerId;
  return {text: name === runnerId ? runnerId : `${name} (${runnerId})`, title: `Runner ${name}, ID ${runnerId}`};
}
