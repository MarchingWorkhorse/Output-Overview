import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStats } from './stats-engine.js';

const DAY = 86_400_000;
const T0 = 1_760_000_000_000;
const T1 = T0 + DAY;
const T2 = T0 + 2 * DAY;

const op = (over) => ({
  session: 's1', workspace: 'ws', ts: T0,
  op: 'write', path: 'D:/proj/a.js', content: '', oldString: '', newString: '', ok: true,
  ...over,
});

test('window: out-of-window ops are excluded from generated counts', () => {
  const ops = [
    op({ ts: T0, content: 'x\ny' }),
    op({ ts: T1, path: 'b.js', content: 'z' }),
  ];
  const all = computeStats(ops);
  assert.equal(all.code.generatedLines, 3);

  const w = computeStats(ops, { from: T1 });
  assert.equal(w.code.generatedLines, 1);
  assert.equal(w.code.survivingLines, 1); // 'z' survives, generated in window
  assert.equal(w.days.length, 1);
  assert.equal(w.sessions.length, 1);
});

test('window: survival counts only in-window provenance lines', () => {
  // write 10 lines before the window, 3 during it
  const before = Array.from({ length: 10 }, (_, i) => `old${i}`).join('\n');
  const during = 'n1\nn2\nn3';
  const ops = [
    op({ ts: T0, path: 'a.js', content: before }),
    op({ ts: T1, path: 'a.js', content: during }),
  ];
  const w = computeStats(ops, { from: T1 });
  assert.equal(w.code.generatedLines, 3);
  assert.equal(w.code.survivingLines, 3);
  assert.equal(w.code.survivalRate, 1);
  // no window: the 3-line write replaced the 10, so only 3 survive of 13
  const all = computeStats(ops);
  assert.equal(all.code.survivingLines, 3);
});

test('window: replace inside window carries new provenance', () => {
  const ops = [
    op({ ts: T0, path: 'a.js', content: 'function f() {\n  return 1;\n}' }),
    op({ ts: T1, op: 'replace', path: 'a.js', oldString: 'return 1;', newString: 'return 2;\nreturn 3;' }),
  ];
  const w = computeStats(ops, { from: T1 });
  assert.equal(w.code.generatedLines, 2);
  // final content: 'function f() {' (T0), '  return 2;' (T1), 'return 3;' (T1), '}' (T0)
  assert.equal(w.code.survivingLines, 2);
  assert.equal(w.code.survivalRate, 1);

  const earlier = computeStats(ops, { to: T0 });
  assert.equal(earlier.code.generatedLines, 3);
  // final state still holds the two untouched T0 lines; the replaced ones are gone
  assert.equal(earlier.code.survivingLines, 2);
});

test('window: replace_all provenance across occurrences', () => {
  const ops = [
    op({ ts: T0, path: 'a.js', content: 'x = 1;\ny = x;\nprint(x);' }),
    op({ ts: T1, op: 'replace', path: 'a.js', oldString: 'x', newString: 'total', replaceAll: true }),
  ];
  const w = computeStats(ops, { from: T1 });
  // one replace op -> line-based counting credits 1 added line; all 3 lines
  // were modified in-window and survive, so the rate can exceed 1
  assert.equal(w.code.generatedLines, 1);
  assert.equal(w.code.survivingLines, 3);
  const all = computeStats(ops);
  assert.equal(all.code.survivingLines, 3);
});

test('window: pure deletion merges boundary lines with original provenance', () => {
  const ops = [
    op({ ts: T0, path: 'a.js', content: 'head\n' }),
    op({ ts: T0, path: 'a.js', op: 'replace', oldString: 'head\n', newString: '' }),
  ];
  const w = computeStats(ops, { to: T0 });
  assert.equal(w.code.generatedLines, 1);
  assert.equal(w.code.survivingLines, 0);
  const all = computeStats(ops);
  assert.equal(all.code.survivingLines, 0);
});

test('window: file list and totals are window-scoped', () => {
  const ops = [
    op({ ts: T0, path: 'a.js', content: 'a1\na2' }),
    op({ ts: T1, path: 'b.md', content: 'doc line' }),
    op({ ts: T2, path: 'c.js', content: 'c1' }),
  ];
  const w = computeStats(ops, { from: T1, to: T1 + DAY - 1 });
  assert.equal(w.code.fileCount, 0);
  assert.equal(w.doc.fileCount, 1);
  assert.equal(w.totals.fileCount, 1);
  assert.deepEqual(w.files.map((f) => f.path), ['b.md']);
  assert.deepEqual(w.workspaces === undefined, true); // engine does not compute workspaces
});
