import { CloudflareTransport } from './src/cloudflare-transport.mjs';
import { ownerAuthorized, ownerGuard } from './src/authorization.mjs';
import { CdpBrowser } from './src/cdp.mjs';
import { HandoffServer } from './src/server.mjs';
import { FunnelTransport } from './src/funnel.mjs';
import { isAbsolute, join } from 'node:path';
import { registerDesktopPlugin } from './src/desktop-plugin.mjs';
import { registerClawserCli } from './src/cli.mjs';
import { createBrowserBindingGuard, monitorBrowserBinding, registerBrowserAccessPolicy } from './src/browser-policy.mjs';

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

const toolDescriptor = {
  name: 'browser_handoff', label: 'Browser Handoff',
  description: 'Owner-authorized temporary browser viewing/takeover links. List configured profile tabs, create one-tab invitations, wait/status, or revoke. Recipients start in watch mode. Browser-tool actions are gated while a human controls the browser. On completion take a fresh browser snapshot. Deliver privately by default. An explicitly allowed group owner request permits delivery only in that same requesting group/thread. Any member can claim the one-use bearer invitation. Keep links out of logs.',
  parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: ['tabs', 'create', 'status', 'wait', 'revoke'] },
    profile: { type: 'string' }, targetId: { type: 'string' }, id: { type: 'string' },
    permission: { type: 'string', enum: ['watch', 'control'] },
    ttlSeconds: { type: 'integer', minimum: 30, maximum: 1800 },
    timeoutSeconds: { type: 'integer', minimum: 1, maximum: 60 },
  } }
};
const liveSymbol = Symbol.for('openclaw.browser-handoff.cdp-live-instances.v1');
const liveInstances = () => globalThis[liveSymbol] ??= new Map();
const instanceKey = api => JSON.stringify(api.pluginConfig || {});

// A canceled tool wait must not cancel the operator-enabled shared warmup.
function awaitPublicTransport(readiness, signal) {
  const cancellation = signal ? AbortSignal.any([signal, readiness.abort.signal]) : readiness.abort.signal;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cancellation.removeEventListener('abort', onAbort);
      reject(cancellation.reason instanceof Error ? cancellation.reason : new Error('Browser handoff cancelled'));
    };
    readiness.promise.then(() => {
      cancellation.removeEventListener('abort', onAbort); resolve();
    }, error => {
      cancellation.removeEventListener('abort', onAbort); reject(error);
    });
    cancellation.addEventListener('abort', onAbort, { once: true });
    if (cancellation.aborted) onAbort();
  });
}

