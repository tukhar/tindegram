// Pointer-driven swipe detection for one element. A gesture locks to the
// horizontal or vertical axis once the finger has travelled a few pixels, so a
// sideways swipe never turns into a vertical one halfway through.
//
// handlers: onDrag(axis, dx, dy), onRelease(axis, dx, dy, vx, vy), onTap(xRatio)
// vx / vy are average velocities in px per ms.

const LOCK_DISTANCE = 8;

export function attachSwipe(element, handlers) {
  let start = null;
  let axis = null;

  element.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (event.target.closest('a, button')) return;
    start = { x: event.clientX, y: event.clientY, time: performance.now(), id: event.pointerId };
    axis = null;
    element.setPointerCapture(event.pointerId);
  });

  element.addEventListener('pointermove', (event) => {
    if (!start || event.pointerId !== start.id) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!axis) {
      if (Math.hypot(dx, dy) < LOCK_DISTANCE) return;
      axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    handlers.onDrag?.(axis, dx, dy);
  });

  const end = (event) => {
    if (!start || event.pointerId !== start.id) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    const elapsed = Math.max(1, performance.now() - start.time);
    const locked = axis;
    const cancelled = event.type === 'pointercancel';
    start = null;
    axis = null;
    if (locked) {
      // A cancelled gesture (the browser took over the touch) snaps back.
      if (cancelled) handlers.onRelease?.(locked, 0, 0, 0, 0);
      else handlers.onRelease?.(locked, dx, dy, dx / elapsed, dy / elapsed);
    } else if (!cancelled && elapsed < 400) {
      const box = element.getBoundingClientRect();
      handlers.onTap?.((event.clientX - box.left) / box.width);
    }
  };

  element.addEventListener('pointerup', end);
  element.addEventListener('pointercancel', end);
}
