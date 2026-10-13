import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSessionOps, collectOperations, clearExtractionCache } from './session-reader.js';

const header = { id: 'session-x', version: 3, createdAt: 1, cwd: 'D:/proj', isSeeded: false, delegationDepth: 0 };

const call = (seq, name, args, callId) => ({
  type: 'tool/call', seq, time: 1000 + seq,
  data: { turn: 1, step: seq, callId, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
});
const result = (seq, callId, isError = false) => ({
  type: 'tool/result', seq, time: 1000 + seq, surfaceOp: 'append',
  data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId }, role: 'user', content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'ok' }], isError }] } },
});

test('extractSessionOps: write with ok result', () => {
  const snapshot = { session: header, events: [
    call(1, 'write', { file_path: 'D:/proj/a.js', content: 'x\ny' }, 'c1'),
    result(2, 'c1'),
  ] };
  const { ops, calls } = extractSessionOps(snapshot, {});
  assert.equal(ops.length, 1);
  assert.deepEqual([ops[0].op, ops[0].path, ops[0].content], ['write', 'D:/proj/a.js', 'x\ny']);
  assert.deepEqual(calls, { total: 1, ok: 1, failed: 0, pending: 0 });
});

test('extractSessionOps: failed or pending results are skipped', () => {
  const snapshot = { session: header, events: [
    call(1, 'write', { file_path: 'a.js', content: 'x' }, 'c1'),
    result(2, 'c1', true),
    call(3, 'write', { file_path: 'b.js', content: 'x' }, 'c2'), // no result
  ] };
  const { ops, calls } = extractSessionOps(snapshot, {});
  assert.equal(ops.length, 0);
  assert.deepEqual(calls, { total: 2, ok: 0, failed: 1, pending: 1 });
});

test('extractSessionOps: edit and str_replace_editor branches', () => {
  const snapshot = { session: header, events: [
    call(1, 'edit', { file_path: 'a.js', old_string: 'a\nb', new_string: 'c', replace_all: true }, 'e1'),
    result(2, 'e1'),
    call(3, 'str_replace_editor', { command: 'create', path: 'n.md', file_text: '# t' }, 'e2'),
    result(4, 'e2'),
    call(5, 'str_replace_editor', { command: 'str_replace', path: 'n.md', old_str: '# t', new_str: '# t2\n# t3' }, 'e3'),
    result(6, 'e3'),
    call(7, 'str_replace_editor', { command: 'insert', path: 'n.md', insert_line: 0, new_str: 'top' }, 'e4'),
    result(8, 'e4'),
    call(9, 'str_replace_editor', { command: 'view', path: 'n.md' }, 'e5'),
    result(10, 'e5'),
  ] };
  const { ops, calls } = extractSessionOps(snapshot, {});
  assert.equal(ops.length, 4);
  assert.deepEqual(ops.map((o) => o.op), ['replace', 'write', 'replace', 'replace']);
  assert.equal(ops[1].content, '# t');
  assert.equal(ops[2].oldString, '# t');
  assert.equal(ops[3].newString, 'top');
  assert.equal(ops[0].replaceAll, true);
  // 'view' is read-only and excluded from both ops and the adoption tally
  assert.deepEqual(calls, { total: 4, ok: 4, failed: 0, pending: 0 });
});

test('extractSessionOps: malformed arguments JSON is skipped', () => {
  const snapshot = { session: header, events: [
    { type: 'tool/call', seq: 1, time: 1, data: { callId: 'c', name: 'write', arguments: '{not json' } },
    result(2, 'c'),
  ] };
  const { ops, calls } = extractSessionOps(snapshot, {});
  assert.equal(ops.length, 0);
  assert.deepEqual(calls, { total: 1, ok: 1, failed: 0, pending: 0 });
});

test('collectOperations: collects all workspaces and sorts chronologically', async () => {
  const mk = (id, cwd, time) => ({
    header: { ...header, id, cwd, createdAt: time },
    live: false, persisted: true,
  });
  const sessions = [mk('s-b', 'D:/b', 5), mk('s-a', 'D:/a', 1)];
  const fakeQuery = {
    async listSessions() { return sessions; },
    async readSession(id) {
      const seq = id === 's-a' ? 0 : 100;
      const model = id === 's-a' ? 'glm-5.3-flash' : 'gpt-6-luna';
      return { session: sessions.find((s) => s.header.id === id).header, events: [
        { type: 'request/header', time: seq, data: { header: { config: { provider: 'deepseek-official', model } } } },
        call(seq + 1, 'write', { file_path: `x-${id}.js`, content: 'l' }, `k-${id}`),
        result(seq + 2, `k-${id}`),
        { type: 'assistant/message', time: seq + 3, data: { turn: 1, usage: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
      ] };
    },
  };
  const all = await collectOperations(fakeQuery);
  assert.equal(all.sessionCount, 2);
  assert.equal(all.ops.length, 2);
  assert.ok(all.ops[0].ts <= all.ops[1].ts);
  assert.deepEqual(all.calls, { total: 2, ok: 2, failed: 0, pending: 0 });
  // The workspace option list must always cover the whole corpus.
  assert.deepEqual(all.workspaces, ['D:/a', 'D:/b']);
  // sessionMeta maps every session to its workspace so the route can scope
  // sessionCount to the selected workspaces.
  assert.deepEqual(
    all.sessionMeta.sort((a, b) => a.id.localeCompare(b.id)),
    [{ id: 's-a', workspace: 'D:/a' }, { id: 's-b', workspace: 'D:/b' }]);
  // models lists every model id announced in the corpus with its turn count,
  // most-used first — the panel's pricing editor lists exactly these.
  // (Turn order across the two sessions follows read order, so assert as a set.)
  assert.deepEqual(
    [...all.models].sort((a, b) => a.id.localeCompare(b.id)),
    [{ id: 'glm-5.3-flash', turns: 1 }, { id: 'gpt-6-luna', turns: 1 }]);
});

test('collectOperations: extraction cache reuses closed sessions and re-reads changed ones', async () => {
  clearExtractionCache();
  const headerA = { ...header, id: 's-a' };
  // Sessions without a matching on-disk log file (no stat identity) must not
  // be cached — that path stays a straight read every time.
  let reads = 0;
  const query = {
    async listSessions() { return [{ header: headerA, live: false, persisted: true }]; },
    async readSession() {
      reads += 1;
      return { session: headerA, events: [
        call(1, 'write', { file_path: 'a.js', content: 'x' }, 'k'),
        result(2, 'k'),
      ] };
    },
  };
  const first = await collectOperations(query);
  const second = await collectOperations(query);
  assert.equal(reads, 2); // no cache identity -> both builds read
  assert.equal(first.ops.length, 1);
  assert.deepEqual(second.ops, first.ops);
});

test('collectOperations: a session whose read fails is not cached', async () => {
  clearExtractionCache();
  const headerB = { ...header, id: 's-err' };
  let reads = 0;
  let fail = true;
  const query = {
    async listSessions() { return [{ header: headerB, live: false, persisted: true }]; },
    async readSession() {
      reads += 1;
      if (fail) throw new Error('boom');
      return { session: headerB, events: [] };
    },
  };
  const bad = await collectOperations(query);
  assert.equal(bad.unreadable, 1);
  fail = false;
  const good = await collectOperations(query);
  assert.equal(reads, 2); // failure was not cached
  assert.equal(good.unreadable, 0);
});
