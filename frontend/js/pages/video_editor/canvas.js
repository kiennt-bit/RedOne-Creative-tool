// Trình dựng video — Fabric.js artboard (center canvas).
//
// Renders the visual clips active at the playhead, lets the user move / scale /
// rotate / select them (writes transforms back to state), previews color
// adjustments, and drives playback (advances the playhead, plays the active
// video/audio elements, repaints each frame). Mirrors the original's
// ArtBoardComponent, on our stack.
import * as S from './state.js';

let fb = null;                 // fabric.Canvas
let containerEl = null;
let _objs = new Map();         // clipId -> { obj, videoEl, audioEl, sig }
let _applying = false;         // guard: writing state->canvas (ignore obj:modified)
let _raf = 0;
let _playStartWall = 0;        // performance.now() at play start
let _playStartTime = 0;        // playhead at play start
let _ro = null;                // ResizeObserver → keeps canvas fitted
let _fitRaf = 0;

// fabric is a UMD global loaded once from the vendored file.
let _fabricPromise = null;
export function ensureFabric() {
  if (window.fabric) return Promise.resolve(window.fabric);
  if (_fabricPromise) return _fabricPromise;
  _fabricPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/static/js/vendor/fabric.min.js';
    s.onload = () => resolve(window.fabric);
    s.onerror = () => reject(new Error('Không tải được fabric.js'));
    document.head.appendChild(s);
  });
  return _fabricPromise;
}

export async function initCanvas(canvasEl, container) {
  await ensureFabric();
  containerEl = container;
  fb = new window.fabric.Canvas(canvasEl, {
    backgroundColor: '#000', preserveObjectStacking: true,
    selection: false, controlsAboveOverlay: true,
  });
  fb.on('object:modified', _onObjectModified);
  fb.on('selection:created', _onSelect);
  fb.on('selection:updated', _onSelect);
  fb.on('selection:cleared', () => { if (!_applying) S.select(null); });

  S.on('change', rebuild);
  S.on('time', _onTime);
  S.on('selection', _syncSelection);
  rebuild();
  fitView();
  // Keep the artboard fitted whenever its container resizes (panel drag, layout
  // settle, window resize) — so it's always "khớp khung".
  if (window.ResizeObserver) {
    try {
      _ro = new ResizeObserver(() => {
        if (_fitRaf) return;
        _fitRaf = requestAnimationFrame(() => { _fitRaf = 0; fitView(); });
      });
      _ro.observe(container);
    } catch (_) {}
  }
  // a couple of delayed fits in case the container sizes after first paint
  setTimeout(fitView, 60);
  setTimeout(fitView, 250);
}

export function disposeCanvas() {
  pause();
  if (_ro) { try { _ro.disconnect(); } catch (_) {} _ro = null; }
  for (const e of _objs.values()) { _stopMedia(e); }
  _objs.clear();
  if (fb) { try { fb.dispose(); } catch (_) {} fb = null; }
}

// ── view fit / zoom ───────────────────────────────────────────────────
export function fitView() {
  if (!fb || !containerEl) return;
  const pw = S.project.width, ph = S.project.height;
  const cw = containerEl.clientWidth - 24, ch = containerEl.clientHeight - 24;
  if (cw <= 0 || ch <= 0) return;
  const z = Math.max(0.02, Math.min(cw / pw, ch / ph));
  _setView(z);
}
function _setView(z) {
  fb.setZoom(z);
  fb.setWidth(S.project.width * z);
  fb.setHeight(S.project.height * z);
  fb.requestRenderAll();
}
export function zoomIn() { if (fb) _setView(fb.getZoom() * 1.15); }
export function zoomOut() { if (fb) _setView(fb.getZoom() / 1.15); }

// ── build / reconcile objects ─────────────────────────────────────────
function _visualClips() {
  // bottom track first so tracks[0] (top) is added last = on top
  const out = [];
  for (let i = S.project.tracks.length - 1; i >= 0; i--) {
    const t = S.project.tracks[i];
    if (t.type === 'audio') continue;
    for (const c of t.clips) if (c.kind !== 'audio') out.push({ track: t, clip: c });
  }
  return out;
}
// Identity for object reuse — deliberately EXCLUDES text/style/color so editing
// those updates the existing object in place (no dispose → no selection clear →
// the inspector text field keeps focus).
function _sig(c) { return `${c.kind}|${c.url}`; }

