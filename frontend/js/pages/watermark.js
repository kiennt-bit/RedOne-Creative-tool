// Watermark remove page — image only (rect crop + OpenCV TELEA inpaint).
// Video watermark removal lives in pages/video_watermark.js under the
// "Xử lý video" sidebar group.
import { el, clear, toast, setLoading, icon } from '../ui.js';
import { api } from '../api.js';

// Module-level state → survives SPA tab navigation (cleared only on F5).
const _st = { file: null, resultUrl: null };

export function renderWatermark(root) {
  let file = _st.file;
  let rect = { x: 0, y: 0, w: 0, h: 0 };
  let imageEl = null;
  let drawing = false;
  let startPt = null;

  root.appendChild(el('div', { class: 'page-hero' },
    el('div', { class: 'hero-icon' }, icon('image', 28)),
    el('div', { class: 'hero-text' },
      el('h2', null, 'Xóa Logo / Watermark (Ảnh)'),
      el('p', null, 'Vẽ vùng chứa watermark, công cụ sẽ xóa bằng inpainting. Cho video → xem tab "Xóa Watermark Video".'),
    ),
  ));

  const layout = el('div', { style: { display: 'grid', gridTemplateColumns: '380px 1fr', gap: '20px' } });
  root.appendChild(layout);

  layout.appendChild(el('div', { class: 'card' },
    el('h3', { class: 'card-title' }, 'Ảnh nguồn'),
    el('div', { class: 'dropzone', id: 'wm-dz', style: { marginTop: '12px' } },
      el('div', { class: 'dropzone-icon' }, icon('upload', 24)),
      el('div', null, 'Kéo thả hoặc click'),
      el('input', { type: 'file', accept: 'image/*', id: 'wm-file', style: { display: 'none' } }),
    ),
    el('div', { class: 'field-label', style: { marginTop: '16px' } }, 'Vùng watermark (vẽ trên ảnh hoặc nhập số)'),
    el('div', { class: 'coords-grid', style: { marginTop: '8px' } },
      ...[['x', 'X'], ['y', 'Y'], ['w', 'W'], ['h', 'H']].map(([k, label]) =>
        el('div', null,
          el('label', { class: 'field-label', style: { fontSize: '10px' } }, label),
          el('input', { type: 'number', class: 'input', id: `wm-${k}`, value: '0', min: 0 }),
        )),
    ),
    el('div', { class: 'field-group', style: { marginTop: '12px' } },
      el('label', { class: 'field-label' }, 'Padding'),
      el('input', { type: 'number', class: 'input', id: 'wm-pad', value: '10', min: 0 }),
    ),
    el('button', { class: 'btn btn-primary', style: { width: '100%', marginTop: '12px' }, id: 'wm-go' },
      icon('sparkles'), 'Xóa watermark',
    ),
    el('div', { class: 'field-help', style: { marginTop: '8px' } },
      'Backend dùng OpenCV inpaint (TELEA). Tab Video hỗ trợ LaMa AI chất lượng cao hơn.'),
  ));

  const right = el('div', { class: 'card' },
    el('h3', { class: 'card-title' }, 'Xem trước & vẽ vùng'),
    el('div', { id: 'wm-canvas-wrap', style: { position: 'relative', marginTop: '12px', userSelect: 'none' } },
      el('div', { class: 'empty' },
        el('div', { class: 'empty-icon' }, icon('image', 32)),
        el('div', null, 'Chưa có ảnh'),
      ),
    ),
    el('div', { id: 'wm-result', style: { marginTop: '16px' } }),
  );
  layout.appendChild(right);

  const dz = root.querySelector('#wm-dz');
  const fi = root.querySelector('#wm-file');
  dz.addEventListener('click', () => fi.click());
  fi.addEventListener('change', () => {
    file = fi.files[0];
    _st.file = file;
    if (!file) return;
    showImage();
  });

  function showImage() {
    const wrap = root.querySelector('#wm-canvas-wrap');
    clear(wrap);
    const container = el('div', { style: { position: 'relative', display: 'inline-block', maxWidth: '100%' } });
    // draggable=false: <img> elements are draggable by default in browsers
    // (native HTML5 drag-and-drop). That hijacks pointer events and shows a
    // ghost image instead of letting us draw a rect. -webkit-user-drag in
    // CSS is the Safari/Chrome equivalent for older engines.
    imageEl = el('img', {
      src: URL.createObjectURL(file),
      draggable: 'false',
      style: {
        maxWidth: '100%', borderRadius: '8px', cursor: 'crosshair',
        display: 'block', WebkitUserDrag: 'none', userSelect: 'none',
        pointerEvents: 'none',   // events go to the overlay instead
      },
    });
    // Overlay is the ACTUAL event target — sits on top of the img and
    // catches pointer events. Previously we listened on the img directly
    // but browsers' native image drag kept hijacking the drag.
    const overlay = el('div', {
      style: {
        position: 'absolute', inset: 0,
        cursor: 'crosshair', userSelect: 'none', touchAction: 'none',
      },
    });
    const rectBox = el('div', {
      style: {
        position: 'absolute', border: '2px dashed #00d4ff',
        background: 'rgba(0,212,255,0.12)', display: 'none',
        pointerEvents: 'none',   // don't block the overlay's events
      },
    });
    overlay.appendChild(rectBox);
    container.appendChild(imageEl);
    container.appendChild(overlay);
    wrap.appendChild(container);

    function localCoords(e) {
      const r = overlay.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    function updateBoxFrom(cx, cy) {
      const x = Math.min(cx, startPt.x), y = Math.min(cy, startPt.y);
      const w = Math.abs(cx - startPt.x), h = Math.abs(cy - startPt.y);
      rectBox.style.left = x + 'px';
      rectBox.style.top = y + 'px';
      rectBox.style.width = w + 'px';
      rectBox.style.height = h + 'px';
    }

    overlay.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      drawing = true;
      startPt = localCoords(e);
      rectBox.style.display = 'block';
      updateBoxFrom(startPt.x, startPt.y);
      overlay.setPointerCapture(e.pointerId);
    });
    overlay.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      const { x: cx, y: cy } = localCoords(e);
      updateBoxFrom(cx, cy);
    });
    overlay.addEventListener('pointerup', (e) => {
      if (!drawing) return;
      drawing = false;
      try { overlay.releasePointerCapture(e.pointerId); } catch (_) {}
      // Convert displayed-pixel rect → natural image pixel rect
      const { x: cx, y: cy } = localCoords(e);
      const x = Math.min(cx, startPt.x), y = Math.min(cy, startPt.y);
      const w = Math.abs(cx - startPt.x), h = Math.abs(cy - startPt.y);
      const scale = imageEl.naturalWidth / imageEl.clientWidth;
      rect = {
        x: Math.round(x * scale),
        y: Math.round(y * scale),
        w: Math.round(w * scale),
        h: Math.round(h * scale),
      };
      root.querySelector('#wm-x').value = rect.x;
      root.querySelector('#wm-y').value = rect.y;
      root.querySelector('#wm-w').value = rect.w;
      root.querySelector('#wm-h').value = rect.h;
    });
    // Cancel a half-drawn rect if the pointer leaves while still down
    // (e.g. user dragged off the page edge)
    overlay.addEventListener('pointercancel', () => { drawing = false; });
  }

  root.querySelector('#wm-go').addEventListener('click', async () => {
    if (!file) return toast('Cần chọn ảnh', 'warning');
    const x = parseInt(root.querySelector('#wm-x').value, 10);
    const y = parseInt(root.querySelector('#wm-y').value, 10);
    const w = parseInt(root.querySelector('#wm-w').value, 10);
    const h = parseInt(root.querySelector('#wm-h').value, 10);
    if (w <= 0 || h <= 0) return toast('Vẽ vùng watermark trên ảnh', 'warning');
    const btn = root.querySelector('#wm-go');
    setLoading(btn, true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('x', x); fd.append('y', y);
      fd.append('w', w); fd.append('h', h);
      fd.append('padding', root.querySelector('#wm-pad').value);
      const r = await api.media.watermark(fd);
      _st.resultUrl = r.url;
      showResult(r.url);
      toast('Đã xóa watermark', 'success');
    } catch (e) { toast(e.message, 'error'); }
    finally { setLoading(btn, false); }
  });

  function showResult(url) {
    const out = root.querySelector('#wm-result');
    clear(out);
    out.appendChild(el('h4', { style: { marginTop: 0 } }, 'Sau khi xóa'));
    out.appendChild(el('img', { src: url, class: 'thumb', style: { maxHeight: '420px', objectFit: 'contain' } }));
    out.appendChild(el('a', { href: url, download: '', class: 'btn btn-primary', style: { marginTop: '8px' } },
      icon('download'), 'Tải về'));
  }

  // Restore source image (for redraw) + result after returning to this tab
  if (file) showImage();
  if (_st.resultUrl) showResult(_st.resultUrl);
}
