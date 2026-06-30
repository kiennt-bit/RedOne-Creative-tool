// Trình dựng video — editor state model (single source of truth).
//
// Mirrors the ORIGINAL editor's shape (Project → Track → Clip) so the layout
// and features map 1:1, adapted to our stack: media = the user's own library
// (Flow/Shakker outputs + uploads), render = our FFmpeg backend.
//
// All mutations go through this module and emit events; canvas/timeline/
// inspector subscribe and re-render. Undo/redo snapshots the whole project.

let _seq = 1;
const newId = (p) => `${p}${(_seq++).toString(36)}${Date.now().toString(36).slice(-3)}`;

// ── events ────────────────────────────────────────────────────────────
const _subs = {};   // event -> Set<cb>
export function on(evt, cb) {
  (_subs[evt] = _subs[evt] || new Set()).add(cb);
  return () => _subs[evt] && _subs[evt].delete(cb);
}
export function emit(evt, payload) {
  const s = _subs[evt];
  if (s) for (const cb of s) { try { cb(payload); } catch (e) { console.warn(e); } }
}
// Drop every subscriber — called when the editor tab re-mounts so canvas/
// timeline/inspector re-subscribe fresh instead of stacking duplicate handlers.
export function offAll() { for (const k in _subs) _subs[k].clear(); }

// Drag payload: a library media item being dragged onto a timeline track.
let _drag = null;
export function setDrag(m) { _drag = m; }
export function getDrag() { return _drag; }
export function clearDrag() { _drag = null; }

// ── factory defaults ──────────────────────────────────────────────────
export function defaultColor() {
  return {
    temperature: 0, tint: 0, saturation: 0, vibrance: 0,
    exposure: 0, contrast: 0, brightness: 0,
    highlights: 0, shadows: 0, whites: 0, blacks: 0, sharpen: 0, blur: 0,
  };
}
export function defaultTextStyle() {
  return {
    fontFamily: 'Inter', fontSize: 72, fontWeight: 'bold', fontStyle: 'normal',
    fill: '#ffffff', stroke: '#000000', strokeWidth: 0, align: 'center',
    bgColor: '', lineHeight: 1.2,
  };
}

// ── the project ───────────────────────────────────────────────────────
export const project = {
  id: null,
  name: 'Dự án mới',
  width: 1920, height: 1080, fps: 30,
  tracks: [],          // index 0 = TOP track (drawn last, on top)
};

// transient UI state
export const ui = {
  selectedClipId: null,
  currentTime: 0,      // seconds
  zoom: 60,            // px per second on the timeline
  playing: false,
};

export function makeTrack(type, name) {
  return {
    id: newId('t'), type,                       // 'video' | 'audio' | 'text'
    name: name || (type === 'audio' ? 'Audio' : type === 'text' ? 'Chữ' : 'Video'),
    volume: 100, muted: false, locked: false,
    clips: [],
  };
}

export function makeClip(kind, m) {
  m = m || {};
  const c = {
    id: newId('c'), trackId: null, kind,        // 'video'|'image'|'audio'|'text'
    name: m.name || (kind === 'text' ? 'Văn bản' : 'clip'),
    path: m.path || '', url: m.url || '',
    srcDuration: m.srcDuration || 0,
    natW: m.natW || project.width, natH: m.natH || project.height,
    in: 0, out: 0, start: 0, duration: 5,
    // canvas transform (project coords, top-left origin)
    left: 0, top: 0, scaleX: 1, scaleY: 1, angle: 0, opacity: 1,
    // color (video/image)
    color: defaultColor(),
    // audio
    volume: 100, fadeIn: 0, fadeOut: 0,
    // text
    text: kind === 'text' ? (m.text || 'Văn bản') : '',
    style: kind === 'text' ? defaultTextStyle() : null,
  };
  if (kind === 'video' || kind === 'audio') {
    c.in = 0; c.out = m.srcDuration || 5; c.duration = c.out - c.in;
  } else {
    c.duration = m.duration || 5;
  }
  return c;
}

// ── duration helpers ──────────────────────────────────────────────────
export function clipDur(c) {
  if (c.kind === 'video' || c.kind === 'audio') return Math.max(0.1, (c.out || 0) - (c.in || 0));
  return Math.max(0.1, c.duration || 5);
}
export function projectDuration() {
  let max = 0;
  for (const t of project.tracks) for (const c of t.clips) max = Math.max(max, (c.start || 0) + clipDur(c));
  return max;
}