export function createPlugin({ desktopRpcFactory, bindingMonitorScheduler, backendFactory = (profiles) => new CdpBrowser(profiles), serverFactory = (options) => new HandoffServer(options), funnelFactory = (options) => new FunnelTransport(options), cloudflareFactory = options => new CloudflareTransport(options) } = {}) {
  return {
    id: 'browser-handoff', name: 'Clawser',
    register(api) {
      if (api.registrationMode !== 'tool-discovery') registerClawserCli(api);
      if (['cli-metadata', 'setup-only'].includes(api.registrationMode)) return;
      if (api.pluginConfig?.desktop?.enabled === true) return registerDesktopPlugin(api, { desktopRpcFactory, bindingMonitorScheduler });
      const config = api.pluginConfig || {};
      const allowed = ctx => ownerAuthorized(ctx, config);
      if (api.registrationMode === 'tool-discovery') {
        api.registerTool({ contextVersion: 2, create(ctx) {
          if (!allowed(ctx)) return null;
          const current = ownerGuard(ctx, config);
          return { ...toolDescriptor, async execute(callId, params, signal) {
            current();
            const instance = liveInstances().get(instanceKey(api));
            if (!instance) throw new Error('Browser Handoff existing-browser service is unavailable');
            const tool = instance.factory.create(ctx);
            if (!tool) throw new Error('Owner-authorized access required');
            return tool.execute(callId, params, signal);
          } };
        } }, { name: 'browser_handoff', optional: true });
        return;
      }
      if (api.registrationMode !== undefined && api.registrationMode !== 'full') return;
      let service, transport, transportReadiness, stopping = false, epoch, publication, stopBindingMonitor;
      const unpublish = () => {
        if (publication && liveInstances().get(publication.key) === publication) liveInstances().delete(publication.key);
        publication = undefined;
      };
      const binding = createBrowserBindingGuard(api, { onDrift() {
        unpublish();
        service?.setPublicBase(undefined);
        if (!service) return;
        // Poison before retirement: ending a share must not clear uncertain
        // human input or a pending native browser call from this generation.
        service.store.gate.poison();
        for (const share of [...service.store.shares.values()]) service.store.end(share, 'configuration_changed');
      } });
      const completed = new Map(), calls = new Map();
      const getService = () => {
        if (!service || stopping) throw new Error('Browser Handoff service is not running');
        binding.current();
        if (!publication || liveInstances().get(publication.key) !== publication) throw new Error('Browser Handoff service is stale or unavailable');
        if (service.store.gate.poisonReason) { unpublish(); throw new Error('Browser Handoff service fault requires operator recovery'); }
        return service;
      };
      registerBrowserAccessPolicy(api, { binding, assertAvailable: getService });
      api.registerService({
        id: 'browser-handoff',
        async start(ctx = {}) {
          if (service) throw new Error('Browser Handoff service is already running or stopping');
          if (config.funnel?.enabled === true && config.cloudflare?.enabled === true) throw new Error('Funnel and Cloudflare transports are mutually exclusive');
          const resolved = binding.pin();
          unpublish(); stopping = false;
          const started = epoch = Symbol();
          const dynamic = config.funnel?.enabled === true || config.cloudflare?.enabled === true;
          const isBindingCurrent = () => {
            if (epoch !== started || stopping) return false;
            try { binding.current(); return true; } catch { return false; }
          };
          const ownedService = service = serverFactory({ isBindingCurrent, backend: backendFactory(resolved.profiles), publicBaseUrl: dynamic ? undefined : config.publicBaseUrl, comparisonProxyUrl: config.comparisonProxyUrl });
          let ownedTransport;
          const current = () => {
            if (epoch !== started || service !== ownedService || stopping) throw new Error('Browser Handoff service changed during startup');
            binding.current();
          };
          ownedService.store.on('ended', event => {
            if (service !== ownedService) return;
            completed.set(event.id, { ...event, mode: 'ended', viewerMetrics: ownedService.viewerMetrics?.(event.id) || null });
            while (completed.size > 100) completed.delete(completed.keys().next().value);
          });
          try {
            await ownedService.start({ port: config.port ?? 18796 }); current();
            if (dynamic && (typeof ctx.stateDir !== 'string' || !isAbsolute(ctx.stateDir))) throw new Error('Browser Handoff public transport requires a stable service stateDir');
            if (config.funnel?.enabled === true) {
              ownedTransport = transport = funnelFactory({ httpsPort: config.funnel.httpsPort ?? 10000, ownershipFile: join(ctx.stateDir, 'browser-handoff', 'funnel-ownership.json') });
              const origin = await ownedTransport.open(Number(new URL(ownedService.localUrl).port)); current();
              ownedService.setPublicBase(origin);
            } else if (config.cloudflare?.enabled === true) {
              ownedTransport = transport = cloudflareFactory({ binaryPath: config.cloudflare.binaryPath, startupTimeoutMs: config.cloudflare.startupTimeoutMs ?? 90_000, stateDir: join(ctx.stateDir, 'browser-handoff', 'cloudflare'), probePath: '/assets/style.css' });
              const readiness = transportReadiness = { abort: new AbortController(), service: ownedService };
              const failed = error => {
                if (epoch !== started || service !== ownedService || transport !== ownedTransport || stopping) return;
                unpublish(); stopping = true;
                readiness.abort.abort(error);
                ownedService.setPublicBase(undefined);
                for (const share of [...ownedService.store.shares.values()]) ownedService.store.end(share, 'tunnel_exit');
                // Keep the local service/gate until normal stop. A failed tunnel
                // must never publish new invitations or bypass browser fencing.
                void ownedTransport.close().catch(() => api.logger.warn('Browser Handoff could not verify owned public transport shutdown.'));
              };
              ownedTransport.on('failure', failed);
              // Host hot activation has a short service.start deadline. Warm
              // the tunnel in the background; create alone waits for readiness.
              readiness.promise = Promise.resolve().then(() => {
                current();
                return ownedTransport.ensure(Number(new URL(ownedService.localUrl).port));
              }).then(origin => { current(); ownedService.setPublicBase(origin); }).catch(error => { failed(error); throw error; });
              // Startup failures are observed even when no owner is waiting.
              void readiness.promise.catch(() => {});
            }
            current();
            publication = { key: instanceKey(api), factory: toolFactory };
            liveInstances().set(publication.key, publication);
            stopBindingMonitor = monitorBrowserBinding(binding, bindingMonitorScheduler);
          } catch (error) {
            if (epoch === started) { unpublish(); stopping = true; stopBindingMonitor?.(); stopBindingMonitor = undefined; }
            ownedService.setPublicBase(undefined);
            try { await ownedService.close(); } catch { api.logger.warn('Browser Handoff startup listener cleanup failed.'); }
            try { await ownedTransport?.close(); } catch { api.logger.warn('Browser Handoff startup public transport cleanup could not be verified.'); }
            if (service === ownedService) service = undefined;
            if (transport === ownedTransport) transport = undefined;
            throw error;
          }
        },
        async stop() {
          unpublish(); stopping = true; epoch = undefined;
          stopBindingMonitor?.(); stopBindingMonitor = undefined;
          const ownedService = service, ownedTransport = transport, readiness = transportReadiness;
          readiness?.abort.abort(new Error('Browser Handoff service stopped during public transport readiness'));
          ownedService?.setPublicBase(undefined);
          try { await ownedService?.close(); }
          finally {
            try { await ownedTransport?.close(); } catch { api.logger.warn('Browser Handoff could not verify public transport cleanup; inspect the owned route/process.'); }
            if (service === ownedService) { service = undefined; calls.clear(); completed.clear(); }
            if (transport === ownedTransport) transport = undefined;
            if (transportReadiness === readiness) transportReadiness = undefined;
          }
        },
      });
      api.on('before_tool_call', (event, ctx) => {
        if (!browserTool(event.toolName)) return;
        const id = callKey(event, ctx);
        if (!id) return { block: true, blockReason: 'Browser Handoff requires a paired agent-runtime lifecycle (sessionKey, sessionId, runId, toolCallId). Use the agent browser tool; legacy HTTP/RPC tools.invoke is unsupported.' };
        try {
          const currentService = getService();
          currentService.store.gate.enter(id);
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
      const toolFactory = { contextVersion: 2, create(ctx) {
        if (!allowed(ctx)) return null;
        const owner = ownerKey(ctx);
        const current = ownerGuard(ctx, config);
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
          ...toolDescriptor,
          async execute(_callId, params, signal) {
            current();
            const s = getService();
            const active = () => {
              current();
              if (signal?.aborted) throw new Error('Browser handoff cancelled');
              if (getService() !== s) throw new Error('Browser Handoff service changed');
            };
            active();
            const resolved = binding.current().binding;
            const profile = params.profile === undefined ? resolved.profile : params.profile;
            if (['tabs', 'create'].includes(params.action) && (typeof profile !== 'string' || !Object.hasOwn(resolved.profiles, profile))) throw new Error('Only configured existing browser profiles can be handed off');
            let result;
            if (params.action === 'tabs') {
              result = { profiles: Object.keys(resolved.profiles), profile, tabs: (await s.backend.list(profile)).map(({ targetId, title, url }) => ({ targetId, title, url })) };
            } else if (params.action === 'create') {
              const readiness = transportReadiness;
              if (readiness?.service === s) {
                active();
                await awaitPublicTransport(readiness, signal);
                active();
              }
              if (!s.publicBaseUrl) throw new Error('Configure publicBaseUrl or explicitly enable Funnel or Cloudflare before creating links');
              // Resolve the target first; invocation may have ended while the browser was queried.
              const tab = (await s.backend.list(profile)).find((tab) => tab.targetId === params.targetId);
              if (!tab) throw new Error('Selected HTTP(S) browser tab is unavailable');
              active();
              const ttlSeconds = params.ttlSeconds ?? 300;
              if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 1800) throw new Error('Invalid invitation lifetime');
              const invite = s.store.create({ owner, target: { profile, targetId: params.targetId }, ttlMs: ttlSeconds * 1000, permission: params.permission || 'control' });
              result = { profile, id: invite.id, url: s.publicBaseUrl + '/s/' + invite.id + '/#invite=' + invite.secret, expiresAt: invite.expiresAt, permission: params.permission || 'control', mode: 'unclaimed' };
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
            active();
            return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
          },
        };
      } };
      api.registerTool(toolFactory, { name: 'browser_handoff', optional: true });
    },
  };
}
export default createPlugin();
