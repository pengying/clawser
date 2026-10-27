import { isAbsolute } from 'node:path';

const scopeNotice = 'This link exposes the entire dedicated browser profile: all tabs, browser chrome, dialogs, and clipboard during control.';
const privateSession = (key) => typeof key === 'string' &&
  (/^agent:[^:]+:main$/i.test(key) || /^agent:[^:]+:[a-z0-9_-]+:(?:direct|dm):.+$/i.test(key)) &&
  !/:group:|:channel:|:subagent:|:cron:|:hook:|:heartbeat:/i.test(key);
const allowed = (ctx) => ctx.senderIsOwner === true && !ctx.sandboxed && privateSession(ctx.sessionKey) &&
  typeof ctx.sessionId === 'string' && !!ctx.sessionId.trim() && typeof ctx.assertInvocationCurrent === 'function';
const browserTool = (name) => /(?:^|[.:_])browser(?:_\d+)?$/.test(name || '');
const callKey = (event, ctx) => {
  const values = [ctx.sessionKey, ctx.sessionId, ctx.runId || event.runId, ctx.toolCallId || event.toolCallId];
  return values.every(value => typeof value === 'string' && value.trim()) ? JSON.stringify([...values, event.toolName]) : null;
};
const defaultRpcFactory = async (socketPath) => new (await import('./desktop-rpc.mjs')).DesktopRpcClient(socketPath);
function cdpIdentity(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Production browser CDP mapping must be a loopback HTTP origin');
  return url.origin;
}
function duration(value, fallback, min, max, label) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`Invalid ${label}`);
  return result;
}

