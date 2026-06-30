// Trình dựng video (Part B) — full editor, faithful to the original layout
// (header · left tab-strip + asset panels · center Fabric.js artboard · right
// properties inspector · bottom multi-track timeline), re-skinned to our design
// system. Media = the user's own library (Flow/Shakker + uploads); render = our
// FFmpeg backend through the normal task queue.
import { el, clear, toast, icon, modal, confirm, setLoading, openMediaViewer, makeLazyVideoObserver } from '../ui.js';
import { api } from '../api.js';
import { ws } from '../ws.js';
import * as S from './video_editor/state.js';
import * as C from './video_editor/canvas.js';
import * as T from './video_editor/timeline.js';

const RES_OPTIONS = [
  { value: '1920x1080', label: 'Ngang 16:9 · 1920×1080' },
  { value: '1080x1920', label: 'Dọc 9:16 · 1080×1920' },
  { value: '1280x720', label: 'Ngang 16:9 · 1280×720' },
  { value: '720x1280', label: 'Dọc 9:16 · 720×1280' },
  { value: '1080x1080', label: 'Vuông 1:1 · 1080×1080' },
];

const LEFT_TABS = [
  { id: 'folder', label: 'Của tôi', icon: 'folder', kind: 'all' },
  { id: 'video', label: 'Video', icon: 'movie', kind: 'video' },
  { id: 'image', label: 'Hình ảnh', icon: 'image', kind: 'image' },
  { id: 'audio', label: 'Audio', icon: 'play', kind: 'audio' },
  { id: 'transition', label: 'Chuyển cảnh', icon: 'copy' },
  { id: 'effect', label: 'Hiệu ứng', icon: 'sparkles' },
  { id: 'ai', label: 'Video AI', icon: 'wand' },
];

let _root = null;
let _activeTab = 'folder';
let _mediaCache = {};        // kind -> media[]
let _renderTaskId = null;
const _aiTasks = new Map();  // Video AI gen task_id -> { kind, total, done, error, status }
let _localFonts = null;      // installed fonts loaded via the Local Font Access API
const _COMMON_FONTS = ['Inter', 'Arial', 'Arial Black', 'Calibri', 'Cambria', 'Candara',
  'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New', 'Georgia', 'Impact',
  'Lucida Console', 'Lucida Sans Unicode', 'Microsoft Sans Serif', 'Palatino Linotype',
  'Segoe UI', 'Segoe Print', 'Segoe Script', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'];
let _keyBound = false;
let _mediaObserver = null;   // lazy-loads library videos on scroll
const E = {};                // element refs

// ── dedicated workspace (own fixed overlay layer) ─────────────────────
// The editor renders in its OWN full-viewport overlay appended to <body>, so
// it never touches the app's grid / sidebar / #page-container (which caused
// layout corruption when toggled). It simply covers the app chrome. Toasts +
// modals are raised above it so they still work inside the editor.
function _ensureTopLayerZ() {
  if (document.getElementById('ve-topz')) return;
  const s = document.createElement('style');
  s.id = 've-topz';
  s.textContent = '#toast-stack{z-index:2600 !important;} #modal-root .modal-backdrop{z-index:2400 !important;}';
  document.head.appendChild(s);
}
function _removeOverlay() {
  const o = document.getElementById('ve-overlay');
  if (o) o.remove();
  E.overlay = null;
}

// Scoped polish for the editor only (pro-NLE dark surfaces, branded range
// sliders, tactile buttons/cards, a checkerboard stage). Injected once.
function _ensureEditorStyles() {
  if (document.getElementById('ve-styles')) return;
  const s = document.createElement('style');
  s.id = 've-styles';
  s.textContent = `
#ve-overlay{ -webkit-font-smoothing:antialiased; }
/* uppercase section labels for a cleaner hierarchy */
#ve-overlay .field-label{ text-transform:uppercase; letter-spacing:.05em; font-size:11px; font-weight:600; color:var(--text-muted); }
/* tactile buttons */
#ve-overlay .btn{ transition:background .15s,border-color .15s,color .15s,transform .06s,box-shadow .15s; }
#ve-overlay .btn:hover{ border-color:var(--border-strong); }
#ve-overlay .btn:active{ transform:translateY(1px); }
#ve-overlay .btn-primary{ box-shadow:var(--sh-red); }
#ve-overlay .btn-primary:hover{ filter:brightness(1.06); }
/* branded, consistent range sliders */
#ve-overlay input[type=range]{ -webkit-appearance:none; appearance:none; height:5px; border-radius:999px; background:var(--border-strong); cursor:pointer; }
#ve-overlay input[type=range]:hover{ background:var(--text-faint); }
#ve-overlay input[type=range]::-webkit-slider-thumb{ -webkit-appearance:none; width:15px; height:15px; border-radius:50%; background:var(--brand); border:2px solid #fff; box-shadow:0 1px 4px rgba(0,0,0,.45); transition:transform .1s; }
#ve-overlay input[type=range]::-webkit-slider-thumb:hover{ transform:scale(1.22); }
#ve-overlay input[type=range]::-webkit-slider-thumb:active{ transform:scale(1.05); }
#ve-overlay input[type=range]::-moz-range-thumb{ width:15px; height:15px; border:2px solid #fff; border-radius:50%; background:var(--brand); box-shadow:0 1px 4px rgba(0,0,0,.45); }
/* compact volume slider in timeline track headers (smaller thumb) */
#ve-overlay .ve-vol{ height:4px; }
#ve-overlay .ve-vol::-webkit-slider-thumb{ width:12px; height:12px; }
#ve-overlay .ve-vol::-moz-range-thumb{ width:12px; height:12px; }
/* focus rings on inputs/selects */
#ve-overlay input[type=number]:focus, #ve-overlay input.input:focus, #ve-overlay select:focus{ border-color:var(--brand); box-shadow:0 0 0 3px var(--brand-soft); outline:none; }
/* media cards lift on hover */
#ve-overlay .card{ transition:transform .12s, box-shadow .15s, border-color .15s; }
#ve-overlay .card[draggable=true]:hover{ transform:translateY(-2px); box-shadow:var(--sh-md); border-color:var(--border-strong); }
/* left tab strip */
#ve-overlay .ve-tab{ position:relative; transition:background .15s,color .15s; }
#ve-overlay .ve-tab:hover{ background:var(--bg-3); color:var(--text-2); }
#ve-overlay .ve-tab--on::before{ content:''; position:absolute; left:0; top:7px; bottom:7px; width:3px; border-radius:0 3px 3px 0; background:var(--brand); }
/* slimmer panel scrollbars */
#ve-overlay ::-webkit-scrollbar{ width:8px; height:8px; }
/* checkerboard "stage" behind the canvas (visible in the letterbox margins) */
#ve-overlay .ve-stage{
  background-color:#0b0c0f;
  background-image:
    linear-gradient(45deg, rgba(255,255,255,.025) 25%, transparent 25%, transparent 75%, rgba(255,255,255,.025) 75%),
    linear-gradient(45deg, rgba(255,255,255,.025) 25%, transparent 25%, transparent 75%, rgba(255,255,255,.025) 75%);
  background-size:24px 24px; background-position:0 0, 12px 12px;
}
`;
  document.head.appendChild(s);
}
function _exitFullscreen() {
  C.pause();
  C.disposeCanvas();
  if (_mediaObserver) { _mediaObserver.disconnect(); _mediaObserver = null; }
  _removeOverlay();
  document.body.style.overflow = '';
  if (window.__app && window.__app.navigate) window.__app.navigate('content');
}

// ── resizable panels (drag the dividers, Premiere-style) ──────────────
const _clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function _getSize(key, def) {
  const v = parseFloat(localStorage.getItem('ve_' + key));
  return (v && v > 40) ? v : def;
}
function _setSize(key, v) { try { localStorage.setItem('ve_' + key, String(Math.round(v))); } catch (_) {} }

function _attachDrag(handle, axis, onDrag) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    let last = axis === 'x' ? e.clientX : e.clientY;
    const move = (ev) => {
      const cur = axis === 'x' ? ev.clientX : ev.clientY;
      onDrag(cur - last); last = cur;
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none';
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });
}
function _resizer(axis, onDrag) {
  const vertical = axis === 'x';
  const line = el('div', { style: { position: 'absolute', background: 'var(--border)',
    ...(vertical ? { top: '0', bottom: '0', left: '50%', width: '1px' } : { left: '0', right: '0', top: '50%', height: '1px' }) } });
  const h = el('div', { style: {
    flex: '0 0 auto', position: 'relative', zIndex: '6',
    cursor: vertical ? 'col-resize' : 'row-resize',
    ...(vertical ? { width: '7px' } : { height: '7px' }),
  } }, line);
  h.addEventListener('mouseenter', () => { line.style.background = 'var(--brand)'; line.style[vertical ? 'width' : 'height'] = '2px'; });
  h.addEventListener('mouseleave', () => { line.style.background = 'var(--border)'; line.style[vertical ? 'width' : 'height'] = '1px'; });
  _attachDrag(h, axis, onDrag);
  return h;
}

