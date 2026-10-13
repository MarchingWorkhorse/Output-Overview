/**
 * output-overview — session log reader.
 *
 * Reads every session through ctx.sessionQuery (mounted by dsh-base via
 * @deepseek-ai/dsh-session-query-sqlite; exact reads stay available even
 * with openAt: never) and extracts normalized file-write operations for
 * the statistics engine.
 *
 * Write-class tools observed in the harness:
 *   write              { file_path, content }
 *   edit               { file_path, old_string, new_string, replace_all? }
 *   str_replace_editor { command: create|str_replace|insert|view, path,
 *                        file_text?, old_str?, new_str?, insert_line? }
 */
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'str_replace_based_edit_tool']);

function normalizeContent(s) {
  return typeof s === 'string' ? s : '';
}

/**
 * Extract normalized operations from one session snapshot.
 * A call counts only when a tool/result with isError=false exists for it.
 * Also tallies write-class tool-call outcomes for the tool-level adoption
 * rate: ok = executed successfully, failed = error result (rejected or
 * errored), pending = no result seen (crash / still running).
 */
export function extractSessionOps(snapshot, record) {
  const header = snapshot?.session ?? record?.header ?? {};
  const events = snapshot?.events ?? [];
  const sessionId = header.id;
  const cwd = typeof header.cwd === 'string' ? header.cwd : '';
  const origin = header.origin ?? (header.delegationDepth > 0 ? 'subagent' : 'main');

  // callId -> isError (undefined = no result seen)
  const results = new Map();
  for (const ev of events) {
    if (ev.type !== 'tool/result') continue;
    const msg = ev.data?.message;
    const callId = msg?.source?.callId;
    if (!callId) continue;
    let isError = false;
    for (const part of msg?.content ?? []) {
      if (part?.type === 'tool-result' && part.isError === true) isError = true;
    }
    if (ev.data?.error) isError = true;
    results.set(callId, isError);
  }

  const ops = [];
  const calls = { total: 0, ok: 0, failed: 0, pending: 0 };
  const callLog = []; // { ts, outcome: 'ok'|'failed'|'pending' } for window filtering
  const turnUsages = []; // { session, turn, ts, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, provider, model }
  // The model in force for each assistant turn. The usage event itself
  // carries no model identity, so track the model announced by the events
  // that precede it: request/header (the actual request config, most
  // precise), then request/context, then model/selection (what was picked).
  // Sessions can switch models mid-stream (seen in real logs), so the LAST
  // announcement before each usage event is the one that produced it.
  let activeProvider = null;
  let activeModel = null;
  for (const ev of events) {
    if (ev.type === 'request/header') {
      const cfg = ev.data?.header?.config;
      if (cfg && typeof cfg.model === 'string' && cfg.model) {
        activeModel = cfg.model;
        activeProvider = typeof cfg.provider === 'string' ? cfg.provider : activeProvider;
      }
    } else if (ev.type === 'request/context') {
      if (typeof ev.data?.model === 'string' && ev.data.model) {
        activeModel = ev.data.model;
        activeProvider = typeof ev.data.provider === 'string' ? ev.data.provider : activeProvider;
      }
    } else if (ev.type === 'model/selection') {
      if (typeof ev.data?.model === 'string' && ev.data.model) {
        activeModel = ev.data.model;
        activeProvider = typeof ev.data.provider === 'string' ? ev.data.provider : activeProvider;
      }
    }
    if (ev.type === 'assistant/message' && ev.data?.usage && typeof ev.data.turn === 'number') {
      const u = ev.data.usage;
      turnUsages.push({
        session: sessionId,
        workspace: cwd,
        turn: ev.data.turn,
        ts: typeof ev.time === 'number' ? ev.time : 0,
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        cacheReadTokens: u.cacheReadTokens ?? 0,
        cacheWriteTokens: u.cacheWriteTokens ?? 0,
        provider: activeProvider,
        model: activeModel,
      });
    }
    if (ev.type !== 'tool/call') continue;
    const name = ev.data?.name;
    if (!WRITE_TOOLS.has(name)) continue;

    let args = null;
    try {
      args = typeof ev.data.arguments === 'string' ? JSON.parse(ev.data.arguments) : ev.data.arguments;
    } catch { /* unparseable: still a real call, tallied but no op extracted */ }
    // 'view' is read-only: never part of the adoption denominator or ops.
    if (args && typeof args === 'object' && name !== 'write' && name !== 'edit' && args.command === 'view') continue;

    calls.total += 1;
    const outcome = results.get(ev.data?.callId);
    const outcomeName = outcome === false ? 'ok' : outcome === true ? 'failed' : 'pending';
    callLog.push({ session: sessionId, workspace: cwd, ts: typeof ev.time === 'number' ? ev.time : 0, outcome: outcomeName });
    if (outcome === false) calls.ok += 1;
    else if (outcome === true) calls.failed += 1;
    else calls.pending += 1;
    if (outcome !== false) continue; // missing result or error -> skip
    if (!args || typeof args !== 'object') continue; // cannot build an op

    const base = {
      session: sessionId,
      cwd,
      workspace: cwd,
      origin,
      turn: ev.data.turn,
      ts: typeof ev.time === 'number' ? ev.time : 0,
    };

    if (name === 'write') {
      const path = args.file_path;
      if (typeof path !== 'string' || path.length === 0) continue;
      ops.push({ ...base, op: 'write', path, content: normalizeContent(args.content) });
      continue;
    }

    if (name === 'edit') {
      const path = args.file_path;
      if (typeof path !== 'string' || path.length === 0) continue;
      ops.push({
        ...base, op: 'replace', path,
        oldString: normalizeContent(args.old_string),
        newString: normalizeContent(args.new_string),
        replaceAll: args.replace_all === true,
      });
      continue;
    }

    // str_replace_editor (and str_replace_based_edit_tool alias)
    const path = args.path;
    if (typeof path !== 'string' || path.length === 0) continue;
    const command = args.command;
    if (command === 'create') {
      ops.push({ ...base, op: 'write', path, content: normalizeContent(args.file_text) });
    } else if (command === 'str_replace') {
      ops.push({
        ...base, op: 'replace', path,
        oldString: normalizeContent(args.old_str),
        newString: normalizeContent(args.new_str),
        replaceAll: args.replace_all === true,
      });
    } else if (command === 'insert') {
      ops.push({
        ...base, op: 'replace', path,
        oldString: '',
        newString: normalizeContent(args.new_str),
      });
    }
    // 'view' and unknown commands are read-only -> skip
  }
  return { ops, calls, callLog, turnUsages };
}

