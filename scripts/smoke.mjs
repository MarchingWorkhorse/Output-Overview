/**
 * Offline integration smoke test: fakes the cordis ctx + webServer + a
 * sessionQuery backed by the real session store (~/.dsh/sessions), boots the
 * plugin entry, and drives a real HTTP request through the registered route.
 */
import http from 'node:http';
import { zstdDecompressSync } from 'node:zlib';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SESSIONS_ROOT = join(process.env.USERPROFILE ?? process.env.HOME, '.dsh', 'sessions');
const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);

function decompressMultiFrame(buf) {
  const frames = [];
  let start = buf.indexOf(MAGIC);
  while (start !== -1) {
    const next = buf.indexOf(MAGIC, start + 4);
    frames.push(buf.subarray(start, next === -1 ? buf.length : next));
    start = next;
  }
  let out = '';
  for (const frame of frames) {
    try { out += zstdDecompressSync(frame).toString('utf8'); } catch { /* skip bad frame */ }
  }
  return out;
}

function fakeSessionQuery() {
  const sessions = new Map();
  for (const ws of readdirSync(SESSIONS_ROOT)) {
    const wsDir = join(SESSIONS_ROOT, ws);
    let entries;
    try { entries = readdirSync(wsDir); } catch { continue; }
    for (const dir of entries) {
      if (!dir.startsWith('session-')) continue;
      const file = join(wsDir, dir, 'session.v3.jsonl.zstd');
      sessions.set(dir, { ws, file });
    }
  }
  const load = (id) => {
    const rec = sessions.get(id);
    if (!rec) throw new Error(`no session ${id}`);
    const lines = decompressMultiFrame(readFileSync(rec.file)).split('\n').filter(Boolean);
    const events = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const header = events.find((e) => e.type === 'session') ?? { type: 'session', version: 3, id, createdAt: 0, isSeeded: false, cwd: rec.ws };
    return { session: header, events };
  };
  return {
    async listSessions() {
      const list = [];
      for (const [id, rec] of sessions) {
        try {
          const { session } = load(id);
          list.push({ header: session, live: false, persisted: true });
        } catch { /* unreadable */ }
      }
      return list;
    },
    async readSession(id) { return load(id); },
  };
}

function fakeCtx(query) {
  const routes = new Map();
  const host = { webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {}; } } };
  const ctx = {
    get: (key) => (key === 'sessionQuery' ? query : undefined),
    inject(_keys, cb) { cb(host); },
  };
  return { ctx, routes };
}

async function main() {
  const { apply } = await import('../lib/index.js');
  const query = fakeSessionQuery();
  const { ctx, routes } = fakeCtx(query);
  apply(ctx, {});
  const handler = routes.get('/output-overview/api/summary');
  if (!handler) throw new Error('route /output-overview/api/summary not registered');

  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    for (const suffix of ['', '?subagents=false', '?workspace=NOPE', '?from=0&to=' + (Date.now() - 365 * 86400000), '?from=' + (Date.now() - 86400000)]) {
      const t0 = Date.now();
      const body = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: `/output-overview/api/summary${suffix}` }, (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => resolve({ status: res.statusCode, data }));
        }).on('error', reject);
      });
      const json = JSON.parse(body.data);
      const win = json.window?.from
        ? `${new Date(json.window.from).toISOString().slice(0, 10)}~${json.window.to ? new Date(json.window.to).toISOString().slice(0, 10) : 'now'}`
        : 'all';
      console.log(`GET ${suffix || '/'} -> ${body.status} in ${Date.now() - t0}ms:`,
        `win=${win} sessions=${json.sessionCount} code=${json.code?.generatedLines}L`,
        `survival=${json.code?.survivalRate} adoption=${json.adoption?.rate}(${json.adoption?.ok}/${json.adoption?.total})`,
        `doc=${json.doc?.docFileCount}f/${json.doc?.generatedLines}L`,
        `cost=${json.costs ? `$${json.costs.total?.toFixed(2)}(code $${json.costs.code?.toFixed(2)} doc $${json.costs.doc?.toFixed(2)} oh $${json.costs.overhead?.toFixed(2)}, turns ${json.costs.turnsWithUsage}/${json.costs.turnsWithUsage + json.costs.turnsWithoutUsage})` : 'n/a'}`,
        `computeMs=${json.computeMs}`);
    }
  } finally {
    server.close();
  }
  console.log('SMOKE OK');
}

main().catch((err) => { console.error(err); process.exit(1); });
