/**
 * Repro: select each REAL workspace through the actual route handler and
 * validate every field the panel renders. Prints exactly which workspace
 * and which field break, with the raw payload excerpt.
 */
import http from 'node:http';
import { zstdDecompressSync } from 'node:zlib';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SESSIONS_ROOT = join(process.env.USERPROFILE, '.dsh', 'sessions');
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
    try { out += zstdDecompressSync(frame).toString('utf8'); } catch { /* skip */ }
  }
  return out;
}

function fakeSessionQuery() {
  const sessions = new Map();
  for (const ws of readdirSync(SESSIONS_ROOT)) {
    let entries;
    try { entries = readdirSync(join(SESSIONS_ROOT, ws)); } catch { continue; }
    for (const dir of entries) {
      if (!dir.startsWith('session-')) continue;
      sessions.set(dir, join(SESSIONS_ROOT, ws, dir, 'session.v3.jsonl.zstd'));
    }
  }
  const load = (id) => {
    const lines = decompressMultiFrame(readFileSync(sessions.get(id))).split('\n').filter(Boolean);
    const events = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const header = events.find((e) => e.type === 'session') ?? { type: 'session', version: 3, id, createdAt: 0, isSeeded: false };
    return { session: header, events };
  };
  return {
    async listSessions() {
      const list = [];
      for (const id of sessions.keys()) {
        try { list.push({ header: load(id).session, live: false, persisted: true }); } catch { /* skip */ }
      }
      return list;
    },
    async readSession(id) { return load(id); },
  };
}

// ---- boot plugin exactly like the host does ----
const { apply } = await import('../lib/index.js');
const routes = new Map();
const ctx = {
  get: (key) => (key === 'sessionQuery' ? fakeSessionQuery() : undefined),
  inject: (_keys, cb) => cb({ webServer: { register: (r) => { routes.set(r.path, r.handler); return () => {}; } } }),
};
apply(ctx, {});
const handler = routes.get('/output-overview/api/summary');
if (!handler) throw new Error('route missing');

const server = http.createServer((req, res) => handler(req, res));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const get = (path) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path }, (res) => {
    let d = '';
    res.on('data', (c) => { d += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: d }));
  }).on('error', reject);
});

// ---- panel render contract: every field the client component touches ----
const CONTRACT = [
  ['code.generatedLines:number', (o) => typeof o?.code?.generatedLines === 'number'],
  ['code.fileCount:number', (o) => typeof o?.code?.fileCount === 'number'],
  ['code.survivalRate:number|null', (o) => o?.code?.survivalRate === null || typeof o?.code?.survivalRate === 'number'],
  ['doc.docFileCount:number', (o) => typeof o?.doc?.docFileCount === 'number'],
  ['doc.generatedLines:number', (o) => typeof o?.doc?.generatedLines === 'number'],
  ['doc.survivalRate:number|null', (o) => o?.doc?.survivalRate === null || typeof o?.doc?.survivalRate === 'number'],
  ['adoption.rate:number|null', (o) => o?.adoption?.rate === null || typeof o?.adoption?.rate === 'number'],
  ['adoption.ok:number', (o) => typeof o?.adoption?.ok === 'number'],
  ['adoption.total:number', (o) => typeof o?.adoption?.total === 'number'],
  ['totals.generatedLines:number', (o) => typeof o?.totals?.generatedLines === 'number'],
  ['totals.survivingLines:number', (o) => typeof o?.totals?.survivingLines === 'number'],
  ['costs.pricing when costs set', (o) => o?.costs == null || (typeof o.costs === 'object' && typeof o.costs.pricing === 'object')],
  ['days:array', (o) => Array.isArray(o?.days)],
  ['files:array', (o) => Array.isArray(o?.files)],
  ['workspaces:array', (o) => Array.isArray(o?.workspaces)],
  ['workspaceFilter:array', (o) => Array.isArray(o?.workspaceFilter)],
  ['sessionCount:number', (o) => typeof o?.sessionCount === 'number'],
  ['generatedAt:number', (o) => typeof o?.generatedAt === 'number'],
  ['computeMs:number', (o) => typeof o?.computeMs === 'number'],
  ['includeSubagents:boolean', (o) => typeof o?.includeSubagents === 'boolean'],
];

const all = JSON.parse((await get('/output-overview/api/summary')).body);
console.log(`all workspaces: ${all.workspaces.length} -> ${JSON.stringify(all.workspaces).slice(0, 300)}`);

let failures = 0;
for (const w of all.workspaces) {
  const path = `/output-overview/api/summary?workspace=${encodeURIComponent(w)}`;
  const res = await get(path);
  let payload;
  try { payload = JSON.parse(res.body); } catch { payload = { __parse_error: res.body.slice(0, 200) }; }
  const broken = CONTRACT.filter(([name, ok]) => { try { return !ok(payload); } catch { return true; } });
  const label = `ws=${JSON.stringify(w).slice(0, 60)}`;
  if (res.status !== 200 || broken.length > 0) {
    failures += 1;
    console.log(`FAIL ${res.status} ${label}`);
    for (const [name] of broken) console.log(`   broken: ${name}`);
    console.log(`   payload keys: ${Object.keys(payload).join(',')}`);
    console.log(`   excerpt: ${res.body.slice(0, 260)}`);
  } else {
    console.log(`ok   ${label} code=${payload.code.generatedLines}L days=${payload.days.length} files=${payload.files.length} sessions=${payload.sessions.length} filter=${JSON.stringify(payload.workspaceFilter)}`);
  }
}

// subagents=false + workspace combo (second corpus key)
const combo = JSON.parse((await get(`/output-overview/api/summary?subagents=false&workspace=${encodeURIComponent(all.workspaces[0])}`)).body);
console.log(`combo subagents=false + ws[0]: code=${combo.code.generatedLines}L days=${(combo.days || []).length} workspaces=${(combo.workspaces || []).length}`);

server.close();
console.log(failures === 0 ? 'REPRO: all workspaces satisfy the panel contract' : `REPRO: ${failures} workspace(s) break the panel contract`);
process.exit(failures === 0 ? 0 : 1);
