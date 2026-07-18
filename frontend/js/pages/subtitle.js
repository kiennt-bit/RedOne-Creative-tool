// Subtitle generator page (Whisper)
import { el, clear, toast, setLoading, icon, wireDropzone } from '../ui.js';
import { api } from '../api.js';

// Module-level state → survives SPA tab navigation. The Whisper job runs on the
// backend as a detached job; we poll its status so leaving/returning to the tab
// keeps the live %.
const st = {
  file: null, jobId: null,
  status: 'idle',            // idle | running | done | error
  percent: 0, stage: '',
  result: null, error: null,
};
let _pollTimer = null;

function _stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

function _startPolling() {
  if (_pollTimer || !st.jobId) return;
  _pollTimer = setInterval(async () => {
    if (!st.jobId) { _stopPolling(); return; }
    try {
      const s = await api.media.subtitleStatus(st.jobId);
      st.percent = s.percent || 0;
      st.stage = s.stage || '';
      st.status = s.status || 'running';
      if (s.status === 'done') { st.result = s; _stopPolling(); }
      else if (s.status === 'error') { st.error = s.error || 'Lỗi'; _stopPolling(); }
    } catch (e) {
      if (e.status === 404) {
        st.status = 'error';
        st.error = 'Mất tiến trình (server đã khởi động lại). Hãy chạy lại.';
        st.jobId = null;
        _stopPolling();
      }
      // other errors: keep polling (transient)
    }
    _paint();
  }, 1000);
}

// Repaint result/progress + button state. No-ops safely when the subtitle tab
// isn't mounted (state is kept and repainted on return).
function _paint() {
  const btn = document.querySelector('#sb-go');
  if (btn) btn.disabled = st.status === 'running';
  const out = document.querySelector('#sb-result');
  if (!out) return;
  clear(out);
  if (st.status === 'running') {
    out.appendChild(el('div', { class: 'field-label', style: { marginBottom: '8px' } }, st.stage || 'Đang xử lý…'));
    out.appendChild(el('div', { style: { height: '10px', background: 'var(--bg-3)', borderRadius: '999px', overflow: 'hidden' } },
      el('div', { style: { width: `${st.percent}%`, height: '100%', background: 'var(--brand)', transition: 'width .3s ease' } }),
    ));
    out.appendChild(el('div', { style: { textAlign: 'right', fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px', fontVariantNumeric: 'tabular-nums' } }, `${st.percent}%`));
    return;
  }
  if (st.status === 'error') {
    out.appendChild(el('div', { class: 'ai-banner error' }, icon('x', 18), el('div', null, st.error || 'Lỗi')));
    return;
  }
  if (st.status === 'done' && st.result) {
    out.appendChild(el('div', { class: 'ai-banner success' },
      icon('check', 18),
      el('div', null, `Nhận diện ngôn ngữ: ${st.result.language || '?'} • ${st.result.segments} đoạn`),
    ));
    out.appendChild(el('a', { href: st.result.url, download: '', class: 'btn btn-primary', style: { marginTop: '8px' } },
      icon('download'), 'Tải SRT'));
    return;
  }
  out.appendChild(el('div', { class: 'empty' },
    el('div', { class: 'empty-icon' }, icon('sparkles', 32)),
    el('div', null, 'Chưa có phụ đề'),
  ));
}

export function renderSubtitle(root) {

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
  const infoEl = root.querySelector('#sb-info');
  dz.addEventListener('click', () => fi.click());
  wireDropzone(dz, fi);
  fi.addEventListener('change', () => {
    st.file = fi.files[0]; if (!st.file) return;
    infoEl.textContent = `${st.file.name} (${(st.file.size/1024/1024).toFixed(1)} MB)`;
  });

  root.querySelector('#sb-go').addEventListener('click', async () => {
    if (!st.file) return toast('Cần chọn file', 'warning');
    if (st.status === 'running') return toast('Đang sinh phụ đề…', 'info');
    const btn = root.querySelector('#sb-go');
    setLoading(btn, true);
    try {
      const fd = new FormData();
      fd.append('file', st.file);
      fd.append('model_size', root.querySelector('#sb-model').value);
      fd.append('language', root.querySelector('#sb-lang').value);
      const r = await api.media.subtitle(fd);   // returns { job_id }
      st.jobId = r.job_id;
      st.status = 'running'; st.percent = 0; st.stage = 'Đang chuẩn bị…';
      st.result = null; st.error = null;
      _startPolling();
      toast('Đã bắt đầu sinh phụ đề', 'info');
    } catch (e) { toast(e.message, 'error'); }
    finally { setLoading(btn, false); _paint(); }
  });

  // Restore state when returning to the tab (job keeps running on the backend).
  if (st.file) infoEl.textContent = `${st.file.name} (${(st.file.size/1024/1024).toFixed(1)} MB)`;
  _paint();
  if (st.status === 'running') _startPolling();
}