// ── track / clip mutations ────────────────────────────────────────────
export function addTrack(type, name, atTop) {
  const t = makeTrack(type, name);
  if (atTop) project.tracks.unshift(t); else project.tracks.push(t);
  pushHistory(); emit('change'); emit('tracks');
  return t;
}
export function removeTrack(trackId) {
  const i = project.tracks.findIndex((t) => t.id === trackId);
  if (i < 0) return;
  project.tracks.splice(i, 1);
  pushHistory(); emit('change'); emit('tracks');
}
export function getTrack(id) { return project.tracks.find((t) => t.id === id); }

// Reorder a track (dir -1 = up/toward top, +1 = down). tracks[0] = top layer.
export function moveTrack(trackId, dir) {
  const i = project.tracks.findIndex((t) => t.id === trackId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= project.tracks.length) return;
  const tmp = project.tracks[i]; project.tracks[i] = project.tracks[j]; project.tracks[j] = tmp;
  pushHistory(); emit('change'); emit('tracks');
}

function _firstTrackFor(kind) {
  const want = kind === 'audio' ? 'audio' : (kind === 'text' ? 'text' : 'video');
  let t = project.tracks.find((x) => x.type === want);
  if (!t) t = addTrack(want);
  return t;
}

// place a new clip at the end of its track's timeline
export function addClip(clip, trackId, startAt) {
  const t = trackId ? getTrack(trackId) : _firstTrackFor(clip.kind);
  clip.trackId = t.id;
  if (startAt != null) {
    clip.start = Math.max(0, startAt);
  } else {
    // append after the last clip on this track
    let end = 0;
    for (const c of t.clips) end = Math.max(end, (c.start || 0) + clipDur(c));
    clip.start = end;
  }
  // center visual clips on the canvas at a sensible default size
  if (clip.kind !== 'audio') centerOnCanvas(clip);
  t.clips.push(clip);
  pushHistory(); emit('change'); emit('tracks');
  select(clip.id);
  return clip;
}

export function centerOnCanvas(clip) {
  const cw = clip.natW || project.width;
  const ch = clip.natH || project.height;
  // fit within canvas keeping aspect
  const s = Math.min(project.width / cw, project.height / ch);
  clip.scaleX = clip.scaleY = (clip.kind === 'text') ? 1 : s;
  const w = cw * clip.scaleX, h = ch * clip.scaleY;
  clip.left = (project.width - w) / 2;
  clip.top = (project.height - h) / 2;
}

export function findClip(clipId) {
  for (const t of project.tracks) {
    const c = t.clips.find((x) => x.id === clipId);
    if (c) return { track: t, clip: c };
  }
  return null;
}
export function selectedClip() {
  return ui.selectedClipId ? (findClip(ui.selectedClipId) || {}).clip || null : null;
}

export function removeClip(clipId) {
  const f = findClip(clipId);
  if (!f) return;
  f.track.clips = f.track.clips.filter((c) => c.id !== clipId);
  if (ui.selectedClipId === clipId) ui.selectedClipId = null;
  pushHistory(); emit('change'); emit('tracks'); emit('selection');
}

export function splitClip(clipId, atTime) {
  const f = findClip(clipId);
  if (!f) return;
  const c = f.clip;
  const local = atTime - c.start;            // offset into the clip
  if (local <= 0.05 || local >= clipDur(c) - 0.05) return;
  const right = JSON.parse(JSON.stringify(c));
  right.id = newId('c');
  if (c.kind === 'video' || c.kind === 'audio') {
    const cut = c.in + local;
    right.in = cut; right.out = c.out; right.start = c.start + local;
    c.out = cut;
  } else {
    right.duration = clipDur(c) - local; right.start = c.start + local;
    c.duration = local;
  }
  const idx = f.track.clips.indexOf(c);
  f.track.clips.splice(idx + 1, 0, right);
  pushHistory(); emit('change'); emit('tracks');
}

export function moveClipTime(clipId, newStart) {
  const f = findClip(clipId);
  if (!f) return;
  f.clip.start = Math.max(0, newStart);
  emit('change');
}
// Move a clip to a different track (drag between layers) + set its start.
export function moveClipToTrack(clipId, trackId, newStart) {
  const f = findClip(clipId);
  const dest = getTrack(trackId);
  if (!f || !dest) return;
  if (f.track.id === trackId) { f.clip.start = Math.max(0, newStart); emit('change'); return; }
  f.track.clips = f.track.clips.filter((c) => c.id !== clipId);
  f.clip.trackId = trackId;
  f.clip.start = Math.max(0, newStart);
  dest.clips.push(f.clip);
  emit('change');
}
export function trimClip(clipId, edge, deltaSec) {
  const f = findClip(clipId);
  if (!f) return;
  const c = f.clip;
  if (c.kind === 'video' || c.kind === 'audio') {
    if (edge === 'left') {
      const ni = Math.min(c.out - 0.1, Math.max(0, c.in + deltaSec));
      c.start += (ni - c.in); c.in = ni;
    } else {
      const no = Math.max(c.in + 0.1, Math.min(c.srcDuration || (c.out + deltaSec), c.out + deltaSec));
      c.out = no;
    }
  } else {
    if (edge === 'left') {
      const d = Math.min(clipDur(c) - 0.1, deltaSec);
      c.start += d; c.duration -= d;
    } else {
      c.duration = Math.max(0.1, c.duration + deltaSec);
    }
  }
  emit('change');
}

