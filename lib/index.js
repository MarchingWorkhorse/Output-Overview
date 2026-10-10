/**
 * dsh-code-stats — host entry.
 *
 * Registers HTTP routes on the web server once it composes, serving
 * aggregated code-generation statistics derived from the session logs via
 * ctx.sessionQuery. Pure GET surface: no state mutation, no shell.
 */
import { computeStats } from './stats-engine.js';
import { collectOperations } from './session-reader.js';

export const name = 'dsh-code-stats';

/** Cache window for the computed corpus (ms). */
const CACHE_TTL_MS = 30_000;

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
  const dispose = ctx.inject(['webServer', 'loader'], (hostCtx) => {
    const host = hostCtx;
    /** @type {{ at: number, key: string, payload: object } | null} */
    let cache = null;
    /** @type {{ at: number, key: string, ops: Array, unreadable: number, sessionCount: number } | null} */
    let opsCache = null;

    async function summary(request, response, url) {
      const sessionQuery = ctx.get('sessionQuery');
      if (sessionQuery === undefined) {
        sendJson(response, 503, { error: 'sessionQuery service unavailable' });
        return;
      }
      const workspace = url.searchParams.get('workspace') || null;
      const includeSubagents = url.searchParams.get('subagents') !== 'false';
      const refresh = url.searchParams.get('refresh') === '1';
      const num = (v) => {
        if (v === null || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? n : null;
      };
      const from = num(url.searchParams.get('from'));
      const to = num(url.searchParams.get('to'));
      const key = JSON.stringify({ workspace, includeSubagents, from, to });

      if (!refresh && cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) {
        sendJson(response, 200, cache.payload);
        return;
      }

      const started = Date.now();
      try {
        // Slow path: collecting raw operations re-reads every session. Cache
        // it separately from the (cheap) windowed aggregation so switching
        // time ranges does not re-read the session store.
        const opsKey = JSON.stringify({ workspace, includeSubagents });
        if (refresh || !opsCache || opsCache.key !== opsKey || Date.now() - opsCache.at > CACHE_TTL_MS) {
          const collected = await collectOperations(sessionQuery, {
            workspace: workspace ?? undefined,
            includeSubagents,
          });
          opsCache = { at: Date.now(), key: opsKey, ...collected };
        }
        const { ops, unreadable, sessionCount, callLog } = opsCache;
        const stats = computeStats(ops, { from, to });
        // Tool-level adoption: write-class calls executed successfully within
        // the window over all such calls observed in it (rejected and errored
        // calls count as not adopted; read-only `view` calls are excluded at
        // extraction time).
        const inWin = (ts) => ts > 0
          && (from === null || ts >= from)
          && (to === null || ts <= to);
        const windowCalls = (callLog ?? []).filter((c) => (from === null && to === null) || inWin(c.ts));
        const okCalls = windowCalls.filter((c) => c.outcome === 'ok').length;
        const adoption = {
          total: windowCalls.length,
          ok: okCalls,
          failed: windowCalls.filter((c) => c.outcome === 'failed').length,
          pending: windowCalls.filter((c) => c.outcome === 'pending').length,
          rate: windowCalls.length > 0 ? +(okCalls / windowCalls.length).toFixed(4) : null,
        };
        const workspaces = [...new Set(stats.sessions.map((s) => s.workspace).filter(Boolean))].sort();
        const payload = {
          ...stats,
          adoption,
          workspaces,
          workspaceFilter: workspace,
          includeSubagents,
          sessionCount,
          unreadableSessions: unreadable,
          computeMs: Date.now() - started,
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
        path: '/code-stats/api/summary',
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
