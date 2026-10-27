// Receiver-paced screen updates. Control replies use a separate, immediate path.
export class DisplayStream {
  constructor({ connectionId, send, canSend, lastInputId = () => 0, now = () => performance.now() }) {
    Object.assign(this, { connectionId, send, canSend, lastInputId, now });
    this.sequence = 0; this.lastFrameAt = -Infinity; this.lastMetadataAt = -Infinity;
    this.currentMetadata = {}; this.metrics = {}; this.replacedFrames = 0; this.clientInputId = 0;
  }
  record(name, value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100_000_000) return;
    const metric = this.metrics[name] ||= { count: 0, samples: [] };
    metric.count++; metric.samples.push(value);
    if (metric.samples.length > 32) metric.samples.shift();
  }
  frame(frame) {
    if (this.closed) return;
    if (this.latestFrame) this.replacedFrames++;
    this.latestFrame = { value: frame, at: this.now() }; this.flush();
  }
  metadata(metadata) {
    if (this.closed) return;
    this.currentMetadata = { ...this.currentMetadata, ...metadata };
    const interactions = this.currentMetadata.interactions;
    const key = JSON.stringify({ ...this.currentMetadata, ...(interactions ? { interactions: { ...interactions, timestamp: undefined } } : {}) });
    if (key === this.metadataKey && this.now() - this.lastMetadataAt < 1000) return;
    this.metadataKey = key; this.latestMetadata = this.currentMetadata; this.flush();
  }
  flush() {
    if (this.closed || this.inFlight || !this.canSend() || !this.latestFrame && !this.latestMetadata) return;
    const now = this.now(), delay = this.latestFrame ? 66 - (now - this.lastFrameAt) : 0;
    if (delay > 0) {
      if (!this.timer) { this.timer = setTimeout(() => { this.timer = null; this.flush(); }, delay); this.timer.unref?.(); }
      return;
    }
    clearTimeout(this.timer); this.timer = null;
    const frame = this.latestFrame, metadata = this.latestMetadata;
    const packet = frame ? { ...frame.value, ...(metadata ? { metadata } : {}) } : { type: 'metadata', ...metadata };
    packet.connectionId = this.connectionId; packet.displayId = ++this.sequence;
    this.inFlight = { id: packet.displayId, at: now, frame: Boolean(frame) };
    if (!this.send(packet)) { this.inFlight = null; return; }
    this.latestFrame = this.latestMetadata = null;
    if (frame) { this.lastFrameAt = now; this.record('frameAgeAtSendMs', now - frame.at); }
    if (metadata) this.lastMetadataAt = now;
    this.record('displayBytes', Buffer.byteLength(JSON.stringify(packet)));
  }
  ack(packet) {
    if (this.closed || packet.connectionId !== this.connectionId || !this.inFlight || packet.displayId !== this.inFlight.id) return false;
    const flight = this.inFlight; this.inFlight = null;
    this.record(flight.frame ? 'frameAckRoundTripMs' : 'metadataAckRoundTripMs', this.now() - flight.at);
    if (flight.frame && Number.isFinite(packet.decodeMs) && packet.decodeMs >= 0 && packet.decodeMs <= 120_000) this.record('decodeDrawMs', packet.decodeMs);
    const input = packet.inputTiming;
    if (input && Number.isSafeInteger(input.id) && input.id > this.clientInputId && input.id <= this.lastInputId() &&
      [input.queueMs, input.roundTripMs].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 120_000)) {
      this.clientInputId = input.id;
      this.record('clientInputQueueMs', input.queueMs); this.record('inputAckRoundTripMs', input.roundTripMs);
    }
    if (['visible', 'hidden'].includes(packet.visibility)) this.visibility = packet.visibility;
    this.flush(); return true;
  }
  snapshot() {
    const metrics = Object.fromEntries(Object.entries(this.metrics).map(([name, { count, samples }]) => {
      const sorted = [...samples].sort((a, b) => a - b), round = value => Math.round(value * 10) / 10;
      return [name, { count, latest: round(samples.at(-1)), p50: round(sorted[Math.floor((sorted.length - 1) * .5)]), p95: round(sorted[Math.ceil((sorted.length - 1) * .95)]) }];
    }));
    return { ...metrics, replacedFrames: this.replacedFrames, outstandingMs: this.inFlight ? Math.round(this.now() - this.inFlight.at) : 0, visibility: this.visibility || 'unknown' };
  }
  close() {
    this.closed = true; clearTimeout(this.timer); this.timer = null;
    this.latestFrame = this.latestMetadata = this.inFlight = null; this.currentMetadata = {}; this.metadataKey = null;
  }
}
