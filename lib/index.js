/**
 * output-overview — host entry.
 *
 * Registers HTTP routes on the web server once it composes, serving
 * aggregated output statistics (code/doc lines, adoption, cost) derived
 * from the session logs via ctx.sessionQuery. Pure GET surface.
 */
import { computeStats, withDisplayCurrency } from './stats-engine.js';
import { collectOperations } from './session-reader.js';

export const name = 'output-overview';

/**
 * Cache windows. The corpus (raw operations extracted from every session
 * log) is expensive (~3s cold) but workspace-independent; the windowed
 * aggregation on top of it is cheap (~20ms). Both live in memory only.
 */
const CORPUS_TTL_MS = 5 * 60_000;
const SUMMARY_TTL_MS = 30_000;

/**
 * Default USD prices per 1M tokens. Mirrors the glm-5.3-flash rates the
 * dsh-context plugin is configured with on this deployment; override via a
 * patch row: `- id: output-overview  config: { pricing: { label, hit, miss,
 * write, out } }` (hit=cacheRead, miss=uncachedInput, write=cacheWrite,
 * out=output).
 */
const DEFAULT_PRICING = { label: 'glm-5.3-flash', hit: 0.01725, miss: 0.06, write: 0.21, out: 0.21 };

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
  const pricing = { label: typeof p.label === 'string' ? p.label : DEFAULT_PRICING.label };
  for (const k of ['hit', 'miss', 'write', 'out']) pricing[k] = num(p[k]) ?? DEFAULT_PRICING[k];
  return pricing;
}

const sendJson = (response, status, payload) => {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
};

/**
 * The injection keys the web host provides. 'loader' is the web app's
 * composition gate (same pair dsh-market uses); 'sessionQuery' comes from
 * the dsh-base stack and is what we read history through.
 */
export function apply(ctx, config) {
  const pricing = pricingOf(config);
  const currency = currencyOf(config);
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
        // The corpus is workspace-independent (filtering happens below) and
        // cached for CORPUS_TTL_MS; collection is single-flight, so bursty
        // requests share one pass over the session store.
        const corpusData = await corpus(sessionQuery, includeSubagents);
        const { ops: allOps, unreadable, sessionCount, workspaces: allWorkspaces, callLog, turnUsages } = corpusData;
        const wanted = (o) => workspaces.length === 0 || workspaces.includes(o.workspace);
        const ops = allOps.filter(wanted);
        const windowCallLog = (callLog ?? []).filter((c) => wanted(c));
        const stats = withDisplayCurrency(
          computeStats(ops, { from, to, pricing, turnUsages }),
          currency);
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
          sessionCount,
          unreadableSessions: unreadable,
          computeMs: Date.now() - started,
          displayCurrency: currency,
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
    ];
    return () => disposers.forEach((d) => d());
  });
  return dispose;
}
