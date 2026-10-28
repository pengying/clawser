export function activationClock() {
  let now = 0, nextId = 0; const timers = new Map();
  return { now: () => now, setTimeout(fn, ms) { const id = ++nextId; timers.set(id, { fn, at: now + ms }); return { id, unref() {} }; }, clearTimeout(timer) { timers.delete(timer.id); }, advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } }, get size() { return timers.size; } };
}
export async function flushActivation() { for (let i = 0; i < 8; i++) await new Promise(setImmediate); }