export async function renderVideoEditor(root) {
  _root = root;
  S.offAll();
  C.disposeCanvas();
  clear(root);
  _removeOverlay();
  _ensureTopLayerZ();
  _ensureEditorStyles();

  const LPW = _getSize('lpw', 280), RPW = _getSize('rpw', 270), TLH = _getSize('tlh', 250);
  E.stripEl = _leftStrip();
  E.leftPanel = el('div', { style: { width: LPW + 'px', flex: '0 0 auto', borderRight: '1px solid var(--border)',
    background: 'var(--surface)', overflow: 'auto', minWidth: '0' } });
  E.artboard = _artboard();
  E.inspector = el('div', { style: { width: RPW + 'px', flex: '0 0 auto', borderLeft: '1px solid var(--border)',
    background: 'var(--surface)', overflow: 'auto', minWidth: '0' } });
  E.timeline = el('div', { style: { flex: '0 0 auto', height: TLH + 'px', minHeight: '0',
    display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--border)', background: 'var(--surface)' } });

  const resL = _resizer('x', (dx) => {
    const w = _clamp((parseFloat(E.leftPanel.style.width) || LPW) + dx, 190, 600);
    E.leftPanel.style.width = w + 'px'; _setSize('lpw', w); C.fitView();
  });
  const resR = _resizer('x', (dx) => {
    const w = _clamp((parseFloat(E.inspector.style.width) || RPW) - dx, 200, 600);
    E.inspector.style.width = w + 'px'; _setSize('rpw', w); C.fitView();
  });
  const resT = _resizer('y', (dy) => {
    const h = _clamp((parseFloat(E.timeline.style.height) || TLH) - dy, 120, 700);
    E.timeline.style.height = h + 'px'; _setSize('tlh', h); C.fitView();
  });

  const body = el('div', { style: { display: 'flex', alignItems: 'stretch', flex: '1', minHeight: '0' } },
    E.stripEl, E.leftPanel, resL, E.artboard, resR, E.inspector);

  // Own full-viewport layer over the app chrome (does NOT touch #app grid).
  E.overlay = el('div', { id: 've-overlay', 'data-theme': 'dark', style: { position: 'fixed', inset: '0', zIndex: '1200',
    background: 'var(--bg-0)', display: 'flex', flexDirection: 'column' } },
    _header(), _exportProgress(),
    el('div', { style: { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' } }, body, resT, E.timeline));
  document.body.appendChild(E.overlay);
  document.body.style.overflow = 'hidden';

  // wire subscriptions that drive header/inspector
  S.on('history', _refreshHistoryButtons);
  S.on('selection', _renderInspector);
  S.on('change', _onChangeLight);
  S.on('time', _updateTimeDisplay);
  S.on('playstate', _updatePlayButton);
  S.on('dropmedia', (d) => { if (d && d.media) _addMedia(d.media, d.trackId, d.start); });
  S.on('selection', () => { if (_activeTab === 'effect' || _activeTab === 'transition') _renderLeft(); });

  T.renderTimeline(E.timeline);
  _renderLeft();
  _renderInspector();
  _refreshHistoryButtons();

  // canvas needs the artboard sized → init after layout settles
  requestAnimationFrame(async () => {
    try {
      await C.initCanvas(E.canvasEl, E.canvasWrap);
    } catch (e) {
      E.canvasWrap.appendChild(el('div', { class: 'card' }, `Không khởi tạo được canvas: ${e.message}`));
    }
    _updateTimeDisplay();
  });

  if (!_keyBound) { document.addEventListener('keydown', _onKey); _keyBound = true; }
  window.addEventListener('resize', _onResize);
}

function _editorActive() { return !!document.getElementById('ve-overlay'); }
function _onResize() { if (_editorActive()) C.fitView(); }

function _onKey(e) {
  if (!_editorActive()) return;
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
  if (e.code === 'Space') { e.preventDefault(); C.togglePlay(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? S.redo() : S.undo(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); S.redo(); }
  else if (e.key === 'Delete' && S.ui.selectedClipId) { S.removeClip(S.ui.selectedClipId); }
}

// ── header ────────────────────────────────────────────────────────────
function _header() {
  E.nameInput = el('input', { class: 'input', value: S.project.name,
    style: { width: '180px', height: '30px' },
    oninput: () => { S.project.name = E.nameInput.value; } });
  E.undoBtn = el('button', { class: 'btn btn-sm', title: 'Hoàn tác (Ctrl+Z)', onclick: () => S.undo() }, '↶');
  E.redoBtn = el('button', { class: 'btn btn-sm', title: 'Làm lại (Ctrl+Y)', onclick: () => S.redo() }, '↷');
  E.exportBtn = el('button', { class: 'btn btn-primary btn-sm', onclick: (e) => _doExport(e.currentTarget) },
    icon('movie', 15), ' Xuất bản');

  return el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px',
    background: 'var(--surface)', borderBottom: '1px solid var(--border)' } },
    el('button', { class: 'btn btn-sm', title: 'Quay lại tool', onclick: _exitFullscreen,
      style: { flex: '0 0 auto' } }, '← Quay lại'),
    el('span', { style: { width: '1px', height: '20px', background: 'var(--border)' } }),
    E.nameInput,
    el('span', { style: { width: '1px', height: '20px', background: 'var(--border)' } }),
    E.undoBtn, E.redoBtn,
    el('div', { style: { flex: '1' } }),
    el('button', { class: 'btn btn-sm', onclick: _openProjects }, icon('folder', 15), ' Mở'),
    el('button', { class: 'btn btn-sm', onclick: _newProject }, icon('plus', 15), ' Mới'),
    el('button', { class: 'btn btn-sm', onclick: (e) => _doSave(e.currentTarget) }, icon('download', 15), ' Lưu'),
    E.exportBtn,
  );
}
function _refreshHistoryButtons() {
  if (E.undoBtn) E.undoBtn.disabled = !S.canUndo();
  if (E.redoBtn) E.redoBtn.disabled = !S.canRedo();
}

function _exportProgress() {
  E.expBar = el('div', { class: 'progress-bar', style: { width: '0%' } });
  E.expMsg = el('span', { class: 'field-help' }, '');
  E.expWrap = el('div', { style: { display: 'none', padding: '8px 12px', borderBottom: '1px solid var(--border)',
    background: 'var(--surface)', gap: '8px', alignItems: 'center' } },
    el('div', { style: { flex: '1' } }, el('div', { class: 'progress' }, E.expBar)),
    E.expMsg);
  return E.expWrap;
}
function _setExport(pct, msg, show) {
  if (!E.expWrap) return;
  E.expWrap.style.display = show ? 'flex' : 'none';
  E.expBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  E.expMsg.textContent = msg || '';
}

// ── left tab strip ────────────────────────────────────────────────────
function _leftStrip() {
  return el('div', { style: { width: '64px', flex: '0 0 auto', background: 'var(--surface-alt)',
    borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: '2px', padding: '6px 4px' } },
    ...LEFT_TABS.map((t) => {
      const on = _activeTab === t.id;
      return el('button', {
        title: t.label, class: on ? 've-tab ve-tab--on' : 've-tab',
        style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px', padding: '8px 0',
          border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '10px', fontWeight: on ? '600' : '500',
          background: on ? 'var(--brand-soft)' : 'transparent',
          color: on ? 'var(--brand)' : 'var(--text-muted)' },
        onclick: () => { _activeTab = t.id; _refreshStrip(); _renderLeft(); },
      }, icon(t.icon, 18), t.label);
    }),
  );
}
function _refreshStrip() {
  const old = E.stripEl;
  const fresh = _leftStrip();
  E.stripEl = fresh;
  if (old && old.parentNode) old.parentNode.replaceChild(fresh, old);
}

// ── left panels ───────────────────────────────────────────────────────
function _renderLeft() {
  if (!E.leftPanel) return;
  clear(E.leftPanel);
  const tab = LEFT_TABS.find((t) => t.id === _activeTab);
  E.leftPanel.appendChild(el('div', { style: { padding: '12px 12px 8px', fontWeight: '600',
    borderBottom: '1px solid var(--border)' } }, tab.label));
  const body = el('div', { style: { padding: '12px' } });
  E.leftPanel.appendChild(body);
  if (['folder', 'video', 'image', 'audio'].includes(_activeTab)) _renderMediaPanel(body, tab.kind);
  else if (_activeTab === 'transition') _renderTransitionPanel(body);
  else if (_activeTab === 'effect') _renderEffectPanel(body);
  else if (_activeTab === 'ai') _renderAIPanel(body);
}

async function _renderMediaPanel(body, kind) {
  const search = el('input', { class: 'input', placeholder: 'Tìm…', style: { width: '100%', marginBottom: '8px' } });
  const tools = el('div', { style: { display: 'flex', gap: '6px', marginBottom: '10px' } },
    el('button', { class: 'btn btn-sm btn-primary', style: { flex: '1' }, onclick: () => _doUpload(kind) }, icon('upload', 14), ' Tải lên'),
    el('button', { class: 'btn btn-sm', onclick: () => _loadMedia(kind, grid, true) }, icon('refresh', 14)),
  );
  const grid = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } });
  body.appendChild(search); body.appendChild(tools); body.appendChild(grid);
  search.addEventListener('input', () => _fillMediaGrid(grid, kind, search.value.trim().toLowerCase()));
  await _loadMedia(kind, grid, false);
}

