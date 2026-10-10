import test from 'node:test';
import assert from 'node:assert/strict';
import { isDocPath, classifyOp, computeStats } from './stats-engine.js';

const op = (over) => ({
  session: 's1', workspace: 'ws', ts: 1760000000000,
  op: 'write', path: 'D:/proj/a.js', content: '', oldString: '', newString: '', ok: true,
  ...over,
});

test('isDocPath classifies doc extensions', () => {
  assert.equal(isDocPath('a.md'), true);
  assert.equal(isDocPath('a.TXT'), true);
  assert.equal(isDocPath('a.js'), false);
  assert.equal(isDocPath('noext'), false);
});

test('classifyOp counts write lines and skips rejected ops', () => {
  const ok = classifyOp(op({ content: 'a\nb\nc' }));
  assert.deepEqual([ok.bucket, ok.added], ['code', 3]);
  assert.equal(classifyOp(op({ ok: false, content: 'a\nb' })), null);
  assert.equal(classifyOp(op({ path: 'x/node_modules/y.js', content: 'a' })), null);
  const doc = classifyOp(op({ path: 'readme.md', content: '# t\n\ntext' }));
  assert.equal(doc.bucket, 'doc');
  assert.equal(doc.added, 3);
});

test('classifyOp counts replace added/removed lines', () => {
  const r = classifyOp(op({ op: 'replace', oldString: 'a\nb', newString: 'x\ny\nz' }));
  assert.equal(r.added, 3);
  assert.equal(r.removed, 2);
});

test('computeStats: survival after overwrite', () => {
  const stats = computeStats([
    op({ path: 'a.js', content: 'l1\nl2\nl3' }),
    op({ path: 'a.js', content: 'n1' }),
  ]);
  assert.equal(stats.code.generatedLines, 4);
  assert.equal(stats.code.survivingLines, 1);
  assert.ok(stats.code.survivalRate < 0.3);
});

test('computeStats: replace replay removes then adds', () => {
  const stats = computeStats([
    op({ path: 'a.js', content: 'function f() {\n  return 1;\n}' }),
    op({ op: 'replace', path: 'a.js', oldString: 'return 1;', newString: 'return 2;\nreturn 3;' }),
  ]);
  assert.equal(stats.code.generatedLines, 3 + 2);
  assert.equal(stats.code.survivingLines, 4); // 3 lines - 1 + 2
});

test('computeStats: doc bucket and doc file count', () => {
  const stats = computeStats([
    op({ path: 'README.md', content: '# A\n# B' }),
    op({ path: 'docs/guide.rst', content: 'g1' }),
    op({ path: 'main.py', content: 'p1\np2' }),
  ]);
  assert.equal(stats.doc.fileCount, 2);
  assert.equal(stats.doc.docFileCount, 2);
  assert.equal(stats.doc.generatedLines, 3);
  assert.equal(stats.code.generatedLines, 2);
  assert.equal(stats.totals.fileCount, 3);
});

test('computeStats: per-day and per-session aggregation', () => {
  const stats = computeStats([
    op({ ts: 1760000000000, content: 'a\nb' }),
    op({ session: 's2', ts: 1760000000000, path: 'c.md', content: 'd' }),
  ]);
  assert.equal(stats.days.length, 1);
  assert.equal(stats.days[0].codeLines, 2);
  assert.equal(stats.days[0].docLines, 1);
  assert.equal(stats.sessions.length, 2);
});
