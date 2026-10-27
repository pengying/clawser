import { CdpBrowser } from './src/cdp.mjs';
import { HandoffServer } from './src/server.mjs';
import { FunnelTransport } from './src/funnel.mjs';
import { isAbsolute, join } from 'node:path';
import { registerDesktopPlugin } from './src/desktop-plugin.mjs';
import { registerClawserCli } from './src/cli.mjs';

const allowed = (ctx) => ctx.senderIsOwner === true && !ctx.sandboxed &&
  typeof ctx.sessionKey === 'string' && typeof ctx.sessionId === 'string' &&
  typeof ctx.assertInvocationCurrent === 'function' &&
  (/^agent:[^:]+:main$/i.test(ctx.sessionKey) || /^agent:[^:]+:[a-z0-9_-]+:(?:direct|dm):.+$/i.test(ctx.sessionKey)) &&
  !/:group:|:channel:|:subagent:|:cron:|:hook:|:heartbeat:/i.test(ctx.sessionKey);
const ownerKey = (ctx) => JSON.stringify([ctx.sessionKey, ctx.sessionId]);
const browserTool = (name) => /(?:^|[.:_])browser(?:_\d+)?$/.test(name || '');
const callKey = (event, ctx) => {
  const id = ctx.toolCallId || event.toolCallId;
  const runId = ctx.runId || event.runId;
  // Legacy tools.invoke only provides sessionKey and has no completion hook.
  // Admitting it would permanently prevent human takeover. Require the full
  // paired agent-runtime lifecycle rather than guessing when a call finished.
  if (![id, ctx.sessionKey, ctx.sessionId, runId].every((value) => typeof value === 'string' && value.trim())) return null;
  return JSON.stringify([ctx.sessionKey, ctx.sessionId, runId, id, event.toolName]);
};

