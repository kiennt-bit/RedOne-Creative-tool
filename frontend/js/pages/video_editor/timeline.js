// Trình dựng video — multi-track timeline (bottom panel).
//
// Track headers (name, mute, volume, lock, delete), a time ruler, a draggable
// playhead, and per-track clip lanes where clips can be dragged to move,
// edge-trimmed, split at the playhead, and deleted. Mirrors the original's
// TimelineComponent on our stack.
import { el, clear, icon, toast } from '../../ui.js';
import * as S from './state.js';
import * as C from './canvas.js';

let _root = null;
let _lanes = null;       // scrollable lanes container
let _lanesWrap = null;   // wraps ruler + lanes + playhead (sets timeline width)
let _headers = null;     // track headers column
let _ruler = null;
let _playhead = null;
let _scroller = null;     // horizontal scroll container (for wheel-zoom anchoring)
let _snapGuide = null;    // vertical guide shown when a dragged clip snaps
let _zoomRaf = 0;         // rAF id coalescing rapid wheel-zoom into one rebuild
let _zoomPending = null;  // { zoom, tCursor, viewportX }
const HEADER_W = 184;
const ROW_H = 64;
const SNAP_PX = 8;        // magnet threshold in pixels (tunable; precision scales with zoom)

const KIND_COLOR = {
  video: 'var(--accent-blue)', image: 'var(--accent-green)',
  audio: 'var(--accent-amber)', text: 'var(--accent-purple)',
};
const ICONS = {
  volume: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>',
  mute: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M22 9l-6 6M16 9l6 6"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  unlock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 7-1.5"/>',
};
function _svg(paths, size = 14) {
  return el('span', { style: { display: 'inline-flex' },
    html: `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>` });
}
function _iconBtn(child, title, onclick) {
  return el('button', { title, onclick, style: {
    width: '26px', height: '22px', padding: '0', flex: '0 0 auto',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    border: '1px solid var(--border)', borderRadius: '6px',
    background: 'var(--surface-alt)', color: 'var(--text-dim)', cursor: 'pointer',
  } }, child);
}

export function renderTimeline(root) {
  _root = root;
  clear(root);

  const toolbar = el('div', {
    style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 10px',
             borderBottom: '1px solid var(--border)' },
  },
    _addTrackBtn(),
    el('button', { class: 'btn btn-sm', title: 'Thêm chữ tại vị trí playhead', onclick: _addText },
      icon('edit', 14), ' Chữ'),
    el('button', { class: 'btn btn-sm', title: 'Cắt tại playhead', onclick: _splitSelected },
      icon('x', 14), ' Cắt'),
    el('button', { class: 'btn btn-sm', title: 'Xóa clip đang chọn', onclick: _deleteSelected },
      icon('trash', 14), ' Xóa'),
    el('div', { style: { flex: '1' } }),
    el('div', { class: 'field-help', id: 've-tl-total' }, ''),
  );

  _headers = el('div', { style: { width: `${HEADER_W}px`, flex: '0 0 auto',
    position: 'sticky', left: '0', zIndex: '10', background: 'var(--surface)',
    borderRight: '1px solid var(--border)' } });
  _ruler = el('div', { style: { position: 'relative', height: '22px',
    borderBottom: '1px solid var(--border)', background: 'var(--surface-alt)', cursor: 'pointer' } });
  _ruler.addEventListener('pointerdown', _onRulerSeek);
  _lanes = el('div', { style: { position: 'relative' } });
  // Playhead: a grabbable pentagon head (in the ruler) + a draggable body line
  // running down through the tracks — drag either to scrub (CapCut-style).
  _playhead = el('div', { style: {
    position: 'absolute', top: '0', bottom: '0', left: '0', width: '0',
    zIndex: '20', pointerEvents: 'none',
  } });
  const phHead = el('div', { title: 'Kéo để di chuyển playhead', style: {
    position: 'absolute', top: '0', left: '0', transform: 'translateX(-50%)',
    width: '14px', height: '16px', background: 'var(--brand)',
    clipPath: 'polygon(0 0, 100% 0, 100% 55%, 50% 100%, 0 55%)',
    boxShadow: '0 1px 3px rgba(0,0,0,0.45)', cursor: 'ew-resize', pointerEvents: 'auto',
  } });
  const phBody = el('div', { style: {
    position: 'absolute', top: '0', bottom: '0', left: '0', transform: 'translateX(-50%)',
    width: '8px', cursor: 'ew-resize', pointerEvents: 'auto',
    display: 'flex', justifyContent: 'center',
  } }, el('div', { style: { width: '1px', background: 'var(--brand)' } }));
  phHead.addEventListener('pointerdown', _startPlayheadDrag);
  phBody.addEventListener('pointerdown', _startPlayheadDrag);
  _playhead.appendChild(phBody); _playhead.appendChild(phHead);
  _snapGuide = el('div', { style: {
    position: 'absolute', top: '22px', bottom: '0', width: '2px', background: 'var(--accent-amber)',
    boxShadow: '0 0 6px var(--accent-amber)', zIndex: '19', pointerEvents: 'none', display: 'none',
  } });
  _lanesWrap = el('div', { style: { position: 'relative', flex: '0 0 auto' } }, _ruler, _lanes, _playhead, _snapGuide);
  const tracksRow = el('div', { style: { display: 'flex', alignItems: 'flex-start', minWidth: 'min-content' } }, _headers, _lanesWrap);

  root.appendChild(toolbar);
  // One scroll area for BOTH axes: the header column is sticky-left (pinned
  // while scrolling time), and all tracks scroll together vertically so lower
  // layers are always reachable. Mouse wheel zooms the timeline (Shift = scroll).
  _scroller = el('div', { style: { flex: '1', minHeight: '0', overflow: 'auto' } }, tracksRow);
  _scroller.addEventListener('wheel', _onWheel, { passive: false });
  root.appendChild(_scroller);

  S.on('change', _rebuild);
  S.on('tracks', _rebuild);
  S.on('selection', _rebuild);
  S.on('time', _positionPlayhead);
  _rebuild();
}

