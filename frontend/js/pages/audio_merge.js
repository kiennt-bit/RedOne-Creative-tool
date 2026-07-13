// Audio merge page
import { el, clear, toast, setLoading, icon } from '../ui.js';
import { api } from '../api.js';

export function renderAudioMerge(root) {
  let video = null, audio = null;

  root.appendChild(el('div', { class: 'page-hero' },
    el('div', { class: 'hero-icon' }, icon('play', 28)),
    el('div', { class: 'hero-text' },
      el('h2', null, 'Ghép Audio Vào Video'),
      el('p', null, 'Thay hoặc trộn audio với video bằng FFmpeg'),
    ),
  ));

  const layout = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' } });
  root.appendChild(layout);

  layout.appendChild(el('div', { class: 'card' },
    el('div', { class: 'field-group' },
      el('label', { class: 'field-label' }, 'Video'),
      el('div', { class: 'dropzone', id: 'am-vdz' },
        el('div', { class: 'dropzone-icon' }, icon('play', 24)),
        el('div', null, 'Chọn video (MP4)'),
        el('div', { class: 'field-help', id: 'am-vinfo' }),
        el('input', { type: 'file', accept: 'video/*', id: 'am-vfile', style: { display: 'none' } }),
      ),
    ),
    el('div', { class: 'field-group' },
      el('label', { class: 'field-label' }, 'Audio'),
      el('div', { class: 'dropzone', id: 'am-adz' },
        el('div', { class: 'dropzone-icon' }, icon('upload', 24)),
        el('div', null, 'Chọn audio (MP3/WAV)'),
        el('div', { class: 'field-help', id: 'am-ainfo' }),
        el('input', { type: 'file', accept: 'audio/*', id: 'am-afile', style: { display: 'none' } }),
      ),
    ),
    el('div', { class: 'field-group' },
      el('label', { class: 'field-label', style: { display: 'flex', alignItems: 'center', gap: '10px' } },
        el('label', { class: 'toggle' },
          el('input', { type: 'checkbox', id: 'am-replace', checked: 'true' }),
          el('span', { class: 'toggle-track' }),
        ),
        el('span', null, 'Thay thế audio gốc (off = trộn lẫn)'),
      ),
    ),
    el('button', { class: 'btn btn-primary', style: { width: '100%', marginTop: '12px' }, id: 'am-go' },
      icon('sparkles'), 'Ghép',
    ),
  ));

  layout.appendChild(el('div', { class: 'card' },
    el('h3', { class: 'card-title' }, 'Kết quả'),
    el('div', { id: 'am-result', style: { marginTop: '12px' } },
      el('div', { class: 'empty' },
        el('div', { class: 'empty-icon' }, icon('play', 32)),
        el('div', null, 'Chưa có video kết quả'),
      ),
    ),
  ));

  function wire(dropId, fileId, infoId, callback) {
    const dz = root.querySelector(dropId);
    const fi = root.querySelector(fileId);
    const info = root.querySelector(infoId);
    dz.addEventListener('click', () => fi.click());
    fi.addEventListener('change', () => {
      if (!fi.files[0]) return;
      info.textContent = `${fi.files[0].name} (${(fi.files[0].size/1024/1024).toFixed(1)} MB)`;
      callback(fi.files[0]);
    });
  }
  wire('#am-vdz', '#am-vfile', '#am-vinfo', f => video = f);
  wire('#am-adz', '#am-afile', '#am-ainfo', f => audio = f);

  root.querySelector('#am-go').addEventListener('click', async () => {
    if (!video || !audio) return toast('Cần chọn cả video và audio', 'warning');
    const btn = root.querySelector('#am-go');
    setLoading(btn, true);
    try {
      const fd = new FormData();
      fd.append('video', video);
      fd.append('audio', audio);
      fd.append('replace', root.querySelector('#am-replace').checked ? 'true' : 'false');
      const r = await api.media.audioMerge(fd);
      const out = root.querySelector('#am-result');
      clear(out);
      out.appendChild(el('video', { src: r.url, controls: true, class: 'video-preview' }));
      out.appendChild(el('a', { href: r.url, download: '', class: 'btn btn-primary', style: { marginTop: '8px' } },
        icon('download'), 'Tải về'));

      toast('Đã ghép xong', 'success');
    } catch (e) { toast(e.message, 'error'); }
    finally { setLoading(btn, false); }
  });
}