export function createPlugin({ desktopRpcFactory, backendFactory = (profiles) => new CdpBrowser(profiles), serverFactory = (options) => new HandoffServer(options), funnelFactory = (options) => new FunnelTransport(options) } = {}) {
  return {
    id: 'browser-handoff', name: 'Clawser',
    register(api) {
      registerClawserCli(api);
      if (['cli-metadata', 'setup-only'].includes(api.registrationMode)) return;
      if (api.pluginConfig?.desktop?.enabled === true) return registerDesktopPlugin(api, { desktopRpcFactory });
      let service, transport, stopping = false;
      const completed = new Map(), calls = new Map();
      const config = api.pluginConfig || {};
      const getService = () => {
        if (!service || stopping) throw new Error('Browser Handoff service is not running');
        return service;
      };
      api.registerService({
        id: 'browser-handoff',
        async start(ctx = {}) {
          stopping = false;
          service = serverFactory({ backend: backendFactory(config.profiles || {}), publicBaseUrl: config.publicBaseUrl, comparisonProxyUrl: config.comparisonProxyUrl });
          service.store.on('ended', (event) => {
            completed.set(event.id, { ...event, mode: 'ended', viewerMetrics: service.viewerMetrics?.(event.id) || null });
            while (completed.size > 100) completed.delete(completed.keys().next().value);
          });
          try {
            await service.start({ port: config.port ?? 18796 });
            if (config.funnel?.enabled === true) {
              if (typeof ctx.stateDir !== 'string' || !isAbsolute(ctx.stateDir)) throw new Error('Browser Handoff Funnel requires a stable service stateDir');
              transport = funnelFactory({ httpsPort: config.funnel.httpsPort ?? 10000, ownershipFile: join(ctx.stateDir, 'browser-handoff', 'funnel-ownership.json') });
              service.setPublicBase(await transport.open(new URL(service.localUrl).port * 1));
            }
          } catch (error) {
            stopping = true;
            try { await service.close(); } catch { api.logger.warn('Browser Handoff startup listener cleanup failed.'); }
            service = undefined;
            try { await transport?.close(); } catch { api.logger.warn('Browser Handoff startup cleanup could not verify Funnel route ownership; inspect Tailscale configuration for unresolved exposure.'); }
            throw error;
          }
        },
        async stop() {
          stopping = true;
          try { await service?.close(); }
          finally {
            try { await transport?.close(); } catch { api.logger.warn('Browser Handoff could not clean up its Funnel route; inspect Tailscale configuration.'); }
            service = undefined; transport = undefined; calls.clear(); completed.clear();
          }
        },
      });
      api.on('before_tool_call', (event, ctx) => {
        if (!browserTool(event.toolName) || !service) return;
        const id = callKey(event, ctx);
        if (!id) return { block: true, blockReason: 'Browser Handoff requires a paired agent-runtime lifecycle (sessionKey, sessionId, runId, toolCallId). Use the agent browser tool; legacy HTTP/RPC tools.invoke is unsupported.' };
        try {
          service.store.gate.enter(id);
          calls.set(id, (calls.get(id) || 0) + 1);
        } catch (error) { return { block: true, blockReason: error.message }; }
      }, { priority: 1000 });
      api.on('after_tool_call', (event, ctx) => {
        if (!browserTool(event.toolName) || !service) return;
        const id = callKey(event, ctx), count = calls.get(id) || 0;
        if (!count) return;
        if (count > 1) { calls.set(id, count - 1); return; }
        calls.delete(id); service.store.gate.leave(id);
      });
      api.on('session_end', (event, ctx) => {
        if (!service) return;
        const sessionKey = event.sessionKey || ctx.sessionKey, sessionId = event.sessionId || ctx.sessionId;
        for (const share of [...service.store.shares.values()]) {
          const [key, incarnation] = JSON.parse(share.owner);
          if (sessionKey === key && (!sessionId || incarnation === sessionId)) service.store.end(share, 'session_end');
        }
      });
      api.registerTool({ contextVersion: 2, create(ctx) {
        if (!allowed(ctx)) return null;
        const owner = ownerKey(ctx);
        function status(id) {
          const s = getService();
          const share = s.store.shares.get(id);
          if (share) {
            if (share.owner !== owner) throw new Error('Share belongs to another owner session');
            try { return { ...s.store.state(share), browserGateFault: s.store.gate.poisonReason, viewerMetrics: s.viewerMetrics?.(id) || null }; } catch {}
          }
          const end = completed.get(id);
          if (!end || end.owner !== owner) throw new Error('Unknown share for this owner session');
          return { id, mode: 'ended', reason: end.reason, browserGateFault: s.store.gate.poisonReason, viewerMetrics: end.viewerMetrics || null };
        }
        return {
          name: 'browser_handoff', label: 'Browser Handoff',
          description: 'Owner-private temporary browser viewing/takeover links. List configured profile tabs, create one-tab invitations, wait/status, or revoke. Recipients start in watch mode. Browser-tool actions are gated while a human controls the browser. On completion take a fresh browser snapshot. Do not share invitation URLs in groups or logs.',
          parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
            action: { type: 'string', enum: ['tabs', 'create', 'status', 'wait', 'revoke'] },
            profile: { type: 'string' }, targetId: { type: 'string' }, id: { type: 'string' },
            permission: { type: 'string', enum: ['watch', 'control'] },
            ttlSeconds: { type: 'integer', minimum: 30, maximum: 1800 },
            timeoutSeconds: { type: 'integer', minimum: 1, maximum: 60 },
          } },
          async execute(_callId, params, signal) {
            ctx.assertInvocationCurrent();
            if (!allowed(ctx)) throw new Error('Owner-private access required');
            const s = getService();
            let result;
            if (params.action === 'tabs') {
              if (!params.profile) result = { profiles: Object.keys(config.profiles || {}) };
              else result = { profile: params.profile, tabs: (await s.backend.list(params.profile)).map(({ targetId, title, url }) => ({ targetId, title, url })) };
            } else if (params.action === 'create') {
              if (!s.publicBaseUrl) throw new Error('Configure publicBaseUrl or explicitly enable Funnel before creating links');
              // Resolve the target first; invocation may have ended while the browser was queried.
              const tab = (await s.backend.list(params.profile)).find((tab) => tab.targetId === params.targetId);
              if (!tab) throw new Error('Selected HTTP(S) browser tab is unavailable');
              ctx.assertInvocationCurrent();
              const ttlSeconds = params.ttlSeconds ?? 300;
              if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 1800) throw new Error('Invalid invitation lifetime');
              const invite = s.store.create({ owner, target: { profile: params.profile, targetId: params.targetId }, ttlMs: ttlSeconds * 1000, permission: params.permission || 'control' });
              result = { id: invite.id, url: `${s.publicBaseUrl}/s/${invite.id}/#invite=${invite.secret}`, expiresAt: invite.expiresAt, permission: params.permission || 'control', mode: 'unclaimed' };
            } else if (params.action === 'revoke') {
              s.store.revoke(params.id, owner); result = status(params.id);
            } else if (params.action === 'status') result = status(params.id);
            else if (params.action === 'wait') {
              const current = status(params.id);
              if (current.mode === 'ended') result = current;
              else {
                const seconds = params.timeoutSeconds ?? 60;
                if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) throw new Error('Invalid wait duration');
                await new Promise((resolve, reject) => {
                  const finish = (error) => {
                    clearTimeout(timer); s.store.off('ended', onEnd); signal?.removeEventListener('abort', onAbort);
                    error ? reject(error) : resolve();
                  };
                  const onEnd = (event) => { if (event.id === params.id) finish(); };
                  const onAbort = () => finish(new Error('Wait cancelled'));
                  const timer = setTimeout(() => finish(), seconds * 1000);
                  s.store.on('ended', onEnd); signal?.addEventListener('abort', onAbort, { once: true });
                  if (signal?.aborted) onAbort();
                });
                result = status(params.id);
              }
            } else throw new Error('Unsupported handoff action');
            ctx.assertInvocationCurrent();
            return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
          },
        };
      } }, { name: 'browser_handoff', optional: true });
    },
  };
}
export default createPlugin();