/**
 * The session store location, resolved lazily (and only once). Matches the
 * JSONL persistence layout: `~/.dsh/sessions/<workspace-slug>/session-<id>/`.
 * `null` once probed and absent — the store may legitimately not exist yet.
 */
let storeRoot;
function sessionStoreRoot() {
  if (storeRoot === undefined) {
    try { storeRoot = join(homedir(), '.dsh', 'sessions'); } catch { storeRoot = null; }
  }
  return storeRoot;
}

/**
 * Per-session extraction cache. collectOperations re-extracts EVERY session
 * on EVERY corpus build, and the extract dominates (~1.5s for 37 sessions):
 * zstd frames must be decompressed and 18k+ events JSON-parsed each time even
 * though closed session logs never change. The extraction result of a stored
 * log is a pure function of the file bytes, so entries are keyed by the same
 * stat identity DSH's own persistence layer uses for revisions
 * (size + mtimeNs + ctimeNs) and reused while that identity holds. Live
 * sessions (still appending) change size on every turn and simply miss.
 * Bounded LRU-ish: exceeded capacity drops the oldest-inserted entry.
 */
const EXTRACT_CACHE_CAPACITY = 256;
const extractCache = new Map(); // sessionId -> { key, extracted }

/** Inverted store index: session id -> persisted log path. */
let storeIndex = null; // null = not built yet; Map (possibly empty) once built
let storeIndexAt = 0;
const STORE_INDEX_TTL_MS = 60_000;

/**
 * Rebuild the id -> log-path index by walking `<slug>/session-<id>/` one
 * level deep. ~7ms for a 37-session store (directory listings only), so it
 * can be refreshed per corpus build without measurably contributing.
 */
function sessionLogIndex() {
  const root = sessionStoreRoot();
  if (!root) return null;
  const now = Date.now();
  if (storeIndex && now - storeIndexAt < STORE_INDEX_TTL_MS) return storeIndex;
  const index = new Map();
  let slugs;
  try { slugs = readdirSync(root, { withFileTypes: true }); } catch { slugs = []; }
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const wsDir = join(root, slug.name);
    let entries;
    try { entries = readdirSync(wsDir); } catch { continue; }
    for (const dir of entries) {
      const logPath = join(wsDir, dir, 'session.v3.jsonl.zstd');
      try { statSync(logPath); index.set(dir, logPath); } catch { /* not a persisted session dir */ }
    }
  }
  storeIndex = index;
  storeIndexAt = now;
  return index;
}

