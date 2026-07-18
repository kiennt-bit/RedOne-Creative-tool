// Chỉnh màu hàng loạt — batch color grading for images + videos.
//
// Preview is SERVER-rendered (same ffmpeg + same filter chain as export), so
// what the user sees is exactly what the export produces. Browser CSS filters
// are deliberately NOT used: they decode color differently and have no notion
// of HSL bands.
//
// Design notes (per app design system + frontend-design pass):
// - The preview stage (.bc-stage) is a fixed dark surround in both themes —
//   neutral dark is what lets the eye judge color accurately.
// - Control groups are ordered exactly like the ffmpeg filter chain:
//   Màu sắc → Ánh sáng → Chi tiết → HSL.
// - Slider readouts are mono/tabular (.bc-val): they are measurements.
// - Video preview: Space (or the play overlay) auto-renders a graded clip on
//   the server and plays it; slider changes while playing re-render it.
import { el, clear, toast, setLoading, icon, modal, makeLazyVideoObserver } from '../ui.js';
import { api } from '../api.js';
import { ws } from '../ws.js';

// ffmpeg's huesaturation has exactly these 6 bands, centered at 0..300°.
// The UI is a CONTINUOUS spectrum: each user "adjustment point" (any hue)
// is compiled into the two adjacent bands, weighted by angular distance.
const BAND_KEYS = ['r', 'y', 'g', 'c', 'b', 'm'];
const BAND_CENTERS = { r: 0, y: 60, g: 120, c: 180, b: 240, m: 300 };

function compileHslPoints(points) {
  const bands = {};
  for (const k of BAND_KEYS) bands[k] = { h: 0, s: 0, l: 0 };
  for (const p of points || []) {
    const hue = ((Number(p.hue) % 360) + 360) % 360;
    const seg = Math.min(5, Math.floor(hue / 60));
    const t = (hue - seg * 60) / 60;          // 0 = band 1, 1 = band 2
    const k1 = BAND_KEYS[seg], k2 = BAND_KEYS[(seg + 1) % 6];
    for (const a of ['h', 's', 'l']) {
      bands[k1][a] += (p[a] || 0) * (1 - t);
      bands[k2][a] += (p[a] || 0) * t;
    }
  }
  for (const k of BAND_KEYS) for (const a of ['h', 's', 'l']) {
    bands[k][a] = Math.round(Math.max(-100, Math.min(100, bands[k][a])));
  }
  return bands;
}

function hueCss(h) { return `hsl(${Math.round(h)}, 85%, 55%)`; }

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

// Group order mirrors the actual ffmpeg chain order (color.py):
// colorchannelmixer/eq → curves → vibrance → unsharp/gblur → huesaturation.
const GROUPS = [
  { id: 'color', title: 'Màu sắc', keys: [
    ['temperature', 'Nhiệt độ'], ['tint', 'Tông màu'],
    ['saturation', 'Bão hoà'], ['vibrance', 'Rực màu'],
  ] },
  { id: 'light', title: 'Ánh sáng', keys: [
    ['exposure', 'Phơi sáng'], ['brightness', 'Độ sáng'], ['contrast', 'Tương phản'],
    ['highlights', 'Vùng sáng'], ['shadows', 'Vùng tối'], ['whites', 'Trắng'], ['blacks', 'Đen'],
  ] },
  { id: 'detail', title: 'Chi tiết', keys: [
    ['sharpen', 'Độ nét'], ['blur', 'Làm mờ'],
  ] },
];
const POSITIVE_ONLY = new Set(['sharpen', 'blur']);

function defaultColor() {
  const c = {};
  for (const g of GROUPS) for (const [k] of g.keys) c[k] = 0;
  c.hslPoints = [];
  return c;
}

// Module-level state → survives SPA tab navigation (F5 clears it).
const state = {
  color: defaultColor(),
  files: [],              // selected media objects {path,url,name,type}
  previewPath: null,
  previewTs: 0,
  previewDur: 0,
  hslActive: -1,          // index of the active adjustment point
  suffix: '_mau',
  batch: null,            // {taskId, finished, items: {name: {percent,status}}}
  media: null,            // my-media cache for the picker
};

function hasAnyAdjustment(c) {
  for (const g of GROUPS) for (const [k] of g.keys) if (c[k]) return true;
  for (const p of c.hslPoints || []) if (p.h || p.s || p.l) return true;
  return false;
}

// What actually goes to the server: points compiled into the 6 ffmpeg bands.
// The extra hslPoints key rides along harmlessly (color_filter ignores it) so
// presets round-trip the full point structure.
function payloadColor() {
  return { ...state.color, hsl: compileHslPoints(state.color.hslPoints) };
}