function _addTrackBtn() {
  const wrap = el('div', { style: { position: 'relative' } });
  const menu = el('div', { style: {
    position: 'absolute', top: '100%', left: '0', marginTop: '4px', zIndex: '30',
    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)',
    boxShadow: 'var(--sh-md)', display: 'none', minWidth: '160px', overflow: 'hidden',
  } },
    _menuItem('Thêm tầng Video', () => { S.addTrack('video'); menu.style.display = 'none'; }),
    _menuItem('Thêm tầng Audio', () => { S.addTrack('audio'); menu.style.display = 'none'; }),
    _menuItem('Thêm tầng Chữ (trên cùng)', () => { _addText(true); menu.style.display = 'none'; }),
  );
  const btn = el('button', { class: 'btn btn-sm btn-primary', onclick: (e) => {
    e.stopPropagation();
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  } }, icon('plus', 14), ' Thêm tầng');
  document.addEventListener('click', () => { menu.style.display = 'none'; });
  wrap.appendChild(btn); wrap.appendChild(menu);
  return wrap;
}
function _menuItem(label, onclick) {
  return el('div', {
    style: { padding: '8px 12px', cursor: 'pointer', fontSize: '13px' },
    onmouseenter: (e) => { e.currentTarget.style.background = 'var(--surface-alt)'; },
    onmouseleave: (e) => { e.currentTarget.style.background = 'transparent'; },
    onclick,
  }, label);
}

