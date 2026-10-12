import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStats } from './stats-engine.js';

const DAY = 86_400_000;
const T0 = 1_760_000_000_000;
const T1 = T0 + DAY;

const op = (over) => ({
  session: 's1', workspace: 'ws', ts: T0,
  op: 'write', path: 'D:/proj/a.js', content: '', oldString: '', newString: '', ok: true,
  ...over,
});

const PRICING = { label: 'test', hit: 0, miss: 1, write: 0, out: 1 }; // $1 per 1M for input & output

test('costs: turn cost split by generated lines; overhead for write-free turns', () => {
  const ops = [
    // turn 1: 3 code lines + 1 doc line in the same turn
    op({ ts: T0, turn: 1, content: 'a\nb\nc' }),
    op({ ts: T0, turn: 1, path: 'r.md', content: 'd' }),
    // turn 2: pure conversation, no writes
  ];
  const turnUsages = [
    { session: 's1', turn: 1, ts: T0, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { session: 's1', turn: 2, ts: T1, inputTokens: 2_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ];
  const s = computeStats(ops, { pricing: PRICING, turnUsages });
  assert.equal(s.costs.total, 3); // (1M + 2M) * $1/1M
  assert.equal(s.costs.code, 0.75); // 3/4 of turn 1's $1
  assert.equal(s.costs.doc, 0.25);
  assert.equal(s.costs.overhead, 2); // turn 2 has usage but no writes
  assert.equal(s.costs.turnsWithUsage, 2);
  assert.equal(s.costs.turnsWithoutUsage, 0);
  assert.equal(s.costs.pricing.label, 'test');
});

test('costs: cache pricing buckets are applied', () => {
  const ops = [op({ ts: T0, turn: 1, content: 'x' })];
  const turnUsages = [{ session: 's1', turn: 1, ts: T0, inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 4_000_000 }];
  const s = computeStats(ops, { pricing: { hit: 1, miss: 1, write: 1, out: 1 }, turnUsages });
  assert.equal(s.costs.total, 8); // (1+1+2+4)M * $1/1M
});

test('costs: window excludes out-of-window usage', () => {
  const ops = [
    op({ ts: T0, turn: 1, content: 'a' }),
    op({ ts: T1, turn: 2, path: 'b.js', content: 'b' }),
  ];
  const turnUsages = [
    { session: 's1', turn: 1, ts: T0, inputTokens: 1_000_000 },
    { session: 's1', turn: 2, ts: T1, inputTokens: 3_000_000 },
  ];
  const w = computeStats(ops, { from: T1, pricing: PRICING, turnUsages });
  assert.equal(w.costs.total, 3); // only turn 2
  assert.equal(w.costs.code, 3);
  assert.equal(w.costs.overhead, 0);
});

test('costs: null when no pricing configured', () => {
  const s = computeStats([op({ turn: 1, content: 'a' })]);
  assert.equal(s.costs, null);
});

test('costs: turns without usage counted, not charged', () => {
  const ops = [op({ ts: T0, turn: 1, content: 'a' })];
  const s = computeStats(ops, { pricing: PRICING, turnUsages: [] });
  assert.equal(s.costs.total, 0);
  assert.equal(s.costs.turnsWithUsage, 0);
  assert.equal(s.costs.turnsWithoutUsage, 1);
});
