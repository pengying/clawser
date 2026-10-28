// Only host-provided V2 context grants authority. Tool parameters and message
// text never participate. Private sessions keep their original default policy.
const forbiddenSession = (key) => /:(?:subagent|cron|hook|heartbeat|automation|automated|background)(?::|$)/i.test(key);
const nonempty = value => typeof value === 'string' && !!value.trim();
const groupBase = key => typeof key === 'string' &&
  /^agent:[^:]+:[a-z0-9_-]+:(?:group|channel):[^:*\s]+$/i.test(key) && !forbiddenSession(key);
export function authorizedSession(key, ownerGroupSessions = []) {
  if (!nonempty(key) || forbiddenSession(key)) return false;
  if ((/^agent:[^:]+:main$/i.test(key) || /^agent:[^:]+:[a-z0-9_-]+:(?:direct|dm):.+$/i.test(key)) && !/:group:|:channel:/i.test(key)) return true;
  if (!Array.isArray(ownerGroupSessions)) return false;
  return ownerGroupSessions.some(base => groupBase(base) && (key === base ||
    // The Google Chat ingress appends a 24-hex thread hash to its base session.
    base.includes(':googlechat:') && key.startsWith(base + ':thread:') && /^[a-f0-9]{24}$/.test(key.slice(base.length + 8))));
}
export function ownerAuthorized(ctx, config = {}) {
  if (!ctx || ctx.senderIsOwner !== true || ctx.sandboxed || !nonempty(ctx.sessionId) ||
      typeof ctx.assertInvocationCurrent !== 'function' || !authorizedSession(ctx.sessionKey, config.ownerGroupSessions)) return false;
  if (/:group:|:channel:/i.test(ctx.sessionKey)) {
    const provenance = ctx.inputProvenance;
    // Native external user turns may omit provenance in the host SDK.
    return nonempty(ctx.requesterSenderId) && nonempty(ctx.nativeChannelId) &&
      (provenance === undefined || provenance?.kind === 'external_user' &&
        (!provenance.sourceRole || provenance.sourceRole === 'user') && !provenance.jobId && !provenance.sourceTool);
  }
  return true;
}
export function ownerGuard(ctx, config = {}) {
  const sessionKey = ctx.sessionKey, sessionId = ctx.sessionId, senderId = ctx.requesterSenderId;
  const group = /:group:|:channel:/i.test(sessionKey), nativeChannelId = ctx.nativeChannelId;
  return () => {
    ctx.assertInvocationCurrent();
    if (ctx.sessionKey !== sessionKey || ctx.sessionId !== sessionId || ctx.requesterSenderId !== senderId || (group && ctx.nativeChannelId !== nativeChannelId) || !ownerAuthorized(ctx, config)) throw new Error('Owner-authorized access required');
  };
}