// ── rebuild ───────────────────────────────────────────────────────────
function _rebuild() {
  if (!_root) return;
  const px = S.ui.zoom;
  const total = Math.max(S.projectDuration(), 10);
  const width = Math.max(total * px + 200, 600);

  const totalEl = document.getElementById('ve-tl-total');
  if (totalEl) totalEl.textContent = `${S.project.tracks.length} tầng · ${_fmt(S.projectDuration())}`;

  // ruler
  clear(_ruler);
  _ruler.style.width = `${width}px`;
  // pick the smallest "nice" step whose label spacing is >= ~64px → labels never
  // crowd, and zooming in automatically reveals finer (sub-second) detail.
  const NICE = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  let step = NICE[NICE.length - 1];
  for (const s of NICE) { if (s * px >= 64) { step = s; break; } }
  for (let i = 0; i * step <= total + step; i++) {
    const s = Math.round(i * step * 1000) / 1000;
    _ruler.appendChild(el('div', { style: {
      position: 'absolute', left: `${s * px}px`, top: '0', bottom: '0',
      borderLeft: '1px solid var(--border)', paddingLeft: '4px', fontSize: '10px',
      color: 'var(--text-muted)', whiteSpace: 'nowrap',
    } }, _fmtTick(s, step)));
  }

  // headers + lanes
  clear(_headers); clear(_lanes);
  _lanes.style.width = `${width}px`;
  if (_lanesWrap) _lanesWrap.style.width = `${width}px`;
  // spacer so header rows line up with the ruler row beside them
  _headers.appendChild(el('div', { style: { height: '22px', flex: '0 0 auto',
    borderBottom: '1px solid var(--border)', background: 'var(--surface-alt)' } }));
  if (!S.project.tracks.length) {
    _headers.appendChild(el('div', { class: 'field-help', style: { padding: '16px 10px' } }, 'Chưa có tầng.'));
    _lanes.appendChild(el('div', { class: 'field-help', style: { padding: '16px' } },
      'Thêm media từ panel trái — clip sẽ nằm trên dòng thời gian này.'));
    _positionPlayhead();
    return;
  }
  for (const track of S.project.tracks) {
    _headers.appendChild(_trackHeader(track));
    _lanes.appendChild(_trackLane(track, px));
  }
  _positionPlayhead();
}

function _trackHeader(track) {
  const typeIcon = track.type === 'text' ? 'edit' : 'movie';
  const muteBtn = _iconBtn(_svg(track.muted ? ICONS.mute : ICONS.volume),
    track.muted ? 'Bật tiếng' : 'Tắt tiếng', () => { track.muted = !track.muted; S.commit(); });
  if (track.muted) { muteBtn.style.color = 'var(--brand)'; muteBtn.style.borderColor = 'var(--brand)'; }
  const lockBtn = _iconBtn(_svg(track.locked ? ICONS.lock : ICONS.unlock),
    track.locked ? 'Mở khóa' : 'Khóa', () => { track.locked = !track.locked; S.commit(); });
  if (track.locked) { lockBtn.style.color = 'var(--brand)'; lockBtn.style.borderColor = 'var(--brand)'; }
  const del = _iconBtn(icon('trash', 13), 'Xóa tầng', () => S.removeTrack(track.id));
  const idx = S.project.tracks.findIndex((t) => t.id === track.id);
  const up = _iconBtn('↑', 'Đưa tầng lên lớp trên', () => S.moveTrack(track.id, -1));
  up.disabled = idx <= 0; if (up.disabled) up.style.opacity = '0.4';
  const down = _iconBtn('↓', 'Đưa tầng xuống lớp dưới', () => S.moveTrack(track.id, 1));
  down.disabled = idx >= S.project.tracks.length - 1; if (down.disabled) down.style.opacity = '0.4';
  const vol = el('input', { type: 'range', min: '0', max: '100', value: String(track.volume),
    class: 've-vol', style: { flex: '1', minWidth: '0', marginRight: '2px' }, title: 'Âm lượng tầng',
    oninput: (e) => { track.volume = Number(e.target.value); S.emit('change'); },
    onchange: () => S.commit() });

  return el('div', { style: {
    height: `${ROW_H}px`, padding: '7px 8px', borderBottom: '1px solid var(--border)',
    display: 'flex', flexDirection: 'column', gap: '8px', justifyContent: 'center', overflow: 'hidden',
  } },
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: '0' } },
      el('span', { style: { color: KIND_COLOR[track.type] || 'var(--text-muted)', display: 'flex', flex: '0 0 auto' } }, icon(typeIcon, 14)),
      el('span', { style: { fontSize: '12px', fontWeight: '600', flex: '1', minWidth: '0', overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, track.name),
      up, down, del,
    ),
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: '0', overflow: 'hidden' } }, muteBtn, lockBtn,
      track.type !== 'text' ? vol : null),
  );
}

