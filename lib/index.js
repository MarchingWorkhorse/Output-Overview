/**
 * output-overview — host entry.
 *
 * Registers HTTP routes on the web server once it composes, serving
 * aggregated output statistics (code/doc lines, adoption, cost) derived
 * from the session logs via ctx.sessionQuery. Pure GET surface.
 */
import { computeStats, withDisplayCurrency } from './stats-engine.js';
import { collectOperations } from './session-reader.js';
import { homedir } from 'node:os';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export const name = 'output-overview';

/**
 * Cache windows. The corpus (raw operations extracted from every session
 * log) is expensive (~3s cold) but workspace-independent; the windowed
 * aggregation on top of it is cheap (~20ms). Both live in memory only.
 */
const CORPUS_TTL_MS = 5 * 60_000;
const SUMMARY_TTL_MS = 30_000;

/**
 * Default USD prices per 1M tokens, per model. `models` keys by the model id
 * as sessions announce it (request/header · request/context ·
 * model/selection); turns whose model is unknown or missing from the table
 * fall back to `default`. The legacy flat shape
 * `{ label, hit, miss, write, out }` also still works (one model for all).
 */
const DEFAULT_PRICING = {
  default: 'glm-5.3-flash',
  models: {
    'glm-5.3-flash': { hit: 0.01725, miss: 0.06, write: 0.21, out: 0.21 },
  },
};

/**
 * Display currency for costs. Model unit prices are quoted in USD; costs are
 * converted for display via `fx` (how many display units one USD buys).
 * Default CNY at 6.70 (updated 2026-10-12); override via config, e.g.
 * `- id: output-overview  config: { currency: { code: 'CNY', symbol: '¥', fx: 6.7 } }`
 * or `{ currency: { code: 'USD', symbol: '$', fx: 1 } }` to keep USD.
 */
const DEFAULT_CURRENCY = { code: 'CNY', symbol: '¥', fx: 6.7 };

function currencyOf(config) {
  const c = config?.currency;
  if (!c || typeof c !== 'object') return DEFAULT_CURRENCY;
  const code = typeof c.code === 'string' && c.code ? c.code : DEFAULT_CURRENCY.code;
  const symbol = typeof c.symbol === 'string' && c.symbol ? c.symbol : (code === 'CNY' ? '¥' : code === 'USD' ? '$' : '');
  const fx = Number(c.fx);
  return { code, symbol, fx: Number.isFinite(fx) && fx > 0 ? fx : 1 };
}

function pricingOf(config) {
  const p = config?.pricing;
  if (!p || typeof p !== 'object') return DEFAULT_PRICING;
  const num = (v) => (Number.isFinite(v) && v >= 0 ? v : undefined);
  // Table form: { default, models: { name: { hit, miss, write, out } } }.
  if (p.models && typeof p.models === 'object') {
    const models = {};
    for (const [name, rates] of Object.entries(p.models)) {
      if (!rates || typeof rates !== 'object') continue;
      const row = {};
      for (const k of ['hit', 'miss', 'write', 'out']) {
        row[k] = num(rates[k]) ?? DEFAULT_PRICING.models[name]?.[k] ?? DEFAULT_PRICING.models[DEFAULT_PRICING.default]?.[k] ?? 0;
      }
      models[name] = row;
    }
    return {
      default: typeof p.default === 'string' && p.default ? p.default : DEFAULT_PRICING.default,
      models: Object.keys(models).length > 0 ? models : DEFAULT_PRICING.models,
    };
  }
  // Flat form (legacy): one price set for everything.
  const flat = { label: typeof p.label === 'string' ? p.label : DEFAULT_PRICING.default };
  for (const k of ['hit', 'miss', 'write', 'out']) flat[k] = num(p[k]) ?? DEFAULT_PRICING.models[DEFAULT_PRICING.default][k];
  return flat;
}

const sendJson = (response, status, payload) => {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
};

