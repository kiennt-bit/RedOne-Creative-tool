// Script-to-Prompt page — one-shot Gemini storyboard
import { el, clear, toast, setLoading, icon, modal } from '../ui.js';
import { api } from '../api.js';

// Module-level state → survives SPA tab navigation (restored on re-render).
// `mode` = 'video' (storyboard, Veo3) | 'image' (Gem-ported image prompts).
// `refs` holds optional reference-image File objects for image mode (survive
// SPA nav, cleared on full F5 like other ref-image flows).
const state = {
  scenes: [], script: '', modelUsed: null, lastData: null, inputs: {},
  mode: 'video', imagePrompts: [],
  refs: { subject: null, background: null, style: null },
};

export function renderScript(root) {

  root.appendChild(el('div', { class: 'page-hero' },
    el('div', { class: 'hero-icon' }, icon('sparkles', 28)),
    el('div', { class: 'hero-text' },
      el('h2', null, 'Ý Tưởng → Prompt'),
      el('p', null, 'Paste kịch bản, AI tự chia cảnh và sinh prompt — gửi sang Tạo Video hoặc Tạo Ảnh'),
    ),
  ));

  const layout = el('div', { style: { display: 'grid', gridTemplateColumns: '380px 1fr', gap: '20px' } });
  root.appendChild(layout);

  // Mode toggle buttons (declared first so setMode can reference them).
  const segVideo = el('button', { class: 'btn btn-sm btn-primary', style: { flex: 1 } }, icon('play', 14), 'Tạo Video');
  const segImage = el('button', { class: 'btn btn-sm btn-ghost', style: { flex: 1 } }, icon('image', 14), 'Tạo Ảnh');

  // Reference-image slot factory (image mode). Files live in state.refs.
  function makeImageSlot(key, label) {
    const thumb = el('div', { style: { width: '100%', aspectRatio: '1/1', borderRadius: '6px', background: 'var(--bg-3)', display: 'grid', placeItems: 'center', overflow: 'hidden', color: 'var(--text-faint)', position: 'relative' } });
    const fi = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    const box = el('div', { title: 'Click chọn ảnh', style: { border: '1px dashed var(--border-strong)', borderRadius: '8px', padding: '6px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'center' } },
      thumb,
      el('div', { style: { fontSize: '11px', color: 'var(--text-dim)' } }, label),
      fi,
    );
    function paint() {
      clear(thumb);
      const r = state.refs[key];
      if (r) {
        thumb.appendChild(el('img', { src: r.previewUrl, style: { width: '100%', height: '100%', objectFit: 'cover' } }));
        const x = el('div', { title: 'Bỏ ảnh', style: { position: 'absolute', top: '2px', right: '2px', width: '18px', height: '18px', borderRadius: '50%', background: 'rgba(0,0,0,0.6)', color: '#fff', display: 'grid', placeItems: 'center', fontSize: '13px', lineHeight: 1, cursor: 'pointer' } }, '×');
        x.addEventListener('click', (e) => { e.stopPropagation(); state.refs[key] = null; paint(); });
        thumb.appendChild(x);
      } else {
        thumb.appendChild(icon('plus', 18));
      }
    }
    box.addEventListener('click', () => fi.click());
    fi.addEventListener('change', () => {
      const f = fi.files[0];
      if (!f) return;
      state.refs[key] = { file: f, previewUrl: URL.createObjectURL(f), name: f.name };
      paint();
    });
    paint();
    return box;
  }

  // LEFT
  layout.appendChild(el('div', null,
    el('div', { class: 'card' },
      el('div', { class: 'field-group' },
        el('label', { class: 'field-label' }, 'Tạo prompt để'),
        el('div', { style: { display: 'flex', gap: '6px' } }, segVideo, segImage),
      ),
      // ── Video-mode fields ──
      el('div', { id: 'sc-video-fields' },
        el('div', { class: 'field-group' },
          el('label', { class: 'field-label' }, 'Phong cách'),
          el('select', { class: 'select', id: 'sc-style' },
            ...['Cinematic', '3D CGI Pixar', 'Anime', 'Realistic Film', 'Documentary', 'Music Video']
              .map(s => el('option', { value: s }, s)),
          ),
        ),
        el('div', { class: 'field-group' },
          el('label', { class: 'field-label' }, 'Số cảnh'),
          el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            el('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' } },
              el('input', { type: 'checkbox', id: 'sc-auto', checked: 'true' }),
              'Tự động',
            ),
            el('input', { type: 'number', class: 'input', id: 'sc-num', value: 5, min: 1, max: 40, style: { flex: 1 } }),
          ),
        ),
        el('div', { class: 'field-group' },
          el('label', { class: 'field-label' }, 'Style Lock'),
          el('textarea', { class: 'textarea', id: 'sc-stylelock', rows: 2,
            placeholder: 'Phong cách bắt buộc...' }),
        ),
        el('div', { class: 'field-group' },
          el('label', { class: 'field-label' }, 'Global context'),
          el('textarea', { class: 'textarea', id: 'sc-ctx', rows: 2,
            placeholder: 'Bối cảnh chung của video...' }),
        ),
        el('div', { class: 'field-group' },
          el('label', { class: 'field-label' }, 'Giọng đọc'),
          el('select', { class: 'select', id: 'sc-voice' },
            el('option', { value: 'female' }, 'Nữ'),
            el('option', { value: 'male' }, 'Nam'),
          ),
        ),
      ),
      // ── Image-mode fields ──
      el('div', { id: 'sc-image-fields', style: { display: 'none' } },
        el('div', { class: 'field-group' },
          el('label', { class: 'field-label' }, 'Số lượng prompt'),
          el('input', { type: 'number', class: 'input', id: 'sc-img-count', value: 10, min: 1 }),
          el('div', { class: 'field-help' }, 'Nhập bao nhiêu cũng được. Số quá lớn có thể bị cắt do giới hạn output của model.'),
        ),
        el('div', { class: 'field-group' },
          el('label', { class: 'field-label' }, 'Ảnh tham chiếu (tùy chọn)'),
          el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' } },
            makeImageSlot('subject', 'Chủ thể'),
            makeImageSlot('background', 'Bối cảnh'),
            makeImageSlot('style', 'Style'),
          ),
          el('div', { class: 'field-help' }, 'Gemini trích xuất chọn lọc: chủ thể từ ảnh 1, bối cảnh từ ảnh 2, style từ ảnh 3.'),
        ),
      ),
      el('div', { style: { marginTop: '12px' } },
        el('button', { class: 'btn btn-primary', style: { width: '100%' }, id: 'sc-go' },
          icon('sparkles'), el('span', { id: 'sc-go-label' }, 'Phân tích kịch bản'),
        ),
      ),
    ),
  ));

  function clearResults() {
    const wrap = root.querySelector('#sc-results');
    clear(wrap);
    wrap.appendChild(el('div', { class: 'empty' },
      el('div', { class: 'empty-icon' }, icon('sparkles', 32)),
      el('div', null, state.mode === 'image' ? 'Nhập ý tưởng rồi bấm Tạo prompt ảnh' : 'Nhập kịch bản rồi bấm Phân tích'),
    ));
  }

  function setMode(mode) {
    state.mode = mode === 'image' ? 'image' : 'video';
    const isImg = state.mode === 'image';
    root.querySelector('#sc-video-fields').style.display = isImg ? 'none' : '';
    root.querySelector('#sc-image-fields').style.display = isImg ? '' : 'none';
    segVideo.className = `btn btn-sm ${isImg ? 'btn-ghost' : 'btn-primary'}`;
    segImage.className = `btn btn-sm ${isImg ? 'btn-primary' : 'btn-ghost'}`;
    const lbl = root.querySelector('#sc-go-label');
    if (lbl) lbl.textContent = isImg ? 'Tạo prompt ảnh' : 'Phân tích kịch bản';
    // Show this mode's last results, or the empty hint.
    if (isImg) { state.imagePrompts.length ? renderImagePrompts(state.imagePrompts) : clearResults(); }
    else { state.scenes.length ? renderScenes(state.scenes) : clearResults(); }
  }
  segVideo.addEventListener('click', () => setMode('video'));
  segImage.addEventListener('click', () => setMode('image'));

  // RIGHT
  const right = el('div', null);
  layout.appendChild(right);

  right.appendChild(el('div', { class: 'card', style: { marginBottom: '16px' } },
    el('div', { class: 'card-header' },
      el('h3', { class: 'card-title' }, 'Kịch bản (tiếng Việt / Anh)'),
    ),
    el('textarea', { class: 'textarea', id: 'sc-script', rows: 8,
      placeholder: 'Dán hoặc nhập ý tưởng / kịch bản của bạn ở đây...' }),
  ));

  right.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-header' },
      el('h3', { class: 'card-title' }, 'Storyboard'),
      el('div', { class: 'card-subtitle', id: 'sc-status' }, 'Chưa phân tích'),
    ),
    el('div', { id: 'sc-banner' }),
    el('div', { id: 'sc-results' },
      el('div', { class: 'empty' },
        el('div', { class: 'empty-icon' }, icon('sparkles', 32)),
        el('div', null, 'Nhập kịch bản rồi bấm Phân tích'),
      ),
    ),
  ));

  root.querySelector('#sc-go').addEventListener('click', async () => {
    if (state.mode === 'image') return runImageMode();
    const script = root.querySelector('#sc-script').value.trim();
    if (!script) return toast('Cần kịch bản', 'warning');
    state.script = script;
    const btn = root.querySelector('#sc-go');
    setLoading(btn, true);
    root.querySelector('#sc-banner').innerHTML = '';
    root.querySelector('#sc-status').textContent = 'Đang phân tích...';
    try {
      const data = await api.analyzer.script({
        script,
        num_scenes: parseInt(root.querySelector('#sc-num').value, 10),
        auto_detect_scenes: root.querySelector('#sc-auto').checked,
        style_preset: root.querySelector('#sc-style').value,
        style_lock: root.querySelector('#sc-stylelock').value || null,
        global_context: root.querySelector('#sc-ctx').value || null,
        voice_gender: root.querySelector('#sc-voice').value,
      });
      state.scenes = data.scenes || [];
      state.modelUsed = data.model_used;
      state.lastData = data;
      _saveInputs();
      renderBanner(data);
      renderScenes(state.scenes);
      root.querySelector('#sc-status').textContent = `${state.scenes.length} cảnh`;
      toast(`Đã sinh ${state.scenes.length} cảnh`, 'success');
    } catch (e) {
      toast(e.message, 'error');
      root.querySelector('#sc-status').textContent = 'Lỗi';
    } finally { setLoading(btn, false); }
  });

  function renderBanner(data) {
    const banner = root.querySelector('#sc-banner');
    const fb = data.fallback_log || [];
    banner.innerHTML = '';
    banner.appendChild(el('div', { class: `ai-banner ${fb.length > 0 ? 'warning' : 'success'}` },
      icon('sparkles', 18),
      el('div', null,
        el('div', { style: { fontWeight: 700 } }, `Model: ${data.model_used}`),
        el('div', { style: { fontSize: '11.5px', opacity: 0.8 } },
          `${(data.scenes?.length ?? data.prompts?.length ?? 0)} ${data.prompts ? 'prompt' : 'cảnh'}${fb.length > 0 ? ` • fallback ${fb.length} lần` : ''}`),
      ),
    ));
  }

  function renderScenes(scenes) {
    const wrap = root.querySelector('#sc-results');
    clear(wrap);
    wrap.appendChild(el('div', { style: { marginBottom: '12px', display: 'flex', gap: '8px' } },
      el('button', { class: 'btn btn-primary', onclick: () => sendAll() },
        icon('play'), `Tạo tất cả ${scenes.length} video`),
      el('button', { class: 'btn btn-ghost', onclick: () => sendAllImage() },
        icon('image'), `Tạo tất cả ${scenes.length} ảnh`),
      el('button', { class: 'btn btn-ghost', onclick: () => {
        navigator.clipboard.writeText(JSON.stringify(scenes, null, 2));
        toast('Đã copy JSON', 'success');
      } }, icon('copy'), 'Copy JSON'),
    ));
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
          el('div', { class: 'scene-prompt' }, sc.prompt || ''),
          el('div', { class: 'scene-actions' },
            el('button', { class: 'btn btn-sm btn-ghost', onclick: () => {
              navigator.clipboard.writeText(sc.prompt || ''); toast('Đã copy', 'success');
            } }, icon('copy', 14)),
            el('button', { class: 'btn btn-sm btn-ghost', onclick: () => regenScene(i) }, icon('refresh', 14)),
            el('button', { class: 'btn btn-sm btn-primary', title: 'Gửi sang Tạo Video', onclick: () => sendOne(sc) },
              icon('play', 14), 'Video'),
            el('button', { class: 'btn btn-sm btn-ghost', title: 'Gửi sang Tạo Ảnh', onclick: () => sendOneImage(sc) },
              icon('image', 14), 'Ảnh'),
          ),
        ),
      );
      grid.appendChild(card);
    });
    wrap.appendChild(grid);
  }

  async function regenScene(idx) {
    try {
      toast('Đang regen cảnh...', 'info');
      const r = await api.analyzer.regenScene({
        script: state.script,
        scenes: state.scenes,
        scene_index: idx,
      });
      state.scenes[idx] = r.scene;
      renderScenes(state.scenes);
      toast('Đã regen', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  function sendOne(sc) {
    sessionStorage.setItem('inject_prompts', JSON.stringify([sc.prompt]));
    window.__app.navigate('content');
  }
  function sendAll() {
    const prompts = state.scenes.map(s => s.prompt).filter(Boolean);
    sessionStorage.setItem('inject_prompts', JSON.stringify(prompts));
    window.__app.navigate('content');
    toast(`Đã chuyển ${prompts.length} prompts`, 'success');
  }
  function sendOneImage(sc) {
    sessionStorage.setItem('inject_prompts', JSON.stringify([sc.prompt]));
    window.__app.navigate('image');
    toast('Đã chuyển sang Tạo Ảnh', 'success');
  }
  function sendAllImage() {
    const prompts = state.scenes.map(s => s.prompt).filter(Boolean);
    sessionStorage.setItem('inject_prompts', JSON.stringify(prompts));
    window.__app.navigate('image');
    toast(`Đã chuyển ${prompts.length} prompts sang Tạo Ảnh`, 'success');
  }

  // ── Image-prompt mode (Gem-ported) ──
  async function runImageMode() {
    const idea = root.querySelector('#sc-script').value.trim();
    if (!idea) return toast('Cần nhập ý tưởng', 'warning');
    state.script = idea;
    const count = Math.max(1, parseInt(root.querySelector('#sc-img-count').value, 10) || 10);
    const btn = root.querySelector('#sc-go');
    setLoading(btn, true);
    root.querySelector('#sc-banner').innerHTML = '';
    root.querySelector('#sc-status').textContent = 'Đang tạo prompt ảnh...';
    try {
      const fd = new FormData();
      fd.append('idea', idea);
      fd.append('count', String(count));
      if (state.refs.subject) fd.append('subject', state.refs.subject.file);
      if (state.refs.background) fd.append('background', state.refs.background.file);
      if (state.refs.style) fd.append('style', state.refs.style.file);
      const data = await api.analyzer.ideaImagePrompts(fd);
      state.imagePrompts = data.prompts || [];
      state.modelUsed = data.model_used;
      state.lastData = data;
      _saveInputs();
      renderBanner(data);
      renderImagePrompts(state.imagePrompts);
      root.querySelector('#sc-status').textContent = `${state.imagePrompts.length} prompt`;
      toast(`Đã tạo ${state.imagePrompts.length} prompt ảnh`, 'success');
    } catch (e) {
      toast(e.message, 'error');
      root.querySelector('#sc-status').textContent = 'Lỗi';
    } finally { setLoading(btn, false); }
  }

  function renderImagePrompts(prompts) {
    const wrap = root.querySelector('#sc-results');
    clear(wrap);
    if (!prompts || !prompts.length) { clearResults(); return; }
    wrap.appendChild(el('div', { style: { marginBottom: '12px', display: 'flex', gap: '8px', flexWrap: 'wrap' } },
      el('button', { class: 'btn btn-primary', onclick: () => sendAllImagePrompts() },
        icon('image'), `Gửi tất cả ${prompts.length} sang Tạo Ảnh`),
      el('button', { class: 'btn btn-ghost', onclick: () => {
        navigator.clipboard.writeText(prompts.join('\n\n')); toast('Đã copy tất cả prompt', 'success');
      } }, icon('copy'), 'Copy tất cả'),
    ));
    const grid = el('div', { style: { display: 'grid', gap: '10px' } });
    prompts.forEach((p, i) => {
      grid.appendChild(el('div', { class: 'scene-card sb-card' },
        el('div', { class: 'scene-info' },
          el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
            el('span', { class: 'sb-num' }, `#${i + 1}`),
          ),
          el('div', { class: 'scene-prompt' }, p),
          el('div', { class: 'scene-actions' },
            el('button', { class: 'btn btn-sm btn-ghost', onclick: () => {
              navigator.clipboard.writeText(p); toast('Đã copy', 'success');
            } }, icon('copy', 14)),
            el('button', { class: 'btn btn-sm btn-primary', title: 'Gửi sang Tạo Ảnh', onclick: () => sendImagePrompt(p) },
              icon('image', 14), 'Tạo ảnh'),
          ),
        ),
      ));
    });
    wrap.appendChild(grid);
  }
  function sendImagePrompt(p) {
    sessionStorage.setItem('inject_prompts', JSON.stringify([p]));
    window.__app.navigate('image');
    toast('Đã chuyển sang Tạo Ảnh', 'success');
  }
  function sendAllImagePrompts() {
    sessionStorage.setItem('inject_prompts', JSON.stringify((state.imagePrompts || []).filter(Boolean)));
    window.__app.navigate('image');
    toast(`Đã chuyển ${state.imagePrompts.length} prompts sang Tạo Ảnh`, 'success');
  }

  function _saveInputs() {
    state.inputs = {
      script: root.querySelector('#sc-script')?.value || '',
      style: root.querySelector('#sc-style')?.value || '',
      num: root.querySelector('#sc-num')?.value || '5',
      auto: !!root.querySelector('#sc-auto')?.checked,
      stylelock: root.querySelector('#sc-stylelock')?.value || '',
      ctx: root.querySelector('#sc-ctx')?.value || '',
      voice: root.querySelector('#sc-voice')?.value || 'female',
      imgCount: root.querySelector('#sc-img-count')?.value || '10',
    };
  }

  // Restore inputs + results after returning to this tab.
  (function _restore() {
    const inp = state.inputs || {};
    const set = (id, v) => { const e = root.querySelector(id); if (e && v != null) e.value = v; };
    set('#sc-script', inp.script);
    set('#sc-style', inp.style);
    set('#sc-num', inp.num);
    set('#sc-stylelock', inp.stylelock);
    set('#sc-ctx', inp.ctx);
    set('#sc-voice', inp.voice);
    set('#sc-img-count', inp.imgCount);
    const a = root.querySelector('#sc-auto');
    if (a && typeof inp.auto === 'boolean') a.checked = inp.auto;
    if (state.lastData) renderBanner(state.lastData);
    // setMode shows the right fields + re-renders this mode's last results.
    setMode(state.mode);
    const st = root.querySelector('#sc-status');
    if (st) {
      if (state.mode === 'image' && state.imagePrompts.length) st.textContent = `${state.imagePrompts.length} prompt`;
      else if (state.mode === 'video' && state.scenes.length) st.textContent = `${state.scenes.length} cảnh`;
    }
  })();
}