export function rebuild() {
  if (!fb) return;
  const wanted = _visualClips();
  // Keep entries for ANY existing clip — audio-only entries (created for
  // playback by _ensureAudioEls) must survive a rebuild, else toggling e.g. a
  // video track's mute (which fires 'change') would purge + stop the audio
  // track's element too.
  const allIds = new Set();
  for (const t of S.project.tracks) for (const c of t.clips) allIds.add(c.id);
  for (const [id, e] of [..._objs]) {
    if (!allIds.has(id)) { _stopMedia(e); if (e.obj) fb.remove(e.obj); _objs.delete(id); }
  }
  // add / update in order (bottom→top)
  for (const { clip } of wanted) {
    const existing = _objs.get(clip.id);
    if (existing && existing.sig === _sig(clip)) {
      _applyTransform(existing.obj, clip);
      if (existing.obj) {
        if (clip.kind === 'image') _applyFilters(existing.obj, clip);
        else if (clip.kind === 'text') _applyTextProps(existing.obj, clip);
        else if (clip.kind === 'video') _drawVideoFrame(existing, clip);
        fb.bringToFront(existing.obj);
      }
    } else {
      if (existing) { _stopMedia(existing); if (existing.obj) fb.remove(existing.obj); _objs.delete(clip.id); }
      _createObject(clip);
    }
  }
  _onTime();
  _syncSelection();
  fb.requestRenderAll();
}

function _applyTransform(obj, clip) {
  if (!obj) return;
  _applying = true;
  obj.set({
    left: clip.left, top: clip.top, scaleX: clip.scaleX, scaleY: clip.scaleY,
    angle: clip.angle || 0, opacity: clip.opacity == null ? 1 : clip.opacity,
  });
  obj.clipId = clip.id;
  obj.setCoords();
  _applying = false;
}

// Build fabric's exact color filters (covers ALL params incl. highlights/
// shadows/whites/blacks via ColorMatrix and sharpen via Convolute).
function _buildColorFilters(c) {
  if (!window.fabric || !window.fabric.Image) return [];
  const F = window.fabric.Image.filters;
  const n = (k) => (Number(c[k]) || 0) / 100;   // slider -100..100 → -1..1
  const filters = [];
  if (c.brightness) filters.push(new F.Brightness({ brightness: n('brightness') }));
  if (c.contrast) filters.push(new F.Contrast({ contrast: n('contrast') }));
  if (c.saturation) filters.push(new F.Saturation({ saturation: n('saturation') }));
  if (c.vibrance && F.Vibrance) filters.push(new F.Vibrance({ vibrance: n('vibrance') }));
  const t = n('temperature'), ti = n('tint'), e = n('exposure'),
        wh = n('whites'), bl = n('blacks'), hl = n('highlights'), sh = n('shadows');
  if ((t || ti || e || wh || bl || hl || sh) && F.ColorMatrix) {
    const base = Math.pow(2, e) * (1 + wh * 0.1) * (1 + hl * 0.1);
    const rMul = base * (1 + t * 0.4), gMul = base * (1 + ti * 0.4), bMul = base * (1 - t * 0.4);
    const off = bl * 0.1 + sh * 0.06;   // 0..1 lift (×255 internally)
    filters.push(new F.ColorMatrix({ matrix: [
      rMul, 0, 0, 0, off, 0, gMul, 0, 0, off, 0, 0, bMul, 0, off, 0, 0, 0, 1, 0,
    ] }));
  }
  if ((c.sharpen || 0) > 0 && F.Convolute) {
    const k = n('sharpen');
    filters.push(new F.Convolute({ matrix: [0, -k, 0, -k, 1 + 4 * k, -k, 0, -k, 0] }));
  }
  if (c.blur) filters.push(new F.Blur({ blur: Math.max(0, Math.min(1, c.blur / 50)) }));
  return filters;
}

// Images use fabric's filter pipeline (static → no freeze).
function _applyFilters(imgObj, clip) {
  if (!imgObj || clip.kind !== 'image' || imgObj.type !== 'image') return;
  imgObj.filters = _buildColorFilters(clip.color || {});
  try { imgObj.applyFilters(); } catch (_) {}
}