/** stat identity of one stored session log, or undefined when unavailable. */
function logIdentity(sessionId) {
  const logPath = sessionLogIndex()?.get(sessionId);
  if (!logPath) return undefined; // live-in-memory, not yet persisted, or layout changed
  try {
    const st = statSync(logPath, { bigint: true });
    return `${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
  } catch {
    return undefined;
  }
}

function cachedExtract(sessionId, record, extract) {
  const identity = logIdentity(sessionId);
  const hit = identity !== undefined ? extractCache.get(sessionId) : undefined;
  if (hit && hit.key === identity) {
    // Refresh insertion order so hot entries survive capacity eviction.
    extractCache.delete(sessionId);
    extractCache.set(sessionId, hit);
    return hit.extracted;
  }
  const extracted = extract();
  if (identity !== undefined) {
    // A rejected read must not poison the cache: never store a promise that
    // can reject — resolve first, then admit to the cache.
    if (extracted && typeof extracted.then === 'function') {
      extracted.then((resolved) => {
        extractCache.set(sessionId, { key: identity, extracted: resolved });
        if (extractCache.size > EXTRACT_CACHE_CAPACITY) {
          const oldest = extractCache.keys().next().value;
          extractCache.delete(oldest);
        }
      }, () => { /* unreadable session: nothing to cache */ });
      return extracted;
    }
    extractCache.set(sessionId, { key: identity, extracted });
    if (extractCache.size > EXTRACT_CACHE_CAPACITY) {
      const oldest = extractCache.keys().next().value;
      extractCache.delete(oldest);
    }
  }
  return extracted;
}

/**
 * Collect operations across all sessions, chronologically. Workspace
 * filtering happens AFTER collection (in the caller), so the workspace
 * option list always covers the whole corpus and switching workspaces
 * never re-reads the session store.
 */
export async function collectOperations(sessionQuery, options = {}) {
  const records = await sessionQuery.listSessions();
  const wanted = [];
  for (const rec of records) {
    if (options.includeSubagents === false && (rec?.header?.delegationDepth ?? 0) > 0) continue;
    wanted.push(rec);
  }
  const workspaces = [...new Set(records.map((rec) => rec?.header?.cwd).filter((c) => typeof c === 'string' && c.length > 0))].sort();
  const ops = [];
  const calls = { total: 0, ok: 0, failed: 0, pending: 0 };
  const callLog = [];
  const turnUsages = [];
  const concurrency = 4;
  let index = 0;
  async function worker() {
    while (index < wanted.length) {
      const rec = wanted[index++];
      try {
        // Closed session logs never change: the extraction (zstd decompress
        // + full JSON parse + fold) is reused across corpus builds while the
        // file's stat identity holds; only new/active sessions are re-read.
        const extracted = await cachedExtract(rec.header.id, rec, () =>
          sessionQuery.readSession(rec.header.id).then((snapshot) => extractSessionOps(snapshot, rec)));
        ops.push(...extracted.ops);
        for (const key of Object.keys(calls)) calls[key] += extracted.calls[key] ?? 0;
        callLog.push(...extracted.callLog ?? []);
        turnUsages.push(...extracted.turnUsages ?? []);
      } catch (err) {
        // A single unreadable session must not fail the whole report.
        ops.push({ __unreadable: true, session: rec.header.id, error: String(err?.message ?? err) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, wanted.length) }, worker));
  const readable = ops.filter((o) => !o.__unreadable);
  readable.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  // Per-session workspace, so the route can scope sessionCount to the
  // selected workspaces without re-reading the session store.
  const sessionMeta = wanted.map((rec) => ({ id: rec?.header?.id, workspace: rec?.header?.cwd ?? '' }));
  // Model ids announced anywhere in the corpus (request/header ·
  // request/context · model/selection), with per-model turn counts — the
  // panel's pricing editor lists exactly these.
  const modelTurns = new Map();
  for (const u of turnUsages) {
    if (typeof u.model !== 'string' || !u.model) continue;
    modelTurns.set(u.model, (modelTurns.get(u.model) ?? 0) + 1);
  }
  const models = [...modelTurns.entries()]
    .map(([id, turns]) => ({ id, turns }))
    .sort((a, b) => b.turns - a.turns);
  return { ops: readable, unreadable: ops.length - readable.length, sessionCount: wanted.length, workspaces, calls, callLog, turnUsages, sessionMeta, models };
}

/** Test seam: drop every cached session extraction. */
export function clearExtractionCache() {
  extractCache.clear();
}
