// YouTube / TikTok analyzer page
import { el, clear, toast, setLoading, icon } from '../ui.js';
import { api } from '../api.js';

// Module-level state → survives SPA tab navigation. renderYoutube() restores
// the storyboard + inputs from here, so switching tabs no longer wipes results.
const state = { mode: 'url', scenes: [], modelUsed: null, lastData: null, inputs: {} };

export function renderYoutube(root) {

  root.appendChild(el('div', { class: 'page-hero' },
    el('div', { class: 'hero-icon' }, icon('sparkles', 28)),
    el('div', { class: 'hero-text' },
      el('h2', null, 'YouTube / TikTok → Storyboard'),
      el('p', null, 'Phân tích video sang storyboard prompt Veo 3 với Gemini Vision'),
    ),
  ));

  const layout = el('div', { style: { display: 'grid', gridTemplateColumns: '380px 1fr', gap: '20px' } });
  root.appendChild(layout);

  // LEFT
  const left = el('div', null,
    el('div', { class: 'card' },
      el('div', { class: 'tabs', style: { marginBottom: '16px' } },
        el('button', { class: 'tab active', onclick: (e) => switchMode(e, 'url') }, 'Dán link'),
        el('button', { class: 'tab', onclick: (e) => switchMode(e, 'upload') }, 'Upload video'),
      ),
      el('div', { id: 'yt-url-block' },
        el('div', { class: 'field-group' },
          el('label', { class: 'field-label' }, 'URL YouTube / TikTok'),
          el('input', { class: 'input', id: 'yt-url', placeholder: 'https://youtube.com/watch?v=...' }),
        ),
      ),
      el('div', { id: 'yt-upload-block', style: { display: 'none' } },
        el('div', { class: 'field-group' },
          el('label', { class: 'field-label' }, 'Chọn video'),
          el('div', { class: 'dropzone', id: 'yt-dropzone' },
            el('div', { class: 'dropzone-icon' }, icon('upload', 24)),
            el('div', null, 'Kéo thả hoặc click để chọn'),
            el('div', { class: 'field-help' }, 'MP4 / MOV, dưới 100MB khuyến nghị'),
            el('input', { type: 'file', accept: 'video/*', id: 'yt-file', style: { display: 'none' } }),
          ),
          el('div', { id: 'yt-file-info', class: 'field-help', style: { marginTop: '8px' } }),
        ),
      ),
      el('div', { class: 'field-group' },
        el('label', { class: 'field-label' }, 'Phong cách'),
        el('select', { class: 'select', id: 'yt-style' },
          ...['Cinematic', '3D CGI Pixar', 'Anime', 'Realistic Film', 'Documentary', 'Music Video']
            .map(s => el('option', { value: s }, s)),
        ),
      ),
      el('div', { class: 'field-group' },
        el('label', { class: 'field-label' }, 'Style Lock (override)'),
        el('textarea', { class: 'textarea', id: 'yt-stylelock', rows: 2,
          placeholder: 'Ép buộc phong cách cố định (vd: hyperrealistic 4k cinematic...)' }),
      ),
      el('div', { class: 'field-group' },
        el('label', { class: 'field-label' }, 'Số cảnh tối đa'),
        el('input', { type: 'number', class: 'input', id: 'yt-max', value: 12, min: 1, max: 40 }),
      ),
      el('div', { class: 'field-group' },
        el('label', { class: 'field-label', style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          el('input', { type: 'checkbox', id: 'yt-quick', checked: 'true' }),
          'Chế độ nhanh (tóm tắt narration)',
        ),
      ),
      el('div', { style: { marginTop: '16px' } },
        el('button', { class: 'btn btn-primary', style: { width: '100%' }, id: 'yt-analyze' },
          icon('sparkles'), 'Phân tích',
        ),
      ),
    ),
  );
  layout.appendChild(left);

  // RIGHT
  const right = el('div', null,
    el('div', { class: 'card' },
      el('div', { class: 'card-header' },
        el('h3', { class: 'card-title' }, 'Storyboard kết quả'),
        el('div', { class: 'card-subtitle', id: 'yt-status' }, 'Chưa phân tích'),
      ),
      el('div', { id: 'yt-banner' }),
      el('div', { id: 'yt-results' },
        el('div', { class: 'empty' },
          el('div', { class: 'empty-icon' }, icon('sparkles', 32)),
          el('div', null, 'Nhập URL / upload video rồi bấm Phân tích'),
        ),
      ),
    ),
  );
  layout.appendChild(right);

  function switchMode(e, mode) {
    state.mode = mode;
    root.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    e.currentTarget.classList.add('active');
    root.querySelector('#yt-url-block').style.display = mode === 'url' ? 'block' : 'none';
    root.querySelector('#yt-upload-block').style.display = mode === 'upload' ? 'block' : 'none';
  }

  // Dropzone
  const dz = root.querySelector('#yt-dropzone');
  const fi = root.querySelector('#yt-file');
  dz.addEventListener('click', () => fi.click());
  fi.addEventListener('change', () => {
    const f = fi.files[0];
    if (!f) return;
    root.querySelector('#yt-file-info').textContent = `${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)`;
  });

  // Analyze
  root.querySelector('#yt-analyze').addEventListener('click', async () => {
    const btn = root.querySelector('#yt-analyze');
    setLoading(btn, true);
    root.querySelector('#yt-banner').innerHTML = '';
    root.querySelector('#yt-status').textContent = 'Đang phân tích...';
    try {
      let data;
      if (state.mode === 'url') {
        const url = root.querySelector('#yt-url').value.trim();
        if (!url) throw new Error('Cần URL');
        data = await api.analyzer.youtube({
          url,
          style_preset: root.querySelector('#yt-style').value,
          style_lock: root.querySelector('#yt-stylelock').value || null,
          quick_mode: root.querySelector('#yt-quick').checked,
          max_scenes: parseInt(root.querySelector('#yt-max').value, 10),
        });
      } else {
        const file = fi.files[0];
        if (!file) throw new Error('Cần chọn video');
        const fd = new FormData();
        fd.append('file', file);
        fd.append('style_preset', root.querySelector('#yt-style').value);
        fd.append('max_scenes', String(root.querySelector('#yt-max').value));
        data = await api.analyzer.youtubeUpload(fd);
      }
      state.scenes = data.scenes || [];
      state.modelUsed = data.model_used;
      state.lastData = data;
      _saveInputs();
      renderBanner(data);
      renderScenes(state.scenes);
      root.querySelector('#yt-status').textContent = `Đã sinh ${state.scenes.length} cảnh`;
      toast(`Phân tích xong (${state.scenes.length} cảnh)`, 'success');
    } catch (e) {
      root.querySelector('#yt-status').textContent = 'Lỗi';
      toast(`Lỗi: ${e.message}`, 'error');
    } finally {
      setLoading(btn, false);
    }
  });

  function renderBanner(data) {
    const banner = root.querySelector('#yt-banner');
    const fb = data.fallback_log || [];
    const type = fb.length > 0 ? 'warning' : 'success';
    banner.innerHTML = '';
    banner.appendChild(el('div', { class: `ai-banner ${type}` },
      icon('sparkles', 18),
      el('div', null,
        el('div', { style: { fontWeight: 700 } },
          fb.length > 0 ? `AI Engine: ${data.model_used} (đã fallback ${fb.length} lần)` : `AI Engine: ${data.model_used}`,
        ),
        el('div', { style: { fontSize: '11.5px', opacity: 0.8 } },
          `Đã phân tích ${data.scenes?.length || 0} cảnh từ ${data.platform || '?'} • ${data.title || ''}`),
      ),
    ));
  }

  function renderScenes(scenes) {
    const wrap = root.querySelector('#yt-results');
    clear(wrap);
    const grid = el('div', { class: 'scene-grid' });
    scenes.forEach((sc, i) => {
      const card = el('div', { class: 'scene-card sb-card' },
        el('div', { class: 'scene-info' },
          el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' } },
            el('span', { class: 'sb-num' }, `Cảnh ${sc.scene || i + 1}`),
            el('div', { class: 'scene-meta', style: { margin: 0 } },
              sc.shot ? el('span', { class: 'chip chip-blue' }, sc.shot) : null,
              sc.camera ? el('span', { class: 'chip chip-purple' }, sc.camera) : null,
            ),
          ),
          sc.narration ? el('div', { class: 'sb-narration' }, `"${sc.narration}"`) : null,
          el('div', { class: 'scene-prompt' }, sc.prompt || sc.narration || ''),
          el('div', { class: 'scene-actions' },
            el('button', { class: 'btn btn-sm btn-ghost', title: 'Copy prompt', onclick: () => {
              navigator.clipboard.writeText(sc.prompt || '');
              toast('Đã copy prompt', 'success');
            } }, icon('copy', 14)),
            el('button', { class: 'btn btn-sm btn-ghost', title: 'Sửa', onclick: () => editScene(i) }, icon('edit', 14)),
            el('button', { class: 'btn btn-sm btn-primary', title: 'Gửi sang Tạo Video', onclick: () => sendToContent(sc) },
              icon('play', 14), 'Video'),
            el('button', { class: 'btn btn-sm btn-ghost', title: 'Gửi sang Tạo Ảnh', onclick: () => sendToImage(sc) },
              icon('image', 14), 'Ảnh'),
          ),
        ),
      );
      grid.appendChild(card);
    });
    wrap.appendChild(grid);
    // Send all button
    wrap.prepend(el('div', { style: { marginBottom: '12px', display: 'flex', gap: '8px' } },
      el('button', { class: 'btn btn-primary', onclick: () => sendAllToContent() },
        icon('play'), `Tạo tất cả ${scenes.length} video`),
      el('button', { class: 'btn btn-ghost', onclick: () => sendAllToImage() },
        icon('image'), `Tạo tất cả ${scenes.length} ảnh`),
      el('button', { class: 'btn btn-ghost', onclick: () => {
        const json = JSON.stringify(scenes, null, 2);
        navigator.clipboard.writeText(json);
        toast('Đã copy JSON', 'success');
      } }, icon('copy'), 'Copy JSON'),
    ));
  }

  function editScene(i) {
    const sc = state.scenes[i];
    const textarea = el('textarea', { class: 'textarea', rows: 6 }, sc.prompt || '');
    import('../ui.js').then(({ modal }) => {
      modal({
        title: `Sửa cảnh #${sc.scene}`,
        body: textarea,
        actions: [
          { label: 'Hủy', class: 'btn-ghost' },
          { label: 'Lưu', class: 'btn-primary', onclick: (close) => {
            sc.prompt = textarea.value;
            renderScenes(state.scenes);
            close();
            toast('Đã lưu', 'success');
          } },
        ],
      });
    });
  }

  function sendToContent(scene) {
    sessionStorage.setItem('inject_prompts', JSON.stringify([scene.prompt]));
    window.__app.navigate('content');
    toast('Đã chuyển sang Tạo Video', 'success');
  }
  function sendAllToContent() {
    const prompts = state.scenes.map(s => s.prompt).filter(Boolean);
    sessionStorage.setItem('inject_prompts', JSON.stringify(prompts));
    window.__app.navigate('content');
    toast(`Đã chuyển ${prompts.length} prompts`, 'success');
  }
  function sendToImage(scene) {
    sessionStorage.setItem('inject_prompts', JSON.stringify([scene.prompt]));
    window.__app.navigate('image');
    toast('Đã chuyển sang Tạo Ảnh', 'success');
  }
  function sendAllToImage() {
    const prompts = state.scenes.map(s => s.prompt).filter(Boolean);
    sessionStorage.setItem('inject_prompts', JSON.stringify(prompts));
    window.__app.navigate('image');
    toast(`Đã chuyển ${prompts.length} prompts sang Tạo Ảnh`, 'success');
  }

  function _saveInputs() {
    state.inputs = {
      url: root.querySelector('#yt-url')?.value || '',
      style: root.querySelector('#yt-style')?.value || '',
      stylelock: root.querySelector('#yt-stylelock')?.value || '',
      max: root.querySelector('#yt-max')?.value || '12',
      quick: !!root.querySelector('#yt-quick')?.checked,
      mode: state.mode,
    };
  }

  // Restore inputs + storyboard after returning to this tab (state is
  // module-level so the previous analysis isn't lost on navigation).
  (function _restore() {
    const inp = state.inputs || {};
    const set = (id, v) => { const e = root.querySelector(id); if (e && v != null) e.value = v; };
    set('#yt-url', inp.url);
    set('#yt-style', inp.style);
    set('#yt-stylelock', inp.stylelock);
    set('#yt-max', inp.max);
    const q = root.querySelector('#yt-quick');
    if (q && typeof inp.quick === 'boolean') q.checked = inp.quick;
    if (inp.mode === 'upload') {
      state.mode = 'upload';
      root.querySelectorAll('.tab').forEach((t, idx) => t.classList.toggle('active', idx === 1));
      root.querySelector('#yt-url-block').style.display = 'none';
      root.querySelector('#yt-upload-block').style.display = 'block';
    }
    if (state.lastData) renderBanner(state.lastData);
    if (state.scenes && state.scenes.length) {
      renderScenes(state.scenes);
      const st = root.querySelector('#yt-status');
      if (st) st.textContent = `Đã sinh ${state.scenes.length} cảnh`;
    }
  })();
}
