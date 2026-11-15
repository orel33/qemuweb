// HTTP helpers for the QemuWeb REST API.
// URL of a node resource: /api/nodes/<nodeId>[/<action>].
export function nodeUrl(nodeId, action = '') {
  return `/api/nodes/${encodeURIComponent(nodeId)}${action ? `/${action}` : ''}`;
}

// fetch() options for a JSON request body.
export function jsonRequest(method, data) {
  return {method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)};
}

// Fetches a JSON response and throws the server error message (or the
// fallback message) when the HTTP status is not successful.
export async function requestJson(url, options, fallbackError) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || fallbackError);
  return body;
}

// URL of the launch preview of a host draft (settings, storage, commands).
export function launchOptionsUrl(machine, settings) {
  const params = new URLSearchParams({system: machine.imageId, engine: machine.engine, interfaces: JSON.stringify(machine.interfaces || []), settings: JSON.stringify(settings), startupDiskEnabled: String(!!machine.startupDiskEnabled)});
  return `${nodeUrl(machine.id, 'options')}?${params}`;
}
