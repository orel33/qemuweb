// IDS01: the host and switch IDs the browser makes (public/node-ids.js): h-/s- and 8 hex characters,
// none the page knows, and a creation sent again with a new ID when the runner answers 409 for its ID.
const assert = require('node:assert/strict');
const test = require('node:test');

const load = () => import('../../public/node-ids.js');

test('a browser node ID is h- or s- and 8 lowercase hex characters, never one the page knows', async () => {
  const {newNodeId} = await load();
  assert.match(newNodeId('host'), /^h-[0-9a-f]{8}$/);
  assert.match(newNodeId('switch'), /^s-[0-9a-f]{8}$/);
  const original = crypto.getRandomValues;
  const draws = [[0, 0, 0, 1], [0, 0, 0, 2]];
  crypto.getRandomValues = array => { array.set(draws.shift()); return array; };
  try { assert.equal(newNodeId('host', new Set(['h-00000001'])), 'h-00000002', 'a known ID is drawn again'); }
  finally { crypto.getRandomValues = original; }
});

test('a creation whose ID the runner already has is sent again with a new ID, a few times at most', async () => {
  const {createWithNewIds, ID_ATTEMPTS} = await load();
  const taken = status => Object.assign(new Error('Host ID already exists; retry with another ID.'), {status});
  const sent = [];
  const result = await createWithNewIds('host', 'h-0000000a', async id => {
    sent.push(id);
    if (sent.length < 3) throw taken(409);
    return {name: 'h1'};
  });
  assert.equal(sent.length, 3);
  assert.equal(sent[0], 'h-0000000a');
  assert.equal(new Set(sent).size, 3, 'a new ID each time');
  assert.deepEqual(result, {id: sent[2], body: {name: 'h1'}}, 'the ID that was created');
  const tries = [];
  await assert.rejects(createWithNewIds('switch', 's-0000000a', async id => { tries.push(id); throw taken(409); }), /ID already exists/);
  assert.equal(tries.length, ID_ATTEMPTS);
  for (const error of [taken(400), Object.assign(new Error('Your session had to be renewed. Please retry.'), {status: 409})]) {
    let calls = 0;
    await assert.rejects(createWithNewIds('host', 'h-0000000a', async () => { calls++; throw error; }), error);
    assert.equal(calls, 1, `not retried: ${error.message} (${error.status})`);
  }
});