async function _loadMedia(kind, grid, force) {
  clear(grid); grid.appendChild(el('div', { class: 'field-help' }, 'Đang tải…'));
  if (force || !_mediaCache[kind]) {
    try { const r = await api.videoEditor.myMedia(kind); _mediaCache[kind] = r.media || []; }
    catch (e) { _mediaCache[kind] = []; toast(`Lỗi tải thư viện: ${e.message}`, 'error'); }
  }
  _fillMediaGrid(grid, kind, '');
}
function _fillMediaGrid(grid, kind, q) {
  clear(grid);
  if (_mediaObserver) { _mediaObserver.disconnect(); _mediaObserver = null; }
  let list = _mediaCache[kind] || [];
  if (q) list = list.filter((m) => (m.name || '').toLowerCase().includes(q));
  if (!list.length) { grid.appendChild(el('div', { class: 'field-help' }, 'Trống.')); return; }
  for (const m of list.slice(0, 200)) grid.appendChild(_mediaCard(m));
  // Only fetch metadata for videos as they scroll into view → no freeze when
  // the library has many videos.
  _mediaObserver = makeLazyVideoObserver(E.leftPanel, { rootMargin: '200px' });
  grid.querySelectorAll('video[data-src]').forEach((v) => _mediaObserver.observe(v));
}
function _mediaCard(m) {
  const thumb = m.type === 'audio'
    ? el('div', { style: { height: '64px', borderRadius: '6px', background: 'var(--accent-amber-soft)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent-amber)' } }, icon('play', 18))
    : m.type === 'video'
      ? el('video', { 'data-src': m.url, muted: true, preload: 'none', draggable: 'false',
          style: { width: '100%', height: '64px', objectFit: 'cover', borderRadius: '6px', background: '#000', cursor: 'pointer' },
          onclick: () => openMediaViewer({ url: m.url, type: 'video', label: m.name }) })
      : el('img', { src: m.url, loading: 'lazy', draggable: 'false',
          style: { width: '100%', height: '64px', objectFit: 'cover', borderRadius: '6px', background: 'var(--surface-alt)', cursor: 'pointer' },
          onclick: () => openMediaViewer({ url: m.url, type: 'image', label: m.name }) });
  return el('div', {
    class: 'card', draggable: 'true', title: 'Kéo thả xuống một tầng để thêm vào tầng đó',
    style: { padding: '6px', display: 'flex', flexDirection: 'column', gap: '5px', minWidth: '0', cursor: 'grab' },
    ondragstart: (e) => {
      S.setDrag(m);
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'copy'; try { e.dataTransfer.setData('text/plain', m.name); } catch (_) {} }
    },
    ondragend: () => S.clearDrag(),
  },
    thumb,
    el('div', { title: m.name, style: { fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: '0' } }, m.name),
    el('button', { class: 'btn btn-sm btn-primary', onclick: () => _addMedia(m) }, '+ Thêm'),
  );
}