export function updateClip(clipId, patch) {
  const f = findClip(clipId);
  if (!f) return;
  Object.assign(f.clip, patch);
  emit('change');
}
export function updateClipTransform(clipId, t) {
  const f = findClip(clipId);
  if (!f) return;
  Object.assign(f.clip, t);
  emit('change');   // no history on every drag frame; commit() ends the gesture
}

export function select(clipId) {
  ui.selectedClipId = clipId;
  emit('selection');
}
export function setTime(t) {
  ui.currentTime = Math.max(0, t);
  emit('time');
}
export function setZoom(z) { ui.zoom = Math.max(8, Math.min(1000, z)); emit('change'); }

// ── undo / redo ───────────────────────────────────────────────────────
const _undo = [];
const _redo = [];
const MAX_HISTORY = 60;
function snapshot() {
  return JSON.stringify({ name: project.name, width: project.width, height: project.height, fps: project.fps, tracks: project.tracks });
}
let _last = null;
export function pushHistory() {
  const snap = snapshot();
  if (snap === _last) return;
  if (_last !== null) { _undo.push(_last); if (_undo.length > MAX_HISTORY) _undo.shift(); }
  _last = snap; _redo.length = 0;
  emit('history');
}
export function commit() { pushHistory(); emit('change'); emit('tracks'); }
function _restore(snap) {
  const d = JSON.parse(snap);
  project.name = d.name; project.width = d.width; project.height = d.height; project.fps = d.fps;
  project.tracks = d.tracks;
  emit('change'); emit('tracks'); emit('selection');
}
export function undo() {
  if (!_undo.length) return;
  _redo.push(_last); _last = _undo.pop(); _restore(_last); emit('history');
}
export function redo() {
  if (!_redo.length) return;
  _undo.push(_last); _last = _redo.pop(); _restore(_last); emit('history');
}
export function canUndo() { return _undo.length > 0; }
export function canRedo() { return _redo.length > 0; }

// ── load / reset ──────────────────────────────────────────────────────
export function loadProject(p, data) {
  project.id = p.id;
  project.name = p.name || 'Dự án';
  project.width = (data && data.width) || 1920;
  project.height = (data && data.height) || 1080;
  project.fps = (data && data.fps) || 30;
  project.tracks = (data && Array.isArray(data.tracks)) ? data.tracks : [];
  ui.selectedClipId = null; ui.currentTime = 0; ui.playing = false;
  _undo.length = 0; _redo.length = 0; _last = null; pushHistory();
  emit('change'); emit('tracks'); emit('selection'); emit('time');
}
export function reset() {
  project.id = null; project.name = 'Dự án mới';
  project.width = 1920; project.height = 1080; project.fps = 30;
  project.tracks = [];
  ui.selectedClipId = null; ui.currentTime = 0; ui.playing = false;
  _undo.length = 0; _redo.length = 0; _last = null; pushHistory();
  emit('change'); emit('tracks'); emit('selection'); emit('time');
}

// project state to persist (for save) + spec to render (for export)
export function serialize() {
  return { width: project.width, height: project.height, fps: project.fps, tracks: project.tracks };
}
export function buildRenderSpec() {
  return {
    width: project.width, height: project.height, fps: project.fps,
    duration: projectDuration(),
    tracks: project.tracks.map((t) => ({
      type: t.type, volume: t.volume, muted: t.muted,
      clips: t.clips.map((c) => ({
        kind: c.kind, path: c.path,
        in: c.in, out: c.out, start: c.start, duration: clipDur(c),
        natW: c.natW, natH: c.natH,
        left: c.left, top: c.top, scaleX: c.scaleX, scaleY: c.scaleY,
        angle: c.angle, opacity: c.opacity,
        color: c.color, volume: c.volume, fadeIn: c.fadeIn, fadeOut: c.fadeOut,
        text: c.text, style: c.style, transition: c.transition,
      })),
    })),
  };
}
