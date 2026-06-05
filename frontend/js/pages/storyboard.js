// Storyboard generator — native port of the Google Flow "Storyboard Creator"
// tool. Idea + reference images → Gemini scene prompts → Nano Banana images,
// reusing the image task pipeline (batch concurrency "số luồng song song" +
// cooldown + WebSocket streaming). Output scenes can be sent in bulk to the
// "Tạo Video" tab as I2V (each scene image becomes the reference frame).
import { el, clear, toast, setLoading, icon, makeThumbnail } from '../ui.js';
import { api } from '../api.js';
import { tasksStore } from '../tasks_store.js';
import { makeSelectionToolbar, attachCardCheckbox } from '../gallery_actions.js';

const IMAGE_MODELS = [
  { key: 'nano_banana_pro', label: '🍌 Nano Banana Pro' },
  { key: 'nano_banana_2',   label: '🍌 Nano Banana 2' },
  { key: 'imagen_4',        label: 'Imagen 4' },
];
const ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4'];

// Module-level state survives SPA navigation (ref File objects too; cleared on F5).
const form = {
  idea: '', count: 4, model: 'nano_banana_pro', aspect: '16:9', concurrent: 4,
  refs: [],   // [{ file, previewUrl, name }]
};
let _taskId = null;
let _unsub = null;

function ratioToStyle(r) {
  return ({ '1:1': '1/1', '16:9': '16/9', '9:16': '9/16', '4:3': '4/3', '3:4': '3/4' })[r] || '16/9';
}

// Upscale-state pill on a scene thumbnail (same look as the Tạo Ảnh gallery).
function _upscaleBadge(it) {
  const res = (it.upscale_resolution || '').toUpperCase();
  switch (it.upscale_status) {
    case 'queued':
      return el('div', { class: 'upscale-badge is-queued', title: 'Đang chờ tới lượt upscale' }, `⏳ Chờ ${res}`);
    case 'running':
      return el('div', { class: 'upscale-badge is-running' },
        el('span', { class: 'upscale-badge-spin' }), `Đang upscale ${res}…`);
    case 'done':
      return el('a', {
        class: 'upscale-badge is-done', href: it.upscale_url || '#', target: '_blank', download: '',
        title: `Ảnh ${res} — click để tải`, onclick: (e) => e.stopPropagation(),
      }, `✓ ${res}`);
    case 'error':
      return el('div', { class: 'upscale-badge is-error', title: it.upscale_error || 'Lỗi upscale' }, `⚠ Lỗi ${res}`);
    default:
      return null;
  }
}

// Upscale selected scenes via the shared image upscale-batch endpoint (the
// storyboard items ARE image-task items with a media_id, so it just works).
async function runBatchUpscale(itemIds, resolution) {
  const RES = resolution.toUpperCase();
  const initial = toast(`Đang upscale ${itemIds.length} ảnh → ${RES}… (5-10s/ảnh)`, 'info', 0);
  try {
    const r = await api.image.upscaleBatch(itemIds, resolution);
    const okN = (r.completed || []).length;
    const errN = (r.errors || []).length;
    if (errN === 0) toast(`Đã upscale ${okN} cảnh → ${RES}`, 'success');
    else toast(`Upscale: ${okN} OK, ${errN} lỗi`, errN ? 'warning' : 'success');
  } finally {
    if (initial && typeof initial.remove === 'function') initial.remove();
  }
}

