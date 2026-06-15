// Subtitle generator page (Whisper)
import { el, clear, toast, setLoading, icon } from '../ui.js';
import { api } from '../api.js';

export function renderSubtitle(root) {
  let file = null;

  root.appendChild(el('div', { class: 'page-hero' },
    el('div', { class: 'hero-icon' }, icon('sparkles', 28)),
    el('div', { class: 'hero-text' },
      el('h2', null, 'Sinh Phụ Đề SRT'),
      el('p', null, 'Whisper offline — không tốn API. Lần đầu sẽ tải model ~145MB'),
    ),
  ));

  const layout = el('div', { style: { display: 'grid', gridTemplateColumns: '380px 1fr', gap: '20px' } });
  root.appendChild(layout);

  layout.appendChild(el('div', { class: 'card' },
    el('div', { class: 'field-group' },
      el('label', { class: 'field-label' }, 'Video / audio'),
      el('div', { class: 'dropzone', id: 'sb-dz' },
        el('div', { class: 'dropzone-icon' }, icon('upload', 24)),
        el('div', null, 'Chọn file'),
        el('div', { class: 'field-help', id: 'sb-info' }),
        el('input', { type: 'file', accept: 'video/*,audio/*', id: 'sb-file', style: { display: 'none' } }),
      ),
    ),
    el('div', { class: 'field-group' },
      el('label', { class: 'field-label' }, 'Whisper model'),
      el('select', { class: 'select', id: 'sb-model' },
        el('option', { value: 'tiny' }, 'tiny (~75MB) — nhanh nhất'),
        el('option', { value: 'base', selected: 'true' }, 'base (~145MB) — cân bằng'),
        el('option', { value: 'small' }, 'small (~490MB) — chính xác'),
        el('option', { value: 'medium' }, 'medium (~1.5GB) — rất chính xác'),
        el('option', { value: 'large' }, 'large (~3GB) — tốt nhất'),
      ),
    ),
    el('div', { class: 'field-group' },
      el('label', { class: 'field-label' }, 'Ngôn ngữ'),
      el('select', { class: 'select', id: 'sb-lang' },
        el('option', { value: 'auto', selected: 'true' }, 'Auto-detect'),
        el('option', { value: 'vi' }, 'Tiếng Việt'),
        el('option', { value: 'en' }, 'English'),
        el('option', { value: 'ja' }, '日本語'),
        el('option', { value: 'ko' }, '한국어'),
        el('option', { value: 'zh' }, '中文'),
      ),
    ),
    el('button', { class: 'btn btn-primary', style: { width: '100%', marginTop: '12px' }, id: 'sb-go' },
      icon('sparkles'), 'Sinh phụ đề',
    ),
    el('div', { class: 'field-help', style: { marginTop: '8px' } },
      'Cần cài: pip install openai-whisper'),
  ));

  layout.appendChild(el('div', { class: 'card' },
    el('h3', { class: 'card-title' }, 'Kết quả'),
    el('div', { id: 'sb-result', style: { marginTop: '12px' } },
      el('div', { class: 'empty' },
        el('div', { class: 'empty-icon' }, icon('sparkles', 32)),
        el('div', null, 'Chưa có phụ đề'),
      ),
    ),
  ));

  const dz = root.querySelector('#sb-dz');
  const fi = root.querySelector('#sb-file');
  dz.addEventListener('click', () => fi.click());
  fi.addEventListener('change', () => {
    file = fi.files[0]; if (!file) return;
    root.querySelector('#sb-info').textContent = `${file.name} (${(file.size/1024/1024).toFixed(1)} MB)`;
  });

  root.querySelector('#sb-go').addEventListener('click', async () => {
    if (!file) return toast('Cần chọn file', 'warning');
    const btn = root.querySelector('#sb-go');
    setLoading(btn, true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('model_size', root.querySelector('#sb-model').value);
      fd.append('language', root.querySelector('#sb-lang').value);
      const r = await api.media.subtitle(fd);
      const out = root.querySelector('#sb-result');
      clear(out);
      out.appendChild(el('div', { class: 'ai-banner success' },
        icon('check', 18),
        el('div', null, `Nhận diện ngôn ngữ: ${r.language || '?'} • ${r.segments} đoạn`),
      ));
      out.appendChild(el('a', { href: r.url, download: '', class: 'btn btn-primary' },
        icon('download'), 'Tải SRT'));
      toast('Đã sinh phụ đề', 'success');
    } catch (e) { toast(e.message, 'error'); }
    finally { setLoading(btn, false); }
  });
}
