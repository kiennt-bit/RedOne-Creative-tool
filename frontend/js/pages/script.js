// Script-to-Prompt page — one-shot Gemini storyboard
import { el, clear, toast, setLoading, icon, modal } from '../ui.js';
import { api } from '../api.js';

// Module-level state → survives SPA tab navigation (restored on re-render).
const state = { scenes: [], script: '', modelUsed: null, lastData: null, inputs: {} };

export function renderScript(root) {

  root.appendChild(el('div', { class: 'page-hero' },
    el('div', { class: 'hero-icon' }, icon('sparkles', 28)),
    el('div', { class: 'hero-text' },
      el('h2', null, 'Ý Tưởng → Video'),
      el('p', null, 'Paste kịch bản, AI tự chia cảnh và sinh prompt Veo 3 trong một lần gọi'),
    ),
  ));

  const layout = el('div', { style: { display: 'grid', gridTemplateColumns: '380px 1fr', gap: '20px' } });
  root.appendChild(layout);

  // LEFT
  layout.appendChild(el('div', null,
    el('div', { class: 'card' },
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
      el('div', { style: { marginTop: '12px' } },
        el('button', { class: 'btn btn-primary', style: { width: '100%' }, id: 'sc-go' },
          icon('sparkles'), 'Phân tích kịch bản',
        ),
      ),
    ),
  ));

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
          `${data.scenes?.length || 0} cảnh${fb.length > 0 ? ` • fallback ${fb.length} lần` : ''}`),
      ),
    ));
  }

  function renderScenes(scenes) {
    const wrap = root.querySelector('#sc-results');
    clear(wrap);
    wrap.appendChild(el('div', { style: { marginBottom: '12px', display: 'flex', gap: '8px' } },
      el('button', { class: 'btn btn-primary', onclick: () => sendAll() },
        icon('play'), `Tạo tất cả ${scenes.length} video`),
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
            el('button', { class: 'btn btn-sm btn-primary', onclick: () => sendOne(sc) },
              icon('play', 14), 'Tạo'),
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

  function _saveInputs() {
    state.inputs = {
      script: root.querySelector('#sc-script')?.value || '',
      style: root.querySelector('#sc-style')?.value || '',
      num: root.querySelector('#sc-num')?.value || '5',
      auto: !!root.querySelector('#sc-auto')?.checked,
      stylelock: root.querySelector('#sc-stylelock')?.value || '',
      ctx: root.querySelector('#sc-ctx')?.value || '',
      voice: root.querySelector('#sc-voice')?.value || 'female',
    };
  }

  // Restore inputs + storyboard after returning to this tab.
  (function _restore() {
    const inp = state.inputs || {};
    const set = (id, v) => { const e = root.querySelector(id); if (e && v != null) e.value = v; };
    set('#sc-script', inp.script);
    set('#sc-style', inp.style);
    set('#sc-num', inp.num);
    set('#sc-stylelock', inp.stylelock);
    set('#sc-ctx', inp.ctx);
    set('#sc-voice', inp.voice);
    const a = root.querySelector('#sc-auto');
    if (a && typeof inp.auto === 'boolean') a.checked = inp.auto;
    if (state.lastData) renderBanner(state.lastData);
    if (state.scenes && state.scenes.length) {
      renderScenes(state.scenes);
      const st = root.querySelector('#sc-status');
      if (st) st.textContent = `${state.scenes.length} cảnh`;
    }
  })();
}
