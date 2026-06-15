// Background remove page
import { el, clear, toast, setLoading, icon } from '../ui.js';
import { api } from '../api.js';

// Module-level state → survives SPA tab navigation (file object + result URL
// stay valid in memory; only a full browser refresh clears them).
const _st = { file: null, resultUrl: null };

export function renderBgRemove(root) {
  let file = _st.file;

  root.appendChild(el('div', { class: 'page-hero' },
    el('div', { class: 'hero-icon' }, icon('image', 28)),
    el('div', { class: 'hero-text' },
      el('h2', null, 'Tách Nền Ảnh'),
      el('p', null, 'Xóa background ảnh bằng rembg (offline)'),
    ),
  ));

  const layout = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' } });
  root.appendChild(layout);

  layout.appendChild(el('div', { class: 'card' },
    el('h3', { class: 'card-title' }, 'Ảnh nguồn'),
    el('div', { class: 'dropzone', id: 'bg-dz', style: { marginTop: '12px' } },
      el('div', { class: 'dropzone-icon' }, icon('upload', 24)),
      el('div', null, 'Kéo thả hoặc click'),
      el('input', { type: 'file', accept: 'image/*', id: 'bg-file', style: { display: 'none' } }),
    ),
    el('div', { id: 'bg-preview', style: { marginTop: '12px' } }),
    el('div', { class: 'field-group', style: { marginTop: '16px' } },
      el('label', { class: 'field-label' }, 'Phương pháp'),
      el('select', { class: 'select', id: 'bg-method' },
        el('option', { value: 'rembg', selected: 'true' }, 'rembg (offline, miễn phí)'),
      ),
    ),
    el('div', { class: 'field-group' },
      el('label', { class: 'field-label' }, 'Màu nền (tùy chọn)'),
      el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
        el('input', { type: 'color', class: 'color-input', id: 'bg-color', value: '#000000' }),
        el('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' } },
          el('input', { type: 'checkbox', id: 'bg-fill' }),
          'Fill nền màu này',
        ),
      ),
    ),
    el('button', { class: 'btn btn-primary', style: { width: '100%', marginTop: '12px' }, id: 'bg-go' },
      icon('sparkles'), 'Tách nền',
    ),
  ));

  layout.appendChild(el('div', { class: 'card' },
    el('h3', { class: 'card-title' }, 'Kết quả'),
    el('div', { class: 'result-display checker-bg', id: 'bg-result', style: { marginTop: '12px', minHeight: '300px' } },
      el('div', { class: 'empty' },
        el('div', { class: 'empty-icon' }, icon('image', 32)),
        el('div', null, 'Chưa có kết quả'),
      ),
    ),
  ));

  const dz = root.querySelector('#bg-dz');
  const fi = root.querySelector('#bg-file');
  dz.addEventListener('click', () => fi.click());
  fi.addEventListener('change', () => {
    file = fi.files[0];
    _st.file = file;
    showPreview();
  });
  function showPreview() {
    if (!file) return;
    const preview = root.querySelector('#bg-preview');
    preview.innerHTML = '';
    preview.appendChild(el('img', { src: URL.createObjectURL(file), class: 'thumb', style: { maxHeight: '200px', objectFit: 'contain' } }));
  }
  function showResult(url) {
    const out = root.querySelector('#bg-result');
    clear(out);
    out.appendChild(el('img', { src: url, class: 'thumb', style: { maxHeight: '420px', objectFit: 'contain' } }));
    out.appendChild(el('div', { style: { marginTop: '8px', display: 'flex', gap: '8px' } },
      el('a', { href: url, download: '', class: 'btn btn-primary' }, icon('download'), 'Tải về')));
  }

  root.querySelector('#bg-go').addEventListener('click', async () => {
    if (!file) return toast('Cần chọn ảnh', 'warning');
    const btn = root.querySelector('#bg-go');
    setLoading(btn, true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('method', root.querySelector('#bg-method').value);
      if (root.querySelector('#bg-fill').checked) {
        fd.append('fill_color', root.querySelector('#bg-color').value);
      }
      const r = await api.media.bgRemove(fd);
      _st.resultUrl = r.url;
      showResult(r.url);
      toast('Đã tách nền', 'success');
    } catch (e) { toast(e.message, 'error'); }
    finally { setLoading(btn, false); }
  });

  // Restore preview + result after returning to this tab
  if (file) showPreview();
  if (_st.resultUrl) showResult(_st.resultUrl);
}