function _mediaMeta(url, type) {
  return new Promise((resolve) => {
    if (type === 'image') {
      const i = new Image();
      i.onload = () => resolve({ duration: 0, w: i.naturalWidth, h: i.naturalHeight });
      i.onerror = () => resolve({ duration: 0, w: 0, h: 0 });
      i.src = url;
    } else {
      const v = document.createElement(type === 'audio' ? 'audio' : 'video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => resolve({ duration: v.duration || 0, w: v.videoWidth || 0, h: v.videoHeight || 0 });
      v.onerror = () => resolve({ duration: 0, w: 0, h: 0 });
      v.src = url;
    }
  });
}
async function _addMedia(m, trackId, startAt) {
  const meta = await _mediaMeta(m.url, m.type);
  const clip = S.makeClip(m.type, {
    name: m.name, url: m.url, path: m.path,
    srcDuration: meta.duration, natW: meta.w || undefined, natH: meta.h || undefined,
  });
  S.addClip(clip, trackId, startAt);
  toast(`Đã thêm "${m.name}"`, 'success', 1300);
}

function _doUpload(kind) {
  const accept = kind === 'audio' ? 'audio/*' : kind === 'image' ? 'image/*' : kind === 'video' ? 'video/*' : 'video/*,image/*,audio/*';
  const inp = el('input', { type: 'file', accept, style: { display: 'none' } });
  inp.addEventListener('change', async () => {
    const file = inp.files && inp.files[0];
    if (!file) return;
    const t = toast('Đang tải lên…', 'info', 0);
    try {
      const m = await api.videoEditor.upload(file);
      t.remove(); toast('Đã tải lên', 'success', 1200);
      _mediaCache[m.type] = [m, ...(_mediaCache[m.type] || [])];
      _mediaCache.all = [m, ...(_mediaCache.all || [])];
      await _addMedia(m);
      _renderLeft();
    } catch (e) { t.remove(); toast(`Tải lên thất bại: ${e.message}`, 'error'); }
  });
  document.body.appendChild(inp); inp.click(); setTimeout(() => inp.remove(), 1000);
}

// label -> ffmpeg xfade name (== VideoTransitionType in the original backend).
// Only types the preview renders faithfully are offered, so what you pick is
// what you see in BOTH preview and the exported file.
const TRANSITIONS = [
  { label: 'Mờ dần', xf: 'fade' }, { label: 'Tan biến', xf: 'dissolve' },
  { label: 'Mờ qua đen', xf: 'fadeblack' },
  { label: 'Gạt trái', xf: 'wipeleft' }, { label: 'Gạt phải', xf: 'wiperight' },
  { label: 'Gạt lên', xf: 'wipeup' }, { label: 'Gạt xuống', xf: 'wipedown' },
  { label: 'Gạt mượt trái', xf: 'smoothleft' }, { label: 'Gạt mượt phải', xf: 'smoothright' },
  { label: 'Trượt trái', xf: 'slideleft' }, { label: 'Trượt phải', xf: 'slideright' },
  { label: 'Trượt lên', xf: 'slideup' }, { label: 'Trượt xuống', xf: 'slidedown' },
  { label: 'Mở tròn', xf: 'circleopen' }, { label: 'Cắt tròn', xf: 'circlecrop' },
  { label: 'Chéo ↘', xf: 'diagtl' }, { label: 'Chéo ↙', xf: 'diagtr' },
  { label: 'Chéo ↗', xf: 'diagbl' }, { label: 'Chéo ↖', xf: 'diagbr' },
];
function _renderTransitionPanel(body) {
  const sel = S.selectedClip();
  body.appendChild(el('div', { class: 'field-help', style: { marginBottom: '10px' } },
    'Chọn clip (cần có clip liền trước trên cùng tầng) rồi chọn hiệu ứng. Khi Xuất sẽ render đúng kiểu (xfade); preview hiển thị gần đúng (hòa tan).'));
  const cur = ((sel || {}).transition || {}).xf;
  const curDur = ((sel || {}).transition || {}).duration || 0.5;
  body.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' } },
    el('span', { style: { fontSize: '12px', color: 'var(--text)' } }, 'Thời lượng (giây)'),
    el('input', {
      class: 'input', type: 'number', min: '0.1', max: '5', step: '0.1', value: String(curDur),
      style: { width: '70px', height: '28px', padding: '0 8px', fontSize: '13px', textAlign: 'center',
        background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)',
        borderRadius: 'var(--r-sm)' },
      oninput: (e) => {
        const c = S.selectedClip();
        if (c && c.transition) {
          const d = Math.max(0.1, Math.min(5, parseFloat(e.target.value) || 0.5));
          S.updateClip(c.id, { transition: { ...c.transition, duration: d } }); S.commit();
        }
      },
    })));
  const grid = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } },
    ...TRANSITIONS.map((tr) => el('button', {
      class: 'card', style: { padding: '12px 6px', cursor: 'pointer', textAlign: 'center', fontSize: '12px',
        border: tr.xf === cur ? '2px solid var(--brand)' : '1px solid var(--border)',
        color: tr.xf === cur ? 'var(--brand)' : 'var(--text)' },
      onclick: () => _applyTransition(tr) }, tr.label)));
  body.appendChild(grid);
  body.appendChild(el('button', { class: 'btn btn-sm', style: { marginTop: '10px' }, onclick: () => {
    const c = S.selectedClip(); if (!c) return;
    S.updateClip(c.id, { transition: null }); S.commit(); _renderLeft();
  } }, 'Bỏ chuyển cảnh'));
}
function _applyTransition(tr) {
  const c = S.selectedClip();
  if (!c) { toast('Chọn 1 clip trước', 'warning'); return; }
  const dur = (c.transition && c.transition.duration) || 0.5;
  S.updateClip(c.id, { transition: { name: tr.label, xf: tr.xf, duration: dur } });
  S.commit();
  _renderLeft();
  toast(`Đã gán "${tr.label}"`, 'success', 1200);
}