/**
 * Local overrides persisted outside the profile. The panel's pricing editor
 * writes here (POST /output-overview/api/config); whatever is saved wins
 * over cordis.patch.yml values and survives restarts. Atomic write
 * (tmp file + rename) so a crash mid-save cannot corrupt the JSON.
 */
const CONFIG_PATH = join(homedir(), '.dsh', 'output-overview-config.json');

async function readLocalOverrides() {
  try {
    const text = await readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // missing or unreadable -> no overrides
  }
}

async function writeLocalOverrides(overrides) {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(overrides, null, 2) + '\n', 'utf8');
  await rename(tmp, CONFIG_PATH);
}

/** Validate and normalize a pricing payload coming from the panel. */
function normalizePricingInput(p) {
  if (!p || typeof p !== 'object') return null;
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const models = {};
  if (p.models && typeof p.models === 'object') {
    for (const [name, rates] of Object.entries(p.models)) {
      if (typeof name !== 'string' || !name || !rates || typeof rates !== 'object') continue;
      const row = {};
      for (const k of ['hit', 'miss', 'write', 'out']) {
        const v = num(rates[k]);
        if (v !== undefined) row[k] = v;
      }
      if (Object.keys(row).length > 0) models[name] = row;
    }
  }
  if (Object.keys(models).length === 0) return null;
  const fallback = Object.keys(models)[0];
  return {
    default: typeof p.default === 'string' && p.default && models[p.default] ? p.default : fallback,
    models,
  };
}

/** Validate and normalize a currency payload coming from the panel. */
function normalizeCurrencyInput(c) {
  if (!c || typeof c !== 'object') return null;
  const code = typeof c.code === 'string' && c.code.trim() ? c.code.trim().toUpperCase() : null;
  if (!code) return null;
  const symbol = typeof c.symbol === 'string' && c.symbol ? c.symbol : (code === 'CNY' ? '¥' : code === 'USD' ? '$' : code);
  const fx = Number(c.fx);
  return { code, symbol, fx: Number.isFinite(fx) && fx > 0 ? fx : 1 };
}

/**
 * The injection keys the web host provides. 'loader' is the web app's
 * composition gate (same pair dsh-market uses); 'sessionQuery' comes from
 * the dsh-base stack and is what we read history through.
 */