function _trackLane(track, px) {
  const lane = el('div', {
    'data-track': track.id,
    ondragover: (e) => {
      const m = S.getDrag();
      const ok = m && _accepts(track.type, m.type);
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = ok ? 'copy' : 'none';
      lane.style.background = ok ? 'var(--brand-soft)' : 'var(--surface-alt)';
    },
    ondragleave: () => { lane.style.background = 'var(--surface-alt)'; },
    ondrop: (e) => {
      e.preventDefault();
      lane.style.background = 'var(--surface-alt)';
      const m = S.getDrag();
      if (!m) return;
      if (!_accepts(track.type, m.type)) {
        toast(m.type === 'audio' ? 'File audio chỉ thả vào tầng Audio' : 'Video/ảnh chỉ thả vào tầng Video', 'warning');
        S.clearDrag(); return;
      }
      const rect = lane.getBoundingClientRect();
      const start = Math.max(0, (e.clientX - rect.left) / px);
      S.emit('dropmedia', { media: m, trackId: track.id, start });
      S.clearDrag();
    },
    style: {
      position: 'relative', height: `${ROW_H}px`, borderBottom: '1px solid var(--border)',
      background: 'var(--surface-alt)',
    },
  });
  for (const clip of track.clips) lane.appendChild(_clipEl(track, clip, px));
  return lane;
}

function _clipEl(track, clip, px) {
  const dur = S.clipDur(clip);
  const selected = S.ui.selectedClipId === clip.id;
  const color = KIND_COLOR[clip.kind] || 'var(--accent-blue)';
  const box = el('div', { 'data-clip': clip.id, style: {
    position: 'absolute', left: `${clip.start * px}px`, top: '4px', height: `${ROW_H - 12}px`,
    width: `${Math.max(dur * px, 12)}px`, borderRadius: '6px', overflow: 'hidden',
    border: selected ? '2px solid var(--brand)' : '1px solid var(--border-strong)',
    background: 'var(--surface)', cursor: 'grab', boxShadow: selected ? 'var(--sh-sm)' : 'none',
    display: 'flex', alignItems: 'center',
  } });
  // colored kind stripe
  box.appendChild(el('div', { style: { position: 'absolute', left: '0', top: '0', bottom: '0',
    width: '3px', background: color } }));
  // thumbnail
  if ((clip.kind === 'image' || clip.kind === 'video') && clip.url) {
    box.appendChild(el('div', { style: {
      position: 'absolute', inset: '0', backgroundImage: `url("${clip.url}")`,
      backgroundSize: 'cover', backgroundPosition: 'center', opacity: '0.35',
    } }));
  }
  box.appendChild(el('div', { style: { position: 'relative', padding: '0 8px', fontSize: '11px',
    fontWeight: '600', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis',
    whiteSpace: 'nowrap', pointerEvents: 'none' } }, clip.kind === 'text' ? (clip.text || 'Văn bản') : clip.name));

  // transition marker (applied transition shows on export; badge here as a cue)
  if (clip.transition && clip.transition.name) {
    box.appendChild(el('div', { title: `Chuyển cảnh: ${clip.transition.name}`, style: {
      position: 'absolute', top: '2px', right: '2px', fontSize: '10px', lineHeight: '1',
      padding: '2px 4px', borderRadius: '4px', background: 'var(--brand)', color: '#fff',
      pointerEvents: 'none' } }, '⇄'));
  }

  // trim handles
  const lh = _handle('left'); const rh = _handle('right');
  box.appendChild(lh); box.appendChild(rh);

  box.addEventListener('pointerdown', (e) => {
    if (e.target === lh || e.target === rh) return;
    if (track.locked) { S.select(clip.id); return; }
    _startDrag(e, clip, px, 'move');
  });
  lh.addEventListener('pointerdown', (e) => { e.stopPropagation(); if (!track.locked) _startDrag(e, clip, px, 'left'); });
  rh.addEventListener('pointerdown', (e) => { e.stopPropagation(); if (!track.locked) _startDrag(e, clip, px, 'right'); });
  box.addEventListener('click', () => S.select(clip.id));
  return box;
}

function _handle(side) {
  return el('div', { 'data-handle': side, style: {
    position: 'absolute', top: '0', bottom: '0', [side]: '0', width: '8px',
    cursor: 'ew-resize', background: 'rgba(239,68,68,0.0)', zIndex: '5',
  } });
}