// Only private control-plane RPC runs in the Gateway. VNC, HTTP viewers, browser
// supervision and the authoritative automation gate live in the controller.
export function registerDesktopPlugin(api, { desktopRpcFactory = defaultRpcFactory } = {}) {
  const config = api.pluginConfig.desktop;
  let client, running = false, fault, pollTimer, serviceEpoch;
  const calls = new Map(), notifications = new Map();
  const canceledOwners = new Set(), canceledSessions = new Set();
  const sessionRuntime = api.runtime?.agent?.session, system = api.runtime?.system;
  const requestWake = typeof system?.requestHeartbeat === 'function'
    ? (options) => system.requestHeartbeat(options)
    : typeof system?.requestHeartbeatNow === 'function' ? (options) => system.requestHeartbeatNow(options) : undefined;
  const canWake = typeof sessionRuntime?.getSessionEntryAsync === 'function' && typeof system?.enqueueSystemEvent === 'function' && !!requestWake;
  const continuation = canWake ? 'session-event' : 'active-wait';
  const continuationNotice = canWake
    ? 'Completion queues a session event after checking the current session incarnation. Continue only if the original task is pending. The SDK does not bind wake requests atomically to a sessionId.'
    : 'Automatic dormant-session wake is unavailable in this SDK. Keep an active wait tool call, or continue from a new owner turn.';
  const canceled = (owner, key) => canceledOwners.has(owner) || canceledSessions.has(key);
  let polling = false;
  async function pollCompletions() {
    if (!canWake || !running || polling) return;
    polling = true;
    const rpc = client, epoch = serviceEpoch;
    const current = () => running && client === rpc && serviceEpoch === epoch;
    const ack = async (id) => { if (current()) await rpc.request('acknowledgeCompletion', { id }, { timeoutMs: 10_000 }); };
    try {
      const result = await rpc.request('completions', { limit: 50 }, { timeoutMs: 10_000 });
      const completions = Array.isArray(result) ? result : result?.completions;
      if (!Array.isArray(completions)) throw new Error('Invalid completion queue response');
      for (const completion of completions) {
        if (!current()) return;
        if (typeof completion?.id !== 'string' || !completion.id || completion.id.length > 256) continue;
        let identity;
        try { identity = JSON.parse(completion.owner); } catch { await ack(completion.id); continue; }
        const [sessionKey, sessionId] = Array.isArray(identity) ? identity : [];
        if (identity?.length !== 2 || !privateSession(sessionKey) || typeof sessionId !== 'string' || !sessionId || completion.profile !== config.profile || canceled(completion.owner, sessionKey) || completion.reason === 'session_end' || completion.reason === 'plugin_stop') {
          await ack(completion.id); continue;
        }
        const notificationKey = JSON.stringify([completion.owner, completion.id]);
        if (notifications.get(notificationKey) === 'delivered') { await ack(completion.id); continue; }
        const entry = await sessionRuntime.getSessionEntryAsync({ sessionKey, readConsistency: 'latest' });
        if (!current()) return;
        if (entry?.sessionId !== sessionId || entry.abortedLastRun === true || canceled(completion.owner, sessionKey)) { await ack(completion.id); continue; }
        const agentId = /^agent:([^:]+):/i.exec(sessionKey)[1];
        if (!notifications.has(notificationKey)) {
          const reason = ['done', 'expired', 'disconnect', 'disconnected', 'revoke', 'revoked', 'tunnel_exit', 'heartbeat_timeout'].includes(completion.reason) ? completion.reason : 'ended';
          const safe = !fault && completion.resumeAllowed === true && completion.recoveryRequired !== true;
          const text = `Browser Handoff ${JSON.stringify(completion.id)} ended (${reason}) for profile ${JSON.stringify(config.profile)}. ` +
            (safe ? 'Input authority returned safely (resumeAllowed=true). Continue only if the original task remains pending. Take a fresh normal browser snapshot and check the actual outcome before continuing. '
              : 'resumeAllowed=false: browser automation must remain paused; operator recovery is required. ') +
            'This event does not prove a CAPTCHA or form succeeded. After expiry, disconnect, or revoke, do not recreate handoff links automatically; ask the owner if further human action is needed. Do not resume a canceled task.';
          // This synchronous enqueue+wake pair follows the latest incarnation
          // read. Published SDK wake APIs do not accept an expected sessionId.
          if (system.enqueueSystemEvent(text, { sessionKey, agentId, contextKey: `browser-handoff:${completion.id}:${sessionId}`, fromConversationTurn: true }) !== true) continue;
          notifications.set(notificationKey, 'enqueued');
        }
        // Targeted background handback requires immediate intent in the SDK:
        // event intent can be disabled with cadence or deferred until its tick.
        requestWake({ source: 'background-task', intent: 'immediate', reason: `browser-handoff:${completion.id}`, agentId, sessionKey });
        notifications.set(notificationKey, 'delivered');
        while (notifications.size > 500) notifications.delete(notifications.keys().next().value);
        await ack(completion.id);
      }
    } catch { if (current()) api.logger.warn('Browser Handoff completion polling did not finish; unacknowledged events will be retried.'); }
    finally { polling = false; }
  }
  const getClient = () => {
    if (!running || !client) throw new Error('Browser Handoff production controller is unavailable');
    return client;
  };
  const validateIdentity = (identity) => {
    if (identity?.ready === false || identity?.recoveryRequired === true) throw new Error('Browser Handoff controller is not ready; reconciliation or operator recovery is required');
    if (!identity || identity.profile !== config.profile) throw new Error('Browser Handoff controller profile does not match desktop.profile');
    const profile = api.config?.browser?.profiles?.[config.profile];
    if (profile?.attachOnly !== true) throw new Error('Browser Handoff requires attachOnly=true for its dedicated Chromium profile');
    if (profile.driver !== undefined && !['openclaw', 'clawd'].includes(profile.driver)) throw new Error('Browser Handoff requires the openclaw CDP driver for its dedicated profile');
    if (profile.engine !== undefined && profile.engine !== 'chromium') throw new Error('Browser Handoff requires the Chromium browser engine for its dedicated profile');
    const mapping = profile.cdpUrl;
    if (!mapping || cdpIdentity(mapping) !== cdpIdentity(identity.cdpUrl)) throw new Error('Browser Handoff CDP profile mapping does not match the production controller');
    return identity;
  };
  const ensure = async (rpc, signal, key) => validateIdentity(await rpc.request('ensure', { profile: config.profile, ...(key ? { callKey: key } : {}) }, { signal, timeoutMs: 120_000 }));
  const releaseAdmission = async (rpc, key) => {
    const count = calls.get(key) || 0;
    if (!count) return;
    if (count > 1) calls.set(key, count - 1);
    else calls.delete(key);
    const receipt = await rpc.request('automationLeave', { callKey: key }, { timeoutMs: 15_000 });
    if (receipt?.released !== true) throw new Error('Uncertain completion receipt');
  };
  const completionFault = () => {
    fault = 'Browser Handoff could not verify browser-call completion; operator recovery is required';
    api.logger.warn(fault);
    return new Error(fault);
  };
  api.registerService({
    id: 'browser-handoff',
    async start() {
      running = false; fault = undefined; serviceEpoch = Symbol();
      if (!isAbsolute(config.socketPath || '')) throw new Error('desktop.socketPath must be an absolute private Unix socket path');
      if (typeof config.profile !== 'string' || !config.profile.trim()) throw new Error('desktop.profile is required');
      try {
        client = await desktopRpcFactory(config.socketPath);
        validateIdentity(await client.request('health', {}, { timeoutMs: 10_000 }));
        running = true;
        if (canWake) {
          pollTimer = setInterval(() => { void pollCompletions(); }, 1000);
          pollTimer.unref?.();
          void pollCompletions();
        } else api.logger.warn('Browser Handoff supports active waits only: session-incarnation reads and system-event wake APIs are required for dormant continuation.');
      } catch (error) {
        client?.close(); client = undefined;
        throw error;
      }
    },
    async stop() {
      running = false; serviceEpoch = undefined;
      clearInterval(pollTimer); pollTimer = undefined;
      const rpc = client;
      try {
        if (rpc) {
          // The dedicated controller survives Gateway restarts. Its ledger,
          // rather than this plugin's memory, identifies every profile lease.
          const receipt = await rpc.request('revokeAll', { reason: 'plugin_stop' }, { timeoutMs: 180_000 });
          if (receipt?.allRetired !== true || receipt?.recoveryRequired !== false)
            throw new Error('Browser Handoff shutdown could not verify every viewer retirement; operator recovery is required');
        }
      } finally { rpc?.close(); client = undefined; calls.clear(); }
    },
  });
  api.on('before_tool_call', async (event, ctx) => {
    if (!browserTool(event.toolName)) return;
    const key = callKey(event, ctx);
    if (!key) return { block: true, blockReason: 'Browser Handoff requires a paired agent-runtime lifecycle (sessionKey, sessionId, runId, toolCallId); legacy tools.invoke is unsupported.' };
    try {
      const rpc = getClient();
      if (fault) throw new Error(fault);
      const receipt = await rpc.request('automationEnter', { callKey: key }, { timeoutMs: 15_000 });
      if (receipt?.admitted !== true) {
        fault = 'Browser Handoff controller returned uncertain automation admission; operator recovery is required';
        throw new Error(fault);
      }
      calls.set(key, (calls.get(key) || 0) + 1);
      try {
        if (!running || rpc !== client) throw new Error('Browser Handoff controller stopped during admission');
        if ((event.params?.profile ?? api.config?.browser?.defaultProfile) === config.profile) await ensure(rpc, undefined, key);
      } catch (error) {
        try { await releaseAdmission(rpc, key); }
        catch { throw completionFault(); }
        throw error;
      }
    } catch (error) { return { block: true, blockReason: error.message }; }
  }, { priority: 1000 });
  api.on('after_tool_call', async (event, ctx) => {
    if (!browserTool(event.toolName)) return;
    const key = callKey(event, ctx), count = calls.get(key) || 0;
    if (!count) return;
    try { await releaseAdmission(getClient(), key); }
    catch { completionFault(); }
  });
  api.on('session_end', async (event, ctx) => {
    if (!running || !client) return;
    const sessionKey = event.sessionKey || ctx.sessionKey, sessionId = event.sessionId || ctx.sessionId;
    if (typeof sessionKey !== 'string' || !sessionKey) return;
    if (typeof sessionId === 'string' && sessionId) canceledOwners.add(JSON.stringify([sessionKey, sessionId]));
    else canceledSessions.add(sessionKey);
    try { await client.request('revokeOwner', { sessionKey, ...(typeof sessionId === 'string' && sessionId ? { sessionId } : {}) }, { timeoutMs: 120_000 }); }
    catch { api.logger.warn('Browser Handoff owner-session cleanup was not confirmed; controller must retain the gate until retirement is verified.'); }
  });
  api.registerTool({ contextVersion: 2, create(ctx) {
    if (!allowed(ctx)) return null;
    const owner = JSON.stringify([ctx.sessionKey, ctx.sessionId]);
    const current = () => {
      ctx.assertInvocationCurrent();
      if (!allowed(ctx)) throw new Error('Owner-private access required');
    };
    return {
      name: 'browser_handoff', label: 'Browser Handoff',
      description: 'Owner-private temporary full-browser viewing or human takeover links for the configured production profile. Includes all tabs, browser chrome, dialogs, and clipboard during control. Use for human CAPTCHA, passwords, 2FA, consent or forms needing human judgment. Share links only privately. Pause browser actions until resumeAllowed=true; then take a fresh normal browser snapshot.',
      parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
        action: { type: 'string', enum: ['tabs', 'create', 'status', 'wait', 'revoke'] },
        profile: { type: 'string' }, targetId: { type: 'string' }, id: { type: 'string' },
        permission: { type: 'string', enum: ['watch', 'control'] }, reason: { type: 'string', maxLength: 500 },
        ttlSeconds: { type: 'integer', minimum: 30, maximum: 1800 },
        timeoutSeconds: { type: 'integer', minimum: 1, maximum: 60 },
      } },
      async execute(_callId, params, signal) {
        current();
        getClient();
        const epoch = serviceEpoch;
        if (signal?.aborted) throw new Error('Browser handoff cancelled');
        if (params.profile !== undefined && params.profile !== config.profile) throw new Error('Only the configured production browser profile can be handed off');
        let rpc;
        try {
          rpc = await desktopRpcFactory(config.socketPath);
          current();
          if (!running || serviceEpoch !== epoch) throw new Error('Browser Handoff service changed during tool startup');
          if (signal?.aborted) throw new Error('Browser handoff cancelled');
          let result;
          if (params.action === 'tabs' || params.action === 'create') {
            await ensure(rpc, signal); current();
            if (params.action === 'tabs') {
              const tabs = await rpc.request('tabs', { profile: config.profile }, { signal });
              result = { profile: config.profile, tabs: Array.isArray(tabs) ? tabs : tabs.tabs };
            } else {
              const ttlSeconds = duration(params.ttlSeconds, 300, 30, 1800, 'invitation lifetime');
              const permission = params.permission ?? 'control';
              if (!['watch', 'control'].includes(permission)) throw new Error('Invalid handoff permission');
              if (params.reason !== undefined && (typeof params.reason !== 'string' || params.reason.length > 500)) throw new Error('Invalid handoff reason');
              // Request cancellation closes only this short-lived connection;
              // the controller retires an unpublished canceled invitation.
              result = await rpc.request('create', { owner, profile: config.profile, ...(params.targetId !== undefined ? { targetId: params.targetId } : {}), permission, ttlSeconds, ...(params.reason !== undefined ? { reason: params.reason } : {}) }, { signal, timeoutMs: 120_000 });
              try { current(); if (signal?.aborted) throw new Error('Browser handoff cancelled'); }
              catch (error) {
                if (result?.id) {
                  try { await rpc.request('revoke', { owner, id: result.id }, { timeoutMs: 120_000 }); }
                  catch { api.logger.warn('Browser Handoff stale invitation cleanup was not confirmed; controller retirement remains authoritative.'); }
                }
                throw error;
              }
            }
          } else if (['status', 'wait', 'revoke'].includes(params.action)) {
            if (typeof params.id !== 'string' || !params.id.trim()) throw new Error('A handoff id is required');
            const seconds = params.action === 'wait' ? duration(params.timeoutSeconds, 60, 1, 60, 'wait duration') : undefined;
            result = await rpc.request(params.action, { owner, id: params.id, ...(seconds === undefined ? {} : { timeoutSeconds: seconds }) }, { signal, timeoutMs: seconds === undefined ? 120_000 : seconds * 1000 + 10_000 });
          } else throw new Error('Unsupported handoff action');
          current();
          const details = { ...result, profile: config.profile, scope: 'browser-profile', scopeNotice, browserGateFault: fault || result?.browserGateFault || null, resumeAllowed: !fault && result?.resumeAllowed === true && result?.recoveryRequired !== true, continuation, continuationNotice };
          return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
        } finally { rpc?.close(); }
      },
    };
  } }, { name: 'browser_handoff', optional: true });
}
