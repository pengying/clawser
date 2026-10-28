// A screenshot is a discard-only compositor paint request. Ordinary screencast
// events remain the sole source of displayed pixels and geometry.
export class PaintAssist {
  constructor({ paint, getState, onError, now = () => performance.now(),
    setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { paint, getState, onError, now, setTimer, clearTimer });
    this.document = this.control = this.sequence = this.frames = 0;
    this.lastFrame = now(); this.lastDispatch = -Infinity;
  }
  state() {
    if (this.stopped) return null;
    let state;
    try { state = this.getState(); } catch {}
    if (!state?.live) { this.stop(); return null; }
    return state;
  }
  start() { if (!this.stopped) { this.active = true; this.lastFrame = this.now(); this.arm(); } }
  frame() {
    if (this.stopped) return;
    this.lastFrame = this.now(); this.frames++;
    if (this.pending && !this.pending.explicit) this.pending = null;
    this.arm();
  }
  noteDispatch() { this.lastDispatch = this.now(); }
  inputStarted() {
    const state = this.state();
    if (!this.active || !state?.control) return null;
    const token = { document: this.document, control: this.control, id: state.control };
    this.hint(token); return token;
  }
  inputCompleted(token) { if (this.valid(token)) this.hint(token); }
  valid(token) {
    const state = this.state();
    return Boolean(token && state && this.active && token.document === this.document &&
      token.control === this.control && token.id === state.control);
  }
  hint(token) {
    const due = this.now() + 100;
    this.pending = { due: Math.min(due, this.pending?.due ?? Infinity), explicit: true,
      token, sequence: ++this.sequence, document: this.document };
    this.arm();
  }
  release() {
    this.control++;
    if (this.pending?.explicit) this.pending = null;
    this.arm();
  }
  navigationStarted() {
    this.document++; this.control++; this.active = false; this.pending = null; this.cancelTimer();
  }
  navigationCommitted() {
    if (!this.stopped) { this.active = true; this.lastFrame = this.now(); this.arm(); }
  }
  demandChanged() { this.arm(); }
  cancelTimer() { if (this.timer !== undefined) this.clearTimer(this.timer); this.timer = undefined; }
  arm() {
    this.cancelTimer();
    const state = this.state();
    if (!state || !this.active || this.inFlight || !state.demand) return;
    if (this.pending?.explicit && !this.valid(this.pending.token)) this.pending = null;
    const due = this.pending?.due ?? Math.max(this.lastFrame, this.lastDispatch) + 2000;
    const at = Math.max(due, this.lastDispatch + 200);
    this.timer = this.setTimer(() => { this.timer = undefined; this.flush(); }, Math.max(0, at - this.now()));
    this.timer?.unref?.();
  }
  flush() {
    const state = this.state();
    if (!state || !this.active || this.inFlight) return;
    if (!state.demand) return; // One pending hint survives; ACK/visibility wakes it.
    if (!this.pending) this.pending = { due: this.now(), explicit: false, document: this.document, frame: this.frames };
    const work = this.pending; this.pending = null;
    if (work.explicit && !this.valid(work.token)) { this.arm(); return; }
    const valid = () => !this.stopped && this.active && work.document === this.document &&
      (work.explicit ? this.valid(work.token) : work.frame === this.frames);
    const context = {
      isCurrent: () => valid() && this.state()?.demand === true,
      onDispatch: () => { if (!context.isCurrent() || this.now() < this.lastDispatch + 200) return false; this.noteDispatch(); return true; },
    };
    this.inFlight = Promise.resolve().then(() => context.isCurrent() ? this.paint(context) : false)
      .then(result => {
        if (result === false && valid()) {
          // Demand can disappear while layout metrics are pending. Preserve one
          // obligation, without replacing a newer input-completion generation.
          if (!this.pending) this.pending = work;
          else this.pending.due = Math.min(this.pending.due, work.due);
        }
      }).catch(error => { this.stop(); this.onError(error); })
      .finally(() => { this.inFlight = null; this.arm(); });
  }
  stop() {
    this.stopped = true; this.active = false; this.document++; this.control++;
    this.pending = null; this.cancelTimer();
  }
}