export function apply(ctx, config) {
  const pricing = pricingOf(config);
  const currency = currencyOf(config);
  // Panel overrides (persisted in ~/.dsh/output-overview-config.json) win
  // over cordis.patch.yml values; loaded once at apply, refreshed on save.
  let localOverrides = null; // null = not loaded yet (lazy, first request)
  let configSequence = 0; // bumped on save; summary cache keys carry it
  const effective = () => ({
    pricing: (localOverrides && localOverrides.pricing) || pricing,
    currency: (localOverrides && localOverrides.currency) || currency,
    source: localOverrides && Object.keys(localOverrides).length > 0 ? 'panel' : 'config',
  });
  const dispose = ctx.inject(['webServer', 'loader'], (hostCtx) => {
    const host = hostCtx;
    /** @type {{ at: number, key: string, payload: object } | null} */
    let cache = null;
    /** @type {{ at: number, promise: Promise<object>, key: string } | null} */
    let inflight = null;
    /** @type {{ at: number, corpus: object } | null} */
    let corpusCache = null;
    /** Collection of the operation corpus; single-flight across requests. */
    async function corpus(sessionQuery, includeSubagents) {
      const key = JSON.stringify({ includeSubagents });
      const fresh = corpusCache
        && corpusCache.key === key
        && Date.now() - corpusCache.at < CORPUS_TTL_MS;
      if (fresh) return corpusCache.corpus;
      if (inflight && inflight.key === key) return inflight.promise; // join in-flight collection
      const promise = (async () => {
        try {
          const collected = await collectOperations(sessionQuery, { includeSubagents });
          corpusCache = { at: Date.now(), key, corpus: collected };
          return collected;
        } finally {
          if (inflight?.promise === promise) inflight = null;
        }
      })();
      inflight = { at: Date.now(), promise, key };
      return promise;
    }

    /**
     * Warm the corpus in the background shortly after the web stack mounts,
     * so the first panel open usually hits a hot cache. The session stack may
     * still be initializing at this point; a failed warm-up is harmless — the
     * first real request collects on demand.
     */
    const warm = setTimeout(() => {
      const q = ctx.get('sessionQuery');
      if (q) corpus(q, true).catch(() => {});
    }, 3_000);
    warm.unref?.();

    async function summary(request, response, url) {
      const sessionQuery = ctx.get('sessionQuery');
      if (sessionQuery === undefined) {
        sendJson(response, 503, { error: 'sessionQuery service unavailable' });
        return;
      }
      // workspace may repeat: ?workspace=a&workspace=b selects multiple;
      // absent/empty = all workspaces.
      const workspaces = url.searchParams.getAll('workspace').filter((w) => w.length > 0);
      const includeSubagents = url.searchParams.get('subagents') !== 'false';
      const refresh = url.searchParams.get('refresh') === '1';
      const num = (v) => {
        if (v === null || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? n : null;
      };
      const from = num(url.searchParams.get('from'));
      const to = num(url.searchParams.get('to'));
      const key = JSON.stringify({ workspaces, includeSubagents, from, to });

      if (!refresh && cache && cache.key === key && Date.now() - cache.at < SUMMARY_TTL_MS) {
        sendJson(response, 200, cache.payload);
        return;
      }

      const started = Date.now();
      try {
        if (localOverrides === null) localOverrides = await readLocalOverrides();
        const eff = effective();
        // The corpus is workspace-independent (filtering happens below) and
        // cached for CORPUS_TTL_MS; collection is single-flight, so bursty
        // requests share one pass over the session store.
        const corpusData = await corpus(sessionQuery, includeSubagents);
        const { ops: allOps, unreadable, sessionCount, workspaces: allWorkspaces, callLog, turnUsages, sessionMeta, models } = corpusData;
        // Workspaces whose cwd is missing from the URL (e.g. a workspace
        // without any file write) must still be scoped the same way as an
        // explicit pick — sessionCount follows the filter, not the ops.
        const wanted = (o) => workspaces.length === 0 || workspaces.includes(o.workspace);
        const wantedSession = (ws) => workspaces.length === 0 || workspaces.includes(ws);
        const scopedSessionCount = workspaces.length === 0
          ? sessionCount
          : sessionMeta.filter((m) => wantedSession(m.workspace)).length;
        const ops = allOps.filter(wanted);
        const windowCallLog = (callLog ?? []).filter((c) => wanted(c));
        // Cost attribution input MUST follow the same workspace filter as the
        // ops: turn usages are corpus-wide, and computeStats only applies the
        // time window to them — passing them unfiltered charged every
        // selected workspace with all other workspaces' token cost.
        const scopedTurnUsages = (turnUsages ?? []).filter((u) => wanted(u));
        const stats = withDisplayCurrency(
          computeStats(ops, { from, to, pricing: eff.pricing, turnUsages: scopedTurnUsages }),
          eff.currency);
        // Tool-level adoption: write-class calls executed successfully within
        // the window over all such calls observed in it (rejected and errored
        // calls count as not adopted; read-only `view` calls are excluded at
        // extraction time).
        const inWin = (ts) => ts > 0
          && (from === null || ts >= from)
          && (to === null || ts <= to);
        const windowCalls = windowCallLog.filter((c) => (from === null && to === null) || inWin(c.ts));
        const okCalls = windowCalls.filter((c) => c.outcome === 'ok').length;
        const adoption = {
          total: windowCalls.length,
          ok: okCalls,
          failed: windowCalls.filter((c) => c.outcome === 'failed').length,
          pending: windowCalls.filter((c) => c.outcome === 'pending').length,
          rate: windowCalls.length > 0 ? +(okCalls / windowCalls.length).toFixed(4) : null,
        };
        const payload = {
          ...stats,
          adoption,
          workspaces: allWorkspaces,
          workspaceFilter: workspaces,
          includeSubagents,
          // sessionCount follows the workspace filter (what the panel is
          // looking at); totalSessionCount stays the whole store.
          sessionCount: scopedSessionCount,
          totalSessionCount: sessionCount,
          unreadableSessions: unreadable,
          computeMs: Date.now() - started,
          displayCurrency: eff.currency,
          configSource: eff.source,
          // Corpus-wide model list with turn counts — the pricing editor
          // offers exactly these ids, pre-filled from real usage.
          models: models ?? [],
        };
        cache = { at: Date.now(), key, payload };
        sendJson(response, 200, payload);
      } catch (err) {
        sendJson(response, 500, { error: String(err?.message ?? err) });
      }
    }

    const disposers = [
      host.webServer.register({
        kind: 'exact',
        path: '/output-overview/api/summary',
        handler: async (request, response) => {
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' });
            response.end();
            return;
          }
          const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
          await summary(request, response, url);
        },
      }),
      // Panel pricing editor: GET returns the effective config (what a save
      // would replace) plus the corpus model list; POST validates and
      // persists overrides, then clears caches so the next summary reflects
      // the new prices immediately.
      host.webServer.register({
        kind: 'exact',
        path: '/output-overview/api/config',
        handler: async (request, response) => {
          if (request.method === 'GET') {
            if (localOverrides === null) localOverrides = await readLocalOverrides();
            const eff = effective();
            sendJson(response, 200, {
              pricing: eff.pricing,
              currency: eff.currency,
              source: eff.source,
              patchPricing: pricing, // what cordis.patch.yml configured
              patchCurrency: currency,
              configPath: CONFIG_PATH,
            });
            return;
          }
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'GET, POST' });
            response.end();
            return;
          }
          let body = '';
          for await (const chunk of request) {
            body += chunk;
            if (body.length > 1_000_000) { // absurd guard; the editor sends ~2KB
              sendJson(response, 413, { error: 'payload too large' });
              return;
            }
          }
          try {
            const parsed = JSON.parse(body || '{}');
            const nextPricing = parsed.pricing === null ? null : normalizePricingInput(parsed.pricing);
            const nextCurrency = parsed.currency === null ? null : normalizeCurrencyInput(parsed.currency);
            if (parsed.pricing !== undefined && parsed.pricing !== null && nextPricing === null) {
              sendJson(response, 400, { error: 'pricing 无效：models 至少需要一个带单价的模型' });
              return;
            }
            if (parsed.currency !== undefined && parsed.currency !== null && nextCurrency === null) {
              sendJson(response, 400, { error: 'currency 无效：需要 code（如 CNY/USD）' });
              return;
            }
            const current = localOverrides ?? (await readLocalOverrides());
            const next = {
              ...(parsed.pricing !== undefined ? { pricing: nextPricing } : {}),
              ...(parsed.currency !== undefined ? { currency: nextCurrency } : {}),
            };
            const merged = { ...current };
            // null explicitly drops that override (panel 「恢复默认」);
            // undefined leaves the stored value untouched.
            for (const k of ['pricing', 'currency']) {
              if (parsed[k] === null) delete merged[k];
              else if (parsed[k] !== undefined) merged[k] = next[k];
            }
            if (Object.keys(merged).length === 0) {
              try { await rename(CONFIG_PATH, `${CONFIG_PATH}.bak`); } catch { /* nothing to clear */ }
            } else {
              await writeLocalOverrides(merged);
            }
            localOverrides = Object.keys(merged).length > 0 ? merged : {};
            cache = null; // next summary recomputes with the new prices
            const eff = effective();
            sendJson(response, 200, { ok: true, pricing: eff.pricing, currency: eff.currency, source: eff.source });
          } catch (err) {
            sendJson(response, 400, { error: String(err?.message ?? err) });
          }
        },
      }),
    ];
    return () => disposers.forEach((d) => d());
  });
  return dispose;
}