export function renderStoryboard(root) {
  root.appendChild(el('div', { class: 'page-hero' },
    el('div', { class: 'hero-icon' }, icon('image', 28)),
    el('div', { class: 'hero-text' },
      el('h2', null, 'Tạo Storyboard'),
      el('p', null, 'Ý tưởng + ảnh tham chiếu → kịch bản phân cảnh (prompt + ảnh) bằng Gemini + Nano Banana'),
    ),
  ));

  const layout = el('div', { class: 'gen-layout' });
  root.appendChild(layout);

  // ── LEFT: config ──
  const refCountLabel = el('span', null, `Ảnh tham chiếu (${form.refs.length}/10)`);
  const refGrid = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' } });

  function pickRefs() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
    inp.onchange = async () => {
      for (const f of inp.files) {
        if (form.refs.length >= 10) break;
        form.refs.push({ file: f, previewUrl: await makeThumbnail(f), name: f.name });
      }
      renderRefs();
    };
    inp.click();
  }

  function renderRefs() {
    clear(refGrid);
    refCountLabel.textContent = `Ảnh tham chiếu (${form.refs.length}/10)`;
    form.refs.forEach((r, i) => {
      refGrid.appendChild(el('div', { style: { position: 'relative', aspectRatio: '1/1', borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--border)' } },
        el('img', { src: r.previewUrl, style: { width: '100%', height: '100%', objectFit: 'cover' } }),
        el('div', {
          title: 'Bỏ ảnh',
          style: { position: 'absolute', top: '3px', right: '3px', width: '20px', height: '20px', borderRadius: '50%', background: 'rgba(0,0,0,0.6)', color: '#fff', display: 'grid', placeItems: 'center', fontSize: '14px', lineHeight: 1, cursor: 'pointer' },
          onclick: () => { form.refs.splice(i, 1); renderRefs(); },
        }, '×'),
      ));
    });
    if (form.refs.length < 10) {
      refGrid.appendChild(el('div', {
        onclick: pickRefs,
        style: { aspectRatio: '1/1', border: '1px dashed var(--border-strong)', borderRadius: '8px', display: 'grid', placeItems: 'center', cursor: 'pointer', color: 'var(--text-faint)' },
      }, icon('plus', 20)));
    }
  }

  const left = el('div', { class: 'gen-config' },
    el('div', { class: 'card' },
      el('div', { class: 'field-group' },
        el('label', { class: 'field-label' }, 'Ý tưởng'),
        el('textarea', { class: 'textarea', id: 'sb2-idea', rows: 4, placeholder: 'Mô tả ý tưởng kịch bản của bạn...', oninput: (e) => { form.idea = e.target.value; } }),
      ),
      el('div', { class: 'field-group' },
        el('label', { class: 'field-label' }, refCountLabel),
        refGrid,
      ),
      el('div', { class: 'field-group' },
        el('label', { class: 'field-label' }, 'Model gen ảnh'),
        el('select', { class: 'select', id: 'sb2-model', onchange: (e) => { form.model = e.target.value; } },
          ...IMAGE_MODELS.map(m => el('option', { value: m.key }, m.label)),
        ),
      ),
      el('div', { class: 'form-row' },
        el('div', { class: 'field-group' },
          el('label', { class: 'field-label' }, 'Tỉ lệ'),
          el('select', { class: 'select', id: 'sb2-aspect', onchange: (e) => { form.aspect = e.target.value; } },
            ...ASPECTS.map(a => el('option', { value: a }, a)),
          ),
        ),
        el('div', { class: 'field-group' },
          el('label', { class: 'field-label' }, 'Số cảnh'),
          el('input', { type: 'number', class: 'input', id: 'sb2-count', min: 1, value: form.count, oninput: (e) => { form.count = Math.max(1, parseInt(e.target.value, 10) || 1); } }),
        ),
      ),
      el('div', { class: 'field-group' },
        el('label', { class: 'field-label' }, 'Số luồng song song'),
        el('input', { type: 'number', class: 'input', id: 'sb2-concurrent', min: 1, max: 8, value: form.concurrent, oninput: (e) => { form.concurrent = Math.max(1, Math.min(8, parseInt(e.target.value, 10) || 1)); } }),
      ),
      el('button', { class: 'btn btn-primary', style: { width: '100%', marginTop: '12px' }, id: 'sb2-go', onclick: generate },
        icon('sparkles'), 'Tạo Storyboard',
      ),
    ),
  );
  layout.appendChild(left);
  renderRefs();

  // ── RIGHT: results ──
  const right = el('div', { class: 'gen-results' },
    el('div', { class: 'card' },
      el('div', { class: 'card-header' },
        el('h3', { class: 'card-title' }, 'Storyboard'),
        el('div', { class: 'card-subtitle', id: 'sb2-status' }, 'Chưa tạo'),
      ),
      el('div', { id: 'sb2-actions', style: { marginBottom: '12px' } }),
      el('div', { id: 'sb2-results' },
        el('div', { class: 'empty' },
          el('div', { class: 'empty-icon' }, icon('image', 32)),
          el('div', null, 'Nhập ý tưởng + ảnh tham chiếu rồi bấm Tạo Storyboard'),
        ),
      ),
    ),
  );
  layout.appendChild(right);

  // Restore field values (survive navigation)
  root.querySelector('#sb2-idea').value = form.idea;
  root.querySelector('#sb2-model').value = form.model;
  root.querySelector('#sb2-aspect').value = form.aspect;
  root.querySelector('#sb2-count').value = form.count;
  root.querySelector('#sb2-concurrent').value = form.concurrent;

  async function generate() {
    const idea = (form.idea || '').trim();
    if (!idea && form.refs.length === 0) return toast('Cần nhập ý tưởng hoặc thêm ảnh tham chiếu', 'warning');
    const btn = root.querySelector('#sb2-go');
    setLoading(btn, true);
    root.querySelector('#sb2-status').textContent = 'Đang viết kịch bản (Gemini)...';
    try {
      const fd = new FormData();
      fd.append('idea', idea);
      fd.append('count', String(form.count));
      fd.append('model', form.model);
      fd.append('aspect_ratio', form.aspect);
      fd.append('concurrent', String(form.concurrent));
      form.refs.forEach(r => fd.append('refs', r.file));
      const res = await api.storyboard.start(fd);
      // Register so WS image events (item_status/item_completed, now carrying
      // the prompt) drive the scene cards.
      tasksStore.register(res.task_id, 'storyboard', { items: res.prompts, aspect: form.aspect });
      attachToTask(res.task_id);
      toast(`Đã tạo ${res.prompts.length} phân cảnh — đang gen ảnh (${res.model_used})`, 'success');
    } catch (e) {
      toast(e.message, 'error');
      root.querySelector('#sb2-status').textContent = 'Lỗi';
    } finally { setLoading(btn, false); }
  }

  function attachToTask(taskId) {
    if (_unsub) { _unsub(); _unsub = null; }
    _taskId = taskId;
    renderGallery(tasksStore.get(taskId));
    _unsub = tasksStore.on(taskId, (s) => renderGallery(s));
  }

  function sendAllToI2V(items) {
    const scenes = items
      .filter(it => it.status === 'done' && it.output_path)
      .map(it => {
        // Prefer the upscaled image when a 2K/4K upscale finished for this scene.
        const up = it.upscale_status === 'done' && it.upscale_path;
        return {
          prompt: it.prompt || '',
          path: up ? it.upscale_path : it.output_path,
          url: up ? it.upscale_url : it.output_url,
          name: 'scene',
        };
      });
    if (!scenes.length) return toast('Chưa có cảnh nào hoàn thành để gửi', 'warning');
    const upN = items.filter(it => it.upscale_status === 'done' && it.upscale_path).length;
    sessionStorage.setItem('inject_i2v', JSON.stringify(scenes));
    window.__app.navigate('content');
    toast(`Đã gửi ${scenes.length} cảnh sang Tạo Video (I2V)${upN ? ` (${upN} ảnh đã upscale)` : ''}`, 'success');
  }

  function renderGallery(state) {
    if (!root.isConnected) return;
    const wrap = root.querySelector('#sb2-results');
    const actions = root.querySelector('#sb2-actions');
    const statusEl = root.querySelector('#sb2-status');
    if (!wrap) return;
    clear(wrap); clear(actions);

    if (!state) {
      wrap.appendChild(el('div', { class: 'empty' },
        el('div', { class: 'empty-icon' }, icon('image', 32)),
        el('div', null, 'Nhập ý tưởng + ảnh tham chiếu rồi bấm Tạo Storyboard'),
      ));
      statusEl.textContent = 'Chưa tạo';
      return;
    }

    // Scene order = DB item id ascending (creation order); unclaimed slots tail.
    const items = [...state.items].sort((a, b) => {
      if (a.id == null && b.id == null) return 0;
      if (a.id == null) return 1;
      if (b.id == null) return -1;
      return a.id - b.id;
    });

    const grid = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '14px' } });

    // Bulk "send to I2V" + selection toolbar (upscale 2K/4K) — once ≥1 done.
    const doneScenes = items.filter(it => it.status === 'done' && it.output_path);
    let toolbar = null;
    if (doneScenes.length) {
      actions.appendChild(el('button', { class: 'btn btn-primary', style: { marginBottom: '8px' }, onclick: () => sendAllToI2V(items) },
        icon('play', 14), `Gửi tất cả ${doneScenes.length} cảnh sang Tạo Video (I2V)`));
      toolbar = makeSelectionToolbar({
        getCards: () => [...grid.querySelectorAll('.scene-card[data-path]')],
        pathOf: (card) => card.dataset.path,
        itemOf: (card) => {
          const id = parseInt(card.dataset.itemId || '0', 10);
          return id ? { id, mediaId: card.dataset.mediaId || null } : null;
        },
        onUpscale: async (ids, res) => { await runBatchUpscale(ids, res); },
      });
      actions.appendChild(toolbar);
    }

    const aspectStyle = ratioToStyle(state.aspect || form.aspect);
    items.forEach((it, i) => {
      const card = el('div', { class: 'scene-card' });
      const thumb = el('div', { class: 'scene-thumb', style: { aspectRatio: aspectStyle } },
        el('div', { class: 'scene-number' }, `SCENE ${i + 1}`),
      );
      if (it.status === 'done' && it.output_url) {
        const img = el('img', { src: it.output_url, style: { width: '100%', height: '100%', objectFit: 'cover', cursor: 'zoom-in' } });
        img.addEventListener('click', () => window.open(it.output_url, '_blank'));
        thumb.appendChild(img);
      } else if (it.status === 'error') {
        thumb.appendChild(el('div', {
          class: 'scene-error',
          title: it.error_detail || it.error || 'Lỗi',
          style: { color: 'var(--red)', fontSize: '11px', padding: '8px', textAlign: 'center', lineHeight: '1.35', overflowY: 'auto', maxHeight: '100%' },
        }, it.error || 'Lỗi'));
      } else {
        thumb.appendChild(el('div', { class: 'spinner' }));
      }
      // Upscale state overlay (queued / running / done / error)
      if (it.upscale_status) {
        const b = _upscaleBadge(it);
        if (b) thumb.appendChild(b);
        if (it.upscale_status === 'queued') card.classList.add('is-upscale-queued');
      }
      card.appendChild(thumb);
      if (it.upscale_status === 'running') card.appendChild(el('div', { class: 'upscale-progress-bar' }));

      const actionsRow = el('div', { class: 'scene-actions' });
      if (it.output_url) {
        actionsRow.appendChild(el('a', { href: it.output_url, download: '', class: 'btn btn-sm btn-ghost' }, icon('download', 14), 'Tải'));
      }
      actionsRow.appendChild(el('button', {
        class: 'btn btn-sm btn-ghost', title: 'Copy prompt',
        onclick: () => { navigator.clipboard.writeText(it.prompt || ''); toast('Đã copy prompt', 'success'); },
      }, icon('copy', 14)));
      if (it.upscale_status === 'done' && it.upscale_url) {
        actionsRow.appendChild(el('a', {
          href: it.upscale_url, download: '', target: '_blank',
          class: 'btn btn-sm btn-ghost', style: { marginLeft: 'auto' }, title: 'Tải ảnh đã upscale',
        }, icon('download', 14), `Tải ${(it.upscale_resolution || '').toUpperCase()}`));
      }

      card.appendChild(el('div', { class: 'scene-info' },
        el('div', { class: 'scene-prompt', style: { WebkitLineClamp: 4 } }, it.prompt || 'Đang viết kịch bản...'),
        actionsRow,
      ));

      // Make done scenes selectable (checkbox) so they can be upscaled.
      if (it.status === 'done' && it.output_path) {
        if (it.id != null) card.dataset.itemId = String(it.id);
        if (it.media_id) card.dataset.mediaId = it.media_id;
        attachCardCheckbox(card, it.output_path, toolbar);
      }
      grid.appendChild(card);
    });
    wrap.appendChild(grid);
    if (toolbar && toolbar._setUpscaleProgress) {
      // Scope progress to THIS task so it doesn't bleed into the Tạo Ảnh tab.
      const ub = tasksStore.getUpscaleBatch();
      toolbar._setUpscaleProgress(ub.active && ub.taskId === state.id ? ub : null);
    }

    const total = state.total || items.length;
    statusEl.textContent = state.status === 'completed'
      ? `Xong ${state.done || 0}/${total}${state.error ? ` • lỗi ${state.error}` : ''}`
      : `Đang gen ${(state.done || 0) + (state.error || 0)}/${total}`;
  }

  // Re-attach to an in-flight/last task when returning to this tab, or via the
  // Tasks Manager eye deep-link.
  const pending = window.__app && window.__app._pendingTaskId;
  if (pending != null && tasksStore.get(pending)) {
    attachToTask(pending);
    window.__app._pendingTaskId = null;
  } else if (_taskId && tasksStore.get(_taskId)) {
    attachToTask(_taskId);
  }
}
