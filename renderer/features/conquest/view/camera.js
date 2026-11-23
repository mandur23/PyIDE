// The map view's camera: which texture pixel is at the canvas's top-left corner (x, y) and how many CSS pixels one
// texture pixel covers (scale), kept so the map always covers the view where it can and is centred where it cannot.
// Conquest.view.camera(mapWidth, mapHeight) -> { x, y, scale, resize, zoomAt, pan, centerOn, fit, toScreen, toMap }.
// Conquest.view.attachCamera(camera, element, { change, click, hover, context, dblclick, painter, box }) adds wheel
// zoom about the cursor, a right or middle drag that pans, and the left drag. painter() may return { down(sx, sy),
// move(sx, sy), up(sx, sy) }: while it does, a left drag that down() accepts (returns true) goes to it (drawing a front
// across provinces). Else box() may return { start(sx, sy), move(sx, sy), end(sx, sy, shift), cancel() }: a left drag
// then draws a selection box (start once it has moved DRAG_PX); with neither, a left drag pans.
(() => {
  const Conquest = (globalThis.Conquest = globalThis.Conquest || {});
  const view = (Conquest.view = Conquest.view || {});
  const MAX_SCALE = 24;
  const DRAG_PX = 4;

  view.camera = (mapW, mapH) => {
    const cam = {
      x: 0, y: 0, scale: 1, w: 1, h: 1,
      get minScale() { return Math.min(cam.w / mapW, cam.h / mapH); },
      clamp() {
        cam.scale = Math.min(MAX_SCALE, Math.max(cam.minScale, cam.scale));
        const vw = cam.w / cam.scale;
        const vh = cam.h / cam.scale;
        cam.x = vw >= mapW ? (mapW - vw) / 2 : Math.min(mapW - vw, Math.max(0, cam.x));
        cam.y = vh >= mapH ? (mapH - vh) / 2 : Math.min(mapH - vh, Math.max(0, cam.y));
        return cam;
      },
      resize(w, h) {
        const [mx, my] = cam.toMap(cam.w / 2, cam.h / 2);
        cam.w = Math.max(1, w);
        cam.h = Math.max(1, h);
        return cam.centerOn(mx, my);
      },
      fit() { cam.scale = cam.minScale; return cam.centerOn(mapW / 2, mapH / 2); },
      zoomAt(sx, sy, factor) {
        const [mx, my] = cam.toMap(sx, sy);
        cam.scale = Math.min(MAX_SCALE, Math.max(cam.minScale, cam.scale * factor));
        cam.x = mx - sx / cam.scale;
        cam.y = my - sy / cam.scale;
        return cam.clamp();
      },
      pan(dx, dy) { cam.x -= dx / cam.scale; cam.y -= dy / cam.scale; return cam.clamp(); },
      centerOn(mx, my, scale = cam.scale) {
        cam.scale = Math.min(MAX_SCALE, Math.max(cam.minScale, scale));
        cam.x = mx - cam.w / 2 / cam.scale;
        cam.y = my - cam.h / 2 / cam.scale;
        return cam.clamp();
      },
      toScreen: (mx, my) => [(mx - cam.x) * cam.scale, (my - cam.y) * cam.scale],
      toMap: (sx, sy) => [cam.x + sx / cam.scale, cam.y + sy / cam.scale],
    };
    return cam;
  };

  // click(sx, sy, e) fires for a left press and release that did not move; hover(sx, sy | null) as the pointer moves
  // over it; context(sx, sy, e) for a right press and release that did not move; dblclick(sx, sy, e) for a double click.
  view.attachCamera = (cam, element, { change, click, hover, context = () => {}, dblclick = () => {}, painter = () => null, box = () => null }) => {
    let drag = null;
    const local = (e) => {
      const r = element.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const onWheel = (e) => {
      e.preventDefault();
      const [sx, sy] = local(e);
      const lines = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1;
      cam.zoomAt(sx, sy, Math.exp(-e.deltaY * lines * 0.0015));
      change();
    };
    const onDown = (e) => {
      if (e.button > 2) return;
      const [sx, sy] = local(e);
      const paint = e.button === 0 ? painter() : null;
      const accepted = paint && paint.down(sx, sy) ? paint : null;
      drag = { id: e.pointerId, button: e.button, sx, sy, lx: sx, ly: sy, moved: false, paint: accepted, box: e.button === 0 && !accepted ? box() : null };
      element.setPointerCapture?.(e.pointerId);
    };
    const onMove = (e) => {
      const [sx, sy] = local(e);
      if (!drag || drag.id !== e.pointerId) return void hover(sx, sy);
      if (drag.paint) { hover(sx, sy); drag.moved = drag.moved || Math.hypot(sx - drag.sx, sy - drag.sy) >= DRAG_PX; return void drag.paint.move(sx, sy); }
      if (!drag.moved && Math.hypot(sx - drag.sx, sy - drag.sy) < DRAG_PX) return;
      if (drag.box) {
        if (!drag.moved) drag.box.start(drag.sx, drag.sy);
        drag.moved = true;
        return void drag.box.move(sx, sy);
      }
      drag.moved = true;
      cam.pan(sx - drag.lx, sy - drag.ly);
      drag.lx = sx;
      drag.ly = sy;
      change();
    };
    const onUp = (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      const d = drag;
      drag = null;
      element.releasePointerCapture?.(e.pointerId);
      if (d.paint) return void d.paint.up(...local(e), d.moved);
      if (d.box && d.moved) return void d.box.end(...local(e), e.shiftKey);
      if (d.moved) return;
      if (d.button === 2) context(...local(e), e);
      else if (d.button === 0) click(...local(e), e);
    };
    const onMenu = (e) => e.preventDefault();
    const onLeave = () => { if (!drag) hover(null); };
    const onCancel = () => { if (drag?.box && drag.moved) drag.box.cancel(); drag = null; };
    const onDbl = (e) => { if (e.button === 0) dblclick(...local(e), e); };
    // A middle press would start the browser's autoscroll instead of a pan.
    const onMouseDown = (e) => { if (e.button === 1) e.preventDefault(); };
    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', onCancel);
    element.addEventListener('pointerleave', onLeave);
    element.addEventListener('contextmenu', onMenu);
    element.addEventListener('dblclick', onDbl);
    element.addEventListener('mousedown', onMouseDown);
    return () => {
      element.removeEventListener('contextmenu', onMenu);
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onCancel);
      element.removeEventListener('pointerleave', onLeave);
      element.removeEventListener('dblclick', onDbl);
      element.removeEventListener('mousedown', onMouseDown);
    };
  };
})();