// Update a Textbox's content + style in place (called on reuse so editing text
// doesn't recreate the object).
function _applyTextProps(obj, clip) {
  if (!obj || obj.type !== 'textbox') return;
  const st = clip.style || S.defaultTextStyle();
  obj.set({
    text: clip.text || '', fontFamily: st.fontFamily, fontSize: st.fontSize,
    fontWeight: st.fontWeight, fontStyle: st.fontStyle, fill: st.fill,
    stroke: st.stroke, strokeWidth: st.strokeWidth, textAlign: st.align,
    lineHeight: st.lineHeight || 1.2, backgroundColor: st.bgColor || '',
  });
}

// Approximate the color adjustment as a CSS filter string (hardware-accelerated)
// — used to filter video frames cheaply so playback stays smooth WITH color.
function _cssFilter(color) {
  if (!color) return 'none';
  const n = (k) => (Number(color[k]) || 0) / 100;
  const parts = [];
  // brightness folds in exposure + whites/highlights/shadows (rough lift)
  const bright = (1 + n('brightness')) * Math.pow(2, n('exposure'))
    * (1 + n('whites') * 0.1) * (1 + n('highlights') * 0.06) * (1 + n('shadows') * 0.06);
  if (Math.abs(bright - 1) > 0.001) parts.push(`brightness(${bright.toFixed(3)})`);
  // contrast folds in blacks (lower blacks → more contrast)
  const con = Math.max(0, 1 + n('contrast') - n('blacks') * 0.15);
  if (Math.abs(con - 1) > 0.001) parts.push(`contrast(${con.toFixed(3)})`);
  const sat = Math.max(0, 1 + n('saturation') + n('vibrance') * 0.5);
  if (Math.abs(sat - 1) > 0.001) parts.push(`saturate(${sat.toFixed(3)})`);
  const t = n('temperature');
  if (t) parts.push(`sepia(${Math.min(1, Math.abs(t) * 0.5).toFixed(3)})`, `hue-rotate(${(t > 0 ? -12 * t : 24 * Math.abs(t)).toFixed(1)}deg)`);
  const ti = n('tint');
  if (ti) parts.push(`hue-rotate(${(ti * 20).toFixed(1)}deg)`);
  const blur = Number(color.blur) || 0;
  if (blur) parts.push(`blur(${(blur / 12).toFixed(2)}px)`);
  return parts.length ? parts.join(' ') : 'none';
}

