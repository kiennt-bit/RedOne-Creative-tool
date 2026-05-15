// Upscale page
import { el, clear, toast, setLoading, icon } from '../ui.js';
import { api } from '../api.js';

export function renderUpscale(root) {
  let file = null;

  root.appendChild(el('div', { class: 'page-hero' },
    el('div', { class: 'hero-icon' }, icon('sparkles', 28)),
    el('div', { class: 'hero-text' },
      el('h2', null, 'Upscale Ảnh'),
      el('p', null, 'Phóng to ảnh giữ nét bằng Lanczos (cài Real-ESRGAN để chất lượng AI cao hơn)'),
    ),
  ));

  const layout = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' } });
  root.appendChild(layout);

  layout.appendChild(el('div', { class: 'card' },
    el('h3', { class: 'card-title' }, 'Ảnh nguồn'),
    el('div', { class: 'dropzone', id: 'up-dz', style: { marginTop: '12px' } },
      el('div', { class: 'dropzone-icon' }, icon('upload', 24)),
      el('div', null, 'Kéo thả hoặc click'),
      el('input', { type: 'file', accept: 'image/*', id: 'up-file', style: { display: 'none' } }),
    ),
    el('div', { id: 'up-preview', style: { marginTop: '12px' } }),
    el('div', { class: 'field-group', style: { marginTop: '16px' } },
      el('label', { class: 'field-label' }, 'Hệ số phóng to'),
      el('select', { class: 'select', id: 'up-scale' },
        el('option', { value: '2' }, '2× (nhanh)'),
        el('option', { value: '4', selected: 'true' }, '4× (chất lượng cao)'),
        el('option', { value: '8' }, '8× (rất nặng)'),
      ),
    ),
    el('button', { class: 'btn btn-primary', style: { width: '100%' }, id: 'up-go' },
      icon('sparkles'), 'Upscale',
    ),
  ));

  layout.appendChild(el('div', { class: 'card' },
    el('h3', { class: 'card-title' }, 'Kết quả'),
    el('div', { id: 'up-result', style: { marginTop: '12px' } },
      el('div', { class: 'empty' },
        el('div', { class: 'empty-icon' }, icon('image', 32)),
        el('div', null, 'Chưa có kết quả'),
      ),
    ),
  ));

  const dz = root.querySelector('#up-dz');
  const fi = root.querySelector('#up-file');
  dz.addEventListener('click', () => fi.click());
  fi.addEventListener('change', () => {
    file = fi.files[0]; if (!file) return;
    const preview = root.querySelector('#up-preview');
    preview.innerHTML = '';
    preview.appendChild(el('img', { src: URL.createObjectURL(file), class: 'thumb', style: { maxHeight: '200px', objectFit: 'contain' } }));
  });

  root.querySelector('#up-go').addEventListener('click', async () => {
    if (!file) return toast('Cần chọn ảnh', 'warning');
    const btn = root.querySelector('#up-go');
    setLoading(btn, true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('scale', root.querySelector('#up-scale').value);
      const r = await api.media.upscale(fd);
      const out = root.querySelector('#up-result');
      clear(out);
      out.appendChild(el('img', { src: r.url, class: 'thumb', style: { maxHeight: '420px', objectFit: 'contain' } }));
      if (r.note) out.appendChild(el('div', { class: 'field-help', style: { marginTop: '8px' } }, r.note));
      out.appendChild(el('a', { href: r.url, download: '', class: 'btn btn-primary', style: { marginTop: '8px' } },
        icon('download'), 'Tải về'));
      toast('Đã upscale', 'success');
    } catch (e) { toast(e.message, 'error'); }
    finally { setLoading(btn, false); }
  });
}
