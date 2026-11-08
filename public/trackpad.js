const SLOW = 0.3;
const FAST = 1.5;
const MAX_GAIN = 3;

// Smoothstep between the two speeds: gain is flat at both ends and rises monotonically, so there is no jump or kink.
function gainFor(speed) {
  if (speed <= SLOW) return 1;
  if (speed >= FAST) return MAX_GAIN;
  const t = (speed - SLOW) / (FAST - SLOW);
  return 1 + (MAX_GAIN - 1) * t * t * (3 - 2 * t);
}

export function accelerate(dx, dy, dtMs) {
  const gain = gainFor(Math.hypot(dx, dy) / Math.max(dtMs, 1));
  return { dx: dx * gain, dy: dy * gain };
}

const clamp = (v, max) => Math.min(Math.max(v, 0), max);

export function movePointer(pointer, delta, scale, size) {
  return {
    x: clamp(pointer.x + delta.dx / scale, size.width - 1),
    y: clamp(pointer.y + delta.dy / scale, size.height - 1),
  };
}

function follow(pos, start, length, margin) {
  const low = start + margin;
  const high = start + length - margin;
  if (pos < low) return pos - low;
  if (pos > high) return pos - high;
  return 0;
}

export function followPointer(pointerScreen, view, margin) {
  return {
    dx: follow(pointerScreen.x, view.left, view.width, margin),
    dy: follow(pointerScreen.y, view.top, view.height, margin),
  };
}