const EFFECTS = ['Không', 'Ấm áp', 'Lạnh', 'Hoàng hôn', 'Ánh trăng', 'Đen trắng', 'Cổ điển'];
function _renderEffectPanel(body) {
  const sel = S.selectedClip();
  body.appendChild(el('div', { class: 'field-help', style: { marginBottom: '10px' } },
    sel ? `Bộ lọc màu cho clip đang chọn (${sel.name || 'clip'}).` : 'Chọn 1 clip ảnh/video trước.'));
  const cur = (sel || {}).effect || (sel ? 'Không' : null);
  const grid = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } },
    ...EFFECTS.map((name) => el('button', {
      class: 'card', style: { padding: '12px 6px', cursor: 'pointer', textAlign: 'center', fontSize: '12px',
        border: name === cur ? '2px solid var(--brand)' : '1px solid var(--border)',
        color: name === cur ? 'var(--brand)' : 'var(--text)' },
      onclick: () => _applyEffect(name) }, name)));
  body.appendChild(grid);
}
function _applyEffect(name) {
  const c = S.selectedClip();
  if (!c || (c.kind !== 'video' && c.kind !== 'image')) { toast('Chọn 1 clip ảnh/video', 'warning'); return; }
  const presets = {
    'Không': {}, 'Ấm áp': { temperature: 25, saturation: 10 }, 'Lạnh': { temperature: -25, saturation: 5 },
    'Hoàng hôn': { temperature: 35, contrast: 10, saturation: 15 }, 'Ánh trăng': { temperature: -30, brightness: -5, contrast: 8 },
    'Đen trắng': { saturation: -100 }, 'Cổ điển': { saturation: -20, contrast: 12, brightness: 4 },
  };
  c.color = { ...S.defaultColor(), ...(presets[name] || {}) };
  c.effect = name;
  S.commit();
  _renderInspector();
  _renderLeft();
  toast(`Đã áp "${name}"`, 'success', 1200);
}

function _renderAIPanel(body) {
  const prompt = el('textarea', { class: 'textarea', rows: '4', placeholder: 'Mô tả nội dung muốn tạo…',
    style: { width: '100%', marginBottom: '8px' } });
  body.appendChild(el('div', { class: 'field-help', style: { marginBottom: '8px' } },
    'Tạo media mới bằng bộ tạo của tool (Flow). Kết quả xuất hiện ở tab "Của tôi".'));
  body.appendChild(prompt);
  body.appendChild(el('div', { style: { display: 'flex', gap: '8px' } },
    el('button', { class: 'btn btn-sm btn-primary', style: { flex: '1' }, onclick: () => _aiGen('image', prompt.value) }, 'Tạo ảnh'),
    el('button', { class: 'btn btn-sm btn-primary', style: { flex: '1' }, onclick: () => _aiGen('video', prompt.value) }, 'Tạo video'),
  ));

  // ── trạng thái các lần tạo (progress + báo khi xong) ──
  const entries = [..._aiTasks.entries()];
  if (entries.length) {
    const wrap = el('div', { style: { marginTop: '14px', display: 'flex', flexDirection: 'column', gap: '8px' } });
    wrap.appendChild(el('div', { class: 'field-label', style: { marginBottom: '2px' } }, 'Đang tạo'));
    for (const [, t] of entries) {
      const done = t.status === 'completed';
      const err = t.status === 'error';
      const pct = done ? 100 : Math.round((t.done / Math.max(1, t.total)) * 100);
      const color = err ? 'var(--red)' : done ? 'var(--green)' : 'var(--brand)';
      const label = done ? 'Hoàn tất ✓' : err ? 'Lỗi' : `Đang tạo… ${t.done}/${t.total}`;
      wrap.appendChild(el('div', { class: 'card', style: { padding: '8px' } },
        el('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '12px', marginBottom: '6px' } },
          el('span', { style: { fontWeight: '600' } }, t.kind === 'image' ? 'Tạo ảnh' : 'Tạo video'),
          el('span', { style: { color } }, label)),
        el('div', { style: { height: '6px', borderRadius: '999px', background: 'var(--bg-3)', overflow: 'hidden' } },
          el('div', { style: { height: '100%', width: `${pct}%`, background: color, transition: 'width 0.3s' } }))));
    }
    if (entries.some(([, t]) => t.status === 'completed' || t.status === 'error')) {
      wrap.appendChild(el('button', { class: 'btn btn-sm', style: { marginTop: '2px' }, onclick: () => {
        for (const [id, t] of [..._aiTasks]) if (t.status !== 'running') _aiTasks.delete(id);
        _renderLeft();
      } }, 'Xóa mục đã xong'));
    }
    body.appendChild(wrap);
  }
}
async function _aiGen(kind, text) {
  text = (text || '').trim();
  if (!text) { toast('Nhập mô tả trước', 'warning'); return; }
  try {
    const res = kind === 'image'
      ? await api.image.start({ prompts: [text], count_per_prompt: 1 })
      : await api.content.start({ prompts: [text], mode: 't2v' });
    const id = res && res.task_id;
    if (id) {
      _aiTasks.set(id, { kind, total: 1, done: 0, error: 0, status: 'running' });
      if (_activeTab === 'ai') _renderLeft();
    }
    toast('Đã gửi yêu cầu tạo — sẽ báo khi xong', 'success', 4000);
  } catch (e) { toast(`Không tạo được: ${e.message}`, 'error'); }
}
// Update a tracked Video-AI task from a WS event + refresh the panel/notify.
function _aiTaskUpdate(d, status) {
  if (!d || !d.task_id) return;
  const t = _aiTasks.get(d.task_id);
  if (!t) return;
  if (typeof d.done === 'number') t.done = d.done;
  if (typeof d.error === 'number') t.error = d.error;
  if (typeof d.total === 'number') t.total = d.total;
  if (status) t.status = status;
  if (status === 'completed') {
    delete _mediaCache[t.kind]; delete _mediaCache.all;   // mới tạo → tải lại "Của tôi"
    toast(`Tạo ${t.kind === 'image' ? 'ảnh' : 'video'} xong ✓ — mở tab "Của tôi" để dùng`, 'success', 7000);
  } else if (status === 'error') {
    toast(`Tạo ${t.kind === 'image' ? 'ảnh' : 'video'} lỗi: ${d.error || ''}`, 'error', 8000);
  }
  if (_activeTab === 'ai' && E.leftPanel) _renderLeft();
}

