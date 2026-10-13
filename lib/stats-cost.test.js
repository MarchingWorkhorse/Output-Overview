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
  assert.equal(s.costs.pricing.label ?? s.costs.pricing.default, 'test');
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

test('costs: applyCurrency converts USD totals and keeps pricing in USD', async () => {
  const ops = [
    op({ ts: T0, turn: 1, content: 'a\nb' }),
  ];
  const turnUsages = [
    { session: 's1', turn: 1, ts: T0, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ];
  const s = computeStats(ops, { pricing: PRICING, turnUsages }); // $1 total
  assert.equal(s.costs.total, 1);

  const { applyCurrency, withDisplayCurrency } = await import('./stats-engine.js');
  const cny = applyCurrency(s.costs, { code: 'CNY', symbol: '¥', fx: 6.7 });
  assert.equal(cny.total, 6.7);
  assert.equal(cny.code, 6.7); // whole turn attributed to code (2 lines, no doc)
  assert.equal(cny.currency, 'CNY');
  assert.equal(cny.symbol, '¥');
  assert.equal(cny.fx.rate, 6.7);
  assert.equal(cny.fx.base, 'USD');
  assert.equal(cny.pricing.currency, 'USD'); // unit prices stay USD

  // withDisplayCurrency: converts when requested, passthrough otherwise
  const converted = withDisplayCurrency(s, { code: 'CNY', symbol: '¥', fx: 6.7 });
  assert.equal(converted.costs.total, 6.7);
  assert.equal(withDisplayCurrency(s, null), s);
  assert.equal(withDisplayCurrency(s, { code: 'USD', symbol: '$', fx: 1 }), s);

  // No-op / invalid fx returns the original object
  assert.equal(applyCurrency(s.costs, null), s.costs);
  assert.equal(applyCurrency(s.costs, { code: 'CNY', symbol: '¥', fx: 0 }), s.costs);
});

test('route: sessionCount follows the workspace filter, total stays store-wide', async () => {
  // The route lazily reads panel overrides from ~/.dsh/output-overview-config.json
  // (this machine has one from manual testing, with different prices and fx).
  // Point the home directory at an empty temp dir BEFORE the first import of
  // index.js (CONFIG_PATH is resolved at module load; os.homedir() reads
  // USERPROFILE on Windows) so the expectations reflect the route's built-in
  // defaults regardless of the developer machine's local override state.
  const fsp = await import('node:fs/promises');
  const pathMod = await import('node:path');
  const fakeHome = await fsp.mkdtemp(pathMod.join(await fsp.realpath(process.env.TEMP ?? process.env.TMP ?? '.'), 'oo-test-'));
  const savedUserProfile = process.env.USERPROFILE;
  const savedHome = process.env.HOME;
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;
  const { apply } = await import('./index.js');

  const records = [
    { header: { id: 'sa', version: 3, cwd: 'D:/a', createdAt: 1 } },
    { header: { id: 'sb', version: 3, cwd: 'D:/b', createdAt: 2 } },
    { header: { id: 'sc', version: 3, cwd: 'D:/b', createdAt: 3 } },
  ];
  const events = (id, ws) => [
    { type: 'session', id, version: 3, cwd: ws, createdAt: 1, isSeeded: false },
    { type: 'tool/call', data: { turn: 1, callId: 'c1', name: 'write', arguments: JSON.stringify({ file_path: `${ws}/f.js`, content: 'x' }) }, time: 10 },
    { type: 'tool/result', data: { message: { source: { callId: 'c1' }, content: [{ type: 'tool-result', isError: false }] } }, time: 11 },
    { type: 'assistant/message', data: { turn: 1, usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }, time: 12 },
  ];
  const fakeQuery = {
    async listSessions() { return records.map((r) => ({ ...r, live: false, persisted: true })); },
    async readSession(id) {
      const rec = records.find((r) => r.header.id === id);
      return { session: rec.header, events: events(id, rec.header.cwd) };
    },
  };
  const routes = new Map();
  apply({
    get: (key) => (key === 'sessionQuery' ? fakeQuery : undefined),
    inject: (_keys, cb) => cb({ webServer: { register: (r) => { routes.set(r.path, r.handler); return () => {}; } } }),
  }, {});
  const handler = routes.get('/output-overview/api/summary');
  const fetchJson = (suffix) => new Promise((resolve, reject) => {
    // Drive the handler directly through fake request/response objects.
    const res = {
      headers: null, status: 0, body: '',
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(chunk) { this.body += chunk ?? ''; resolve(JSON.parse(this.body || '{}')); },
    };
    handler({ method: 'GET', url: `/output-overview/api/summary${suffix}`, headers: {} }, res).catch(reject);
  });

  const all = await fetchJson('');
  assert.equal(all.sessionCount, 3);
  assert.equal(all.totalSessionCount, 3);

  const a = await fetchJson('?workspace=D%3A%2Fa');
  assert.equal(a.workspaceFilter.length, 1);
  assert.equal(a.sessionCount, 1, 'picking D:/a must scope sessionCount to its 1 session');
  assert.equal(a.totalSessionCount, 3);
  assert.equal(a.code.generatedLines, 1, 'only D:/a ops counted');
  // Route uses DEFAULT_PRICING (miss 0.06/1M): 1M uncached input = $0.06,
  // displayed in CNY at fx 6.7 -> ¥0.402. Any other value means the filter
  // leaked other workspaces' turns in (or dropped ours).
  assert.ok(Math.abs(a.costs.total - 0.06 * 6.7) < 1e-9, `cost must come from D:/a turns only, got ${a.costs.total}`);
  assert.equal(a.displayCurrency.code, 'CNY');

  const b = await fetchJson('?workspace=D%3A%2Fb');
  assert.equal(b.sessionCount, 2, 'picking D:/b must scope sessionCount to its 2 sessions');
  assert.equal(b.totalSessionCount, 3);
  assert.equal(b.code.generatedLines, 2, 'only D:/b ops counted');
  assert.ok(Math.abs(b.costs.total - 0.12 * 6.7) < 1e-9, `cost must come from D:/b turns only, got ${b.costs.total}`);
  // Cross-check: D:/a + D:/b union costs equals all-workspace costs.
  const union = await fetchJson('?workspace=D%3A%2Fa&workspace=D%3A%2Fb');
  assert.equal(union.sessionCount, 3);
  assert.ok(Math.abs(union.costs.total - all.costs.total) < 1e-9, 'union of all workspaces equals the unfiltered cost');
  // Restore the real home and drop the temp dir.
  process.env.USERPROFILE = savedUserProfile;
  process.env.HOME = savedHome;
  await fsp.rm(fakeHome, { recursive: true, force: true });
});

test('costs: per-model pricing prices each turn by its own model', async () => {
  const { computeStats } = await import('./stats-engine.js');
  const ops = [
    op({ ts: T0, turn: 1, content: 'a' }), // glm turn: 1M miss input
    op({ ts: T0, turn: 2, path: 'b.js', content: 'b' }), // luna turn: 2M miss input
  ];
  const turnUsages = [
    { session: 's1', turn: 1, ts: T0, inputTokens: 1_000_000, model: 'glm-5.3-flash' },
    { session: 's1', turn: 2, ts: T0 + 1, inputTokens: 2_000_000, model: 'gpt-6-luna' },
  ];
  const pricing = {
    default: 'glm-5.3-flash',
    models: {
      'glm-5.3-flash': { hit: 0, miss: 1, write: 0, out: 0 },
      'gpt-6-luna': { hit: 0, miss: 5, write: 0, out: 0 },
    },
  };
  const s = computeStats(ops, { pricing, turnUsages });
  assert.equal(s.costs.total, 11, 'turn1 $1 (glm) + turn2 $10 (luna)');
  assert.equal(s.costs.pricing.models['glm-5.3-flash'].cost, 1);
  assert.equal(s.costs.pricing.models['gpt-6-luna'].cost, 10);
  assert.equal(s.costs.pricing.models['glm-5.3-flash'].turns, 1);
  assert.equal(s.costs.pricing.models['gpt-6-luna'].turns, 1);
  assert.equal(s.costs.pricing.default, 'glm-5.3-flash');
});

test('costs: unknown-model turns fall back to pricing.default', async () => {
  const { computeStats } = await import('./stats-engine.js');
  const ops = [op({ ts: T0, turn: 1, content: 'a' })];
  const turnUsages = [
    { session: 's1', turn: 1, ts: T0, inputTokens: 1_000_000 }, // no model identity (old logs)
    { session: 's1', turn: 2, ts: T0 + 1, inputTokens: 1_000_000, model: 'never-configured' },
  ];
  const pricing = {
    default: 'glm-5.3-flash',
    models: { 'glm-5.3-flash': { hit: 0, miss: 1, write: 0, out: 0 } },
  };
  const s = computeStats(ops, { pricing, turnUsages });
  assert.equal(s.costs.total, 2, 'both turns fall back to the default model ($1 each)');
  assert.equal(s.costs.pricing.models['glm-5.3-flash'].turns, 2);
});

test('costs: legacy flat pricing shape still works', async () => {
  const { computeStats } = await import('./stats-engine.js');
  const ops = [op({ ts: T0, turn: 1, content: 'a' })];
  const turnUsages = [
    { session: 's1', turn: 1, ts: T0, inputTokens: 1_000_000, model: 'whatever' },
  ];
  const s = computeStats(ops, { pricing: { label: 'flat', hit: 0, miss: 3, write: 0, out: 0 }, turnUsages });
  assert.equal(s.costs.total, 3, 'flat rates apply regardless of the turn model');
});

test('costs: CNY-quoted pricing normalizes through the fx rate', async () => {
  const { computeStats } = await import('./stats-engine.js');
  const ops = [op({ ts: T0, turn: 1, content: 'a' })];
  const turnUsages = [
    { session: 's1', turn: 1, ts: T0, inputTokens: 1_000_000, model: 'glm' },
  ];
  // ¥4.2 / 1M input, 1 USD = 6 CNY -> $0.7 USD internally.
  const pricing = { default: 'glm', unit: 'CNY', models: { glm: { hit: 0, miss: 4.2, write: 0, out: 0 } } };
  const s = computeStats(ops, { pricing, turnUsages, unitFxToUsd: 6 });
  assert.ok(Math.abs(s.costs.total - 0.7) < 1e-9, `¥4.2 / 6 = $0.7, got ${s.costs.total}`);
  assert.equal(s.costs.pricing.currency, 'CNY', 'unit prices keep their quote currency');

  // Display in CNY at the same rate: total returns to the entered ¥4.2.
  const { applyCurrency } = await import('./stats-engine.js');
  const cny = applyCurrency(s.costs, { code: 'CNY', symbol: '¥', fx: 6 });
  assert.ok(Math.abs(cny.total - 4.2) < 1e-9, 'CNY-priced table displayed in CNY at the same rate round-trips');

  // Missing/invalid unitFxToUsd falls back to the built-in default rate.
  const s2 = computeStats(ops, { pricing, turnUsages });
  assert.ok(Math.abs(s2.costs.total - 4.2 / 6.7) < 1e-9, 'fallback rate 6.7 applied when unitFxToUsd is absent');

  // USD pricing ignores unitFxToUsd entirely.
  const usd = computeStats(ops, { pricing: { default: 'glm', unit: 'USD', models: { glm: { miss: 1, hit: 0, write: 0, out: 0 } } }, turnUsages, unitFxToUsd: 6 });
  assert.equal(usd.costs.total, 1);
});
