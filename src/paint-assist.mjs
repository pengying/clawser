const retired = () => Object.assign(new Error('Capture preparation retired'), { definitive: true });
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
    if (this.pending && !this.pending.explicit && !this.pending.preparation) this.pending = null;
    this.arm();
  }
  noteDispatch() { this.lastDispatch = this.now(); }
  prepare() {
    const state = this.state();
    if (!state || !this.active) return Promise.reject(retired());
    if (this.pending?.preparation) return this.pending.preparation.promise;
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const token = state.control ? { document: this.document, control: this.control, id: state.control } : null;
    const preparation = { promise, resolve, reject, token };
    this.pending = { ...this.pending, due: this.now(), document: this.document, preparation };
    this.arm(); return promise;
  }
  settlePreparation(work, error) {
    const preparation = work?.preparation;
    if (!preparation || preparation.done) return;
    preparation.done = true;
    if (error) preparation.reject(error); else preparation.resolve();
  }
  workValid(work) {
    return !this.stopped && this.active && work.document === this.document &&
      (!work.preparation?.token || this.valid(work.preparation.token)) &&
      (work.explicit ? this.valid(work.token) : work.preparation || work.frame === this.frames);
  }
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
    this.pending = { ...this.pending, due: Math.min(due, this.pending?.due ?? Infinity), explicit: true,
      token, sequence: ++this.sequence, document: this.document };
    this.arm();
  }
  release() {
    this.control++;
    if (this.pending?.explicit || this.pending?.preparation?.token) { this.settlePreparation(this.pending, retired()); this.pending = null; }
    if (this.flightWork?.preparation?.token) this.settlePreparation(this.flightWork, retired());
    this.arm();
  }
  navigationStarted() {
    this.document++; this.control++; this.active = false;
    this.settlePreparation(this.pending, retired()); this.settlePreparation(this.flightWork, retired());
    this.pending = null; this.cancelTimer();
  }
  navigationCommitted() {
    if (!this.stopped) { this.navigationStarted(); this.active = true; this.lastFrame = this.now(); this.arm(); }
  }
  demandChanged() { this.arm(); }
  cancelTimer() { if (this.timer !== undefined) this.clearTimer(this.timer); this.timer = undefined; }
  arm() {
    this.cancelTimer();
    const state = this.state();
    if (!state || !this.active || this.inFlight || !state.demand) return;
    if (this.pending && !this.workValid(this.pending)) { this.settlePreparation(this.pending, retired()); this.pending = null; }
    const due = this.pending?.due ?? Math.max(this.lastFrame, this.lastDispatch) + 2000;
    const at = Math.max(due, this.lastDispatch + 200);
    this.timer = this.setTimer(() => { this.timer = undefined; this.flush(); }, Math.max(0, Math.ceil(at - this.now())));
    this.timer?.unref?.();
  }
  flush() {
    const state = this.state();
    if (!state || !this.active || this.inFlight) return;
    if (!state.demand) return; // One pending hint survives; ACK/visibility wakes it.
    if (!this.pending) this.pending = { due: this.now(), explicit: false, document: this.document, frame: this.frames };
    const work = this.pending; this.pending = null;
    if (!this.workValid(work)) { this.settlePreparation(work, retired()); this.arm(); return; }
    const valid = () => this.workValid(work);
    this.flightWork = work;
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
          else {
            this.pending.due = Math.min(this.pending.due, work.due);
            if (work.preparation && !this.pending.preparation) this.pending.preparation = work.preparation;
            else if (work.preparation && work.preparation !== this.pending.preparation)
              this.pending.preparation.promise.then(() => this.settlePreparation(work), error => this.settlePreparation(work, error));
          }
        } else if (result !== false && valid()) this.settlePreparation(work);
        else this.settlePreparation(work, retired());
      }).catch(error => { this.stop(error); this.onError(error); })
      .finally(() => { this.flightWork = null; this.inFlight = null; this.arm(); });
  }
  stop(error = retired()) {
    this.settlePreparation(this.pending, error); this.settlePreparation(this.flightWork, error);
    this.stopped = true; this.active = false; this.document++; this.control++;
    this.pending = null; this.cancelTimer();
  }
}
