'use strict';

// The answer of runner.status (ADM04) as an administrator sees it (GET /api/admin/runners/:id/status).
// A runner's answer is untrusted input: sanitizeRunnerStatus keeps only the known fields of the shape
// of common/runner-status.js, with valid IDs and logins, printable bounded texts, finite non-negative
// numbers (else null), at most MAX_SESSIONS sessions and MAX_NODES nodes, and recomputes the totals.
const {SESSION_ID} = require('./session');
const {entityKind} = require('../common/node-id');
const {LOGIN_PATTERN} = require('../common/login');
const {MAX_SESSIONS, MAX_NODES, MAX_TEXT, roundCpu, totalsOf} = require('../common/runner-status');

const text = value => (typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, MAX_TEXT) || null : null);
const number = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
const integer = value => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const pidOf = value => (Number.isSafeInteger(value) && value > 0 ? value : null);
const isoDate = value => (typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null);
const nodeIdOf = value => { try { entityKind(value); return value; } catch (_) { return null; } };

function sanitizeNode(node) {
  const id = nodeIdOf(node?.id);
  if (!id) return null;
  const kind = id[0] === 'h' ? 'host' : 'switch';
  const running = node.running === true;
  return {id, name: text(node.name), kind, system: kind === 'host' ? text(node.system) : null, engine: text(node.engine), running,
    pid: running ? pidOf(node.pid) : null, rssBytes: running ? integer(node.rssBytes) : null,
    memoryMb: kind === 'host' ? integer(node.memoryMb) : null, cpuPercent: running ? roundCpu(number(node.cpuPercent)) : null};
}

function sanitizeRunnerStatus(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(value.sessions) ? value.sessions : [];
  let truncated = value.truncated === true || list.length > MAX_SESSIONS;
  let budget = MAX_NODES;
  const sessions = [];
  for (const item of list.slice(0, MAX_SESSIONS)) {
    if (!item || typeof item !== 'object' || typeof item.sessionId !== 'string' || !SESSION_ID.test(item.sessionId)) continue;
    const given = Array.isArray(item.nodes) ? item.nodes : [];
    if (given.length > budget) truncated = true;
    const nodes = given.slice(0, budget).map(sanitizeNode).filter(Boolean);
    budget -= Math.min(given.length, budget);
    sessions.push({sessionId: item.sessionId, owner: typeof item.owner === 'string' && LOGIN_PATTERN.test(item.owner) ? item.owner : null,
      createdAt: isoDate(item.createdAt), ageSeconds: integer(item.ageSeconds), nodes, totals: totalsOf(nodes)});
  }
  const runner = value.runner && typeof value.runner === 'object' ? value.runner : {};
  return {runner: {pid: pidOf(runner.pid), uptimeSeconds: integer(runner.uptimeSeconds), rssBytes: integer(runner.rssBytes), cpuPercent: roundCpu(number(runner.cpuPercent))},
    sessions, totals: totalsOf(sessions.flatMap(session => session.nodes)), truncated, sampledAt: isoDate(value.sampledAt)};
}

module.exports = {sanitizeRunnerStatus};