// ── center artboard ───────────────────────────────────────────────────
function _artboard() {
  const resSel = el('select', { style: { height: '30px', width: '240px', flex: '0 0 auto',
    background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)',
    borderRadius: 'var(--r-sm)', padding: '0 10px', fontSize: '13px', cursor: 'pointer' },
    onchange: (e) => {
      const [w, h] = e.target.value.split('x').map(Number);
      S.project.width = w; S.project.height = h; S.commit(); C.fitView();
    } },
    ...RES_OPTIONS.map((o) => el('option', { value: o.value, selected: o.value === `${S.project.width}x${S.project.height}` }, o.label)));

  const top = el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 10px',
    borderBottom: '1px solid var(--border)' } },
    resSel,
    el('div', { style: { flex: '1' } }),
    el('button', { class: 'btn btn-sm', style: { whiteSpace: 'nowrap', flex: '0 0 auto' }, title: 'Khớp clip đang chọn vừa khung hình', onclick: () => {
      const c = S.selectedClip();
      if (c && c.kind !== 'audio') {
        S.centerOnCanvas(c);
        S.updateClip(c.id, { left: c.left, top: c.top, scaleX: c.scaleX, scaleY: c.scaleY });
        S.commit(); _renderInspector(); C.fitView();
        toast('Đã khớp clip vào khung hình', 'success', 1200);
      } else {
        C.fitView();
        toast('Chọn 1 clip (ảnh/video) để khớp vào khung', 'info', 1800);
      }
    } }, 'Khớp khung'));

  E.canvasEl = el('canvas');
  E.canvasWrap = el('div', { class: 've-stage', style: { flex: '1', display: 'flex', alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden', minHeight: '0' } }, E.canvasEl);

  E.timeLabel = el('span', { class: 'field-help' }, '00:00 / 00:00');
  E.playBtn = el('button', { class: 'btn btn-sm', title: 'Phát/Dừng (Space)', onclick: () => C.togglePlay() }, icon('play', 16));
  const zoom = el('input', { type: 'range', min: '8', max: '1000', value: String(S.ui.zoom), style: { width: '120px' },
    oninput: (e) => S.setZoom(Number(e.target.value)) });
  E.zoomSlider = zoom;
  const bottom = el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '6px 10px',
    borderTop: '1px solid var(--border)' } },
    E.timeLabel,
    el('div', { style: { flex: '1', display: 'flex', justifyContent: 'center', gap: '10px', alignItems: 'center' } },
      el('button', { class: 'btn btn-sm', title: 'Về đầu', onclick: () => C.seek(0) }, '⏮'),
      E.playBtn,
      el('button', { class: 'btn btn-sm', title: 'Về cuối', onclick: () => C.seek(S.projectDuration()) }, '⏭'),
    ),
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } }, icon('image', 13), zoom),
  );

  return el('div', { style: { flex: '1', display: 'flex', flexDirection: 'column', minWidth: '0', background: 'var(--bg-0)' } },
    top, E.canvasWrap, bottom);
}

function _updateTimeDisplay() {
  if (E.timeLabel) E.timeLabel.textContent = `${_fmt(S.ui.currentTime)} / ${_fmt(S.projectDuration())}`;
}
function _updatePlayButton() {
  if (E.playBtn) { clear(E.playBtn); E.playBtn.appendChild(icon(S.ui.playing ? 'pause' : 'play', 16)); }
}
function _onChangeLight() {
  _updateTimeDisplay();
  // keep the zoom slider in sync when zoom changes via mouse-wheel
  if (E.zoomSlider && Number(E.zoomSlider.value) !== Math.round(S.ui.zoom)) {
    E.zoomSlider.value = String(Math.round(S.ui.zoom));
  }
}

// ── right inspector ───────────────────────────────────────────────────
function _renderInspector() {
  if (!E.inspector) return;
  clear(E.inspector);
  E.inspector.appendChild(el('div', { style: { padding: '12px', fontWeight: '600',
    borderBottom: '1px solid var(--border)' } }, 'Thuộc tính'));
  const body = el('div', { style: { padding: '12px', display: 'flex', flexDirection: 'column', gap: '14px' } });
  E.inspector.appendChild(body);
  const c = S.selectedClip();
  if (!c) { body.appendChild(el('div', { class: 'field-help' }, 'Chọn một phần tử trên canvas hoặc timeline để chỉnh.')); return; }

  if (c.kind === 'text') body.appendChild(_secText(c));
  if (c.kind !== 'audio') body.appendChild(_secTransform(c));
  if (c.kind === 'video' || c.kind === 'image') body.appendChild(_secColor(c));
  if (c.kind === 'audio' || c.kind === 'video') body.appendChild(_secAudio(c));
}