// Unsharp 3x3 convolution on a canvas context (CSS has no sharpen filter).
// Heavy, so callers only run it while paused (one frame), not during playback.
function _sharpenCanvas(ctx, w, h, k) {
  const src = ctx.getImageData(0, 0, w, h);
  const out = ctx.createImageData(w, h);
  const s = src.data, d = out.data, c = 1 + 4 * k, e = -k, row = w * 4;
  for (let y = 0; y < h; y++) {
    for (let xq = 0; xq < w; xq++) {
      const i = (y * w + xq) * 4;
      for (let ch = 0; ch < 3; ch++) {
        let v = s[i + ch] * c
          + (xq > 0 ? s[i - 4 + ch] : s[i + ch]) * e
          + (xq < w - 1 ? s[i + 4 + ch] : s[i + ch]) * e
          + (y > 0 ? s[i - row + ch] : s[i + ch]) * e
          + (y < h - 1 ? s[i + row + ch] : s[i + ch]) * e;
        d[i + ch] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
      d[i + 3] = s[i + 3];
    }
  }
  ctx.putImageData(out, 0, 0);
}

// Draw the current video frame into its offscreen canvas. Color is baked via a
// fast CSS filter so playback stays smooth (no fabric filters on video — they
// cache/black-out the frame). Sharpen (no CSS equivalent) is convolved on the
// frame only while paused, so it's visible while adjusting without lagging play.
function _drawVideoFrame(e, clip) {
  if (!e || !e.fctx || !e.videoEl || !e.frameCanvas || !e.obj) return;
  try {
    if (e.obj.filters && e.obj.filters.length) { e.obj.filters = []; try { e.obj.applyFilters(); } catch (_) {} }
    const w = e.frameCanvas.width, h = e.frameCanvas.height;
    e.fctx.filter = _cssFilter(clip.color);
    e.fctx.clearRect(0, 0, w, h);
    e.fctx.drawImage(e.videoEl, 0, 0, w, h);
    e.fctx.filter = 'none';
    const sh = (Number(clip.color && clip.color.sharpen) || 0) / 100;
    if (sh > 0 && !S.ui.playing) { try { _sharpenCanvas(e.fctx, w, h, sh); } catch (_) {} }
    e.obj.dirty = true;
  } catch (_) {}
}

function _drawActiveVideoFrames() {
  const t = S.ui.currentTime;
  for (const [id, e] of _objs) {
    if (!e.videoEl || !e.frameCanvas) continue;
    const f = S.findClip(id);
    if (!f) continue;
    const c = f.clip;
    if (t >= c.start - 0.001 && t < c.start + S.clipDur(c)) _drawVideoFrame(e, c);
  }
}

function _commonProps(clip) {
  return {
    left: clip.left, top: clip.top, scaleX: clip.scaleX, scaleY: clip.scaleY,
    angle: clip.angle || 0, opacity: clip.opacity == null ? 1 : clip.opacity,
    originX: 'left', originY: 'top', cornerColor: '#ef4444', borderColor: '#ef4444',
    cornerStyle: 'circle', transparentCorners: false, cornerSize: 10,
  };
}

function _createObject(clip) {
  if (clip.kind === 'text') {
    const st = clip.style || S.defaultTextStyle();
    const obj = new window.fabric.Textbox(clip.text || 'Văn bản', {
      ..._commonProps(clip), width: clip.natW || 800,
      fontFamily: st.fontFamily, fontSize: st.fontSize, fontWeight: st.fontWeight,
      fontStyle: st.fontStyle, fill: st.fill, stroke: st.stroke, strokeWidth: st.strokeWidth,
      textAlign: st.align, lineHeight: st.lineHeight || 1.2,
      backgroundColor: st.bgColor || '',
    });
    obj.clipId = clip.id;
    _objs.set(clip.id, { obj, sig: _sig(clip) });
    fb.add(obj);
    return;
  }
  if (clip.kind === 'image') {
    window.fabric.Image.fromURL(clip.url, (img) => {
      if (!fb || S.findClip(clip.id) == null) return;
      img.set(_commonProps(clip));
      img.clipId = clip.id;
      if (!clip.natW || clip.natW === S.project.width) { clip.natW = img.width; clip.natH = img.height; }
      _applyFilters(img, clip);
      _objs.set(clip.id, { obj: img, sig: _sig(clip) });
      fb.add(img); fb.bringToFront(img);
      _onTime(); _syncSelection(); fb.requestRenderAll();
    }, { crossOrigin: 'anonymous' });
    _objs.set(clip.id, { obj: null, sig: _sig(clip) });   // placeholder until loaded
    return;
  }
  // video → backed by an offscreen canvas we redraw each frame with a CSS color
  // filter, so playback stays smooth AND shows the color adjustments live.
  const v = document.createElement('video');
  v.src = clip.url; v.crossOrigin = 'anonymous'; v.muted = true; v.preload = 'metadata';
  v.playsInline = true;
  v.addEventListener('loadedmetadata', () => {
    if (S.findClip(clip.id) == null) return;
    const w = v.videoWidth || S.project.width, h = v.videoHeight || S.project.height;
    if (!clip.natW || clip.natW === S.project.width) { clip.natW = w; clip.natH = h; }
    const fc = document.createElement('canvas');
    fc.width = w; fc.height = h;
    const fctx = fc.getContext('2d');
    const img = new window.fabric.Image(fc, { ..._commonProps(clip), objectCaching: false });
    img.clipId = clip.id;
    const e = _objs.get(clip.id) || {};
    e.obj = img; e.videoEl = v; e.frameCanvas = fc; e.fctx = fctx; e.sig = _sig(clip);
    _objs.set(clip.id, e);
    fb.add(img); fb.bringToFront(img);
    v.addEventListener('seeked', () => { _drawVideoFrame(e, clip); if (fb) fb.requestRenderAll(); }, { once: true });
    try { v.currentTime = (clip.in || 0); } catch (_) {}
    _onTime(); _syncSelection(); fb.requestRenderAll();
  });
  _objs.set(clip.id, { obj: null, videoEl: v, sig: _sig(clip) });
}

function _stopMedia(e) {
  if (!e) return;
  if (e.videoEl) { try { e.videoEl.pause(); e.videoEl.src = ''; } catch (_) {} }
  if (e.audioEl) { try { e.audioEl.pause(); e.audioEl.src = ''; } catch (_) {} }
}

// ── selection sync ────────────────────────────────────────────────────
function _onSelect(e) {
  if (_applying) return;
  const obj = (e && (e.selected ? e.selected[0] : e.target)) || (fb && fb.getActiveObject());
  if (obj && obj.clipId) S.select(obj.clipId);
}
function _syncSelection() {
  if (!fb) return;
  _applying = true;
  const id = S.ui.selectedClipId;
  const e = id && _objs.get(id);
  if (e && e.obj) { fb.setActiveObject(e.obj); } else { fb.discardActiveObject(); }
  fb.requestRenderAll();
  _applying = false;
}
function _onObjectModified(e) {
  if (_applying) return;
  const obj = e.target;
  if (!obj || !obj.clipId) return;
  const patch = {
    left: obj.left, top: obj.top, scaleX: obj.scaleX, scaleY: obj.scaleY,
    angle: obj.angle, opacity: obj.opacity,
  };
  S.updateClipTransform(obj.clipId, patch);
  S.commit();
}

// ── time / playback ───────────────────────────────────────────────────
// The visual clip immediately before `c` on the same track (by start time) —
// the clip a transition cross-dissolves FROM.
function _prevVisualClip(c) {
  const tr = S.project.tracks.find((t) => t.clips.some((x) => x.id === c.id));
  if (!tr) return null;
  let best = null;
  for (const x of tr.clips) {
    if (x.id === c.id || x.kind === 'audio' || x.kind === 'text') continue;
    if (x.start < c.start - 0.0001 && (!best || x.start > best.start)) best = x;
  }
  if (!best) return null;
  const gap = c.start - (best.start + S.clipDur(best));   // only dissolve from an adjacent clip
  return gap > 0.12 ? null : best;
}

// transition family from the ffmpeg xfade name
function _txCat(xf) {
  xf = (xf || 'fade').toLowerCase();
  if (xf.indexOf('wipe') === 0 || xf.indexOf('smooth') === 0) return 'wipe';
  if (xf.indexOf('slide') === 0) return 'slide';
  if (xf.indexOf('circle') === 0) return 'circle';
  if (xf.indexOf('diag') === 0) return 'diag';
  if (xf === 'fadeblack' || xf === 'fadewhite') return 'fadeblack';
  return 'fade';   // fade/dissolve -> cross-dissolve preview
}

// Polygon clip for a diagonal wipe revealing from `corner` ('tl'|'tr'|'bl'|'br')
function _diagClip(left, top, w, h, p, corner) {
  const k = 2 * p;
  let pts = k <= 1
    ? [{ x: 0, y: 0 }, { x: k * w, y: 0 }, { x: 0, y: k * h }]
    : [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: (k - 1) * h }, { x: (k - 1) * w, y: h }, { x: 0, y: h }];
  if (corner.indexOf('r') >= 0) pts = pts.map((q) => ({ x: w - q.x, y: q.y }));
  if (corner.indexOf('b') >= 0) pts = pts.map((q) => ({ x: q.x, y: h - q.y }));
  pts = pts.map((q) => ({ x: q.x + left, y: q.y + top }));
  return new window.fabric.Polygon(pts, { absolutePositioned: true });
}