// ── drag / trim ───────────────────────────────────────────────────────
function _startDrag(e, clip, px, mode) {
  e.preventDefault();
  S.select(clip.id);
  const startX = e.clientX;
  const origStart = clip.start;
  const origIn = clip.in, origOut = clip.out, origDur = clip.duration;
  const origEnd = origStart + S.clipDur(clip);
  const move = (ev) => {
    const dxSec = (ev.clientX - startX) / px;
    if (mode === 'move') {
      const raw = Math.max(0, origStart + dxSec);
      const sn = _snapStart(raw, S.clipDur(clip), clip.id, ev.altKey);
      // which track lane is the cursor over? → drag the clip between layers
      let tid = clip.trackId;
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const laneEl = under && under.closest && under.closest('[data-track]');
      if (laneEl) {
        const t = S.project.tracks.find((tr) => tr.id === laneEl.getAttribute('data-track'));
        if (t && t.id !== clip.trackId && _acceptsClip(t.type, clip.kind)) tid = t.id;
      }
      if (tid !== clip.trackId) S.moveClipToTrack(clip.id, tid, sn.start);
      else S.moveClipTime(clip.id, sn.start);
      _showSnap(sn.guide);
    } else if (mode === 'left') {
      const sn = _snapEdge(origStart + dxSec, clip.id, ev.altKey);
      clip.in = origIn; clip.out = origOut; clip.duration = origDur; clip.start = origStart;
      S.trimClip(clip.id, 'left', sn.time - origStart);
      _showSnap(sn.guide);
    } else {
      const sn = _snapEdge(origEnd + dxSec, clip.id, ev.altKey);
      clip.in = origIn; clip.out = origOut; clip.duration = origDur;
      S.trimClip(clip.id, 'right', sn.time - origEnd);
      _showSnap(sn.guide);
    }
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    _showSnap(null);
    S.commit();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

// ── playhead / ruler ──────────────────────────────────────────────────
function _positionPlayhead() {
  if (!_playhead) return;
  _playhead.style.left = `${S.ui.currentTime * S.ui.zoom}px`;
}
// Grab the playhead head/body and drag it left/right to scrub.
function _startPlayheadDrag(e) {
  e.preventDefault(); e.stopPropagation();
  const seekTo = (clientX) => {
    const rect = _lanesWrap.getBoundingClientRect();
    S.setTime(Math.max(0, (clientX - rect.left) / S.ui.zoom));
  };
  seekTo(e.clientX);
  document.body.style.cursor = 'ew-resize';
  const move = (ev) => seekTo(ev.clientX);
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.body.style.cursor = '';
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}
function _onRulerSeek(e) {
  const rect = _ruler.getBoundingClientRect();
  const scroller = _ruler.parentElement.parentElement;
  const sl = scroller ? scroller.scrollLeft : 0;
  C.seek(Math.max(0, (e.clientX - rect.left) / S.ui.zoom));
  const move = (ev) => {
    S.setTime(Math.max(0, (ev.clientX - rect.left) / S.ui.zoom));
  };
  const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

// Which media kinds a track accepts on drop (video/image → video tracks;
// audio → audio tracks).
function _accepts(trackType, mediaType) {
  if (mediaType === 'audio') return trackType === 'audio';
  if (mediaType === 'video' || mediaType === 'image') return trackType === 'video';
  return false;
}
// Can an existing clip of `clipKind` live on a `trackType` track? (cross-track drag)
function _acceptsClip(trackType, clipKind) {
  if (clipKind === 'text') return trackType === 'text';
  if (clipKind === 'audio') return trackType === 'audio';
  return trackType === 'video';   // video/image → video tracks
}

function _addText(forceNewTrack) {
  let tt = forceNewTrack ? null : S.project.tracks.find((t) => t.type === 'text');
  if (!tt) tt = S.addTrack('text', null, true);   // chữ luôn ở lớp trên cùng
  // span the whole timeline: 0 → tổng độ dài các clip đang có (mép phải xa nhất)
  const dur = Math.max(S.projectDuration(), 5);
  const clip = S.makeClip('text', { text: 'Văn bản mới', duration: dur });
  clip.natW = Math.round(S.project.width * 0.6);
  clip.natH = Math.round(S.project.height * 0.18);
  S.addClip(clip, tt.id, 0);
  if (S.ui.currentTime >= dur) S.setTime(dur / 2);   // keep playhead inside so it shows
  toast('Đã thêm chữ — sửa nội dung & kiểu ở bảng Thuộc tính bên phải', 'success', 3000);
}

function _splitSelected() {
  if (!S.ui.selectedClipId) { toast('Chọn 1 clip để cắt', 'warning'); return; }
  S.splitClip(S.ui.selectedClipId, S.ui.currentTime);
}
function _deleteSelected() {
  if (!S.ui.selectedClipId) { toast('Chọn 1 clip để xóa', 'warning'); return; }
  S.removeClip(S.ui.selectedClipId);
}

function _fmt(s) {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}
// Ruler tick label — shows one decimal when the step is sub-second (e.g. 0:05.5).
function _fmtTick(s, step) {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (step < 1) return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
  return `${m}:${String(Math.floor(sec)).padStart(2, '0')}`;
}

// ── magnetic snapping ─────────────────────────────────────────────────
// Candidate snap times: 0, the playhead, and every OTHER clip's start + end.
function _snapEdges(draggedId) {
  const arr = [0, S.ui.currentTime];
  for (const t of S.project.tracks) {
    for (const c of t.clips) {
      if (c.id === draggedId) continue;
      arr.push(c.start, c.start + S.clipDur(c));
    }
  }
  return arr;
}
// Snap a moving clip (both its start AND end edges) to the nearest candidate.
function _snapStart(rawStart, dur, draggedId, altKey) {
  if (altKey) return { start: rawStart, guide: null };       // Alt = free placement
  let best = SNAP_PX / S.ui.zoom, start = rawStart, guide = null;
  for (const c of _snapEdges(draggedId)) {
    const dS = Math.abs(rawStart - c);
    if (dS < best) { best = dS; start = c; guide = c; }
    const dE = Math.abs((rawStart + dur) - c);
    if (dE < best) { best = dE; start = c - dur; guide = c; }
  }
  return { start: Math.max(0, start), guide };
}
// Snap a single edge (used while trimming) to the nearest candidate.
function _snapEdge(rawTime, draggedId, altKey) {
  if (altKey) return { time: rawTime, guide: null };
  let best = SNAP_PX / S.ui.zoom, time = rawTime, guide = null;
  for (const c of _snapEdges(draggedId)) {
    const d = Math.abs(rawTime - c);
    if (d < best) { best = d; time = c; guide = c; }
  }
  return { time, guide };
}
function _showSnap(guide) {
  if (!_snapGuide) return;
  if (guide == null) { _snapGuide.style.display = 'none'; return; }
  _snapGuide.style.left = `${guide * S.ui.zoom}px`;
  _snapGuide.style.display = 'block';
}

// ── wheel zoom (anchored at cursor) ───────────────────────────────────
function _onWheel(e) {
  // Alt+wheel = pan the viewed portion horizontally (like CapCut PC).
  // Ctrl/Cmd+wheel = zoom (anchored on the playhead). Plain wheel = scroll the
  // layer list vertically (native).
  if (e.altKey && !(e.ctrlKey || e.metaKey)) {
    _scroller.scrollLeft += (e.deltaY || e.deltaX);
    e.preventDefault();
    return;
  }
  if (!(e.ctrlKey || e.metaKey)) return;  // plain wheel → native vertical scroll
  e.preventDefault();                     // stop the browser's Ctrl+wheel page zoom
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const base = _zoomPending != null ? _zoomPending : S.ui.zoom;
  _zoomPending = Math.max(8, Math.min(1000, base * factor));   // compound rapid notches
  if (_zoomRaf) return;
  _zoomRaf = requestAnimationFrame(() => {
    _zoomRaf = 0;
    const z = _zoomPending; _zoomPending = null;
    if (z == null) return;
    const oz = S.ui.zoom;
    const tPh = S.ui.currentTime;         // keep the playhead pinned on screen
    const sl = _scroller.scrollLeft;
    S.setZoom(z);                         // clamps + emit('change') → _rebuild()
    _scroller.scrollLeft = Math.max(0, sl + tPh * (S.ui.zoom - oz));
  });
}