function _section(title, ...kids) {
  return el('div', null, el('div', { class: 'field-label', style: { marginBottom: '8px' } }, title), ...kids);
}
function _slider(label, val, min, max, step, onInput) {
  const clamp = (v) => Math.max(min, Math.min(max, v));
  const num = el('input', {
    class: 'input', type: 'number', value: String(Math.round(Number(val) || 0)),
    min: String(min), max: String(max), step: String(step),
    style: { width: '62px', height: '24px', padding: '0 6px', fontSize: '12px', textAlign: 'right' },
  });
  const r = el('input', {
    type: 'range', min: String(min), max: String(max), step: String(step), value: String(Number(val) || 0),
    style: { flex: '1' },
  });
  r.addEventListener('input', () => { const v = clamp(Number(r.value)); num.value = String(Math.round(v)); onInput(v); });
  r.addEventListener('change', () => S.commit());
  num.addEventListener('input', () => {
    const v = Number(num.value);
    if (Number.isNaN(v)) return;
    const cv = clamp(v); r.value = String(cv); onInput(cv);
  });
  num.addEventListener('change', () => { const v = clamp(Number(num.value) || 0); num.value = String(v); r.value = String(v); onInput(v); S.commit(); });
  return el('div', { style: { marginBottom: '8px' } },
    el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' } },
      el('span', { class: 'field-help' }, label), num),
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, r));
}
function _resetBtn(onClick) {
  return el('button', { class: 'btn btn-sm',
    style: { fontSize: '11px', padding: '3px 9px', marginBottom: '8px', alignSelf: 'flex-start' },
    onclick: onClick }, '↺ Đặt lại mặc định');
}
function _secTransform(c) {
  return _section('Vị trí & kích thước',
    _resetBtn(() => {
      S.centerOnCanvas(c);
      S.updateClip(c.id, { left: c.left, top: c.top, scaleX: c.scaleX, scaleY: c.scaleY, angle: 0, opacity: 1 });
      S.commit(); _renderInspector();
      toast('Đã đặt lại vị trí & kích thước', 'success', 1200);
    }),
    _slider('X', c.left, -2000, 4000, 1, (v) => S.updateClip(c.id, { left: v })),
    _slider('Y', c.top, -2000, 4000, 1, (v) => S.updateClip(c.id, { top: v })),
    _slider('Kích thước %', (c.scaleX || 1) * 100, 5, 400, 1, (v) => S.updateClip(c.id, { scaleX: v / 100, scaleY: v / 100 })),
    _slider('Xoay °', c.angle || 0, -180, 180, 1, (v) => S.updateClip(c.id, { angle: v })),
    _slider('Độ mờ %', (c.opacity == null ? 1 : c.opacity) * 100, 0, 100, 1, (v) => S.updateClip(c.id, { opacity: v / 100 })),
  );
}
function _secColor(c) {
  const f = (k) => (v) => { c.color = c.color || S.defaultColor(); c.color[k] = v; S.emit('change'); };
  const col = Object.assign(S.defaultColor(), c.color || {});
  return _section('Màu sắc',
    _resetBtn(() => {
      S.updateClip(c.id, { color: S.defaultColor() }); S.commit(); _renderInspector();
      toast('Đã đặt lại màu về mặc định', 'success', 1200);
    }),
    _slider('Nhiệt độ', col.temperature, -100, 100, 1, f('temperature')),
    _slider('Tông màu', col.tint, -100, 100, 1, f('tint')),
    _slider('Bão hòa', col.saturation, -100, 100, 1, f('saturation')),
    _slider('Rực màu', col.vibrance, -100, 100, 1, f('vibrance')),
    _slider('Phơi sáng', col.exposure, -100, 100, 1, f('exposure')),
    _slider('Độ sáng', col.brightness, -100, 100, 1, f('brightness')),
    _slider('Tương phản', col.contrast, -100, 100, 1, f('contrast')),
    _slider('Vùng sáng', col.highlights, -100, 100, 1, f('highlights')),
    _slider('Vùng tối', col.shadows, -100, 100, 1, f('shadows')),
    _slider('Trắng', col.whites, -100, 100, 1, f('whites')),
    _slider('Đen', col.blacks, -100, 100, 1, f('blacks')),
    _slider('Độ nét', col.sharpen, -100, 100, 1, f('sharpen')),
    _slider('Làm mờ', col.blur, 0, 50, 1, f('blur')),
  );
}
function _secAudio(c) {
  return _section('Âm thanh',
    _slider('Âm lượng %', c.volume == null ? 100 : c.volume, 0, 200, 1, (v) => S.updateClip(c.id, { volume: v })),
    _slider('Fade vào (s)', c.fadeIn || 0, 0, 10, 0.1, (v) => S.updateClip(c.id, { fadeIn: v })),
    _slider('Fade ra (s)', c.fadeOut || 0, 0, 10, 0.1, (v) => S.updateClip(c.id, { fadeOut: v })),
  );
}
// Searchable font combobox: type to filter, click to pick (previews each font).
function _fontPicker(c, st) {
  const fonts = (_localFonts && _localFonts.length) ? _localFonts : _COMMON_FONTS;
  const wrap = el('div', { style: { position: 'relative', flex: '1', minWidth: '0' } });
  const input = el('input', { class: 'input', value: st.fontFamily || 'Arial', placeholder: 'Gõ để tìm font…',
    spellcheck: 'false', style: { width: '100%' } });
  const list = el('div', { style: { position: 'absolute', top: '100%', left: '0', right: '0', zIndex: '40',
    marginTop: '2px', maxHeight: '220px', overflowY: 'auto', background: 'var(--surface)',
    border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', boxShadow: 'var(--sh-md)', display: 'none' } });
  const pick = (f) => {
    input.value = f; st.fontFamily = f; S.updateClip(c.id, { style: st }); S.commit();
    list.style.display = 'none';
  };
  const fill = (q) => {
    clear(list);
    const ql = (q || '').trim().toLowerCase();
    const matches = fonts.filter((f) => !ql || f.toLowerCase().includes(ql)).slice(0, 300);
    if (!matches.length) { list.appendChild(el('div', { class: 'field-help', style: { padding: '8px 10px' } }, 'Không có font khớp')); return; }
    for (const f of matches) {
      list.appendChild(el('div', {
        style: { padding: '6px 10px', cursor: 'pointer', fontFamily: `"${f}"`, fontSize: '13px',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
        onmousedown: (e) => { e.preventDefault(); pick(f); },   // before input blur
        onmouseenter: (e) => { e.currentTarget.style.background = 'var(--surface-alt)'; },
        onmouseleave: (e) => { e.currentTarget.style.background = 'transparent'; },
      }, f));
    }
  };
  input.addEventListener('focus', () => { input.select(); fill(''); list.style.display = 'block'; });
  input.addEventListener('input', () => { fill(input.value); list.style.display = 'block'; });
  input.addEventListener('blur', () => { setTimeout(() => { list.style.display = 'none'; }, 150); });
  wrap.appendChild(input); wrap.appendChild(list);
  return wrap;
}
async function _loadLocalFonts() {
  if (!window.queryLocalFonts) {
    toast('Trình duyệt không hỗ trợ liệt kê font máy — đang dùng danh sách font phổ biến', 'warning', 4500);
    return;
  }
  try {
    const fonts = await window.queryLocalFonts();
    const fams = [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
    if (fams.length) { _localFonts = fams; toast(`Đã nạp ${fams.length} font từ máy`, 'success', 3000); }
  } catch (e) { toast(`Không nạp được font máy: ${e.message}`, 'error'); }
}
function _secText(c) {
  const st = c.style || S.defaultTextStyle();
  const ta = el('textarea', { class: 'textarea', rows: '2', style: { width: '100%' },
    oninput: (e) => { S.updateClip(c.id, { text: e.target.value }); }, onchange: () => S.commit() });
  ta.value = c.text || '';
  const colorInput = el('input', { type: 'color', value: st.fill || '#ffffff',
    oninput: (e) => { st.fill = e.target.value; S.updateClip(c.id, { style: st }); }, onchange: () => S.commit() });
  // font picker — gõ để tìm trong danh sách font (đặc biệt sau khi nạp font máy)
  const fontSel = _fontPicker(c, st);
  const loadFontsBtn = el('button', { class: 'btn btn-sm', style: { marginTop: '6px' },
    title: 'Nạp toàn bộ font đã cài trên máy', onclick: () => _loadLocalFonts().then(() => _renderInspector()) },
    '＋ Nạp font máy');
  return _section('Văn bản',
    ta,
    el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '6px' } },
      el('span', { class: 'field-help', style: { flex: '0 0 auto' } }, 'Font'), fontSel),
    loadFontsBtn,
    _slider('Cỡ chữ', st.fontSize, 12, 300, 1, (v) => { st.fontSize = v; S.updateClip(c.id, { style: st }); }),
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' } },
      el('span', { class: 'field-help' }, 'Màu chữ'), colorInput,
      el('button', { class: 'btn btn-sm', onclick: () => { st.fontWeight = st.fontWeight === 'bold' ? 'normal' : 'bold'; S.updateClip(c.id, { style: st }); S.commit(); } }, 'B'),
      el('button', { class: 'btn btn-sm', onclick: () => { st.fontStyle = st.fontStyle === 'italic' ? 'normal' : 'italic'; S.updateClip(c.id, { style: st }); S.commit(); } }, 'I'),
    ),
  );
}

// ── actions: save / open / new / export ───────────────────────────────
async function _doSave(btn) {
  setLoading(btn, true);
  try {
    if (!S.project.id) {
      const p = await api.videoEditor.createProject(S.project.name);
      S.project.id = p.id;
    }
    await api.videoEditor.saveProject(S.project.id, S.project.name, S.serialize());
    toast('Đã lưu dự án', 'success');
  } catch (e) { toast(`Lưu thất bại: ${e.message}`, 'error'); }
  finally { setLoading(btn, false); }
}
function _newProject() {
  S.reset();
  if (E.nameInput) E.nameInput.value = S.project.name;
  C.fitView();
  toast('Dự án mới', 'info', 1200);
}
async function _openProjects() {
  let projects = [];
  try { projects = (await api.videoEditor.projects()).projects || []; }
  catch (e) { toast(`Lỗi: ${e.message}`, 'error'); return; }
  const list = projects.length
    ? el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '52vh', overflow: 'auto' } },
        ...projects.map((p) => el('div', { class: 'card', style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px' } },
          el('div', { style: { flex: '1', minWidth: '0' } },
            el('div', { style: { fontWeight: '600' } }, p.name || `Dự án ${p.id}`),
            el('div', { class: 'field-help' }, `Cập nhật: ${p.updated_at || p.created_at || '—'}`)),
          el('button', { class: 'btn btn-sm btn-primary', onclick: () => { ref.close(); _loadProject(p.id); } }, 'Mở'),
          el('button', { class: 'btn btn-sm', onclick: async () => {
            if (!(await confirm(`Xóa "${p.name}"?`))) return;
            try { await api.videoEditor.deleteProject(p.id); ref.close(); _openProjects(); } catch (e) { toast(e.message, 'error'); }
          } }, icon('trash', 14)))))
    : el('div', { class: 'field-help' }, 'Chưa có dự án đã lưu.');
  const ref = modal({ title: 'Dự án đã lưu', body: list, actions: [{ label: 'Đóng' }] });
}
async function _loadProject(id) {
  try {
    const p = await api.videoEditor.project(id);
    S.loadProject(p, p.data || {});
    if (E.nameInput) E.nameInput.value = S.project.name;
    C.fitView();
    toast(`Đã mở "${S.project.name}"`, 'success', 1400);
  } catch (e) { toast(`Mở thất bại: ${e.message}`, 'error'); }
}
async function _doExport(btn) {
  if (!S.projectDuration()) { toast('Timeline trống', 'warning'); return; }
  setLoading(btn, true);
  try {
    const res = await api.videoEditor.render({ name: S.project.name, project_id: S.project.id, spec: S.buildRenderSpec() });
    _renderTaskId = res.task_id;
    _setExport(1, 'Đã đưa vào hàng đợi…', true);
    toast('Đã tạo task xuất video — theo dõi tại đây hoặc "Quản lý Task"', 'success', 6000);
  } catch (e) { toast(`Xuất thất bại: ${e.message}`, 'error'); }
  finally { setLoading(btn, false); }
}

function _fmt(s) {
  s = Math.max(0, Math.round(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ── WS (once) ─────────────────────────────────────────────────────────
ws.on('video_render_progress', (d) => { if (d && d.task_id === _renderTaskId) _setExport(d.percent || 0, d.message || 'Đang dựng…', true); });
ws.on('task_completed', (d) => { if (d && d.task_id === _renderTaskId) { _setExport(100, 'Hoàn tất ✓', true); toast('Xuất video hoàn tất! Xem ở "Quản lý Task".', 'success', 7000); } });
ws.on('task_error', (d) => { if (d && d.task_id === _renderTaskId) { _setExport(0, `Lỗi: ${d.error || ''}`, true); toast(`Xuất lỗi: ${d.error || ''}`, 'error', 8000); } });
// Video AI generation progress (separate from export — filtered by _aiTasks)
ws.on('task_progress', (d) => _aiTaskUpdate(d, null));
ws.on('task_completed', (d) => _aiTaskUpdate(d, 'completed'));
ws.on('task_error', (d) => _aiTaskUpdate(d, 'error'));