// Seek a predecessor's video to its last frame and draw it (held during a
// transition while the predecessor is no longer the active clip).
function _freezePrev(eP, prev, t) {
  if (!eP || !eP.videoEl) return;
  const pend = prev.start + S.clipDur(prev);
  if (t < pend - 0.001) return;
  const want = Math.max(0, (prev.in || 0) + S.clipDur(prev) - 0.05);
  try {
    if (Math.abs(eP.videoEl.currentTime - want) > 0.08) {
      eP.videoEl.addEventListener('seeked', () => { _drawVideoFrame(eP, prev); if (fb) fb.requestRenderAll(); }, { once: true });
      eP.videoEl.currentTime = want;
    } else { _drawVideoFrame(eP, prev); }
  } catch (_) {}
}

function _onTime() {
  if (!fb) return;
  const t = S.ui.currentTime;
  _applying = true;
  const txList = [];
  for (const [id, e] of _objs) {
    if (!e.obj) continue;
    const f = S.findClip(id);
    if (!f) { e.obj.visible = false; continue; }
    const c = f.clip;
    const active = t >= c.start - 0.001 && t < c.start + S.clipDur(c);
    e.obj.visible = active;
    if (active) {
      // reset any transient transition transform left over from a prior frame
      e.obj.clipPath = null;
      e.obj.left = c.left; e.obj.top = c.top;
      e.obj.opacity = (c.opacity == null ? 1 : c.opacity);
      e.obj.dirty = true;
      const tr2 = c.transition;
      if (tr2 && tr2.duration > 0) {
        const into = t - c.start;
        if (into >= 0 && into < tr2.duration) {
          txList.push({ e, c, p: Math.max(0, Math.min(1, into / tr2.duration)), xf: tr2.xf });
        }
      }
    }
    if (active && e.videoEl && !S.ui.playing) {
      const want = (c.in || 0) + (t - c.start);
      try {
        if (Math.abs(e.videoEl.currentTime - want) > 0.08) {
          e.videoEl.addEventListener('seeked', () => {
            _drawVideoFrame(e, c); if (fb) fb.requestRenderAll();
          }, { once: true });
          e.videoEl.currentTime = want;
        }
      } catch (_) {}
    }
    if (!active && e.videoEl) { try { e.videoEl.pause(); } catch (_) {} }
  }

  // apply the actual transition (wipe/slide/circle/fade) to each incoming clip
  for (const tx of txList) {
    const { e, c, p, xf } = tx;
    const cat = _txCat(xf);
    const x = (xf || '').toLowerCase();
    const wB = e.obj.getScaledWidth();
    const hB = e.obj.getScaledHeight();
    const base = (c.opacity == null ? 1 : c.opacity);

    // predecessor (if adjacent) held beneath, frozen on its last frame
    const prev = _prevVisualClip(c);
    const eP = prev ? _objs.get(prev.id) : null;
    if (prev && eP && eP.obj) {
      eP.obj.visible = true;
      eP.obj.clipPath = null; eP.obj.dirty = true;
      eP.obj.left = prev.left; eP.obj.top = prev.top;
      eP.obj.opacity = (prev.opacity == null ? 1 : prev.opacity);
      _freezePrev(eP, prev, t);
    }
    const pW = eP && eP.obj ? eP.obj.getScaledWidth() : 0;
    const pH = eP && eP.obj ? eP.obj.getScaledHeight() : 0;

    if (cat === 'fade') {
      e.obj.opacity = base * p;
      if (eP && eP.obj) eP.obj.opacity = (prev.opacity == null ? 1 : prev.opacity) * (1 - p);
    } else if (cat === 'slide') {
      if (x.indexOf('left') >= 0) { e.obj.left = c.left + wB * (1 - p); if (eP && eP.obj) eP.obj.left = prev.left - pW * p; }
      else if (x.indexOf('right') >= 0) { e.obj.left = c.left - wB * (1 - p); if (eP && eP.obj) eP.obj.left = prev.left + pW * p; }
      else if (x.indexOf('up') >= 0) { e.obj.top = c.top + hB * (1 - p); if (eP && eP.obj) eP.obj.top = prev.top - pH * p; }
      else { e.obj.top = c.top - hB * (1 - p); if (eP && eP.obj) eP.obj.top = prev.top + pH * p; }
    } else if (cat === 'wipe') {
      let r;
      if (x.indexOf('left') >= 0) r = { left: c.left + wB * (1 - p), top: c.top, width: wB * p, height: hB };
      else if (x.indexOf('right') >= 0) r = { left: c.left, top: c.top, width: wB * p, height: hB };
      else if (x.indexOf('up') >= 0) r = { left: c.left, top: c.top + hB * (1 - p), width: wB, height: hB * p };
      else r = { left: c.left, top: c.top, width: wB, height: hB * p };
      e.obj.clipPath = new window.fabric.Rect({ ...r, absolutePositioned: true });
      e.obj.dirty = true;
    } else if (cat === 'circle') {
      const cx = c.left + wB / 2, cy = c.top + hB / 2;
      const rad = Math.max(1, (Math.hypot(wB, hB) / 2) * p);
      e.obj.clipPath = new window.fabric.Circle({ left: cx - rad, top: cy - rad, radius: rad, absolutePositioned: true });
      e.obj.dirty = true;
    } else if (cat === 'diag') {
      e.obj.clipPath = _diagClip(c.left, c.top, wB, hB, p, x.slice(4));
      e.obj.dirty = true;
    } else if (cat === 'fadeblack') {
      // fade through black: predecessor out (0..0.5), then incoming in (0.5..1)
      if (p < 0.5) { e.obj.opacity = 0; if (eP && eP.obj) eP.obj.opacity = (prev.opacity == null ? 1 : prev.opacity) * (1 - 2 * p); }
      else { e.obj.opacity = base * (2 * p - 1); if (eP && eP.obj) eP.obj.opacity = 0; }
    }
  }
  _applying = false;
  fb.requestRenderAll();
}

