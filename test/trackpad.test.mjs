import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accelerate, movePointer, followPointer } from '../public/trackpad.js';

test('slow finger travel moves the pointer one to one on screen', () => {
  assert.deepEqual(accelerate(3, -4, 20), { dx: 3, dy: -4 });
});
test('fast finger travel is amplified, up to three times, and never shrinks', () => {
  const fast = accelerate(30, 0, 10);
  assert.ok(fast.dx > 30 && fast.dx <= 90);
  assert.equal(accelerate(300, 0, 10).dx, 900);
  let last = 0;
  for (let dt = 100; dt >= 1; dt--) { const { dx } = accelerate(10, 0, dt); assert.ok(dx >= last); last = dx; }
});
test('screen travel becomes framebuffer travel at the current scale, clamped to the screen', () => {
  const size = { width: 1920, height: 1080 };
  assert.deepEqual(movePointer({ x: 100, y: 100 }, { dx: 1, dy: 0 }, 0.2146, size).x.toFixed(2), (100 + 1 / 0.2146).toFixed(2));
  assert.deepEqual(movePointer({ x: 5, y: 5 }, { dx: -100, dy: -100 }, 0.5, size), { x: 0, y: 0 });
  assert.deepEqual(movePointer({ x: 1915, y: 1075 }, { dx: 100, dy: 100 }, 0.5, size), { x: 1919, y: 1079 });
});
test('the view scrolls only when the pointer nears its edge', () => {
  const view = { left: 0, top: 0, width: 400, height: 800 };
  assert.deepEqual(followPointer({ x: 200, y: 400 }, view, 40), { dx: 0, dy: 0 });
  assert.deepEqual(followPointer({ x: 390, y: 400 }, view, 40), { dx: 30, dy: 0 });
  assert.deepEqual(followPointer({ x: 10, y: 790 }, view, 40), { dx: -30, dy: 30 });
});
test('a pointer outside a shrunken screen is pulled back inside', () => {
  assert.deepEqual(movePointer({ x: 3000, y: -20 }, { dx: 0, dy: 0 }, 0.3, { width: 1920, height: 1080 }), { x: 1919, y: 0 });
});