function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function renderBatchColor(root) {
  const unsubs = [];
  const urls = new Set();          // object URLs to revoke on leave
  const origCache = new Map();     // `${path}@${ts}` → objectURL (ungraded)
  let previewTimer = null;
  let previewSeq = 0;
  let clipSeq = 0;
  let clipMode = false;            // video element showing a graded clip

  root.appendChild(el('div', { class: 'page-hero' },
    el('div', { class: 'hero-icon' }, icon('wand', 28)),
    el('div', { class: 'hero-text' },
      el('h2', null, 'Chỉnh màu hàng loạt'),
      el('p', null, 'Áp một thiết lập màu cho nhiều ảnh và video — xem trước đúng màu file xuất'),
    ),
  ));

  const layout = el('div', { class: 'bc-layout', style: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 300px', gap: '16px', alignItems: 'start' } });
  root.appendChild(layout);

  // ───────────── Left column ─────────────
  const left = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '0' } });
  layout.appendChild(left);

  const previewBox = el('div', { class: 'bc-stage' },
    el('img', { id: 'bc-img', style: { display: 'none' } }),
    el('video', { id: 'bc-clip', loop: 'true', style: { display: 'none' } }),
    el('div', { id: 'bc-empty', class: 'empty bc-dropzone', role: 'button', tabindex: '0', 'aria-label': 'Kéo thả hoặc bấm để chọn tệp' },
      el('div', { class: 'empty-icon' }, icon('image', 32)),
      el('div', { id: 'bc-dz-title', style: { fontSize: '14px', color: 'var(--text)' } }, 'Kéo thả ảnh hoặc video vào đây'),
      el('div', { style: { fontSize: '12px', color: 'var(--text-muted)' } }, 'hoặc bấm để chọn từ thư viện · máy tính'),
    ),
    el('div', { id: 'bc-spin', class: 'bc-overlay', style: { top: '8px', right: '8px', display: 'none' } },
      el('span', { class: 'bc-render-dot' }), 'Đang render'),
    el('button', { id: 'bc-play', class: 'bc-play', title: 'Phát video xem trước đúng màu (Space)', 'aria-label': 'Phát video xem trước', style: { display: 'none' } }, icon('play', 26)),
    el('button', { id: 'bc-exit-clip', class: 'bc-chipbtn', style: { bottom: '8px', right: '8px', display: 'none' } }, 'Về ảnh tĩnh'),
  );

  const controlsRow = el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginTop: '8px' } },
    el('button', { class: 'btn btn-sm', id: 'bc-pick', title: 'Bấm rồi chấm lên ảnh để đặt điểm HSL tại đúng màu đó' }, icon('wand', 14), 'Chấm màu'),
    el('button', { class: 'btn btn-sm', id: 'bc-orig' }, icon('eye', 14), 'Giữ để xem gốc'),
    el('span', { id: 'bc-picked', style: { fontSize: '11px', color: 'var(--text-muted)', marginLeft: 'auto' } },
      'Video: bấm Space hoặc nút phát — tự render đúng màu rồi chạy'),
  );

  const scrubRow = el('div', { id: 'bc-scrub', style: { display: 'none', gap: '8px', alignItems: 'center', marginTop: '8px' } },
    el('input', { type: 'range', min: '0', max: '1000', value: '0', id: 'bc-ts', style: { flex: '1' } }),
    el('span', { id: 'bc-time', class: 'bc-val', style: { width: '84px' } }, '00:00 / 00:00'),
  );

  const previewCard = el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('h3', { class: 'card-title' }, 'Xem trước'),
      el('button', { class: 'btn btn-sm btn-primary', id: 'bc-add' }, icon('plus', 14), 'Chọn tệp'),
    ),
    previewBox, controlsRow, scrubRow,
  );
  left.appendChild(previewCard);

  const thumbsHeader = el('div', { id: 'bc-thumbs-head', style: { display: 'none', alignItems: 'center', gap: '8px', margin: '2px 2px 0' } },
    el('span', { id: 'bc-thumbs-count', style: { fontSize: '12px', color: 'var(--text-2)' } }),
    el('button', { class: 'btn btn-sm', id: 'bc-clear-all', style: { marginLeft: 'auto', color: 'var(--red)' } }, icon('trash', 13), 'Xóa tất cả'),
  );
  left.appendChild(thumbsHeader);
  const thumbs = el('div', { id: 'bc-thumbs', style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } });
  left.appendChild(thumbs);

  const queueCard = el('div', { class: 'card', id: 'bc-queue', style: { display: 'none' } });
  left.appendChild(queueCard);

  // ───────────── Right column ─────────────
  const right = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } });
  layout.appendChild(right);
  const controlsHost = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } });
  right.appendChild(controlsHost);

  const exportRow = el('div', { class: 'card' },
    el('div', { style: { display: 'flex', gap: '8px', marginBottom: '8px' } },
      el('input', { type: 'text', class: 'input', id: 'bc-suffix', value: state.suffix, style: { width: '90px' }, title: 'Hậu tố tên file xuất' }),
      el('button', { class: 'btn btn-primary', id: 'bc-go', style: { flex: '1' } }, icon('sparkles', 14), el('span', null, 'Xuất')),
    ),
    el('div', { style: { display: 'flex', gap: '6px' } },
      el('select', { class: 'select', id: 'bc-preset', style: { flex: '1' } }, el('option', { value: '' }, '— Preset —')),
      el('button', { class: 'btn btn-sm', id: 'bc-preset-save', title: 'Lưu thiết lập hiện tại thành preset', 'aria-label': 'Lưu preset' }, icon('download', 13)),
      el('button', { class: 'btn btn-sm', id: 'bc-preset-del', title: 'Xoá preset đang chọn', 'aria-label': 'Xoá preset' }, icon('trash', 13)),
      el('button', { class: 'btn btn-sm', id: 'bc-reset', title: 'Đưa mọi thông số về 0', 'aria-label': 'Đặt lại thông số' }, icon('refresh', 13)),
    ),
  );
  right.appendChild(exportRow);


  // ───────────── Controls (rebuilt on preset/reset/band change) ─────────────

  function sliderRow(label, get, set, min = -100, max = 100) {
    const val = el('span', { class: 'bc-val' }, String(get()));
    const input = el('input', { type: 'range', min: String(min), max: String(max), step: '1', value: String(get()), style: { flex: '1' } });
    input.addEventListener('input', () => { set(parseInt(input.value, 10) || 0); val.textContent = input.value; refreshDots(); schedulePreview(); });
    input.addEventListener('dblclick', () => { set(0); input.value = '0'; val.textContent = '0'; refreshDots(); schedulePreview(); });
    return el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '11px' } },
      el('span', { style: { fontSize: '11px', color: 'var(--text-muted)', width: '66px', flexShrink: '0' } }, label),
      input, val);
  }

  const groupDots = {};
  function refreshDots() {
    for (const g of GROUPS) {
      const active = g.keys.some(([k]) => state.color[k]);
      if (groupDots[g.id]) groupDots[g.id].style.display = active ? 'inline-block' : 'none';
    }
    const pts = state.color.hslPoints || [];
    const hslActive = pts.some(p => p.h || p.s || p.l);
    if (groupDots.hsl) groupDots.hsl.style.display = hslActive ? 'inline-block' : 'none';
    controlsHost.querySelectorAll('.bc-point').forEach(mk => {
      const p = pts[Number(mk.dataset.idx)];
      const mark = mk.querySelector('.bc-band-mark');
      if (p && mark) mark.style.display = (p.h || p.s || p.l) ? 'block' : 'none';
    });
  }

  function dot(id) {
    const d = el('span', { style: { display: 'none', width: '6px', height: '6px', borderRadius: '50%', background: 'var(--brand)', marginLeft: '6px', verticalAlign: '2px' } });
    groupDots[id] = d;
    return d;
  }

  function renderControls() {
    clear(controlsHost);
    for (const g of GROUPS) {
      controlsHost.appendChild(el('div', { class: 'card', style: { padding: '10px 12px' } },
        el('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '6px' } },
          el('span', { style: { fontSize: '12px', fontWeight: '600' } }, g.title, dot(g.id)),
          el('span', { style: { fontSize: '10px', color: 'var(--text-muted)' } }, 'đúp = về 0'),
        ),
        ...g.keys.map(([k, label]) => sliderRow(label,
          () => state.color[k], (v) => { state.color[k] = v; },
          POSITIVE_ONLY.has(k) ? 0 : -100, 100)),
      ));
    }
    // HSL — one continuous spectrum; click adds/selects a point, drag moves it.
    const spectrum = el('div', { class: 'bc-spectrum', title: 'Bấm để thêm hoặc chọn điểm màu' });
    const headRow = el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', minHeight: '24px' } });
    const hslSliders = el('div');
    let headSwatch = null, headDeg = null;
    const activePoint = () => (state.color.hslPoints || [])[state.hslActive] || null;

    const renderPointSliders = () => {
      clear(hslSliders);
      clear(headRow);
      headSwatch = headDeg = null;
      const p = activePoint();
      if (!p) {
        headRow.appendChild(el('span', { style: { fontSize: '11px', color: 'var(--text-muted)' } },
          'Bấm lên dải màu để thêm điểm chỉnh'));
        return;
      }
      headSwatch = el('span', { style: { display: 'inline-block', width: '12px', height: '12px', borderRadius: '50%', background: hueCss(p.hue), flexShrink: '0' } });
      headDeg = el('span', { style: { fontSize: '11px', color: 'var(--text-muted)' } }, `Điểm màu ${Math.round(p.hue)}°`);
      headRow.appendChild(headSwatch);
      headRow.appendChild(headDeg);
      headRow.appendChild(el('button', {
        class: 'btn btn-sm', title: 'Xoá điểm này', 'aria-label': 'Xoá điểm màu',
        style: { marginLeft: 'auto', padding: '2px 7px' },
        onclick: () => {
          state.color.hslPoints.splice(state.hslActive, 1);
          state.hslActive = state.color.hslPoints.length - 1;
          renderPoints(); renderPointSliders(); refreshDots(); schedulePreview();
        },
      }, icon('trash', 12)));
      hslSliders.appendChild(sliderRow('Sắc màu', () => p.h, (v) => { p.h = v; }));
      hslSliders.appendChild(sliderRow('Bão hoà', () => p.s, (v) => { p.s = v; }));
      hslSliders.appendChild(sliderRow('Độ đậm', () => p.l, (v) => { p.l = v; }));
    };

    const renderPoints = () => {
      spectrum.querySelectorAll('.bc-point').forEach(n => n.remove());
      (state.color.hslPoints || []).forEach((p, i) => {
        const mk = el('span', {
          class: 'bc-point' + (i === state.hslActive ? ' active' : ''),
          'data-idx': String(i),
          style: { left: `${(p.hue / 360) * 100}%`, background: hueCss(p.hue) },
        }, el('span', { class: 'bc-band-mark', style: { display: (p.h || p.s || p.l) ? 'block' : 'none' } }));
        mk.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (state.hslActive !== i) { state.hslActive = i; renderPoints(); renderPointSliders(); }
          const rect = spectrum.getBoundingClientRect();
          const move = (ev) => {
            const hue = Math.max(0, Math.min(359.9, ((ev.clientX - rect.left) / rect.width) * 360));
            p.hue = hue;
            mk.style.left = `${(hue / 360) * 100}%`;
            mk.style.background = hueCss(hue);
            if (headSwatch) headSwatch.style.background = hueCss(hue);
            if (headDeg) headDeg.textContent = `Điểm màu ${Math.round(hue)}°`;
            schedulePreview();
          };
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            schedulePreview();
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        });
        spectrum.appendChild(mk);
      });
    };

    spectrum.addEventListener('pointerdown', (e) => {
      if (e.target !== spectrum) return;      // markers handle themselves
      const rect = spectrum.getBoundingClientRect();
      const hue = Math.max(0, Math.min(359.9, ((e.clientX - rect.left) / rect.width) * 360));
      const pts = state.color.hslPoints;
      const near = pts.findIndex(p =>
        Math.min(Math.abs(p.hue - hue), 360 - Math.abs(p.hue - hue)) <= 14);
      if (near >= 0) {
        state.hslActive = near;
      } else {
        pts.push({ hue, h: 0, s: 0, l: 0 });
        state.hslActive = pts.length - 1;
      }
      renderPoints();
      renderPointSliders();
      refreshDots();
    });

    controlsHost.appendChild(el('div', { class: 'card', style: { padding: '10px 12px' } },
      el('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '2px' } },
        el('span', { style: { fontSize: '12px', fontWeight: '600' } }, 'HSL theo dải màu', dot('hsl')),
      ),
      spectrum, headRow, hslSliders,
    ));
    renderPoints();
    renderPointSliders();
    refreshDots();
  }
  renderControls();

  // ───────────── Server preview (still frame) ─────────────

  function setSpin(on) { previewBox.querySelector('#bc-spin').style.display = on ? 'block' : 'none'; }
  function currentFile() { return state.files.find(x => x.path === state.previewPath) || null; }

  async function fetchPreview(color) {
    const blob = await api.batchColor.preview(state.previewPath, color, state.previewTs);
    const u = URL.createObjectURL(blob);
    urls.add(u);
    return u;
  }

  function swapImage(u) {
    const img = previewBox.querySelector('#bc-img');
    const tmp = new Image();
    tmp.onload = () => {
      img.classList.add('bc-swapping');
      img.src = u;
      requestAnimationFrame(() => requestAnimationFrame(() => img.classList.remove('bc-swapping')));
      img.style.display = 'block';
      previewBox.querySelector('#bc-empty').style.display = 'none';
      previewBox.classList.add('bc-media');
    };
    tmp.src = u;
  }

  async function refreshFrame() {
    if (!state.previewPath || !root.isConnected) return;
    const seq = ++previewSeq;
    setSpin(true);
    try {
      const u = await fetchPreview(payloadColor());
      if (seq !== previewSeq || !root.isConnected) return;
      swapImage(u);
    } catch (e) {
      if (seq === previewSeq) toast(`Xem trước lỗi: ${e.message}`, 'error');
    } finally {
      if (seq === previewSeq) setSpin(false);
    }
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    // While the graded clip is showing, slider changes re-render the CLIP
    // (auto), not the still frame.
    previewTimer = setTimeout(clipMode ? renderClip : refreshFrame, clipMode ? 600 : 300);
  }

  async function originalUrl() {
    const key = `${state.previewPath}@${state.previewTs}`;
    if (!origCache.has(key)) origCache.set(key, await fetchPreview({}));
    return origCache.get(key);
  }

  // Hold-to-compare (still frame only)
  {
    const btn = controlsRow.querySelector('#bc-orig');
    const img = () => previewBox.querySelector('#bc-img');
    let graded = null;
    const down = async () => {
      if (!state.previewPath || clipMode) return;
      graded = img().src;
      try { img().src = await originalUrl(); } catch (e) { toast(e.message, 'error'); }
    };
    const up = () => { if (graded) { img().src = graded; graded = null; } };
    btn.addEventListener('mousedown', down);
    btn.addEventListener('touchstart', down);
    for (const ev of ['mouseup', 'mouseleave', 'touchend']) btn.addEventListener(ev, up);
  }

  // Eyedropper — click a color on the SERVER-rendered frame, drop an HSL point
  // at that exact hue on the spectrum (or select a nearby existing one).
  let picking = false;
  {
    const btn = controlsRow.querySelector('#bc-pick');
    const img = previewBox.querySelector('#bc-img');
    const label = controlsRow.querySelector('#bc-picked');
    const setPicking = (on) => {
      picking = on;
      btn.classList.toggle('btn-primary', on);
      img.style.cursor = on ? 'crosshair' : '';
    };
    btn.addEventListener('click', () => {
      if (!state.previewPath || clipMode) return toast('Chọn ảnh/khung hình tĩnh trước đã', 'warning');
      setPicking(!picking);
      if (picking) toast('Bấm lên ảnh xem trước để chấm màu', 'info');
    });
    img.addEventListener('click', (e) => {
      if (!picking) return;
      setPicking(false);
      const rect = img.getBoundingClientRect();
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const x = Math.floor((e.clientX - rect.left) / rect.width * img.naturalWidth);
      const y = Math.floor((e.clientY - rect.top) / rect.height * img.naturalHeight);
      const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
      const { h, s, v } = rgbToHsv(r, g, b);
      if (s < 0.1 || v < 0.06 || (v > 0.96 && s < 0.15)) {
        label.textContent = 'Vùng này gần như không có màu — chấm vào vùng màu rõ hơn';
        return;
      }
      const pts = state.color.hslPoints;
      const near = pts.findIndex(p => Math.min(Math.abs(p.hue - h), 360 - Math.abs(p.hue - h)) <= 14);
      if (near >= 0) {
        state.hslActive = near;
      } else {
        pts.push({ hue: h, h: 0, s: 0, l: 0 });
        state.hslActive = pts.length - 1;
      }
      renderControls();
      clear(label);
      label.append('Đã chấm: ',
        el('span', { style: { display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', background: `rgb(${r},${g},${b})`, verticalAlign: '-1px' } }),
        ` → điểm ${Math.round(h)}°${near >= 0 ? ' (điểm sẵn có)' : ''} — kéo slider để chỉnh`);
    });
  }

  // ───────────── Graded video clip (auto-render + Space) ─────────────

  const clipEl = previewBox.querySelector('#bc-clip');
  const playBtn = previewBox.querySelector('#bc-play');
  const exitBtn = previewBox.querySelector('#bc-exit-clip');

  function syncPlayBtn() {
    const f = currentFile();
    playBtn.style.display = (f && f.type === 'video' && !clipMode) ? 'flex' : 'none';
  }

  async function renderClip() {
    const f = currentFile();
    if (!f || f.type !== 'video' || !root.isConnected) return;
    const seq = ++clipSeq;
    setSpin(true);
    try {
      const r = await api.batchColor.previewClip(state.previewPath, payloadColor(), state.previewTs, 5);
      if (seq !== clipSeq || !root.isConnected) return;
      clipMode = true;
      clipEl.src = r.url;
      clipEl.style.display = 'block';
      previewBox.querySelector('#bc-img').style.display = 'none';
      previewBox.querySelector('#bc-empty').style.display = 'none';
      previewBox.classList.add('bc-media');
      exitBtn.style.display = 'block';
      syncPlayBtn();
      try { await clipEl.play(); } catch { /* autoplay policy — Space plays */ }
    } catch (e) {
      if (seq === clipSeq) toast(`Render xem trước lỗi: ${e.message}`, 'error');
    } finally {
      if (seq === clipSeq) setSpin(false);
    }
  }

  function exitClip() {
    clipSeq++;                      // invalidate in-flight clip renders
    clipMode = false;
    clipEl.pause();
    clipEl.style.display = 'none';
    previewBox.querySelector('#bc-img').style.display = 'block';
    exitBtn.style.display = 'none';
    syncPlayBtn();
    refreshFrame();
  }

  playBtn.addEventListener('click', renderClip);
  exitBtn.addEventListener('click', exitClip);
  clipEl.addEventListener('click', () => { clipEl.paused ? clipEl.play() : clipEl.pause(); });

  const onKey = (e) => {
    if (e.code !== 'Space' || !root.isConnected) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const f = currentFile();
    if (!f || f.type !== 'video') return;
    e.preventDefault();
    if (clipMode) { clipEl.paused ? clipEl.play() : clipEl.pause(); }
    else renderClip();
  };
  document.addEventListener('keydown', onKey);
  unsubs.push(() => document.removeEventListener('keydown', onKey));

  // Scrubber (video only)
  {
    const slider = scrubRow.querySelector('#bc-ts');
    const label = scrubRow.querySelector('#bc-time');
    slider.addEventListener('input', () => {
      state.previewTs = (parseInt(slider.value, 10) / 1000) * state.previewDur;
      label.textContent = `${fmtTime(state.previewTs)} / ${fmtTime(state.previewDur)}`;
    });
    slider.addEventListener('change', () => schedulePreview());
  }

  function detectDuration(url) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      v.onloadedmetadata = () => resolve(v.duration || 0);
      v.onerror = () => resolve(0);
      v.src = url;
    });
  }

  async function setPreviewFile(f) {
    state.previewPath = f.path;
    state.previewTs = 0;
    state.previewDur = 0;
    clipSeq++;
    clipMode = false;
    clipEl.pause();
    clipEl.style.display = 'none';
    exitBtn.style.display = 'none';
    const isVideo = f.type === 'video';
    scrubRow.style.display = isVideo ? 'flex' : 'none';
    syncPlayBtn();
    if (isVideo && f.url) {
      state.previewDur = await detectDuration(f.url);
      scrubRow.querySelector('#bc-ts').value = '0';
      scrubRow.querySelector('#bc-time').textContent = `00:00 / ${fmtTime(state.previewDur)}`;
    }
    renderThumbs();
    clearTimeout(previewTimer);
    refreshFrame();
  }

  // ───────────── File picker (modal: library + upload, shift-select) ─────────────

  function isSelected(m) { return state.files.some(x => x.path === m.path); }
  function setSelected(m, on) {
    if (on && !isSelected(m)) state.files.push(m);
    if (!on) state.files = state.files.filter(x => x.path !== m.path);
  }

  // Upload File objects (from the picker's button OR a drag-drop onto the stage)
  // into the library and select them. Returns how many succeeded.
  async function uploadMedia(files) {
    let ok = 0;
    for (const f of files) {
      try {
        const m = await api.videoEditor.upload(f);
        state.media = [m, ...(state.media || [])];
        setSelected(m, true);
        ok++;
      } catch (e) { toast(`Tải lên "${f.name}" lỗi: ${e.message}`, 'error'); }
    }
    return ok;
  }

  function openPicker() {
    let lastIdx = -1;
    let rows = [];
    let lazyObs = null;
    const grid = el('div', { class: 'bc-grid' }, el('div', { class: 'empty' }, 'Đang tải thư viện…'));
    const countLabel = el('span', { style: { fontSize: '12px', color: 'var(--text-2)' } });
    const search = el('input', { type: 'text', class: 'input', placeholder: 'Tìm theo tên…', style: { width: '170px' } });
    const typeSel = el('select', { class: 'select', style: { width: '100px' } },
      el('option', { value: 'all' }, 'Tất cả'),
      el('option', { value: 'image' }, 'Ảnh'),
      el('option', { value: 'video' }, 'Video'),
    );
    const fileInput = el('input', { type: 'file', multiple: 'true', accept: 'image/*,video/*', style: { display: 'none' } });
    const uploadBtn = el('button', { class: 'btn btn-sm' }, icon('upload', 14), 'Tải lên từ máy');
    uploadBtn.addEventListener('click', () => fileInput.click());

    const updateCount = () => { countLabel.textContent = `Đã chọn: ${state.files.length}`; };

    function renderGrid() {
      if (lazyObs) { lazyObs.disconnect(); lazyObs = null; }
      clear(grid);
      const q = (search.value || '').toLowerCase();
      const t = typeSel.value;
      rows = (state.media || [])
        .filter(m => m.type !== 'audio')
        .filter(m => t === 'all' || m.type === t)
        .filter(m => !q || m.name.toLowerCase().includes(q))
        .slice(0, 200);
      if (!rows.length) {
        grid.appendChild(el('div', { class: 'empty', style: { gridColumn: '1/-1' } },
          'Không có media nào — bấm "Tải lên từ máy" hoặc tạo ảnh/video trước'));
        updateCount();
        return;
      }
      rows.forEach((m, i) => {
        const cell = el('div', { class: 'bc-cell' + (isSelected(m) ? ' sel' : ''), title: m.name });
        if (m.type === 'image') {
          // Server-side small thumb — NEVER the full-size original (a grid of
          // 4K PNGs chokes the browser's image decoder).
          cell.appendChild(el('img', { src: `/api/batch-color/thumb?path=${encodeURIComponent(m.path)}&w=240`, loading: 'lazy' }));
        } else {
          cell.appendChild(el('video', { 'data-src': m.url, muted: 'true', preload: 'none' }));
        }
        cell.appendChild(el('span', { class: 'bc-check' }, icon('check', 12)));
        cell.appendChild(el('span', { class: 'bc-name' }, m.name));
        cell.addEventListener('click', (e) => {
          if (e.shiftKey && lastIdx >= 0) {
            // Range: apply the clicked item's NEW state to the whole range.
            const target = !isSelected(m);
            const [a, b] = [Math.min(lastIdx, i), Math.max(lastIdx, i)];
            for (let k = a; k <= b; k++) setSelected(rows[k], target);
          } else {
            setSelected(m, !isSelected(m));
          }
          lastIdx = i;
          for (let k = 0; k < rows.length; k++) {
            const c = grid.children[k];
            if (c && c.classList) c.classList.toggle('sel', isSelected(rows[k]));
          }
          updateCount();
        });
        grid.appendChild(cell);
      });
      lazyObs = makeLazyVideoObserver(grid, { rootMargin: '200px' });
      grid.querySelectorAll('video[data-src]').forEach(v => lazyObs.observe(v));
      updateCount();
    }

    fileInput.addEventListener('change', async () => {
      const files = [...fileInput.files];
      fileInput.value = '';
      if (!files.length) return;
      setLoading(uploadBtn, true);
      const ok = await uploadMedia(files);
      setLoading(uploadBtn, false);
      if (ok) toast(`Đã tải lên ${ok}/${files.length} tệp`, 'success');
      renderGrid();
    });
    search.addEventListener('input', renderGrid);
    typeSel.addEventListener('change', renderGrid);

    const body = el('div', null,
      el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '10px' } },
        search, typeSel, uploadBtn, fileInput,
        el('span', { style: { marginLeft: 'auto' } }, countLabel),
      ),
      grid,
      el('div', { style: { fontSize: '11px', color: 'var(--text-muted)', marginTop: '8px' } },
        'Bấm để chọn / bỏ chọn · Shift+bấm để chọn cả dải'),
    );

    modal({
      title: 'Chọn tệp cần chỉnh màu',
      body,
      actions: [{ label: 'Xong', class: 'btn-primary', onclick: (close) => {
        if (lazyObs) lazyObs.disconnect();
        close();
        renderThumbs();
        if (!state.previewPath && state.files[0]) setPreviewFile(state.files[0]);
        if (state.previewPath && !state.files.some(x => x.path === state.previewPath)) {
          if (state.files[0]) setPreviewFile(state.files[0]);
        }
      } }],
    });
    const mEl = document.querySelector('#modal-root .modal');
    if (mEl) mEl.style.maxWidth = '780px';

    // Fetch fresh each open so newly generated files show up.
    api.videoEditor.myMedia('all').then(d => {
      state.media = d.media || [];
      renderGrid();
    }).catch(e => {
      toast(e.message, 'error');
      state.media = state.media || [];
      renderGrid();
    });
  }

  previewCard.querySelector('#bc-add').addEventListener('click', openPicker);

  // Empty preview = drag-and-drop zone. Click (or Enter/Space) opens the picker;
  // dropping image/video files uploads them straight into the batch.
  {
    const dz = previewBox.querySelector('#bc-empty');
    const dzTitle = dz.querySelector('#bc-dz-title');
    const DZ_TEXT = dzTitle.textContent;
    let dzBusy = false;
    dz.addEventListener('click', () => { if (!dzBusy) openPicker(); });
    dz.addEventListener('keydown', (e) => {
      if (dzBusy) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(); }
    });
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    dz.addEventListener('dragenter', (e) => { stop(e); dz.classList.add('bc-drag'); });
    dz.addEventListener('dragover', (e) => { stop(e); dz.classList.add('bc-drag'); });
    dz.addEventListener('dragleave', (e) => { stop(e); if (!dz.contains(e.relatedTarget)) dz.classList.remove('bc-drag'); });
    dz.addEventListener('drop', async (e) => {
      stop(e);
      dz.classList.remove('bc-drag');
      if (dzBusy) return;
      const files = [...(e.dataTransfer?.files || [])].filter(f => /^(image|video)\//.test(f.type));
      if (!files.length) return toast('Chỉ nhận tệp ảnh hoặc video', 'warning');
      dzBusy = true;
      dzTitle.textContent = `Đang tải lên ${files.length} tệp…`;
      const ok = await uploadMedia(files);
      dzBusy = false;
      dzTitle.textContent = DZ_TEXT;
      if (ok) {
        toast(`Đã tải lên ${ok}/${files.length} tệp`, 'success');
        renderThumbs();
        if (!state.previewPath && state.files[0]) setPreviewFile(state.files[0]);
      }
    });
  }

  // ───────────── Selected thumbnails strip ─────────────

  function fallbackThumbIcon(name) {
    return el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' } }, icon(name, 18));
  }

  function renderThumbs() {
    clear(thumbs);
    thumbsHeader.style.display = state.files.length ? 'flex' : 'none';
    thumbsHeader.querySelector('#bc-thumbs-count').textContent = `Đã chọn ${state.files.length} tệp`;
    for (const f of state.files) {
      const isActive = f.path === state.previewPath;
      const box = el('div', {
        title: f.name,
        style: { position: 'relative', width: '72px', height: '48px', borderRadius: '6px', overflow: 'hidden', cursor: 'pointer', border: isActive ? '2px solid var(--brand)' : '2px solid transparent', background: 'var(--bg-3)' },
        onclick: () => setPreviewFile(f),
      });
      if (f.type === 'video' && f.url) {
        // First-frame poster so videos are identifiable; #t seeks past frame 0.
        const v = el('video', { src: `${f.url}#t=0.1`, muted: 'true', preload: 'metadata', playsinline: 'true', style: { width: '100%', height: '100%', objectFit: 'cover' } });
        v.addEventListener('error', () => { v.remove(); box.insertBefore(fallbackThumbIcon('movie'), box.firstChild); });
        box.appendChild(v);
        box.appendChild(el('span', { style: { position: 'absolute', bottom: '1px', left: '2px', color: '#fff', filter: 'drop-shadow(0 0 2px rgba(0,0,0,.9))', pointerEvents: 'none' } }, icon('play', 12)));
      } else if (f.type === 'image' && f.url) {
        const im = el('img', { src: `/api/batch-color/thumb?path=${encodeURIComponent(f.path)}&w=160`, style: { width: '100%', height: '100%', objectFit: 'cover' }, loading: 'lazy' });
        im.addEventListener('error', () => { im.remove(); box.insertBefore(fallbackThumbIcon('image'), box.firstChild); });
        box.appendChild(im);
      } else {
        box.appendChild(fallbackThumbIcon(f.type === 'video' ? 'movie' : 'image'));
      }
      box.appendChild(el('span', {
        title: 'Bỏ khỏi lô',
        role: 'button', 'aria-label': `Bỏ ${f.name} khỏi lô`,
        style: { position: 'absolute', top: '1px', right: '1px', background: 'rgba(0,0,0,.55)', color: '#fff', borderRadius: '50%', width: '18px', height: '18px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' },
        onclick: (e) => {
          e.stopPropagation();
          setSelected(f, false);
          if (state.previewPath === f.path) {
            if (state.files[0]) setPreviewFile(state.files[0]);
            else resetPreviewStage();
          }
          renderThumbs();
        },
      }, icon('x', 10)));
      thumbs.appendChild(box);
    }
    updateGoLabel();
  }

  function resetPreviewStage() {
    state.previewPath = null;
    clipSeq++;
    clipMode = false;
    clipEl.pause();
    clipEl.style.display = 'none';
    exitBtn.style.display = 'none';
    previewBox.querySelector('#bc-img').style.display = 'none';
    // '' (not 'block') — .empty is a flex column; 'block' breaks its centering.
    previewBox.querySelector('#bc-empty').style.display = '';
    previewBox.classList.remove('bc-media');
    scrubRow.style.display = 'none';
    // Back to the fresh-load state: drop any stale "Đã chấm 61°" hint and turn
    // off eyedropper mode — nothing is loaded to pick from anymore.
    picking = false;
    controlsRow.querySelector('#bc-pick').classList.remove('btn-primary');
    controlsRow.querySelector('#bc-picked').textContent =
      'Video: bấm Space hoặc nút phát — tự render đúng màu rồi chạy';
    syncPlayBtn();
  }

  thumbsHeader.querySelector('#bc-clear-all').addEventListener('click', () => {
    state.files = [];
    resetPreviewStage();
    renderThumbs();
    toast('Đã bỏ chọn tất cả tệp', 'info');
  });

  function updateGoLabel() {
    const label = exportRow.querySelector('#bc-go span');
    if (label) label.textContent = state.files.length ? `Xuất ${state.files.length} tệp` : 'Xuất';
  }

  // ───────────── Export queue ─────────────

  function renderQueue() {
    const b = state.batch;
    queueCard.style.display = b ? 'block' : 'none';
    if (!b) return;
    clear(queueCard);
    queueCard.appendChild(el('div', { class: 'card-header' },
      el('h3', { class: 'card-title' }, `Hàng đợi xuất — task #${b.taskId}`),
      b.finished ? el('span', { style: { fontSize: '12px', color: 'var(--green)' } }, 'Xong')
        : el('button', { class: 'btn btn-sm', style: { color: 'var(--red)' }, onclick: async () => {
            try { await api.tasks.cancel(b.taskId); toast('Đã hủy lô', 'info'); } catch (e) { toast(e.message, 'error'); }
          } }, icon('x', 13), 'Hủy lô'),
    ));
    for (const [name, it] of Object.entries(b.items)) {
      const color = it.status === 'error' ? 'var(--red)' : it.status === 'done' ? 'var(--green)' : 'var(--text-2)';
      queueCard.appendChild(el('div', { style: { marginBottom: '6px' } },
        el('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px', color } },
          el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '75%' } }, name),
          el('span', { class: 'bc-val', style: { width: 'auto' } }, it.status === 'done' ? '✓' : it.status === 'error' ? 'lỗi' : `${Math.round(it.percent || 0)}%`),
        ),
        el('div', { style: { height: '4px', borderRadius: '99px', background: 'var(--border-strong)', marginTop: '3px' } },
          el('div', { style: { width: `${it.status === 'done' ? 100 : Math.round(it.percent || 0)}%`, height: '100%', borderRadius: '99px', background: it.status === 'error' ? 'var(--red)' : 'var(--brand)' } }),
        ),
      ));
    }
  }

  exportRow.querySelector('#bc-go').addEventListener('click', async () => {
    if (!state.files.length) return toast('Chưa chọn tệp nào', 'warning');
    if (!hasAnyAdjustment(state.color)) return toast('Chưa chỉnh thông số màu nào', 'warning');
    const btn = exportRow.querySelector('#bc-go');
    state.suffix = exportRow.querySelector('#bc-suffix').value || '_mau';
    setLoading(btn, true);
    try {
      const r = await api.batchColor.start(state.files.map(f => f.path), payloadColor(), state.suffix);
      state.batch = { taskId: r.task_id, finished: false, items: {} };
      for (const f of state.files) state.batch.items[f.name] = { percent: 0, status: 'wait' };
      renderQueue();
      toast(r.queued ? `Đã vào hàng đợi (vị trí ${r.queue_position})` : 'Bắt đầu xuất…', 'success');
    } catch (e) { toast(e.message, 'error'); }
    finally { setLoading(btn, false); }
  });

  unsubs.push(ws.on('batch_color_progress', (d) => {
    const b = state.batch;
    if (!b || d.task_id !== b.taskId) return;
    if (b.items[d.name]) { b.items[d.name].percent = d.percent; b.items[d.name].status = 'run'; renderQueue(); }
  }));
  unsubs.push(ws.on('item_completed', (d) => {
    const b = state.batch;
    if (!b || d.kind !== 'batch_color' || d.task_id !== b.taskId) return;
    const stem = (p) => (p || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    const outStem = stem(d.output_path);
    const name = Object.keys(b.items).find(n => outStem.startsWith(stem(n)));
    if (name) { b.items[name].status = 'done'; b.items[name].percent = 100; renderQueue(); }
  }));
  unsubs.push(ws.on('task_completed', (d) => {
    const b = state.batch;
    if (!b || d.kind !== 'batch_color' || d.task_id !== b.taskId) return;
    b.finished = true;
    for (const it of Object.values(b.items)) {
      if (it.status === 'run' || it.status === 'wait') it.status = d.error ? 'error' : 'done';
      if (it.status === 'done') it.percent = 100;
    }
    renderQueue();
    toast(`Chỉnh màu xong: ${d.done} tệp${d.error ? `, ${d.error} lỗi` : ''}`, d.error ? 'warning' : 'success');
  }));

  // ───────────── Presets ─────────────

  let presets = [];
  async function loadPresets() {
    try {
      const d = await api.batchColor.presets();
      presets = d.presets || [];
    } catch { presets = []; }
    const sel = exportRow.querySelector('#bc-preset');
    clear(sel);
    sel.appendChild(el('option', { value: '' }, '— Preset —'));
    for (const p of presets) sel.appendChild(el('option', { value: p.name }, p.name));
  }
  loadPresets();

  exportRow.querySelector('#bc-preset').addEventListener('change', (e) => {
    const p = presets.find(x => x.name === e.target.value);
    if (!p) return;
    state.color = Object.assign(defaultColor(), JSON.parse(JSON.stringify(p.color || {})));
    // Legacy presets (per-band hsl, no points): seed one point per non-zero
    // band at its center hue so they keep working on the spectrum UI.
    if (!Array.isArray(state.color.hslPoints)) {
      const pts = [];
      for (const k of BAND_KEYS) {
        const v = (state.color.hsl || {})[k] || {};
        if (v.h || v.s || v.l) pts.push({ hue: BAND_CENTERS[k], h: v.h || 0, s: v.s || 0, l: v.l || 0 });
      }
      state.color.hslPoints = pts;
    }
    state.hslActive = state.color.hslPoints.length - 1;
    renderControls();
    schedulePreview();
    toast(`Đã áp preset "${p.name}"`, 'info');
  });
  exportRow.querySelector('#bc-preset-save').addEventListener('click', async () => {
    const name = prompt('Tên preset:');
    if (!name || !name.trim()) return;
    try {
      await api.batchColor.savePreset(name.trim(), payloadColor());
      await loadPresets();
      exportRow.querySelector('#bc-preset').value = name.trim();
      toast('Đã lưu preset', 'success');
    } catch (e) { toast(e.message, 'error'); }
  });
  exportRow.querySelector('#bc-preset-del').addEventListener('click', async () => {
    const name = exportRow.querySelector('#bc-preset').value;
    if (!name) return toast('Chọn preset cần xoá trước', 'warning');
    try {
      await api.batchColor.deletePreset(name);
      await loadPresets();
      toast('Đã xoá preset', 'info');
    } catch (e) { toast(e.message, 'error'); }
  });
  exportRow.querySelector('#bc-reset').addEventListener('click', () => {
    state.color = defaultColor();
    renderControls();
    schedulePreview();
  });

  // ───────────── Restore + cleanup ─────────────

  if (state.files.length) {
    renderThumbs();
    const f = state.files.find(x => x.path === state.previewPath) || state.files[0];
    if (f) setPreviewFile(f);
  }
  if (state.batch) renderQueue();

  const host = root.parentElement || document.body;
  const mo = new MutationObserver(() => {
    if (root.isConnected) return;
    for (const u of unsubs) { try { u(); } catch { /* noop */ } }
    for (const u of urls) URL.revokeObjectURL(u);
    urls.clear();
    origCache.clear();
    clearTimeout(previewTimer);
    mo.disconnect();
  });
  mo.observe(host, { childList: true });
}