function _ensureAudioEls() {
  for (const tr of S.project.tracks) {
    if (tr.type !== 'audio') continue;
    for (const c of tr.clips) {
      let e = _objs.get(c.id);
      if (!e) { e = {}; _objs.set(c.id, e); }
      if (!e.audioEl) {
        const a = document.createElement('audio');
        a.src = c.url; a.preload = 'auto';
        e.audioEl = a; e.sig = e.sig || _sig(c);
      }
    }
  }
}

export function play() {
  if (S.ui.playing) return;
  const total = S.projectDuration();
  if (S.ui.currentTime >= total) S.setTime(0);
  S.ui.playing = true;
  _ensureAudioEls();
  _playStartWall = performance.now();
  _playStartTime = S.ui.currentTime;
  _syncPlaybackMedia(true);
  const tick = () => {
    if (!S.ui.playing) return;
    const t = _playStartTime + (performance.now() - _playStartWall) / 1000;
    if (t >= total) { S.setTime(total); pause(); return; }
    S.setTime(t);
    _syncPlaybackMedia(false);
    _drawActiveVideoFrames();
    fb.requestRenderAll();
    _raf = requestAnimationFrame(tick);
  };
  _raf = requestAnimationFrame(tick);
  S.emit('playstate');
}

function _syncPlaybackMedia(forceSeek) {
  const t = S.ui.currentTime;
  for (const [id, e] of _objs) {
    const f = S.findClip(id);
    if (!f) continue;
    const c = f.clip; const tr = f.track;
    const active = t >= c.start - 0.001 && t < c.start + S.clipDur(c);
    const media = e.videoEl || e.audioEl;
    if (!media) continue;
    if (active) {
      const want = (c.in || 0) + (t - c.start);
      if (forceSeek) { try { media.currentTime = want; } catch (_) {} }
      // track/clip volume + mute + fade in/out (so fades are audible in preview)
      let vol = (c.volume == null ? 100 : c.volume) / 100 * ((tr.volume == null ? 100 : tr.volume) / 100);
      const into = t - c.start, dur = S.clipDur(c);
      if (c.fadeIn && into < c.fadeIn) vol *= Math.max(0, into / c.fadeIn);
      if (c.fadeOut && into > dur - c.fadeOut) vol *= Math.max(0, (dur - into) / c.fadeOut);
      try { media.muted = !!tr.muted; media.volume = Math.max(0, Math.min(1, vol)); } catch (_) {}
      if (media.paused) { media.play().catch(() => {}); }
      if (Math.abs(media.currentTime - want) > 0.25) { try { media.currentTime = want; } catch (_) {} }
    } else if (!media.paused) {
      media.pause();
    }
  }
}

export function pause() {
  S.ui.playing = false;
  if (_raf) { cancelAnimationFrame(_raf); _raf = 0; }
  for (const e of _objs.values()) {
    if (e.videoEl) { try { e.videoEl.pause(); } catch (_) {} }
    if (e.audioEl) { try { e.audioEl.pause(); } catch (_) {} }
  }
  _drawActiveVideoFrames();
  if (fb) fb.requestRenderAll();
  S.emit('playstate');
}
export function togglePlay() { S.ui.playing ? pause() : play(); }
export function seek(t) { pause(); S.setTime(t); }
