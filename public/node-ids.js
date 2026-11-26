// Host and switch IDs made by the browser: h-/s- and 8 hex characters (32 random bits), as
// common/node-id.js on the server side. The runner answers 409 to an ID its session already has
// (one this page did not know yet): the creation is sent again with a new ID, a few times.

// A new ID, none of `known` (a Set or Map of the IDs this page knows).
export function newNodeId(kind, known = new Set()) {
  let id;
  do id = `${kind === 'switch' ? 's' : 'h'}-${[...crypto.getRandomValues(new Uint8Array(4))].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
  while (known.has(id));
  return id;
}

export const ID_ATTEMPTS = 4;

// Runs request(id) with `id`, then with new IDs while it fails with a 409 naming the ID; resolves to {id, body}.
export async function createWithNewIds(kind, id, request, known = new Set()) {
  for (let attempt = 1; ; attempt++) {
    try { return {id, body: await request(id)}; }
    catch (error) {
      if (error.status !== 409 || !/ID already exists/.test(error.message) || attempt >= ID_ATTEMPTS) throw error;
      id = newNodeId(kind, known);
    }
  }
}
