// Image-to-Prompt page
import { el, clear, toast, setLoading, icon, geminiKeyNotice } from '../ui.js';
import { api } from '../api.js';

// Module-level state → the generated prompt survives SPA tab navigation.
const state = { output: '', instruction: '', loading: false };

// Current mount's renderer — an in-flight request (started before navigating
// away) calls this on resolve so the prompt lands on the page now shown.
let _liveRender = () => {};

export function renderImagePrompt(root) {
  let selectedFile = null;

  // Nhắc nhập Gemini API key nếu chưa có (tab này cần Gemini).
  const _gkn = geminiKeyNotice();
  if (_gkn) root.appendChild(_gkn);
  root.appendChild(el('div', { class: 'page-hero' },
    el('div', { class: 'hero-icon' }, icon('image', 28)),
    el('div', { class: 'hero-text' },
      el('h2', null, 'Ảnh → Prompt'),
      el('p', null, 'Upload ảnh, AI sẽ mô tả thành prompt cinematic cho Veo'),
    ),
  ));

  const layout = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' } });
  root.appendChild(layout);

  // LEFT: image input
  const left = el('div', { class: 'card' },
    el('h3', { class: 'card-title' }, 'Ảnh nguồn'),
    el('div', { class: 'dropzone', id: 'ip-dz', style: { marginTop: '12px' } },
      el('div', { class: 'dropzone-icon' }, icon('image', 24)),
      el('div', null, 'Kéo thả ảnh hoặc click'),
      el('div', { class: 'field-help' }, 'PNG / JPG / WEBP'),
      el('input', { type: 'file', accept: 'image/*', id: 'ip-file', style: { display: 'none' } }),
    ),
    el('div', { id: 'ip-preview', style: { marginTop: '12px' } }),
    el('div', { class: 'field-group', style: { marginTop: '16px' } },
      el('label', { class: 'field-label' }, 'Custom instruction (tùy chọn)'),
      el('textarea', { class: 'textarea', id: 'ip-inst', rows: 4,
        placeholder: 'Để trống → dùng prompt mặc định.\nVD: "Mô tả ảnh dưới góc nhìn phim Marvel..."' }),
    ),
    el('button', { class: 'btn btn-primary', style: { width: '100%' }, id: 'ip-go' },
      icon('sparkles'), 'Sinh prompt',
    ),
  );
  layout.appendChild(left);

  // RIGHT: result
  const right = el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('h3', { class: 'card-title' }, 'Prompt'),
      el('button', { class: 'btn btn-sm btn-ghost', id: 'ip-copy', disabled: 'true' },
        icon('copy', 14), 'Copy',
      ),
    ),
    el('textarea', { class: 'textarea', id: 'ip-output', rows: 14,
      placeholder: 'Prompt được sinh sẽ hiện ở đây...' }),
    el('button', { class: 'btn btn-primary', style: { width: '100%', marginTop: '12px' }, id: 'ip-send' },
      icon('play'), 'Gửi sang Tạo Video',
    ),
  );
  layout.appendChild(right);

  // Dropzone wiring
  const dz = root.querySelector('#ip-dz');
  const fi = root.querySelector('#ip-file');
  const preview = root.querySelector('#ip-preview');
  dz.addEventListener('click', () => fi.click());
  ['dragover', 'dragleave', 'drop'].forEach(ev => {
    dz.addEventListener(ev, e => {
      e.preventDefault();
      dz.classList.toggle('dragover', ev === 'dragover');
      if (ev === 'drop' && e.dataTransfer.files[0]) {
        fi.files = e.dataTransfer.files;
        showPreview();
      }
    });
  });
  fi.addEventListener('change', showPreview);
  function showPreview() {
    selectedFile = fi.files[0];
    if (!selectedFile) return;
    preview.innerHTML = '';
    preview.appendChild(el('img', { src: URL.createObjectURL(selectedFile), class: 'thumb', style: { maxHeight: '300px', objectFit: 'contain' } }));
  }

  // Render current state (prompt + loading) into THIS mount. Wired to the
  // module `_liveRender` so an in-flight request updates the live page even if
  // it was started from a previous mount (switch tab mid-generation → back).
  function renderState() {
    if (!root.isConnected) return;
    const out = root.querySelector('#ip-output');
    const copy = root.querySelector('#ip-copy');
    const go = root.querySelector('#ip-go');
    if (go) go.disabled = !!state.loading;
    if (state.loading) {
      if (out) { out.value = ''; out.placeholder = 'Đang sinh prompt…'; }
      if (copy) copy.disabled = true;
      return;
    }
    if (out) { out.value = state.output || ''; out.placeholder = 'Prompt được sinh sẽ hiện ở đây...'; }
    if (copy) copy.disabled = !state.output;
  }
  _liveRender = renderState;

  // Generate
  const goBtn = root.querySelector('#ip-go');
  const output = root.querySelector('#ip-output');
  const copyBtn = root.querySelector('#ip-copy');
  goBtn.addEventListener('click', async () => {
    if (!selectedFile) return toast('Cần chọn ảnh', 'warning');
    const fd = new FormData();
    fd.append('file', selectedFile);
    fd.append('instruction', root.querySelector('#ip-inst').value);
    state.instruction = root.querySelector('#ip-inst').value;
    state.loading = true;
    _liveRender();
    try {
      const r = await api.analyzer.imageToPrompt(fd);
      state.output = r.prompt || '';
      state.loading = false;
      _liveRender();
      toast('Đã sinh prompt', 'success');
    } catch (e) {
      state.loading = false;
      _liveRender();
      toast(e.message, 'error');
    }
  });
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(output.value);
    toast('Đã copy', 'success');
  });
  root.querySelector('#ip-send').addEventListener('click', () => {
    if (!output.value.trim()) return toast('Chưa có prompt', 'warning');
    sessionStorage.setItem('inject_prompts', JSON.stringify([output.value.trim()]));
    window.__app.navigate('content');
  });

  // Restore the generated prompt + instruction after returning to this tab.
  // renderState() also shows the "đang sinh" state if a request is still
  // running (started before navigating away).
  if (state.instruction) root.querySelector('#ip-inst').value = state.instruction;
  renderState();
}
